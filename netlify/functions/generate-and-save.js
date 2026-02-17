const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// أسعار الموديلات (بالتوكين) بناءً على تكلفة التشغيل
const MODEL_COSTS = {
    // موديلات الصور
    'imagen-4': 1,      // Nano Banana (الأرخص والأسرع)
    'klein': 2,         // Flux 4B (جودة متوسطة)
    'klein-large': 4,   // Flux 9B (جودة عالية)
    'gptimage': 5,      // Chat GPT (الأغلى والأذكى)
    
    // موديلات الشات
    'openai-large': 3,  // GPT-5.2 Large
    'openai-fast': 1,   // GPT-5 Nano
    'openai': 1         // GPT-5 Mini
};

// تحديد الموديلات الخاصة بالشات لتسهيل الفرز
const CHAT_MODELS = ['openai-large', 'openai-fast', 'openai'];

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let uploadedFileName = null;

    try {
        const body = JSON.parse(event.body);
        // استقبلنا messages من الفرونت إند عشان الهيستوري بتاع الشات
        const { prompt, username, pi_uid, model, width, height, messages } = body;

        if (!prompt || !username || !pi_uid) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
        }

        // تحديد الموديل والتكلفة ونوع العملية
        const selectedModel = model || 'imagen-4';
        const cost = MODEL_COSTS[selectedModel] || 5; // الافتراضي 5 للأمان
        const isChat = CHAT_MODELS.includes(selectedModel);

        // 1. التحقق من الرصيد المبدئي
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

        let botReply = null;
        let finalImageUrl = null;

        // 2. التنفيذ بناءً على نوع العملية (شات أو صورة)
        if (isChat) {
            // ==========================================
            // مسار الشات (Chat Logic)
            // ==========================================
            const systemMessage = {
                role: "system",
                content: "You are a helpful AI assistant. Always format code using Markdown code blocks (```language). Use bold text for emphasis."
            };
            
            let finalMessages = messages || [];
            if (finalMessages.length === 0) {
                finalMessages.push({ role: "user", content: prompt });
            }
            // التأكد من وضع الـ system message في البداية
            if (finalMessages.length > 0 && finalMessages[0].role !== 'system') {
                finalMessages.unshift(systemMessage);
            }

            const chatRes = await fetch('[https://gen.pollinations.ai/v1/chat/completions](https://gen.pollinations.ai/v1/chat/completions)', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: selectedModel,
                    messages: finalMessages
                })
            });

            if (!chatRes.ok) throw new Error(`Chat Generation Failed: ${chatRes.statusText}`);
            
            const chatData = await chatRes.json();
            botReply = chatData.choices[0].message.content;

        } else {
            // ==========================================
            // مسار الصور (Image Logic)
            // ==========================================
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

            // رفع الصورة لـ Supabase Storage
            uploadedFileName = `${username}_${Date.now()}.jpg`;
            const { error: uploadError } = await supabase.storage.from('nano_images').upload(uploadedFileName, buffer, { contentType: 'image/jpeg' });
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(uploadedFileName);
            finalImageUrl = publicUrlData.publicUrl;
        }

        // 3. خصم الرصيد (التحقق المتأخر قبل الخصم)
        const { data: userFinal } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
        
        if (!userFinal || userFinal.token_balance < cost) {
            throw new Error("INSUFFICIENT_TOKENS_LATE");
        }

        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        // 4. حفظ السجل في قاعدة البيانات (حسب النوع) وإرسال الرد للفرونت إند
        if (isChat) {
            // حفظ الشات
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                bot_response: botReply, 
                type: 'text' 
            }]);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, reply: botReply, newBalance: newBalance, type: 'text' })
            };
        } else {
            // حفظ الصورة
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                image_url: finalImageUrl, 
                type: 'image' 
            }]);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, imageUrl: finalImageUrl, newBalance: newBalance, type: 'image' })
            };
        }

    } catch (error) {
        console.error("Handler Error:", error);
        
        // مسح الصورة من Storage لو حصل خطأ بعد الرفع (تنظيف)
        if (uploadedFileName) {
            await supabase.storage.from('nano_images').remove([uploadedFileName]);
        }
        
        if (error.message === "INSUFFICIENT_TOKENS_LATE") {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) };
        }
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
