const fetch = require('node-fetch');

exports.handler = async function(event, context) {
    // 1. استلام البيانات من الواجهة الأمامية
    const { prompt, model, width, height, seed } = event.queryStringParameters;
    
    // 2. جلب المفتاح السري من متغيرات البيئة في Netlify
    const API_KEY = process.env.POLLINATIONS_API_KEY;

    if (!prompt) {
        return { statusCode: 400, body: "Missing prompt" };
    }

    // 3. تجهيز رابط الـ API الخارجي
    // ملاحظة: نقوم بعمل encodeURIComponent للنص لضمان عدم تكسر الرابط
    const targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${model}&width=${width}&height=${height}&seed=${seed}&nologo=true&key=${API_KEY}`;

    try {
        // 4. طلب الصورة من المصدر
        const response = await fetch(targetUrl);

        if (!response.ok) {
            return { statusCode: response.status, body: response.statusText };
        }

        // 5. تحويل الصورة إلى صيغة يمكن إرسالها (Base64)
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');

        // 6. إرجاع الصورة للواجهة الأمامية
        return {
            statusCode: 200,
            headers: {
                "Content-Type": "image/jpeg", // أو نوع الصورة المناسب
            },
            body: base64Image,
            isBase64Encoded: true
        };

    } catch (error) {
        return { statusCode: 500, body: error.message };
    }
};
