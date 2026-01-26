const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1) Supabase (Service Role Key لازم يكون موجود في Netlify env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 2) App wallet secret (محفظة النظام اللي هتدفع منها)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// 3) Pi Testnet (Stellar)
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const json = (statusCode, payload) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  },
  body: JSON.stringify(payload),
});

function isValidAmount(n) {
  return Number.isFinite(n) && n > 0;
}

// Stellar public key check (اختياري لكنه مفيد)
function isValidStellarPublicKey(address) {
  try {
    return StellarSdk.StrKey.isValidEd25519PublicKey(address);
  } catch (_) {
    return false;
  }
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return json(200, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  try {
    // تحقق من env
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return json(500, { error: 'Missing Supabase environment variables (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
    }
    if (!APP_WALLET_SECRET) {
      return json(500, { error: 'APP_WALLET_SECRET is not defined in environment variables' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const body = JSON.parse(event.body || '{}');
    const uid = body.uid; // ده لازم يساوي delivery_earnings.delivery_id
    const username = body.username || null;
    const walletAddress = body.walletAddress;
    const withdrawAmount = Number(body.amount);

    // تحقق من المدخلات
    if (!uid || !walletAddress || !body.amount) {
      return json(400, { error: 'بيانات ناقصة', required: ['uid', 'amount', 'walletAddress'] });
    }
    if (!isValidAmount(withdrawAmount)) {
      return json(400, { error: 'قيمة السحب غير صحيحة' });
    }
    if (!isValidStellarPublicKey(walletAddress)) {
      return json(400, { error: 'عنوان المحفظة غير صحيح (Stellar/Pi address)' });
    }

    // --- 1) حساب رصيد الدليفري من قاعدة البيانات ---
    // جدولك: delivery_earnings (delivery_id, amount_pi, ...)
    const { data: earnings, error: earnErr } = await supabase
      .from('delivery_earnings')
      .select('amount_pi')
      .eq('delivery_id', uid);

    if (earnErr) {
      return json(500, { error: 'Database error reading earnings', details: earnErr.message });
    }

    const { data: withdrawals, error: wdErr } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    if (wdErr) {
      return json(500, { error: 'Database error reading withdrawals', details: wdErr.message });
    }

    const totalEarned = (earnings || []).reduce((sum, row) => sum + Number(row.amount_pi || 0), 0);
    const totalWithdrawn = (withdrawals || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const currentBalance = totalEarned - totalWithdrawn;

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
      fee: '100000', // 0.01 Pi تقريباً (حسب إعدادك)
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
    const { error: insertErr } = await supabase.from('withdrawals').insert([
      {
        pi_user_id: uid,
        username: username,
        amount: withdrawAmount,
        wallet_address: walletAddress,
        txid: result.hash,
      },
    ]);

    if (insertErr) {
      // التحويل حصل بالفعل على الشبكة، بس التسجيل فشل
      return json(200, {
        success: true,
        txid: result.hash,
        message: 'تم التحويل بنجاح (لكن فشل تسجيل العملية في قاعدة البيانات)',
        db_error: insertErr.message,
      });
    }

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
      balance_before: Number(currentBalance.toFixed(7)),
      withdrawn: Number(withdrawAmount.toFixed(7)),
      balance_after: Number((currentBalance - withdrawAmount).toFixed(7)),
    });
  } catch (err) {
    console.error('--- ERROR LOG START ---');

    let errorResponse = {
      error: 'فشلت المعاملة',
      details: err?.message || 'Unknown error',
    };

    // Stellar/Horizon errors
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

    console.error(errorResponse.details);
    console.error('--- ERROR LOG END ---');

    return json(500, errorResponse);
  }
};
