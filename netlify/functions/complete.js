const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  
  // نستقبل بيانات الدفع + معرف المستخدم لزيادة رصيده
  const { paymentId, txid, pi_uid, tokenAmount } = JSON.parse(event.body);
  
  if (!paymentId || !txid || !pi_uid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing payment data' }) };
  }
  
  const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
  const PI_API_BASE = 'https://api.minepi.com/v2';
  
  try {
    // 1. إبلاغ شبكة Pi باكتمال الدفع
    const response = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid }),
    });
    
    if (response.ok) {
      const data = await response.json();
      
      // 2. زيادة رصيد المستخدم في Supabase
      // نستخدم RPC أو استعلام مباشر. هنا سنستخدم استعلام مباشر للتبسيط
      // نجلب الرصيد الحالي أولاً (أو ننشئ المستخدم لو مش موجود)
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('token_balance')
        .eq('pi_uid', pi_uid)
        .single();

      let newBalance = parseInt(tokenAmount || 0);
      
      if (user) {
        newBalance += (user.token_balance || 0);
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);
      } else {
        // مستخدم جديد
        await supabase.from('users').insert({ pi_uid: pi_uid, token_balance: newBalance });
      }

      return { statusCode: 200, body: JSON.stringify({ completed: true, newBalance, data }) };
    } else {
      const error = await response.json();
      return { statusCode: response.status, body: JSON.stringify({ error }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
