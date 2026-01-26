
// netlify/functions/withdraw.js
'use strict';

const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ================== CONFIG ================== */
// ملاحظة هامة: تم إزالة القيم النصية (Hardcoded) لمنع أخطاء الأمان في Netlify
// يجب التأكد من إضافة هذه المتغيرات في لوحة تحكم Netlify: Site Settings > Environment Variables

const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// App wallet (TESTNET secret)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// Pi TESTNET Horizon & Passphrase
const PI_HORIZON_URL = process.env.PI_HORIZON_URL;
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE;
const PI_PLATFORM_API_URL = process.env.PI_PLATFORM_API_URL || 'https://api.minepi.com/v2/me';

// Server-side Supabase client (service role)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================== HELPERS ================== */
const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  },
  body: JSON.stringify(obj),
});

const safeParse = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const isValidStellarAddress = (address) => /^G[A-Z2-7]{55}$/.test(address);

const calcDeliveryEarningsPi = (order) => {
  const snap = order?.pricing_snapshot || {};
  const totalPi = toNum(snap.total_pi);
  const platformFeePi = toNum(snap.platform_fee_pi);

  if (totalPi > 0) return Math.max(0, totalPi - platformFeePi);

  const priceEgp = toNum(order?.price);
  const deliveryFeeEgp = toNum(order?.delivery_fee);
  const totalPriceEgp = toNum(order?.total_price);
  const platformFeeEgp = toNum(order?.platform_fee);

  const baseEgp = (priceEgp || deliveryFeeEgp)
    ? (priceEgp + deliveryFeeEgp)
    : Math.max(0, totalPriceEgp - platformFeeEgp);

  const piEgp = toNum(snap.pi_egp);
  if (baseEgp > 0 && piEgp > 0) return baseEgp / piEgp;

  return 0;
};

const getAuthToken = (event) => {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.replace('Bearer ', '').trim();
};

const resolveIdentity = async (token) => {
  if (!token) return { error: 'Missing auth token' };

  if (PI_PLATFORM_API_URL) {
    try {
      const resp = await fetch(PI_PLATFORM_API_URL, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        const uid = data?.uid || data?.user?.uid || data?.user?.id;
        const username = data?.username || data?.user?.username;
        if (uid && username) return { uid: String(uid), username: String(username) };
      }
    } catch (err) {
      console.warn('Pi API verify failed:', err?.message || err);
    }
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data?.user) {
      const uid = data.user.id;
      const username = data.user.user_metadata?.username || data.user.user_metadata?.pi_username;
      if (uid && username) return { uid: String(uid), username: String(username) };
    }
  } catch (err) {
    console.warn('Supabase auth verify failed:', err?.message || err);
  }

  return { error: 'Unauthorized' };
};

const getNetworkFee = async (server) => {
  try {
    const stats = await server.feeStats();
    const raw = Number(stats?.fee_charged?.max || stats?.last_ledger_base_fee);
    if (Number.isFinite(raw) && raw > 0) return String(Math.max(100, Math.floor(raw)));
  } catch (err) {
    console.warn('feeStats failed:', err?.message || err);
  }
  return '100000';
};

