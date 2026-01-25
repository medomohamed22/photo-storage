// netlify/functions/withdraw.js
const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ================== CONFIG ================== */
const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

const PI_HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE || 'Pi Network';

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
  
  // لو snapshot موجود (أفضل)
  if (totalPi > 0) return Math.max(0, totalPi - platformFeePi);
  
  // fallback لو snapshot ناقص (حساب تقريبي)
  const priceEgp = toNumber(order?.price);
  const deliveryFeeEgp = toNumber(order?.delivery_fee);
  const totalPriceEgp = toNumber(order?.total_price);
  const platformFeeEgp = toNumber(order?.platform_fee);
  
  const baseEgp = (priceEgp || deliveryFeeEgp) ?
    (priceEgp + deliveryFeeEgp) :
    Math.max(0, totalPriceEgp - platformFeeEgp);
  
  const piEgp = toNumber(snap.pi_egp);
  if (baseEgp > 0 && piEgp > 0) return baseEgp / piEgp;
  
  return 0;
};

/* ================== HANDLER ================== */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  
  try {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    if (!APP_WALLET_SECRET) throw new Error('Missing APP_WALLET_SECRET');
    
    const body = JSON.parse(event.body || '{}');
    
    // لازم تبعت requestId من الفرونت
    const requestId = body.requestId;
    const deliveryId = body.deliveryId;
    const username = body.username;
    const amount = body.amount;
    const walletAddress = (body.walletAddress || '').trim();
    
    const resolvedDeliveryId = (deliveryId || username || '').trim();
    const withdrawAmount = Number.parseFloat(amount);
    
    if (!requestId || !resolvedDeliveryId || !walletAddress || !Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }
    
    // 0) تأكد أن الطلب موجود ومعلّق pending (علشان منع الدفع مرتين)
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
    
    if (reqRow.status !== 'pending') {
      return json(400, { error: 'هذا الطلب تم التعامل معه بالفعل' });
    }
    
    // لو حابب: اتأكد إن القيمة اللي جاية مطابقة للطلب المسجل (عشان أمان أكتر)
    const reqAmount = toNumber(reqRow.amount_pi);
    if (reqAmount > 0 && Math.abs(reqAmount - withdrawAmount) > 1e-9) {
      return json(400, { error: 'قيمة السحب لا تطابق الطلب المسجل' });
    }
    const reqWallet = (reqRow.wallet_address || '').trim();
    if (reqWallet && reqWallet !== walletAddress) {
      return json(400, { error: 'عنوان المحفظة لا يطابق الطلب المسجل' });
    }
    
    // 1) تحقق رصيد من الطلبات المسلّمة + خصم المحجوز (approved) والمدفوع (paid)
    const { data: orders, error: e1 } = await supabase
      .from('orders')
      .select('pricing_snapshot,status,delivery_id,price,delivery_fee,total_price,platform_fee')
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'delivered');
    if (e1) throw e1;
    
    const { data: reservedReqs, error: e2 } = await supabase
      .from('withdraw_requests')
      .select('amount_pi')
      .eq('delivery_id', resolvedDeliveryId)
      .in('status', ['approved', 'paid']);
    if (e2) throw e2;
    
    const totalEarned = (orders || []).reduce((sum, row) => sum + calculateOrderEarningsPi(row), 0);
    const reservedSum = sumAmounts(reservedReqs, 'amount_pi'); // محجوز + مدفوع
    
    // لو عندك wallet table فده أدق
    const { data: walletRow, error: eWal } = await supabase
      .from('delivery_wallet')
      .select('balance_pi')
      .eq('delivery_id', resolvedDeliveryId)
      .maybeSingle();
    if (eWal) throw eWal;
    
    const walletBalance = walletRow?.balance_pi !== undefined ? toNumber(walletRow.balance_pi) : null;
    
    const currentBalance = walletBalance !== null ?
      Math.max(0, walletBalance - reservedSum) :
      Math.max(0, totalEarned - reservedSum);
    
    if (currentBalance + 1e-9 < withdrawAmount) {
      return json(400, { error: 'رصيد حسابك غير كافٍ' });
    }
    
    // 2) تحويل Stellar (Pi)
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());
    
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: '100000', // 0.01 Pi (حسب اللي كنت حاطه)
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
    
    // 3) UPDATE لنفس الطلب -> paid + txid (بدون INSERT جديد)
    const { error: e3 } = await supabase
      .from('withdraw_requests')
      .update({
        status: 'paid',
        txid: result.hash,
        note: null,
      })
      .eq('id', requestId)
      .eq('delivery_id', resolvedDeliveryId)
      .eq('status', 'pending'); // حماية إضافية ضد double-pay
    
    if (e3) throw e3;
    
    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
    });
    
  } catch (err) {
    console.error('withdraw error:', err);
    
    let errorResponse = { error: 'فشلت المعاملة', details: err?.message || 'Unknown' };
    
    // أخطاء Horizon / Stellar
    if (err.response?.data?.extras?.result_codes) {
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
        errorResponse.error = 'عنوان المحفظة غير صحيح أو غير مفعل';
      }
    }
    
    return json(500, errorResponse);
  }
};
