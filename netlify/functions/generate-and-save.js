const { createClient } = require('@supabase/supabase-js');

// ⚠️ هام: قمنا بحذف سطر require('node-fetch') لاستخدام الـ fetch الأصلي
// هذا يحل مشكلة Only absolute URLs في بيئات Node الحديثة

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// أسعار الموديلات
const MODEL_COSTS = {
    // صور
    'imagen-4': 1,
    'klein': 2,
    'klein-large': 4,
    'gptimage': 5,
    // شات
    'openai-large': 3,
    'openai-fast': 1,
    'openai': 1
};

exports.handler = async (event) => {
    // السماح فقط بطلبات POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let uploadedFileName = null;

    try {
        const body = JSON.parse(event.body);
        let { prompt, username, pi_uid, model, width, height, messages } = body;

        // تنظيف البيانات
        if (!prompt || !username || !pi_uid) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
        }
        
        // التأكد من أن اسم الموديل نظيف
        const selectedModel = model ? model.trim() : 'imagen-4';
        
        // 🛠️ إصلاح التعرف على الشات: أي موديل يحتوي على openai أو gpt يعتبر شات
        // هذا يضمن عدم دخول موديلات الشات في مسار الصور بالخطأ
        const isChat = selectedModel.includes('openai') || selectedModel.includes('gpt-5') || (messages && messages.length > 0);

        // تحديد التكلفة
        const cost = MODEL_COSTS[selectedModel] || 5;

        // 1. التحقق من الرصيد
        const { data: userCheck, error: checkError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (checkError || !userCheck) {
            return { statusCode: 403, body: JSON.stringify({ error: 'User check failed', details: checkError }) };
        }

        if (userCheck.token_balance < cost) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', currentBalance: userCheck.token_balance }) 
            };
        }

        let botReply = null;
        let finalImageUrl = null;

        // 2. التنفيذ (شات أو صورة)
        if (isChat) {
            // ====================== مسار الشات ======================
            console.log("Processing Chat Request for model:", selectedModel);

            const systemMessage = {
                role: "system",
                content: "You are a helpful AI assistant. Always format code using Markdown code blocks (```language). Use bold text for emphasis."
            };
            
            let finalMessages = messages || [];
            if (finalMessages.length === 0) {
                finalMessages.push({ role: "user", content: prompt });
            }
            if (finalMessages.length > 0 && finalMessages[0].role !== 'system') {
                finalMessages.unshift(systemMessage);
            }

            const chatUrl = '[https://gen.pollinations.ai/v1/chat/completions](https://gen.pollinations.ai/v1/chat/completions)';
            
            const chatRes = await fetch(chatUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: selectedModel, // سيتم إرسال openai-large أو غيره
                    messages: finalMessages
                })
            });

            if (!chatRes.ok) throw new Error(`Chat API Error: ${chatRes.statusText}`);
            
            const chatData = await chatRes.json();
            botReply = chatData.choices[0].message.content;

        } else {
            // ====================== مسار الصور ======================
            console.log("Processing Image Request for model:", selectedModel);

            const safeWidth = width || 1024;
            const safeHeight = height || 1024;
            const seed = Math.floor(Math.random() * 1000000);
            
            // بناء الرابط بشكل آمن
            let targetUrl = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`);
            targetUrl.searchParams.append('model', selectedModel);
            targetUrl.searchParams.append('width', safeWidth);
            targetUrl.searchParams.append('height', safeHeight);
            targetUrl.searchParams.append('seed', seed);
            targetUrl.searchParams.append('nologo', 'true');

            // طباعة الرابط للتأكد منه في اللوج
            console.log("Fetching Image URL:", targetUrl.toString());

            const imageRes = await fetch(targetUrl.toString());
            
            if (!imageRes.ok) {
                const errText = await imageRes.text();
                throw new Error(`Image Gen Failed: ${imageRes.status} - ${errText}`);
            }
            
            const arrayBuffer = await imageRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // رفع الصورة
            uploadedFileName = `${username}_${Date.now()}.jpg`;
            const { error: uploadError } = await supabase.storage.from('nano_images').upload(uploadedFileName, buffer, { contentType: 'image/jpeg' });
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(uploadedFileName);
            finalImageUrl = publicUrlData.publicUrl;
        }

        // 3. خصم الرصيد
        const { data: userFinal } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
        if (!userFinal || userFinal.token_balance < cost) {
            throw new Error("INSUFFICIENT_TOKENS_LATE");
        }
        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        // 4. حفظ البيانات والرد
        if (isChat) {
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                bot_response: botReply, 
                type: 'text' 
            }]);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, reply: botReply, newBalance, type: 'text' })
            };
        } else {
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                image_url: finalImageUrl, 
                type: 'image' 
            }]);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, imageUrl: finalImageUrl, newBalance, type: 'image' })
            };
        }

    } catch (error) {
        console.error("Handler Error:", error);
        
        // تنظيف الملفات التالفة
        if (uploadedFileName) await supabase.storage.from('nano_images').remove([uploadedFileName]);
        
        if (error.message === "INSUFFICIENT_TOKENS_LATE") {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) };
        }
        
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
