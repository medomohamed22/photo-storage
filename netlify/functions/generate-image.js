// تم حذف سطر require('node-fetch') لأن Netlify يدعم fetch تلقائياً الآن

exports.handler = async function(event, context) {
    // التأكد من أن الطلب هو POST
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

        // إعدادات التوليد
        const seed = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(userPrompt);
        
        // استخدام Pollinations API (Flux Model)
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&model=flux&nologo=true`;

        // جلب الصورة
        const imageResponse = await fetch(imageUrl); // fetch تعمل هنا تلقائياً
        
        if (!imageResponse.ok) {
             throw new Error("فشل في جلب الصورة من المصدر");
        }

        // تحويل الصورة إلى Base64
        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');

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
