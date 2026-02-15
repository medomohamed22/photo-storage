const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    const pi_uid = event.queryStringParameters.uid;
    if (!pi_uid) return { statusCode: 400, body: 'Missing UID' };

    const { data, error } = await supabase
        .from('users')
        .select('token_balance')
        .eq('pi_uid', pi_uid)
        .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found
        return { statusCode: 500, body: JSON.stringify(error) };
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ balance: data ? data.token_balance : 0 })
    };
};
