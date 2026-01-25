const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات (Supabase)
const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tiuMncgWhf1YRWoD-uYQ3Q_ziI8OKci';

// 2. إعدادات المحفظة (من متغيرات البيئة - Environment Variables)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// 3. إعدادات شبكة Pi Testnet
const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  // السماح فقط بطلبات POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { uid, deliveryId, username, amount, walletAddress } = JSON.parse(event.body);
    const resolvedDeliveryId = deliveryId || uid;
    const withdrawAmount = parseFloat(amount);

    // التحقق من المدخلات
    if (!resolvedDeliveryId || !amount || !walletAddress) {
      return { statusCode: 400, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
    }

    // --- خطوة 1: التحقق من الرصيد في قاعدة البيانات ---
    const { data: orders } = await supabase
      .from('orders')
      .select('pricing_snapshot,status,delivery_id')
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'delivered');
    const { data: withdrawals } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('delivery_id', resolvedDeliveryId);

    const totalEarned = (orders || []).reduce((sum, row) => {
      const totalPi = parseFloat(row?.pricing_snapshot?.total_pi || 0);
      const platformFeePi = parseFloat(row?.pricing_snapshot?.platform_fee_pi || 0);
      const deliveryProfit = totalPi - platformFeePi;
      return sum + (isNaN(deliveryProfit) ? 0 : deliveryProfit);
    }, 0);
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount), 0) : 0;
    const currentBalance = totalEarned - totalWithdrawn;

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيد حسابك غير كافٍ' }) };
    }

    // --- خطوة 2: تهيئة شبكة Pi (Stellar) ---
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

    if (!APP_WALLET_SECRET) throw new Error('APP_WALLET_SECRET is not defined in environment variables');
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);

    // تحميل بيانات حساب التطبيق
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    // بناء المعاملة مع الرسوم المحدثة (0.01 Pi)
    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100000', // تم التعديل لحل خطأ tx_insufficient_fee
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7).toString(),
        }),
      )
      .setTimeout(30)
      .build();

    // توقيع المعاملة
    transaction.sign(sourceKeys);

    // إرسال المعاملة للبلوكشين
    const result = await server.submitTransaction(transaction);

    // --- خطوة 3: تسجيل العملية بنجاح في Supabase ---
    await supabase.from('withdrawals').insert([
      {
        delivery_id: resolvedDeliveryId,
        username: username,
        amount: withdrawAmount,
        wallet_address: walletAddress,
        txid: result.hash,
      },
    ]);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        txid: result.hash,
        message: 'تم التحويل بنجاح',
      }),
    };
  } catch (err) {
    // معالجة الأخطاء المتقدمة
    console.error('--- ERROR LOG START ---');
    let errorResponse = {
      error: 'فشلت المعاملة',
      details: err.message,
    };

    if (err.response && err.response.data && err.response.data.extras) {
      const codes = err.response.data.extras.result_codes;
      const opCodes = codes.operations ? codes.operations.join(', ') : 'no_op_code';
      errorResponse.details = `Blockchain Error: ${codes.transaction} (${opCodes})`;

      // تنبيهات مخصصة للأخطاء
      if (codes.transaction === 'tx_insufficient_fee') {
        errorResponse.error = 'رسوم الشبكة مرتفعة حالياً، حاول مرة أخرى';
      } else if (opCodes.includes('op_underfunded')) {
        errorResponse.error = 'محفظة النظام تحتاج شحن رصيد';
      }
    }

    console.error(errorResponse.details);
    console.error('--- ERROR LOG END ---');

    return {
      statusCode: 500,
      body: JSON.stringify(errorResponse),
    };
  }
};
