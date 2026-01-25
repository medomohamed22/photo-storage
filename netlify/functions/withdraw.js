// netlify/functions/withdraw.js
'use strict';

const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ================== CONFIG ================== */
const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// ✅ بدون fallback values عشان Netlify secrets scan
const PI_HORIZON_URL = process.env.PI_HORIZON_URL;
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE;

// IMPORTANT: service role only on server
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================== HELPERS ================== */
const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  },
  body: JSON.stringify(obj),
});

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const sumAmounts = (rows, key) => (rows || []).reduce((s, r) => s + toNumber(r?.[key]), 0);

// دليفري = إجمالي الطلب - ربح الموقع (platform fee)
const calculateOrderEarningsPi = (order) => {
  const snap = order?.pricing_snapshot || {};
  const totalPi = toNumber(snap.total_pi);
  const platformFeePi = toNumber(snap.platform_fee_pi);

  // الأفضل لو snapshot موجود
  if (totalPi > 0) return Math.max(0, totalPi - platformFeePi);

  // fallback تقريبي
  const priceEgp = toNumber(order?.price);
  const deliveryFeeEgp = toNumber(order?.delivery_fee);
  const totalPriceEgp = toNumber(order?.total_price);
  const platformFeeEgp = toNumber(order?.platform_fee);

  const baseEgp = (priceEgp || deliveryFeeEgp)
    ? (priceEgp + deliveryFeeEgp)
    : Math.max(0, totalPriceEgp - platformFeeEgp);

  const piEgp = toNumber(snap.pi_egp);
  if (baseEgp > 0 && piEgp > 0) return baseEgp / piEgp;

  return 0;
};

const safeParse = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};

const isUUIDish = (s) => typeof s === 'string' && s.length >= 8;
const trimStr = (x) => (typeof x === 'string' ? x.trim() : '');

