const { createClient } = require('@supabase/supabase-js');

// ⚠️ هام: لا نستخدم require('node-fetch') هنا لتجنب مشاكل "Absolute URL"
// Netlify Functions (Node 18+) تدعم fetch تلقائياً

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// إعدادات التكلفة
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
            return { statusCode: 400, body: JSON.stringify({ error: "بيانات ناقصة" }) };
        }

        const selectedModel = model ? model.trim() : 'imagen-4';
        
        // 1. تحديد نوع العملية (شات أم صور)
        // أي موديل يحتوي على openai أو gpt أو تم إرسال messages معه يعتبر شات
        const isChat = selectedModel.includes('openai') || selectedModel.includes('gpt-5') || (messages && messages.length > 0);
        const cost = MODEL_COSTS[selectedModel] || 5;

        // 2. التحقق من الرصيد
        const { data: userCheck, error: checkError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (checkError || !userCheck) {
            return { statusCode: 403, body: JSON.stringify({ error: 'User Check Failed' }) };
        }

        if (userCheck.token_balance < cost) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', currentBalance: userCheck.token_balance }) 
            };
        }

        // متغيرات لتخزين النتائج
        let botReply = null;
        let finalImageUrl = null;

        // 3. التنفيذ
        if (isChat) {
            // ====================== مسار الشات (تعديل حسب طلبك) ======================
            console.log("Processing Chat Request:", selectedModel);

            // تجهيز الرسائل
            let finalMessages = messages || [];
            
            // إضافة System Message لتنسيق الكود إذا لم تكن موجودة
            const systemMsg = { role: "system", content: "You are a helpful assistant. Use Markdown for code." };
            if (finalMessages.length === 0 || finalMessages[0].role !== 'system') {
                finalMessages.unshift(systemMsg);
            }
            // إذا لم تصل رسائل، نضع البرومبت كرسالة مستخدم
            if (finalMessages.length === 1 && prompt) {
                finalMessages.push({ role: "user", content: prompt });
            }

            // استدعاء API الشات (نفس الكود الذي أرسلته لي)
            const chatResponse = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json"
                    // "Authorization": `Bearer ${API_KEY}` // أضف المفتاح هنا إذا كان لديك، وإلا اتركه
                },
                body: JSON.stringify({ 
                    model: selectedModel, 
                    messages: finalMessages 
                })
            });

            if (!chatResponse.ok) {
                const errTxt = await chatResponse.text();
                throw new Error(`Chat API Error: ${chatResponse.status} - ${errTxt}`);
            }

            const chatData = await chatResponse.json();
            botReply = chatData.choices[0].message.content; // استخراج النص

        } else {
            // ====================== مسار الصور ======================
            console.log("Processing Image Request:", selectedModel);

            const safeWidth = width || 1024;
            const safeHeight = height || 1024;
            const seed = Math.floor(Math.random() * 1000000);
            
            // بناء رابط الصورة
            const imageUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;

            const imageRes = await fetch(imageUrl);
            
            if (!imageRes.ok) throw new Error(`Image Gen Failed: ${imageRes.status}`);
            
            const arrayBuffer = await imageRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // رفع الصورة لـ Supabase
            uploadedFileName = `${username}_${Date.now()}.jpg`;
            const { error: uploadError } = await supabase.storage.from('nano_images').upload(uploadedFileName, buffer, { contentType: 'image/jpeg' });
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(uploadedFileName);
            finalImageUrl = publicUrlData.publicUrl;
        }

        // 4. خصم الرصيد (بعد النجاح)
        const { data: userFinal } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
        if (!userFinal || userFinal.token_balance < cost) throw new Error("INSUFFICIENT_TOKENS_LATE");
        
        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        // 5. حفظ البيانات في الجدول والرد
        if (isChat) {
            // حفظ الشات
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                bot_response: botReply, // العمود الجديد للنص
                type: 'text' 
            }]);

            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    success: true, 
                    reply: botReply, // نرد بالنص
                    newBalance: newBalance, 
                    type: 'text' 
                })
            };
        } else {
            // حفظ الصورة
            await supabase.from('user_images').insert([{ 
                pi_username: username, 
                prompt: prompt, 
                image_url: finalImageUrl, // العمود القديم للصورة
                type: 'image' 
            }]);

            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    success: true, 
                    imageUrl: finalImageUrl, // نرد برابط الصورة
                    newBalance: newBalance, 
                    type: 'image' 
                })
            };
        }

    } catch (error) {
        console.error("Handler Error:", error);
        
        // تنظيف (إذا فشل رفع الصورة نمسحها)
        if (uploadedFileName) await supabase.storage.from('nano_images').remove([uploadedFileName]);
        
        if (error.message === "INSUFFICIENT_TOKENS_LATE") {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) };
        }
        
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
