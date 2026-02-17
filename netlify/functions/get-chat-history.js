const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    const { username } = event.queryStringParameters;

    if (!username) {
        return { statusCode: 400, body: JSON.stringify({ error: "Missing username" }) };
    }

    try {
        // جلب الرسائل (الصور والنصوص) مرتبة من الأقدم للأحدث
        const { data, error } = await supabase
            .from('user_images')
            .select('*')
            .eq('pi_username', username)
            .order('created_at', { ascending: true }) // ترتيب زمني
            .limit(50); // آخر 50 رسالة فقط لتجنب البطء

        if (error) throw error;

        return {
            statusCode: 200,
            body: JSON.stringify(data)
        };

    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
