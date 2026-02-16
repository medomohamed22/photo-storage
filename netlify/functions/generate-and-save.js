const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 1. تحديث قائمة الأسعار حسب طلبك
const MODEL_COSTS = {
    // صور
    'imagen-4': 1,      
    'klein': 2,         
    'klein-large': 4,   
    'gptimage': 5,
    // فيديو
    'grok-video': 6,    // سعر الفيديو
    // شات
    'openai': 1,        // شات ضعيف (GPT-5 Mini)
    'openai-large': 3   // شات قوي (GPT-5.2)
};

// تحديد نوع الموديل
const getModelType = (modelId) => {
    if (modelId.includes('video')) return 'video';
    if (modelId.includes('openai')) return 'chat';
    return 'image';
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

        const selectedModel = model || 'imagen-4';
        const modelType = getModelType(selectedModel);
        const cost = MODEL_COSTS[selectedModel] || 5; 

        // 2. التحقق من الرصيد
        const { data: userCheck, error: checkError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (checkError || !userCheck || userCheck.token_balance < cost) {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', required: cost }) };
        }

        let resultData = {};

        // 3. التنفيذ حسب نوع الموديل
        if (modelType === 'chat') {
            // --- معالجة الشات ---
            const chatRes = await fetch('https://text.pollinations.ai/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [{ role: 'user', content: prompt }],
                    model: selectedModel
                })
            });
            
            if (!chatRes.ok) throw new Error("Chat API Error");
            const chatText = await chatRes.text(); // Pollinations text returns raw string often
            resultData = { type: 'text', content: chatText };

        } else {
            // --- معالجة الصور والفيديو ---
            const seed = Math.floor(Math.random() * 1000000);
            let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&seed=${seed}&nologo=true`;
            
            // إضافة أبعاد للصورة فقط
            if (modelType === 'image') {
                targetUrl += `&width=${width || 1024}&height=${height || 1024}`;
            }

            const mediaRes = await fetch(targetUrl);
            if (!mediaRes.ok) throw new Error(`Generation Failed: ${mediaRes.statusText}`);
            
            const arrayBuffer = await mediaRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // رفع الملف (صورة أو فيديو)
            const ext = modelType === 'video' ? 'mp4' : 'jpg';
            const contentType = modelType === 'video' ? 'video/mp4' : 'image/jpeg';
            
            uploadedFileName = `${username}_${Date.now()}.${ext}`;
            
            const { error: uploadError } = await supabase.storage
                .from('nano_images') // تأكد أن السلة تدعم ملفات الفيديو أيضاً أو أنشئ سلة جديدة
                .upload(uploadedFileName, buffer, { contentType: contentType });
                
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(uploadedFileName);
            
            resultData = { type: modelType, url: publicUrlData.publicUrl };
            
            // حفظ في السجل
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                image_url: publicUrlData.publicUrl, // نستخدم نفس العمود حتى للفيديو
                media_type: modelType // يفضل إضافة عمود جديد لنوع الميديا في المستقبل
            }]);
        }

        // 4. خصم الرصيد
        const { data: userFinal } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
        if (!userFinal || userFinal.token_balance < cost) throw new Error("INSUFFICIENT_TOKENS_LATE");

        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, result: resultData, newBalance: newBalance })
        };

    } catch (error) {
        console.error("Handler Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
