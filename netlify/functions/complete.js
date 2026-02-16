const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  
  // نستقبل بيانات الدفع + بيانات المبلغ (دولار وباي) لتخزينها
  // usdAmount: قيمة الباقة بالدولار (1, 5, 10)
  // pAmount: المبلغ الذي دفعه المستخدم بعملة باي
  const { paymentId, txid, pi_uid, tokenAmount, usdAmount, pAmount } = JSON.parse(event.body);
  
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
      
      // 2. تحديث بيانات المستخدم في Supabase (رصيد + إحصائيات)
      
      // جلب البيانات الحالية للمستخدم
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('token_balance, total_usd_spent, total_pi_spent')
        .eq('pi_uid', pi_uid)
        .single();

      // تحويل القيم لأرقام لضمان الجمع الصحيح
      const tokensToAdd = parseInt(tokenAmount || 0);
      const usdToAdd = parseFloat(usdAmount || 0);
      const piToAdd = parseFloat(pAmount || 0);

      if (user) {
        // تحديث مستخدم موجود: نجمع الجديد على القديم
        const newBalance = (user.token_balance || 0) + tokensToAdd;
        const newTotalUsd = (user.total_usd_spent || 0) + usdToAdd;
        const newTotalPi = (user.total_pi_spent || 0) + piToAdd;

        await supabase.from('users').update({ 
            token_balance: newBalance,
            total_usd_spent: newTotalUsd,
            total_pi_spent: newTotalPi
        }).eq('pi_uid', pi_uid);

        return { statusCode: 200, body: JSON.stringify({ completed: true, newBalance, data }) };

      } else {
        // مستخدم جديد: ننشئ سجل جديد بالقيم الحالية
        await supabase.from('users').insert({ 
            pi_uid: pi_uid, 
            token_balance: tokensToAdd,
            total_usd_spent: usdToAdd,
            total_pi_spent: piToAdd
        });

        return { statusCode: 200, body: JSON.stringify({ completed: true, newBalance: tokensToAdd, data }) };
      }

    } else {
      const error = await response.json();
      return { statusCode: response.status, body: JSON.stringify({ error }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
