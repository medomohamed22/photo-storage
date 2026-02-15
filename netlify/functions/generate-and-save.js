const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// تعريف تكلفة الموديلات (في الباك إند للأمان)
const MODEL_COSTS = {
    'imagen-4': 1,      // Nano Banana
    'gptimage': 3,      // Chat GPT
    'klein': 2,         // Flux Klein 4B
    'klein-large': 2    // Flux Klein 9B
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { prompt, username, pi_uid, model, width, height } = JSON.parse(event.body);

        if (!prompt || !username || !pi_uid) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
        }

        // 1. تحديد التكلفة
        // إذا الموديل غير موجود في القائمة، نعتبر التكلفة 2 احتياطياً
        const selectedModel = model || 'imagen-4';
        const cost = MODEL_COSTS[selectedModel] !== undefined ? MODEL_COSTS[selectedModel] : 2;

        // 2. التحقق من رصيد المستخدم من قاعدة البيانات
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (userError && userError.code !== 'PGRST116') {
            throw new Error("Database error checking balance");
        }

        // الرصيد الحالي (0 إذا لم يكن المستخدم موجوداً)
        const currentBalance = user ? user.token_balance : 0;

        // 3. التحقق من كفاية الرصيد
        if (currentBalance < cost) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ 
                    error: 'INSUFFICIENT_TOKENS', 
                    currentBalance 
                }) 
            };
        }

        // 4. خصم الرصيد (قبل التوليد لضمان الحق)
        const newBalance = currentBalance - cost;
        const { error: updateError } = await supabase
            .from('users')
            .update({ token_balance: newBalance })
            .eq('pi_uid', pi_uid);

        if (updateError) throw updateError;

        // 5. البدء في التوليد (بعد الخصم الناجح)
        const safeWidth = width || 1024;
        const safeHeight = height || 1024;
        const seed = Math.floor(Math.random() * 1000000);
        const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || ""; 

        let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
        if (POLLINATIONS_KEY) targetUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

        const imageRes = await fetch(targetUrl);
        if (!imageRes.ok) {
            // (اختياري: يمكن هنا إعادة الرصيد إذا فشل التوليد، لكن للتبسيط نتركه مخصوماً أو نعمل Refund logic)
            throw new Error(`Generation API Error: ${imageRes.statusText}`);
        }
        
        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // رفع الصورة
        const fileName = `${username}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage.from('nano_images').upload(fileName, buffer, { contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(fileName);

        // حفظ السجل
        await supabase.from('user_images').insert([{ pi_username: username, prompt: prompt, image_url: publicUrlData.publicUrl }]);

        // إرجاع النتيجة مع الرصيد الجديد لتحديث الواجهة
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                imageUrl: publicUrlData.publicUrl, 
                newBalance: newBalance 
            })
        };

    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
