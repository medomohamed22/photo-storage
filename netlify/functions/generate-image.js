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

        console.log("Attempting to generate image for:", userPrompt);

        // إعداد الرابط (نستخدم موديل سريع لتجنب نفاذ الوقت في Netlify)
        const seed = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(userPrompt);
        
        // ملاحظة: قمنا بتغيير الرابط قليلاً ليكون أكثر استقراراً
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=1024&seed=${seed}&model=flux&nologo=true`;

        // 👇 الإضافة الهامة جداً: إرسال Headers
        const imageResponse = await fetch(imageUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
            }
        });
        
        // تسجيل سبب الخطأ إذا فشل الطلب
        if (!imageResponse.ok) {
             console.error(`External API Error: Status ${imageResponse.status} - ${imageResponse.statusText}`);
             // قراءة نص الخطأ من المصدر
             const errorText = await imageResponse.text();
             console.error("Error Body:", errorText);
             
             throw new Error(`فشل المصدر في التوليد (Code: ${imageResponse.status})`);
        }

        const arrayBuffer = await imageResponse.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');

        return {
            statusCode: 200,
            body: JSON.stringify({ image: base64Image })
        };

    } catch (error) {
        console.error("Final Server Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: "حدث خطأ أثناء الاتصال بخادم الصور. حاول مرة أخرى لاحقاً.",
                details: error.message 
            })
        };
    }
};