/* ================== HANDLER ================== */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });

  // POST only
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    // التحقق من وجود المتغيرات الهامة قبل البدء
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });
    if (!APP_WALLET_SECRET) return json(500, { error: 'Missing APP_WALLET_SECRET' });
    if (!PI_HORIZON_URL) return json(500, { error: 'Missing PI_HORIZON_URL' });
    if (!NETWORK_PASSPHRASE) return json(500, { error: 'Missing PI_NETWORK_PASSPHRASE' });

    const body = safeParse(event.body);
    const token = getAuthToken(event);
    const identity = await resolveIdentity(token);
    if (identity.error) return json(401, { error: 'غير مصرح', details: identity.error });

    const uid = identity.uid;
    const username = identity.username;
    const walletAddress = String(body.walletAddress || '').trim();
    const withdrawAmount = Number.parseFloat(body.amount);

    if (!walletAddress || !Number.isFinite(withdrawAmount)) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }
    if (!isValidStellarAddress(walletAddress)) {
      return json(400, { error: 'عنوان المحفظة غير صحيح' });
    }
    if (withdrawAmount < 0.01) {
      return json(400, { error: 'الحد الأدنى للسحب 0.010000 Pi' });
    }
    if (!uid || !username) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }

    const now = Date.now();
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const oneMinAgo = new Date(now - 60 * 1000).toISOString();

    const { count: rateCount, error: rateErr } = await supabase
      .from('withdrawals')
      .select('id', { count: 'exact', head: true })
      .eq('pi_user_id', uid)
      .gte('created_at', tenMinAgo);

    if (rateErr) throw rateErr;
    if ((rateCount || 0) >= 3) {
      return json(429, { error: 'تم تجاوز الحد الأقصى للسحب، حاول لاحقًا' });
    }

    const { data: dupes, error: dupErr } = await supabase
      .from('withdrawals')
      .select('id')
      .eq('pi_user_id', uid)
      .eq('wallet_address', walletAddress)
      .eq('amount', withdrawAmount)
      .gte('created_at', oneMinAgo)
      .limit(1);

    if (dupErr) throw dupErr;
    if ((dupes || []).length) {
      return json(409, { error: 'طلب مكرر، حاول بعد دقيقة' });
    }

    let walletBalance = null;
    try {
      const { data: walletRow, error: walletErr } = await supabase
        .from('delivery_wallet')
        .select('balance_pi')
        .eq('delivery_id', username)
        .maybeSingle();
      if (!walletErr && walletRow && walletRow.balance_pi !== null) {
        walletBalance = toNum(walletRow.balance_pi);
      }
    } catch (err) {
      console.warn('delivery_wallet lookup failed:', err?.message || err);
    }

    if (walletBalance === null) {
      const { data: orders, error: ordersErr } = await supabase
        .from('orders')
        .select('pricing_snapshot,status,delivery_id,price,delivery_fee,total_price,platform_fee')
        .eq('delivery_id', username)
        .eq('status', 'delivered')
        .limit(2000);

      if (ordersErr) throw ordersErr;
      walletBalance = (orders || []).reduce((sum, order) => sum + calcDeliveryEarningsPi(order), 0);
    }

    const { data: withdrawals, error: e2 } = await supabase
      .from('withdrawals')
      .select('amount,status')
      .eq('pi_user_id', uid)
      .or('status.is.null,status.in.(pending,sent)');

    if (e2) throw e2;

    const totalWithdrawn = (withdrawals || []).reduce((s, r) => s + toNum(r.amount), 0);
    const currentBalance = Math.max(0, walletBalance - totalWithdrawn);

    if (currentBalance + 1e-12 < withdrawAmount) {
      return json(400, { error: 'رصيد حسابك غير كافٍ' });
    }

    const { data: inserted, error: insertErr } = await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      status: 'pending',
    }]).select('id').single();

    if (insertErr) throw insertErr;

    /* ---------- 2) Stellar transfer (Pi Testnet) ---------- */
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);

    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());
    const sourceBalance = toNum(
      sourceAccount.balances?.find((b) => b.asset_type === 'native')?.balance,
    );
    if (sourceBalance < withdrawAmount + 1) {
      await supabase.from('withdrawals')
        .update({ status: 'failed', error_message: 'System wallet insufficient funds' })
        .eq('id', inserted.id);
      return json(400, { error: 'محفظة النظام تحتاج شحن رصيد' });
    }

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: await getNetworkFee(server),
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
      await supabase.from('withdrawals')
        .update({ status: 'sent', txid: result.hash, error_message: null })
        .eq('id', inserted.id);
    } catch (submitErr) {
      await supabase.from('withdrawals')
        .update({ status: 'failed', error_message: submitErr?.message || 'submit_failed' })
        .eq('id', inserted.id);
      throw submitErr;
    }

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
    });

  } catch (err) {
    console.error('withdraw error:', err);

    let errorResponse = { error: 'فشلت المعاملة', details: err?.message || 'Unknown' };

    // Stellar/Horizon structured errors
    if (err?.response?.data?.extras?.result_codes) {
      const codes = err.response.data.extras.result_codes;
      const ops = codes.operations ? codes.operations.join(', ') : 'no_op_code';
      errorResponse.details = `Blockchain Error: ${codes.transaction} (${ops})`;

      if (codes.transaction === 'tx_insufficient_fee') {
        errorResponse.error = 'رسوم الشبكة مرتفعة حالياً، حاول مرة أخرى';
      } else if (String(ops).includes('op_underfunded')) {
        errorResponse.error = 'محفظة النظام تحتاج شحن رصيد';
      } else if (String(ops).includes('op_no_destination')) {
        errorResponse.error = 'عنوان المحفظة غير صحيح أو غير مُفعل';
      }
    }

    // common 404 case = wrong horizon URL
    if (err?.response?.status === 404) {
      errorResponse.error = 'Horizon URL غير صحيح (404)';
      errorResponse.details = `راجع PI_HORIZON_URL: ${PI_HORIZON_URL}`;
    }

    return json(500, errorResponse);
  }
};
