// netlify/functions/withdraw.js
const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ================== CONFIG ================== */
const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// Mainnet افتراضي
const PI_HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE || 'Pi Network';

// service role server only
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

const sumAmounts = (rows, key) =>
  (rows || []).reduce((s, r) => s + toNumber(r?.[key]), 0);

/* دليفري = إجمالي الطلب - ربح الموقع */
const calculateOrderEarningsPi = (order) => {
  const snap = order?.pricing_snapshot || {};

  const totalPi = toNumber(snap.total_pi);
  const platformFeePi = toNumber(snap.platform_fee_pi);

  if (totalPi > 0) return Math.max(0, totalPi - platformFeePi);

  // fallback بالجنيه
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

/* ================== HANDLER ================== */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    if (!APP_WALLET_SECRET) throw new Error('Missing APP_WALLET_SECRET');

    const body = JSON.parse(event.body || '{}');

    const requestId = body.requestId; // 👈 لازم ييجي من الفرونت
    const deliveryId = (body.deliveryId || body.username || '').trim();
    const walletAddress = (body.walletAddress || '').trim();
    const withdrawAmount = Number.parseFloat(body.amount);

    if (!requestId || !deliveryId || !walletAddress || !Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }

    /* ================== 0) تحقق من الطلب ================== */
    const { data: reqRow, error: er0 } = await supabase
      .from('withdraw_requests')
      .select('id,delivery_id,amount_pi,wallet_address,status')
      .eq('id', requestId)
      .maybeSingle();

    if (er0) throw er0;
    if (!reqRow) return json(404, { error: 'طلب السحب غير موجود' });

    if (String(reqRow.delivery_id) !== String(deliveryId)) {
      return json(403, { error: 'هذا الطلب لا يخص هذا الحساب' });
    }

    if (reqRow.status !== 'pending') {
      return json(400, { error: 'تم التعامل مع هذا الطلب بالفعل' });
    }

    if (Math.abs(toNumber(reqRow.amount_pi) - withdrawAmount) > 1e-9) {
      return json(400, { error: 'قيمة السحب لا تطابق الطلب المسجل' });
    }

    if ((reqRow.wallet_address || '').trim() !== walletAddress) {
      return json(400, { error: 'عنوان المحفظة لا يطابق الطلب المسجل' });
    }

    /* ================== 1) تحقق الرصيد ================== */
    const { data: orders, error: e1 } = await supabase
      .from('orders')
      .select('pricing_snapshot,status,delivery_id,price,delivery_fee,total_price,platform_fee')
      .eq('delivery_id', deliveryId)
      .eq('status', 'delivered');
    if (e1) throw e1;

    const { data: reservedReqs, error: e2 } = await supabase
      .from('withdraw_requests')
      .select('amount_pi')
      .eq('delivery_id', deliveryId)
      .in('status', ['approved', 'paid']);
    if (e2) throw e2;

    const totalEarned = (orders || []).reduce(
      (sum, row) => sum + calculateOrderEarningsPi(row),
      0
    );

    const reservedSum = sumAmounts(reservedReqs, 'amount_pi');

    const { data: walletRow, error: eWal } = await supabase
      .from('delivery_wallet')
      .select('balance_pi')
      .eq('delivery_id', deliveryId)
      .maybeSingle();
    if (eWal) throw eWal;

    const walletBalance =
      walletRow?.balance_pi !== undefined ? toNumber(walletRow.balance_pi) : null;

    const currentBalance =
      walletBalance !== null
        ? Math.max(0, walletBalance - reservedSum)
        : Math.max(0, totalEarned - reservedSum);

    if (currentBalance + 1e-9 < withdrawAmount) {
      return json(400, { error: 'رصيد حسابك غير كافٍ' });
    }

    /* ================== 2) إرسال Pi ================== */
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100000', // 0.01 Pi
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

    /* ================== 3) UPDATE الطلب ================== */
    const { error: e3 } = await supabase
      .from('withdraw_requests')
      .update({
        status: 'paid',
        txid: result.hash,
        note: null,
      })
      .eq('id', requestId)
      .eq('delivery_id', deliveryId)
      .eq('status', 'pending'); // حماية ضد double-pay

    if (e3) throw e3;

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
    });

  } catch (err) {
    console.error('withdraw error:', err);

    let errorResponse = {
      error: 'فشلت المعاملة',
      details: err?.message || 'Unknown',
    };

    if (err.response?.data?.extras?.result_codes) {
      const codes = err.response.data.extras.result_codes;
      const opCodes = codes.operations ? codes.operations.join(', ') : 'no_op_code';

      errorResponse.details = `Blockchain Error: ${codes.transaction} (${opCodes})`;

      if (codes.transaction === 'tx_insufficient_fee') {
        errorResponse.error = 'رسوم الشبكة مرتفعة حالياً';
      }
      if (String(opCodes).includes('op_underfunded')) {
        errorResponse.error = 'محفظة النظام تحتاج شحن رصيد';
      }
      if (String(opCodes).includes('op_no_destination')) {
        errorResponse.error = 'عنوان المحفظة غير صحيح أو غير مفعل';
      }
    }

    return json(500, errorResponse);
  }
};
