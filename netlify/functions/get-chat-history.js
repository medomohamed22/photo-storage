const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  const { username } = (event.queryStringParameters || {});

  if (!username) {
    return {
      statusCode: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: "Missing username" }),
    };
  }

  try {
    // ✅ جلب آخر 50 رسالة (الأحدث أولاً) ثم نعكسهم ليرجعوا من الأقدم للأحدث
    const { data, error } = await supabase
      .from('user_images')
      .select('*')
      .eq('pi_username', username)
      .order('created_at', { ascending: false }) // الأحدث أولاً للحصول على "آخر 50"
      .limit(50);

    if (error) throw error;

    const result = Array.isArray(data) ? data.reverse() : [];

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(result),
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: error.message }),
    };
  }
};
