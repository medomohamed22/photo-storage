const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MODEL_COSTS = {
    'imagen-4': 1, 'klein': 2, 'klein-large': 4, 'gptimage': 5,
    'openai-large': 3, 'openai-fast': 1, 'openai': 1
};

const json = (statusCode, data) => ({
    statusCode,
    headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
    },
    body: JSON.stringify(data)
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') return json(204, { ok: true });
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    let uploadedFileName = null;

    try {
        const body = JSON.parse(event.body || "{}");
        let { prompt, username, pi_uid, model, width, height, messages } = body;

        if ((!prompt && (!messages || messages.length === 0)) || !username || !pi_uid) {
            return json(400, { error: "بيانات ناقصة" });
        }

        const selectedModel = model ? model.trim() : 'imagen-4';
        
        // 🛠️ الإصلاح هنا: استثناء gptimage من الشات
        // نتأكد أن الموديل ليس gptimage حتى لو أرسل الفرونت رسائل (messages)
        const isChat = (
            (selectedModel.includes('openai') || 
            (selectedModel.includes('gpt') && !selectedModel.includes('gptimage'))) || 
            (messages && messages.length > 0 && selectedModel !== 'gptimage')
        );

        const cost = MODEL_COSTS[selectedModel] || 5;
        const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || "";

        // 1. التحقق من الرصيد
        const { data: user, error: userErr } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (userErr || !user) return json(403, { error: 'User Check Failed' });
        if (user.token_balance < cost) return json(403, { error: 'INSUFFICIENT_TOKENS' });

        let botReply = null;
        let finalImageUrl = null;

        // 2. التنفيذ
        if (isChat) {
            console.log("Starting Chat:", selectedModel);
            
            let finalMessages = messages || [];
            if (finalMessages.length === 0) finalMessages.push({ role: "user", content: prompt });
            if (!finalMessages.some(m => m.role === 'system')) {
                finalMessages.unshift({ role: "system", content: "You are a helpful assistant. Use Markdown." });
            }

            const chatUrl = `https://gen.pollinations.ai/v1/chat/completions?key=${encodeURIComponent(POLLINATIONS_KEY)}`;
            
            const res = await fetch(chatUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: selectedModel, messages: finalMessages })
            });

            if (!res.ok) throw new Error(`Chat API Error: ${res.status}`);
            const data = await res.json();
            botReply = data.choices?.[0]?.message?.content || "";

        } else {
            console.log("Starting Image:", selectedModel);

            const safeWidth = width || 1024;
            const safeHeight = height || 1024;
            const seed = Math.floor(Math.random() * 1000000);
            
            let imgUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
            if (POLLINATIONS_KEY) imgUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

            // 🔄 نظام Retry (المحسّن للوقت القصير)
            let imgRes;
            
            // نحاول مرتين فقط، كل مرة 12 ثانية كحد أقصى لتفادي خطأ 30 ثانية
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 12000); 

                    console.log(`Image Attempt ${attempt} (${selectedModel})...`);
                    imgRes = await fetch(imgUrl, { signal: controller.signal });
                    clearTimeout(timeoutId);

                    if (imgRes.ok) break; 
                    
                    if ([500, 502, 503, 504].includes(imgRes.status)) {
                        console.log(`Server Error ${imgRes.status}, retrying...`);
                        if (attempt < 2) await sleep(1000);
                        continue;
                    }
                    throw new Error(`Image Gen Failed: ${imgRes.status}`);

                } catch (err) {
                    console.log(`Attempt ${attempt} failed: ${err.message}`);
                    if (attempt === 2) throw new Error("Image Generation Timed Out or Failed");
                    await sleep(1000);
                }
            }

            const buffer = Buffer.from(await imgRes.arrayBuffer());
            uploadedFileName = `${username}_${Date.now()}.jpg`;
            
            const { error: uploadError } = await supabase.storage
                .from('nano_images')
                .upload(uploadedFileName, buffer, { contentType: 'image/jpeg' });

            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from('nano_images')
                .getPublicUrl(uploadedFileName);
            
            finalImageUrl = publicUrlData.publicUrl;
        }

        // 3. خصم الرصيد
        const { data: userFinal } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
        if (!userFinal || userFinal.token_balance < cost) throw new Error("INSUFFICIENT_TOKENS_LATE");
        
        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        // 4. حفظ السجل
        const dbPayload = {
            pi_uid,
            pi_username: username,
            prompt: prompt || (messages && messages.length > 0 ? messages[messages.length-1].content : "No Prompt"),
            type: isChat ? 'text' : 'image',
            bot_response: botReply,
            image_url: finalImageUrl
        };

        try { await supabase.from('user_images').insert([dbPayload]); } catch (dbErr) { console.error("DB Insert Error:", dbErr); }

        return json(200, {
            success: true,
            newBalance,
            reply: botReply,
            imageUrl: finalImageUrl,
            type: isChat ? 'text' : 'image'
        });

    } catch (error) {
        console.error("Handler Error:", error);
        if (uploadedFileName) await supabase.storage.from('nano_images').remove([uploadedFileName]);
        return json(500, { error: error.message || "Server Error" });
    }
};
