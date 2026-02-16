const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  
  // استقبال البيانات بما فيها username
  const { paymentId, txid, pi_uid, username, tokenAmount, usdAmount, pAmount } = JSON.parse(event.body);
  
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
      
      // 2. التعامل مع قاعدة البيانات
      
      // جلب بيانات المستخدم الحالية (للحساب التراكمي)
      const { data: user } = await supabase
        .from('users')
        .select('token_balance, total_usd_spent, total_pi_spent')
        .eq('pi_uid', pi_uid)
        .single();

      const tokensToAdd = parseInt(tokenAmount || 0);
      const usdToAdd = parseFloat(usdAmount || 0);
      const piToAdd = parseFloat(pAmount || 0);

      let newBalance = tokensToAdd;
      let newTotalUsd = usdToAdd;
      let newTotalPi = piToAdd;

      if (user) {
        // مستخدم قديم: نجمع الجديد على القديم
        newBalance += (user.token_balance || 0);
        newTotalUsd += (user.total_usd_spent || 0);
        newTotalPi += (user.total_pi_spent || 0);

        // تحديث البيانات
        await supabase.from('users').update({ 
            username: username, // تحديث الاسم لو تغير
            token_balance: newBalance,
            total_usd_spent: newTotalUsd,
            total_pi_spent: newTotalPi
        }).eq('pi_uid', pi_uid);

      } else {
        // مستخدم جديد: إنشاء سجل
        await supabase.from('users').insert({ 
            pi_uid: pi_uid, 
            username: username, // تسجيل الاسم لأول مرة
            token_balance: newBalance,
            total_usd_spent: newTotalUsd,
            total_pi_spent: newTotalPi
        });
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
