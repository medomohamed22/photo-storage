const { createClient } = require('@supabase/supabase-js');
// في Netlify Functions الحديثة قد تحتاج لاستخدام import أو التأكد من أن node-fetch مثبت
// إذا ظهر خطأ، استخدم: npm install node-fetch
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { prompt, username } = JSON.parse(event.body);

        // 1. قراءة مفتاح الـ API من متغيرات Netlify
        // تأكد أن الاسم في Netlify هو نفسه المكتوب هنا تماماً
        const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || ""; 

        // إعدادات الصورة
        const model = "flux";
        const width = 1024;
        const height = 1024;
        const seed = Math.floor(Math.random() * 1000000);

        // 2. بناء الرابط مع إضافة المفتاح إذا كان موجوداً
        let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${model}&width=${width}&height=${height}&seed=${seed}&nologo=true`;
        
        // إضافة المفتاح للرابط فقط إذا كان موجوداً في الـ Environment Variables
        if (POLLINATIONS_KEY) {
            targetUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;
        }

        // جلب الصورة
        const imageRes = await fetch(targetUrl);
        if (!imageRes.ok) throw new Error(`Pollinations API Error: ${imageRes.statusText}`);
        
        const arrayBuffer = await imageRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // رفع الصورة لـ Supabase
        const fileName = `${username}_${Date.now()}.jpg`;
        const { error: uploadError } = await supabase
            .storage
            .from('nano_images')
            .upload(fileName, buffer, { contentType: 'image/jpeg' });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase
            .storage
            .from('nano_images')
            .getPublicUrl(fileName);

        // حفظ البيانات في الجدول
        const { data: dbData, error: dbError } = await supabase
            .from('user_images')
            .insert([{ 
                pi_username: username,
                prompt: prompt,
                image_url: publicUrlData.publicUrl
            }])
            .select();

        if (dbError) throw dbError;

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, imageUrl: publicUrlData.publicUrl, imageId: dbData[0].id })
        };

    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
