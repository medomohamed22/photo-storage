const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// Env
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// Pi Testnet (Stellar)
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (statusCode, payload) => ({
  statusCode,
  headers,
  body: JSON.stringify(payload),
});

function isValidAmount(n) {
  return Number.isFinite(n) && n > 0;
}

function isValidStellarPublicKey(address) {
  try {
    return StellarSdk.StrKey.isValidEd25519PublicKey(address);
  } catch (_) {
    return false;
  }
}

function clampBalance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

// ✅ عميل Supabase مرة واحدة فقط
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === 'OPTIONS') {
    return json(200, { ok: true });
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  try {
    // تحقق من env
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: 'Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
    }
    if (!APP_WALLET_SECRET) {
      return json(500, { error: 'APP_WALLET_SECRET is not defined' });
    }

    const body = JSON.parse(event.body || '{}');

    const uid = body.uid; // delivery_earnings.delivery_id
    const username = body.username || null;
    const walletAddress = body.walletAddress;
    const withdrawAmount = Number(body.amount);

    // تحقق من المدخلات
    if (!uid || !walletAddress || body.amount === undefined) {
      return json(400, { error: 'بيانات ناقصة', required: ['uid', 'amount', 'walletAddress'] });
    }
    if (!isValidAmount(withdrawAmount)) {
      return json(400, { error: 'قيمة السحب غير صحيحة' });
    }
    if (!isValidStellarPublicKey(walletAddress)) {
      return json(400, { error: 'عنوان المحفظة غير صحيح (Stellar/Pi address)' });
    }

    // --- 1) حساب الرصيد من قاعدة البيانات ---
    const { data: earnings, error: earnErr } = await db
      .from('delivery_earnings')
      .select('amount_pi')
      .eq('delivery_id', uid);

    if (earnErr) {
      return json(500, { error: 'Database error reading earnings', details: earnErr.message });
    }

    const { data: withdrawals, error: wdErr } = await db
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    if (wdErr) {
      return json(500, { error: 'Database error reading withdrawals', details: wdErr.message });
    }

    const totalEarned = (earnings || []).reduce((sum, row) => sum + Number(row.amount_pi || 0), 0);
    const totalWithdrawn = (withdrawals || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const currentBalance = clampBalance(totalEarned - totalWithdrawn);

    if (currentBalance < withdrawAmount) {
      return json(400, {
        error: 'رصيد حسابك غير كافٍ',
        balance: Number(currentBalance.toFixed(7)),
        requested: Number(withdrawAmount.toFixed(7)),
      });
    }

    // --- 2) تنفيذ التحويل على Pi Testnet ---
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);

    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7),
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(sourceKeys);

    const result = await server.submitTransaction(tx);

    // --- 3) تسجيل السحب في Supabase ---
    const { error: insertErr } = await db.from('withdrawals').insert([
      {
        pi_user_id: uid,
        username,
        amount: withdrawAmount,
        wallet_address: walletAddress,
        txid: result.hash,
      },
    ]);

    if (insertErr) {
      // التحويل حصل لكن التسجيل فشل
      return json(200, {
        success: true,
        txid: result.hash,
        message: 'تم التحويل بنجاح (لكن فشل تسجيل العملية في قاعدة البيانات)',
        db_error: insertErr.message,
      });
    }

    const balanceAfter = clampBalance(currentBalance - withdrawAmount);

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
      balance_before: Number(currentBalance.toFixed(7)),
      withdrawn: Number(withdrawAmount.toFixed(7)),
      balance_after: Number(balanceAfter.toFixed(7)),
    });
  } catch (err) {
    console.error('withdraw error:', err);

    let errorResponse = {
      error: 'فشلت المعاملة',
      details: err?.message || 'Unknown error',
    };

    if (err.response && err.response.data && err.response.data.extras) {
      const codes = err.response.data.extras.result_codes;
      const opCodes = codes.operations ? codes.operations.join(', ') : 'no_op_code';
      errorResponse.details = `Blockchain Error: ${codes.transaction} (${opCodes})`;

      if (codes.transaction === 'tx_insufficient_fee') {
        errorResponse.error = 'رسوم الشبكة مرتفعة حالياً، حاول مرة أخرى';
      } else if (opCodes.includes('op_underfunded')) {
        errorResponse.error = 'محفظة النظام تحتاج شحن رصيد';
      } else if (codes.transaction === 'tx_bad_seq') {
        errorResponse.error = 'هناك تعارض تسلسلي (Sequence). أعد المحاولة بعد ثواني';
      }
    }

    return json(500, errorResponse);
  }
};
