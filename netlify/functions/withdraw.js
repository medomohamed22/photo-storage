const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

// 1. إعدادات قاعدة البيانات (Supabase)
const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_tiuMncgWhf1YRWoD-uYQ3Q_ziI8OKci';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 2. إعدادات المحفظة (من متغيرات البيئة - Environment Variables)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// 3. إعدادات شبكة Pi (الافتراضي Mainnet مع إمكانية التبديل عبر env)
const PI_HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE || 'Pi Network';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY);
const authSupabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const sumAmounts = (rows, key) => (rows || []).reduce((sum, row) => sum + toNumber(row?.[key]), 0);

const calculateOrderEarningsPi = (order) => {
  const snapshot = order?.pricing_snapshot || {};
  const totalPi = toNumber(snapshot.total_pi);
  const platformFeePi = toNumber(snapshot.platform_fee_pi);
  if (totalPi > 0) {
    return Math.max(0, totalPi - platformFeePi);
  }

  const priceEgp = toNumber(order?.price);
  const deliveryFeeEgp = toNumber(order?.delivery_fee);
  const totalPriceEgp = toNumber(order?.total_price);
  const platformFeeEgp = toNumber(order?.platform_fee);
  const baseEgp = priceEgp || deliveryFeeEgp
    ? priceEgp + deliveryFeeEgp
    : Math.max(0, totalPriceEgp - platformFeeEgp);
  const piPerEgp = toNumber(snapshot.pi_egp);
  if (baseEgp > 0 && piPerEgp > 0) {
    return baseEgp / piPerEgp;
  }
  return 0;
};

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
    if (!Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'قيمة السحب غير صالحة' }) };
    }
    if (!APP_WALLET_SECRET) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'APP_WALLET_SECRET غير مضبوط على السيرفر' }),
      };
    }
    if (SUPABASE_SERVICE_ROLE_KEY) {
      const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (!token) {
        return { statusCode: 401, body: JSON.stringify({ error: 'مطلوب تسجيل الدخول' }) };
      }
      const { data: authData, error: authError } = await authSupabase.auth.getUser(token);
      if (authError || !authData?.user) {
        return { statusCode: 401, body: JSON.stringify({ error: 'جلسة غير صالحة' }) };
      }
      const metadata = authData.user.user_metadata || {};
      const expectedDeliveryId = metadata.pi_username || metadata.delivery_id || metadata.username;
      if (!expectedDeliveryId || expectedDeliveryId !== resolvedDeliveryId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'غير مسموح لهذا الحساب' }) };
      }
    }

    // --- خطوة 1: التحقق من الرصيد في قاعدة البيانات ---
    const { data: orders, error: ordersError } = await supabase
      .from('orders')
      .select('pricing_snapshot,status,delivery_id,price,delivery_fee,total_price,platform_fee')
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'delivered');
    if (ordersError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'فشل قراءة الطلبات', details: ordersError.message }) };
    }
    const { data: withdrawals, error: withdrawalsError } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('delivery_id', resolvedDeliveryId);
    if (withdrawalsError) {
      return { statusCode: 500, body: JSON.stringify({ error: 'فشل قراءة السحوبات', details: withdrawalsError.message }) };
    }
    const { data: approvedRequests, error: approvedError } = await supabase
      .from('withdraw_requests')
      .select('amount_pi')
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'approved');
    if (approvedError) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'فشل قراءة طلبات السحب', details: approvedError.message }),
      };
    }
    const { data: walletRow, error: walletError } = await supabase
      .from('delivery_wallet')
      .select('balance_pi')
      .eq('delivery_id', resolvedDeliveryId)
      .maybeSingle();
    if (walletError && walletError.code !== 'PGRST116') {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'فشل قراءة رصيد المحفظة', details: walletError.message }),
      };
    }

    const totalEarned = (orders || []).reduce((sum, row) => sum + calculateOrderEarningsPi(row), 0);
    const totalWithdrawn = sumAmounts(withdrawals, 'amount');
    const approvedWithdrawn = sumAmounts(approvedRequests, 'amount_pi');
    const walletBalance = walletRow?.balance_pi !== undefined ? toNumber(walletRow.balance_pi) : null;
    const currentBalance = walletBalance !== null
      ? walletBalance - totalWithdrawn - approvedWithdrawn
      : totalEarned - totalWithdrawn - approvedWithdrawn;

    if (currentBalance < withdrawAmount) {
      return { statusCode: 400, body: JSON.stringify({ error: 'رصيد حسابك غير كافٍ' }) };
    }

    // --- خطوة 2: تهيئة شبكة Pi (Stellar) ---
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

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
    const { error: insertError } = await supabase.from('withdrawals').insert([
      {
        delivery_id: resolvedDeliveryId,
        username: username,
        amount: withdrawAmount,
        wallet_address: walletAddress,
        txid: result.hash,
      },
    ]);
    if (insertError) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'فشل تسجيل السحب', details: insertError.message }),
      };
    }

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
      } else if (opCodes.includes('op_no_destination')) {
        errorResponse.error = 'عنوان المحفظة غير مفعل على شبكة Pi';
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
