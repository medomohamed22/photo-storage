const { createClient } = require('@supabase/supabase-js');

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

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function clampBalance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

function deliveryPayoutFromSnapshot(snapshot) {
  const s = snapshot || {};
  const total = toNum(s.total_pi);
  const platform = toNum(s.platform_fee_pi);

  if (total > 0) {
    const payout = total - platform;
    return payout > 0 ? payout : 0;
  }

  const price = toNum(s.price_pi);
  const deliveryFee = toNum(s.delivery_fee_pi);
  if (price > 0 || deliveryFee > 0) return Math.max(0, price + deliveryFee);

  return Math.max(0, deliveryFee);
}

function getDb() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    throw new Error(`Missing env: ${missing.join(', ')}`);
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

async function getWithdrawnSum(db, uid) {
  const { data, error } = await db
    .from('withdrawals')
    .select('amount')
    .eq('pi_user_id', uid)
    .limit(5000);

  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, r) => sum + toNum(r.amount), 0);
}

async function getEarnedSum(db, uid) {
  // 1) delivery_wallet
  const walletRes = await db
    .from('delivery_wallet')
    .select('balance_pi')
    .eq('delivery_id', uid)
    .maybeSingle();

  if (!walletRes.error && walletRes.data && walletRes.data.balance_pi !== null) {
    return toNum(walletRes.data.balance_pi);
  }

  // 2) delivery_earnings
  const earnRes = await db
    .from('delivery_earnings')
    .select('amount_pi')
    .eq('delivery_id', uid)
    .limit(5000);

  if (!earnRes.error && earnRes.data && earnRes.data.length) {
    return (earnRes.data || []).reduce((sum, r) => sum + toNum(r.amount_pi), 0);
  }

  // 3) fallback orders snapshot
  const ordersRes = await db
    .from('orders')
    .select('pricing_snapshot')
    .eq('delivery_id', uid)
    .eq('status', 'delivered')
    .limit(5000);

  if (ordersRes.error) throw new Error(ordersRes.error.message);

  return (ordersRes.data || []).reduce((sum, o) => {
    return sum + deliveryPayoutFromSnapshot(o?.pricing_snapshot);
  }, 0);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const db = getDb();

    const { uid } = JSON.parse(event.body || '{}');
    if (!uid) return json(400, { error: 'بيانات ناقصة', required: ['uid'] });

    const earned = await getEarnedSum(db, uid);
    const withdrawn = await getWithdrawnSum(db, uid);
    const balance = clampBalance(earned - withdrawn);

    return json(200, {
      balance: Number(balance.toFixed(7)),
      earned: Number(earned.toFixed(7)),
      withdrawn: Number(withdrawn.toFixed(7)),
    });
  } catch (err) {
    console.error('get-balance error:', err);
    return json(500, { error: 'فشل تحميل الرصيد', details: err?.message || 'Unknown error' });
  }
};
