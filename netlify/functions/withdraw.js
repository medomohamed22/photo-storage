const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات (Supabase)
const SUPABASE_URL = process.env.SUPABASE_URL; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; 

// 2) App wallet secret (محفظة النظام اللي هتدفع منها)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// 3) Pi Testnet (Stellar)
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function clampBalance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

exports.handler = async (event) => {
  // السماح فقط بطلبات POST
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
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

    // التحقق من المدخلات
    if (!uid || !amount || !walletAddress) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
    }
    if (!Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'قيمة السحب غير صحيحة' }) };
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'إعدادات قاعدة البيانات غير متوفرة' }) };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // --- خطوة 1: التحقق من الرصيد في قاعدة البيانات ---
    const { data: earnings } = await supabase
      .from('delivery_earnings')
      .select('amount_pi')
      .eq('delivery_pi_user_id', uid);
    const { data: withdrawals } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    const totalEarned = earnings ? earnings.reduce((sum, row) => sum + parseFloat(row.amount_pi || 0), 0) : 0;
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0) : 0;
    const currentBalance = clampBalance(totalEarned - totalWithdrawn);

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'رصيد حسابك غير كافٍ' }) };
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

    // توقيع المعاملة
    transaction.sign(sourceKeys);

    // إرسال المعاملة للبلوكشين
    const result = await server.submitTransaction(transaction);

    // --- خطوة 3: تسجيل العملية بنجاح في Supabase ---
    await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash
    }]);

    const balanceAfter = clampBalance(currentBalance - withdrawAmount);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        txid: result.hash, 
        balance_before: currentBalance,
        withdrawn: withdrawAmount,
        balance_after: balanceAfter
      })
    };

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

    return { 
      statusCode: 500, 
      headers,
      body: JSON.stringify(errorResponse) 
    };
  }
};
