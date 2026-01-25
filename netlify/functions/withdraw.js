// netlify/functions/withdraw.js
const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ================== CONFIG ================== */
const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// مثال: https://api.mainnet.minepi.com  (الكود هيجرب كمان /horizon تلقائيًا)
const PI_HORIZON_URL = process.env.PI_HORIZON_URL || 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE || 'Pi Testnet';

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

function normalizeUrl(u) {
  let url = String(u || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, ''); // remove trailing slashes
  return url;
}

/**
 * نجرب Horizon URL بطريقتين:
 * 1) كما هو
 * 2) + "/horizon" (لو مش موجودة)
 * ونختار أول واحد ينجح في server.root()
 */
async function getWorkingHorizonServer(baseUrl) {
  const url = normalizeUrl(baseUrl);
  if (!url) throw new Error('PI_HORIZON_URL is empty');
  
  const candidates = [];
  candidates.push(url);
  
  // لو مش منتهي بـ /horizon جرّبه
  if (!/\/horizon$/i.test(url)) candidates.push(url + '/horizon');
  
  let lastErr = null;
  for (const c of candidates) {
    try {
      const server = new StellarSdk.Horizon.Server(c);
      // root() لو فشل غالبًا URL غلط
      await server.root();
      return { server, horizonBase: c };
    } catch (e) {
      lastErr = e;
    }
  }
  
  // لو فشل الاتنين
  const detail = lastErr?.response?.detail || lastErr?.message || 'Unknown';
  throw new Error(`Horizon URL not reachable. Tried: ${candidates.join(' , ')} | ${detail}`);
}

/* ================== HANDLER ================== */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  
  try {
    if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    if (!APP_WALLET_SECRET) throw new Error('Missing APP_WALLET_SECRET');
    
    let body = {};
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Body JSON غير صالح' });
    }
    
    // ✅ FIX: trim is not a function
    const requestId = String(body.requestId ?? '').trim();
    const deliveryId = String(body.deliveryId ?? '').trim();
    const username = String(body.username ?? '').trim();
    const walletAddress = String(body.walletAddress ?? '').trim();
    
    const resolvedDeliveryId = (deliveryId || username || '').trim();
    const withdrawAmount = Number.parseFloat(body.amount);
    
    if (!requestId || !resolvedDeliveryId || !walletAddress || !Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }
    
    // 0) تأكد أن الطلب موجود ومعلّق pending (منع الدفع مرتين)
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
    
    // تأكد المبلغ والعنوان مطابقين للطلب المسجل (أمان)
    const reqAmount = toNumber(reqRow.amount_pi);
    if (reqAmount > 0 && Math.abs(reqAmount - withdrawAmount) > 1e-9) {
      return json(400, { error: 'قيمة السحب لا تطابق الطلب المسجل' });
    }
    const reqWallet = String(reqRow.wallet_address || '').trim();
    if (reqWallet && reqWallet !== walletAddress) {
      return json(400, { error: 'عنوان المحفظة لا يطابق الطلب المسجل' });
    }
    
    // 1) تحقق رصيد من الطلبات المسلّمة + خصم المحجوز/المدفوع
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
      .in('status', ['approved', 'paid']); // pending مش محسوب هنا لأن ده الطلب الحالي نفسه pending
    if (e2) throw e2;
    
    const totalEarned = (orders || []).reduce((sum, row) => sum + calculateOrderEarningsPi(row), 0);
    const reservedSum = sumAmounts(reservedReqs, 'amount_pi');
    
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
    
    // 2) تحويل Stellar (Pi) + إصلاح 404 عبر اكتشاف Horizon الصحيح
    const { server, horizonBase } = await getWorkingHorizonServer(PI_HORIZON_URL);
    
    if (!APP_WALLET_SECRET) throw new Error('APP_WALLET_SECRET missing');
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    
    let sourceAccount;
    try {
      sourceAccount = await server.loadAccount(sourceKeys.publicKey());
    } catch (e) {
      // لو الـ root شغال بس loadAccount 404 => غالبًا الحساب مش مُفعّل/مش موجود على الشبكة
      if (e?.response?.status === 404) {
        return json(500, {
          error: 'محفظة النظام غير مفعلة على الشبكة',
          details: `Account not found on Horizon (${horizonBase}). لازم تفعّل/تموّل الحساب اللي جاي من APP_WALLET_SECRET على نفس الشبكة.`,
        });
      }
      throw e;
    }
    
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: '100000', // زي ما كنت عامل
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
    
    let result;
    try {
      result = await server.submitTransaction(tx);
    } catch (err) {
      // أخطاء Horizon / Stellar
      let errorResponse = { error: 'فشلت المعاملة', details: err?.message || 'Unknown' };
      
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
      .eq('status', 'pending'); // حماية ضد double-pay
    if (e3) throw e3;
    
    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
      horizon: horizonBase,
    });
    
  } catch (err) {
    console.error('withdraw error:', err);
    
    // لو URL غلط أو مش قابل للوصول
    const msg = err?.message || 'Unknown';
    
    return json(500, {
      error: 'فشل تنفيذ السحب',
      details: msg,
    });
  }
};
