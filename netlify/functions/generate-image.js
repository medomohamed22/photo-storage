// netlify/functions/generate-image.js
// هذا الكود يستخدم نموذج Flux القوي والمجاني كبديل لـ Google Imagen
// لضمان عمل الموقع فوراً دون مشاكل الصلاحيات

const fetch = require('node-fetch'); // Netlify يوفر هذا تلقائياً في البيئة

exports.handler = async function(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const body = JSON.parse(event.body);
        const userPrompt = body.prompt;

        if (!userPrompt) {
            return { statusCode: 400, body: JSON.stringify({ error: "الرجاء إدخال وصف للصورة" }) };
        }

        console.log("Generating image for:", userPrompt);

        // استخدام Pollinations API (موديل Flux)
        // نقوم بإنشاء رقم عشوائي (Seed) لضمان اختلاف الصورة في كل مرة
        const seed = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(userPrompt);
        
        // رابط توليد الصورة
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&model=flux&nologo=true`;

        // نقوم بجلب الصورة وتحويلها لـ Base64 لكي تتوافق مع كود الفرونت إند السابق
        const imageResponse = await fetch(imageUrl);
        
        if (!imageResponse.ok) {
             throw new Error("فشل في جلب الصورة من المصدر");
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');

        // إرسال الصورة للفرونت إند
        return {
            statusCode: 200,
            body: JSON.stringify({ image: base64Image })
        };

    } catch (error) {
        console.error("Server Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "حدث خطأ أثناء توليد الصورة، حاول مرة أخرى." })
        };
    }
};
