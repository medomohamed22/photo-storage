const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'إعدادات قاعدة البيانات غير متوفرة' }) };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { uid } = JSON.parse(event.body || '{}');
    if (!uid) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
    }

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ balance: currentBalance })
    };
  } catch (err) {
    console.error('get-balance error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'فشل تحميل الرصيد' }) };
  }
};
