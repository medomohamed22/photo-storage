const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const username = (event.queryStringParameters || {}).username;

  if (!username) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: "Missing username" })
    };
  }

  const { data, error } = await supabase
    .from('user_images')
    .select('id, image_url, created_at, type')
    .eq('pi_username', username)        // الفلترة باسم المستخدم
    .eq('type', 'image')               // ✅ صور فقط
    .not('image_url', 'is', null)      // ✅ استبعاد null
    .neq('image_url', '')              // ✅ استبعاد الفاضي
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({ error: error.message })
    };
  }

  // تنسيق البيانات للواجهة: صور فقط
  const images = (Array.isArray(data) ? data : []).map((row) => ({
    id: row.id,
    url: row.image_url
  }));

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(images)
  };
};
