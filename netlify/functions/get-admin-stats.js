const { createClient } = require('@supabase/supabase-js');

// نستخدم السيرفس رول كي لأنه يمتلك صلاحيات كاملة
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// كلمة سر بسيطة لحماية لوحة التحكم (ضعها في Netlify Environment Variables باسم ADMIN_PASSWORD)
// أو يمكنك وضعها هنا مؤقتاً (غير مستحسن للإنتاج الفعلي لكنه يعمل)
const ADMIN_SECRET = process.env.ADMIN_PASSWORD || "MySuperSecretPass123";

exports.handler = async (event) => {
    // السماح فقط بطلبات POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { password } = JSON.parse(event.body);

        // 1. التحقق من كلمة المرور
        if (password !== ADMIN_SECRET) {
            return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
        }

        // 2. جلب كافة المستخدمين وبياناتهم المالية
        // نختار الحقول المهمة فقط لتقليل حجم البيانات
        const { data: users, error } = await supabase
            .from('users')
            .select('username, token_balance, total_usd_spent, total_pi_spent, created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;

        // 3. حساب الإجماليات في الباك إند (أسرع وأكثر أماناً)
        let totalUSD = 0;
        let totalPi = 0;

        users.forEach(u => {
            totalUSD += (u.total_usd_spent || 0);
            totalPi += (u.total_pi_spent || 0);
        });

        // 4. إرسال البيانات جاهزة
        return {
            statusCode: 200,
            body: JSON.stringify({
                users: users,
                stats: {
                    totalUSD,
                    totalPi,
                    totalUsers: users.length
                }
            })
        };

    } catch (error) {
        console.error("Admin API Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
