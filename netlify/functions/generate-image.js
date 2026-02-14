

// netlify/functions/generate-image.js

export async function handler(event, context) {
    // السماح فقط بطلبات POST
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const body = JSON.parse(event.body);
        const userPrompt = body.prompt;
        
        // جلب المفتاح من إعدادات Netlify الآمنة
        const API_KEY = process.env.POLLINATIONS_API_KEY;

        if (!userPrompt) {
            return { statusCode: 400, body: JSON.stringify({ error: "الرجاء إدخال وصف للصورة" }) };
        }

        console.log(`Generating image for: ${userPrompt}`);

        // إعداد الرابط (Flux Model)
        const encodedPrompt = encodeURIComponent(userPrompt);
        const seed = Math.floor(Math.random() * 1000000);
        const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux&width=1024&height=1024&seed=${seed}&nologo=true`;

        // إعداد الهيدر (هنا نضع المفتاح بأمان)
        const headers = {
            "User-Agent": "My-Netlify-App/1.0",
        };

        // نضيف المفتاح فقط إذا كان موجوداً
        if (API_KEY) {
            headers["Authorization"] = `Bearer ${API_KEY}`;
        }

        // الاتصال بـ Pollinations من السيرفر
        const response = await fetch(url, {
            method: "GET",
            headers: headers
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`خطأ من المصدر (${response.status}): ${errorText}`);
        }

        // تحويل الصورة إلى Base64 لإرسالها للفرونت اند
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: base64Image })
        };

    } catch (error) {
        console.error("Server Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "حدث خطأ أثناء معالجة الصورة", details: error.message })
        };
    }
}
