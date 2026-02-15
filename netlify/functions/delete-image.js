const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    const { id, username } = JSON.parse(event.body);

    // الحذف بشرط تطابق المعرف واسم المستخدم (للأمان)
    const { error } = await supabase
        .from('user_images')
        .delete()
        .match({ id: id, pi_username: username });

    if (error) return { statusCode: 500, body: JSON.stringify(error) };

    return { statusCode: 200, body: JSON.stringify({ success: true }) };
};
