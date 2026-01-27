const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

function clampBalance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}

// ✅ Supabase client مرة واحدة
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(500, { error: 'إعدادات قاعدة البيانات غير متوفرة' });
    }

    const { uid } = JSON.parse(event.body || '{}');
    if (!uid) {
      return json(400, { error: 'بيانات ناقصة', required: ['uid'] });
    }

    // ✅ العمود الصحيح (بدل delivery_pi_user_id)
    const { data: earnings, error: earnErr } = await db
      .from('delivery_earnings')
      .select('amount_pi')
      .eq('delivery_id', uid);

    if (earnErr) return json(500, { error: 'Database error reading earnings', details: earnErr.message });

    const { data: withdrawals, error: wdErr } = await db
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    if (wdErr) return json(500, { error: 'Database error reading withdrawals', details: wdErr.message });

    const totalEarned = (earnings || []).reduce((sum, row) => sum + Number(row.amount_pi || 0), 0);
    const totalWithdrawn = (withdrawals || []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const currentBalance = clampBalance(totalEarned - totalWithdrawn);

    return json(200, { balance: Number(currentBalance.toFixed(7)) });
  } catch (err) {
    console.error('get-balance error:', err);
    return json(500, { error: 'فشل تحميل الرصيد', details: err?.message || 'Unknown error' });
  }
};
