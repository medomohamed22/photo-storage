const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'إعدادات قاعدة البيانات غير متوفرة' }) };
    }

    const { uid } = JSON.parse(event.body || '{}');
    if (!uid) {
      return { statusCode: 400, body: JSON.stringify({ error: 'بيانات ناقصة' }) };
    }

    const { data: earnings } = await supabase
      .from('delivery_earnings')
      .select('amount')
      .eq('delivery_pi_user_id', uid);
    const { data: withdrawals } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    const totalEarned = earnings ? earnings.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0) : 0;
    const totalWithdrawn = withdrawals ? withdrawals.reduce((sum, row) => sum + parseFloat(row.amount || 0), 0) : 0;
    const currentBalance = totalEarned - totalWithdrawn;

    return {
      statusCode: 200,
      body: JSON.stringify({ balance: currentBalance })
    };
  } catch (err) {
    console.error('get-balance error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'فشل تحميل الرصيد' }) };
  }
};
