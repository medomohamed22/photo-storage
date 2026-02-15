exports.handler = async function(event, context) {
    const { prompt, model, width, height, seed } = event.queryStringParameters;
    
    // جلب المفتاح من متغيرات البيئة في Netlify
    const API_KEY = process.env.POLLINATIONS_API_KEY || ""; 

    if (!prompt) {
        return { statusCode: 400, body: "Missing prompt" };
    }

    // تجهيز رابط الصورة المباشر
    // استخدام هذا الرابط يضمن أن المتصفح هو من ينتظر الصورة وليس سيرفر Netlify
    const encodedPrompt = encodeURIComponent(prompt);
    let targetUrl = `https://pollinations.ai/p/${encodedPrompt}?model=${model}&width=${width}&height=${height}&seed=${seed}&nologo=true`;

    if (API_KEY) {
        targetUrl += `&api_key=${API_KEY}`;
    }

    // إعادة توجيه (Redirect) فورية
    // هذا يخدع Netlify بأن العملية انتهت، بينما المتصفح يكمل تحميل الصورة
    return {
        statusCode: 302, 
        headers: {
            "Location": targetUrl,
            "Cache-Control": "no-cache"
        },
        body: ""
    };
};
