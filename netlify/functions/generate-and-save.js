const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); 

// إعداد الاتصال بقاعدة البيانات
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// تعريف تكلفة الموديلات
const MODEL_COSTS = {
    'imagen-4': 1,      // Nano Banana
    'gptimage': 3,      // Chat GPT
    'klein': 2,         // Flux Klein 4B
    'klein-large': 2    // Flux Klein 9B
};

exports.handler = async (event) => {
    // التحقق من طريقة الطلب
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    // متغيرات سنحتاجها للتنظيف في حالة الفشل
    let uploadedFileName = null;

    try {
        // 1. استقبال البيانات
        const { prompt, username, pi_uid, model, width, height } = JSON.parse(event.body);

        if (!prompt || !username || !pi_uid) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
        }

        // تحديد التكلفة
        const selectedModel = model || 'imagen-4';
        const cost = MODEL_COSTS[selectedModel] !== undefined ? MODEL_COSTS[selectedModel] : 2;

        // =========================================================
        // خطوة 1: التحقق المبدئي من الرصيد (بدون خصم)
        // =========================================================
        const { data: userCheck, error: checkError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (checkError || !userCheck) {
            // لو المستخدم مش موجود أو في خطأ، نعتبر الرصيد 0
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', currentBalance: 0 }) };
        }

        if (userCheck.token_balance < cost) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ 
                    error: 'INSUFFICIENT_TOKENS', 
                    currentBalance: userCheck.token_balance 
                }) 
            };
        }

        // =========================================================
        // خطوة 2: توليد الصورة (المرحلة الخطرة التي قد تفشل)
        // =========================================================
        const safeWidth = width || 1024;
        const safeHeight = height || 1024;
        const seed = Math.floor(Math.random() * 1000000);
        const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || ""; 

        let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
        if (POLLINATIONS_KEY) targetUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

        console.log(`Generating for ${username}...`);
        
        const imageRes = await fetch(targetUrl);
        if (!imageRes.ok) {
            throw new Error(`Generation Failed: ${imageRes.statusText}`);
        }
        
        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // =========================================================
        // خطوة 3: رفع الصورة للسيرفر
        // =========================================================
        uploadedFileName = `${username}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase
            .storage
            .from('nano_images')
            .upload(uploadedFileName, buffer, { contentType: 'image/jpeg' });

        if (uploadError) throw uploadError;

        // الحصول على الرابط
        const { data: publicUrlData } = supabase.storage.from('nano_images').getPublicUrl(uploadedFileName);
        const finalImageUrl = publicUrlData.publicUrl;

        // =========================================================
        // خطوة 4: الخصم النهائي (Transaction-like)
        // =========================================================
        // الآن وقد نجحت الصورة، نحاول خصم الرصيد
        // نعيد التحقق والخصم في أمر واحد لضمان عدم حدوث تلاعب
        
        // 1. جلب المستخدم مرة أخرى للتأكد من الرصيد لحظة الخصم
        const { data: userFinal, error: finalCheckError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (finalCheckError || userFinal.token_balance < cost) {
            // كارثة: الرصيد نفذ أثناء توليد الصورة (مثلاً فتح تبويبين)
            // الحل: نحذف الصورة التي رفعناها ونلغي العملية
            throw new Error("INSUFFICIENT_TOKENS_LATE"); 
        }

        // 2. تنفيذ الخصم
        const newBalance = userFinal.token_balance - cost;
        const { error: updateError } = await supabase
            .from('users')
            .update({ token_balance: newBalance })
            .eq('pi_uid', pi_uid);

        if (updateError) throw updateError;

        // 3. حفظ سجل الصورة في الجدول (لأن الخصم تم بنجاح)
        await supabase
            .from('user_images')
            .insert([{ 
                pi_username: username,
                prompt: prompt,
                image_url: finalImageUrl
            }]);

        // =========================================================
        // خطوة 5: الرد بالنجاح
        // =========================================================
        return {
            statusCode: 200,
            body: JSON.stringify({ 
                success: true, 
                imageUrl: finalImageUrl, 
                newBalance: newBalance 
            })
        };

    } catch (error) {
        console.error("Handler Error:", error);

        // تنظيف: إذا تم رفع صورة ولكن حدث خطأ لاحقاً (مثلاً فشل الخصم)
        // نقوم بحذف الصورة لكي لا تأخذ مساحة دون فائدة
        if (uploadedFileName) {
            await supabase.storage.from('nano_images').remove([uploadedFileName]);
            console.log("Cleaned up orphaned file:", uploadedFileName);
        }

        // تحديد نوع الخطأ للفرونت إند
        if (error.message === "INSUFFICIENT_TOKENS_LATE") {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) 
            };
        }

        return { statusCode: 500, body: JSON.stringify({ error: error.message || "Internal Error" }) };
    }
};
