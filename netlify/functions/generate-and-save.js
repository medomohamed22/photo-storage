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

// دالة انتظار (Sleep)
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
        
        // كشف نوع العملية: شات أم صورة
        // ⚠️ هام: نستثني gptimage من كونه شات
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
            
            // 🟢 نظام إعادة المحاولة للشات (Fix 429)
            // سيحاول 3 مرات في حال وجود ضغط
            let chatRes;
            let success = false;
            
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    chatRes = await fetch(chatUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ model: selectedModel, messages: finalMessages })
                    });

                    // إذا نجح الطلب (200 OK) نخرج من الحلقة
                    if (chatRes.ok) {
                        success = true;
                        break;
                    }

                    // إذا كان الخطأ 429 (Too Many Requests) أو 5xx (Server Error)
                    if (chatRes.status === 429 || chatRes.status >= 500) {
                        console.log(`Chat Attempt ${attempt} failed: ${chatRes.status}. Retrying...`);
                        // انتظار تصاعدي: 1.5 ثانية، ثم 3 ثواني
                        if (attempt < 3) await sleep(1500 * attempt);
                        continue;
                    }
                    
                    // أخطاء أخرى لا تستحق المحاولة
                    break; 

                } catch (err) {
                    console.log(`Chat Network Error Attempt ${attempt}: ${err.message}`);
                    if (attempt < 3) await sleep(1500);
                }
            }

            if (!success || !chatRes || !chatRes.ok) {
                const status = chatRes ? chatRes.status : "Unknown";
                throw new Error(`Chat API Failed after retries: ${status}`);
            }

            const data = await chatRes.json();
            botReply = data.choices?.[0]?.message?.content || "No response content";

        } else {
            console.log("Starting Image (Long Wait):", selectedModel);

            const safeWidth = width || 1024;
            const safeHeight = height || 1024;
            const seed = Math.floor(Math.random() * 1000000);
            
            let imgUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
            if (POLLINATIONS_KEY) imgUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

            // محاولة واحدة طويلة للصور (28 ثانية) لتجنب انقطاع الاتصال
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 28000); 

            try {
                const imgRes = await fetch(imgUrl, { signal: controller.signal });
                clearTimeout(timeoutId);

                if (!imgRes.ok) {
                    const errTxt = await imgRes.text();
                    throw new Error(`Image Gen Failed: ${imgRes.status}`);
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

            } catch (err) {
                if (err.name === 'AbortError') throw new Error("Image Timeout (Server Busy)");
                throw err;
            }
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

        try { await supabase.from('user_images').insert([dbPayload]); } catch (dbErr) { console.error("DB Insert Warning:", dbErr); }

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
        
        const errMsg = error.message || "Server Error";
        // إذا كان الخطأ 429، نرسله للفرونت ليتم التعامل معه
        if (errMsg.includes("429")) {
            return json(429, { error: "High Traffic, Please wait..." });
        }
        
        return json(500, { error: errMsg });
    }
};