/* ================== HANDLER ================== */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    // ENV required
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    if (!APP_WALLET_SECRET) throw new Error('Missing APP_WALLET_SECRET');
    if (!PI_HORIZON_URL) throw new Error('Missing PI_HORIZON_URL');
    if (!NETWORK_PASSPHRASE) throw new Error('Missing PI_NETWORK_PASSPHRASE');

    const body = safeParse(event.body);

    // requestId لازم يكون string (Netlify log كان بيقول trim is not a function)
    const requestId = trimStr(body.requestId);
    const deliveryId = trimStr(body.deliveryId);
    const username = trimStr(body.username);
    const walletAddress = trimStr(body.walletAddress);

    const resolvedDeliveryId = trimStr(deliveryId || username);
    const withdrawAmount = Number.parseFloat(body.amount);

    if (!isUUIDish(requestId) || !resolvedDeliveryId || !walletAddress || !Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }

    /* ================== 0) Validate request row ================== */
    const { data: reqRow, error: er0 } = await supabase
      .from('withdraw_requests')
      .select('id,delivery_id,amount_pi,wallet_address,status')
      .eq('id', requestId)
      .maybeSingle();

    if (er0) throw er0;
    if (!reqRow) return json(404, { error: 'طلب السحب غير موجود' });

    if (String(reqRow.delivery_id) !== String(resolvedDeliveryId)) {
      return json(403, { error: 'هذا الطلب لا يخص هذا الحساب' });
    }

    if (String(reqRow.status) !== 'pending') {
      return json(400, { error: 'هذا الطلب تم التعامل معه بالفعل' });
    }

    // تأكد من مطابقة القيمة والعنوان للطلب المسجل (حماية)
    const reqAmount = toNumber(reqRow.amount_pi);
    if (reqAmount > 0 && Math.abs(reqAmount - withdrawAmount) > 1e-9) {
      return json(400, { error: 'قيمة السحب لا تطابق الطلب المسجل' });
    }
    const reqWallet = trimStr(reqRow.wallet_address);
    if (reqWallet && reqWallet !== walletAddress) {
      return json(400, { error: 'عنوان المحفظة لا يطابق الطلب المسجل' });
    }

    /* ================== 1) Balance check ================== */
    const { data: orders, error: e1 } = await supabase
      .from('orders')
      .select('pricing_snapshot,status,delivery_id,price,delivery_fee,total_price,platform_fee')
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'delivered');
    if (e1) throw e1;

    // محجوز + مدفوع (approved, paid)
    const { data: reservedReqs, error: e2 } = await supabase
      .from('withdraw_requests')
      .select('amount_pi')
      .eq('delivery_id', resolvedDeliveryId)
      .in('status', ['approved', 'paid']);
    if (e2) throw e2;

    const totalEarned = (orders || []).reduce((sum, row) => sum + calculateOrderEarningsPi(row), 0);
    const reservedSum = sumAmounts(reservedReqs, 'amount_pi');

    // لو wallet table موجود يبقى أدق
    const { data: walletRow, error: eWal } = await supabase
      .from('delivery_wallet')
      .select('balance_pi')
      .eq('delivery_id', resolvedDeliveryId)
      .maybeSingle();
    if (eWal) throw eWal;

    const walletBalance = (walletRow && walletRow.balance_pi !== undefined) ? toNumber(walletRow.balance_pi) : null;

    const currentBalance = walletBalance !== null
      ? Math.max(0, walletBalance - reservedSum)
      : Math.max(0, totalEarned - reservedSum);

    if (currentBalance + 1e-9 < withdrawAmount) {
      return json(400, { error: 'رصيد حسابك غير كافٍ' });
    }

    /* ================== 2) Stellar transfer ================== */
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

    // لو 404 هنا: غالباً PI_HORIZON_URL غلط (زي ما ظهر في اللوج)
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);

    let sourceAccount;
    try {
      sourceAccount = await server.loadAccount(sourceKeys.publicKey());
    } catch (e) {
      // 404 / not found -> horizon url غلط غالباً
      const status = e?.response?.status;
      if (status === 404) {
        // سجّل note للطلب
        await supabase.from('withdraw_requests')
          .update({ note: 'Horizon URL غير صحيح أو الشبكة لا تحتوي على الحساب (404)' })
          .eq('id', requestId)
          .eq('status', 'pending');
        return json(500, { error: 'إعدادات الشبكة غير صحيحة', details: 'Horizon URL returned 404' });
      }
      throw e;
    }

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100000', // كما كنت تستخدم
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7),
        })
      )
      .setTimeout(60)
      .build();

    tx.sign(sourceKeys);

    let result;
    try {
      result = await server.submitTransaction(tx);
    } catch (e) {
      // سجّل note بالسبب
      const msg =
        e?.response?.data?.extras?.result_codes
          ? `Blockchain Error: ${e.response.data.extras.result_codes.transaction} (${(e.response.data.extras.result_codes.operations || []).join(',')})`
          : (e?.message || 'Blockchain submit failed');

      await supabase.from('withdraw_requests')
        .update({ note: msg })
        .eq('id', requestId)
        .eq('status', 'pending');

      // صياغة رسالة مفهومة
      let userError = 'فشلت المعاملة';
      const codes = e?.response?.data?.extras?.result_codes;
      const opCodes = codes?.operations ? codes.operations.join(', ') : '';

      if (codes?.transaction === 'tx_insufficient_fee') userError = 'رسوم الشبكة مرتفعة حالياً، حاول مرة أخرى';
      if (String(opCodes).includes('op_underfunded')) userError = 'محفظة النظام تحتاج شحن رصيد';
      if (String(opCodes).includes('op_no_destination')) userError = 'عنوان المحفظة غير صحيح أو غير مُفعل';

      return json(500, { error: userError, details: msg });
    }

    /* ================== 3) UPDATE request row to paid ================== */
    const { error: e3 } = await supabase
      .from('withdraw_requests')
      .update({
        status: 'paid',
        txid: result.hash,
        note: null,
      })
      .eq('id', requestId)
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'pending'); // حماية ضد double pay

    if (e3) throw e3;

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
    });

  } catch (err) {
    console.error('withdraw error:', err);

    // محاولة استخراج أخطاء Stellar
    let errorResponse = { error: 'فشلت المعاملة', details: err?.message || 'Unknown' };

    if (err?.response?.status === 404) {
      errorResponse.error = 'Horizon URL غير صحيح (404)';
      errorResponse.details = 'راجع PI_HORIZON_URL في Netlify ENV';
      return json(500, errorResponse);
    }

    if (err?.response?.data?.extras?.result_codes) {
      const codes = err.response.data.extras.result_codes;
      const opCodes = codes.operations ? codes.operations.join(', ') : 'no_op_code';

      errorResponse.details = `Blockchain Error: ${codes.transaction} (${opCodes})`;

      if (codes.transaction === 'tx_insufficient_fee') {
        errorResponse.error = 'رسوم الشبكة مرتفعة حالياً، حاول مرة أخرى';
      }
      if (String(opCodes).includes('op_underfunded')) {
        errorResponse.error = 'محفظة النظام تحتاج شحن رصيد';
      }
      if (String(opCodes).includes('op_no_destination')) {
        errorResponse.error = 'عنوان المحفظة غير صحيح أو غير مُفعل';
      }
    }

    return json(500, errorResponse);
  }
};
