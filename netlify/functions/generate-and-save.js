const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// أسعار الموديلات (بالتوكين) بناءً على تكلفة التشغيل
const MODEL_COSTS = {
    'imagen-4': 1,      // Nano Banana (الأرخص والأسرع)
    'klein': 2,         // Flux 4B (جودة متوسطة)
    'klein-large': 4,   // Flux 9B (جودة عالية)
    'gptimage': 5       // Chat GPT (الأغلى والأذكى)
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let uploadedFileName = null;

    try {
        const { prompt, username, pi_uid, model, width, height } = JSON.parse(event.body);

        if (!prompt || !username || !pi_uid) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
        }

        // تحديد التكلفة بناءً على الموديل
        const selectedModel = model || 'imagen-4';
        const cost = MODEL_COSTS[selectedModel] || 5; // الافتراضي 5 للأمان

        // 1. التحقق من الرصيد
        const { data: userCheck, error: checkError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (checkError || !userCheck) {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', currentBalance: 0 }) };
        }

        if (userCheck.token_balance < cost) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ 
                    error: 'INSUFFICIENT_TOKENS', 
                    required: cost,
                    currentBalance: userCheck.token_balance 
                }) 
            };
        }

        // 2. توليد الصورة
        const safeWidth = width || 1024;
        const safeHeight = height || 1024;
        const seed = Math.floor(Math.random() * 1000000);
        const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || ""; 

        let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
        if (POLLINATIONS_KEY) targetUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

        const imageRes = await fetch(targetUrl);
        if (!imageRes.ok) throw new Error(`Generation Failed: ${imageRes.statusText}`);
        
        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 3. رفع الصورة
        uploadedFileName = `${username}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage.from('nano_images').upload(uploadedFileName, buffer, { contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(uploadedFileName);
        const finalImageUrl = publicUrlData.publicUrl;

        // 4. خصم الرصيد (بعد النجاح)
        // نعيد التحقق لحظة الخصم
        const { data: userFinal } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
        
        if (!userFinal || userFinal.token_balance < cost) {
            throw new Error("INSUFFICIENT_TOKENS_LATE");
        }

        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        // 5. حفظ السجل
        await supabase.from('user_images').insert([{ pi_username: username, prompt: prompt, image_url: finalImageUrl }]);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, imageUrl: finalImageUrl, newBalance: newBalance })
        };

    } catch (error) {
        console.error("Handler Error:", error);
        if (uploadedFileName) await supabase.storage.from('nano_images').remove([uploadedFileName]);
        
        if (error.message === "INSUFFICIENT_TOKENS_LATE") {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
