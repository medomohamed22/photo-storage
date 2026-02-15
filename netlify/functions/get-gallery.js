const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    const username = event.queryStringParameters.username;
    
    if (!username) return { statusCode: 400, body: 'Missing username' };

    const { data, error } = await supabase
        .from('user_images')
        .select('*')
        .eq('pi_username', username) // الفلترة باسم المستخدم
        .order('created_at', { ascending: false });

    if (error) return { statusCode: 500, body: JSON.stringify(error) };

    // تنسيق البيانات للواجهة
    const images = data.map(row => ({
        id: row.id,
        url: row.image_url
    }));

    return {
        statusCode: 200,
        body: JSON.stringify(images)
    };
};
