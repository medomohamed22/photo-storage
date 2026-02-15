const { createClient } = require('@supabase/supabase-js');
// تأكد من أن node-fetch موجود في package.json
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    // التحقق من طريقة الطلب
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        // 1. استقبال البيانات الجديدة من الفرونت إند
        // (model, width, height) تمت إضافتهم
        const { prompt, username, model, width, height } = JSON.parse(event.body);

        // التحقق من البيانات الأساسية
        if (!prompt || !username) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing prompt or username" }) };
        }

        // 2. إعداد المتغيرات (مع قيم افتراضية للأمان)
        const safeModel = model || 'flux'; // الافتراضي flux
        const safeWidth = width || 1024;   // الافتراضي 1024
        const safeHeight = height || 1024; // الافتراضي 1024
        const seed = Math.floor(Math.random() * 1000000); // بذرة عشوائية لتغيير النتيجة كل مرة

        // قراءة مفتاح API (اختياري)
        const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || ""; 

        // 3. بناء الرابط باستخدام المتغيرات المستلمة من الفرونت إند
        let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${safeModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
        
        // إضافة المفتاح للرابط فقط إذا كان موجوداً
        if (POLLINATIONS_KEY) {
            targetUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;
        }

        console.log(`Generating image for ${username} using model: ${safeModel} (${safeWidth}x${safeHeight})`);

        // 4. جلب الصورة من Pollinations
        const imageRes = await fetch(targetUrl);
        if (!imageRes.ok) throw new Error(`Pollinations API Error: ${imageRes.statusText}`);
        
        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 5. رفع الصورة إلى Supabase Storage
        // نستخدم اسم ملف فريد
        const fileName = `${username}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase
            .storage
            .from('nano_images')
            .upload(fileName, buffer, { contentType: 'image/jpeg' });

        if (uploadError) throw uploadError;

        // الحصول على الرابط العام
        const { data: publicUrlData } = supabase
            .storage
            .from('nano_images')
            .getPublicUrl(fileName);

        // 6. حفظ السجل في قاعدة البيانات
        const { data: dbData, error: dbError } = await supabase
            .from('user_images')
            .insert([{ 
                pi_username: username,
                prompt: prompt,
                image_url: publicUrlData.publicUrl
                // ملاحظة: إذا أردت حفظ الأبعاد والموديل في القاعدة مستقبلاً، يجب إضافة أعمدة لهم في الجدول أولاً
            }])
            .select();

        if (dbError) throw dbError;

        // 7. الرد على الفرونت إند
        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                success: true, 
                imageUrl: publicUrlData.publicUrl, 
                imageId: dbData[0].id 
            })
        };

    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
