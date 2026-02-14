// netlify/functions/generate-image.js
import { GoogleGenAI } from "@google/genai";

export async function handler(event, context) {
    // التأكد من أن الطلب POST
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const body = JSON.parse(event.body);
        const userPrompt = body.prompt || "Create a picture of a nano banana dish in a fancy restaurant";
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return { statusCode: 500, body: JSON.stringify({ error: "API Key missing" }) };
        }

        // 1. إعداد العميل (نفس الكود الخاص بك)
        const ai = new GoogleGenAI({ apiKey: apiKey });

        // 2. طلب الصورة من موديل Gemini المتقدم
        // ملاحظة: نستخدم gemini-2.0-flash-exp لأنه المتاح حالياً والمضمون لتوليد الصور
        // إذا كان gemini-2.5-flash-image متاحاً لك، يمكنك تغيير الاسم أدناه
        const response = await ai.models.generateContent({
            model: "gemini-2.0-flash-exp", 
            contents: {
                role: "user",
                parts: [{ text: userPrompt }]
            },
            config: {
                responseMimeType: "image/jpeg" // إجبار النموذج على إخراج صورة
            }
        });

        // 3. استخراج بيانات الصورة
        let base64Image = null;

        // البحث في الرد عن الصورة (Inline Data)
        // هذا يحاكي الـ Loop الموجود في كودك الأصلي
        const candidates = response.candidates;
        if (candidates && candidates[0] && candidates[0].content && candidates[0].content.parts) {
            for (const part of candidates[0].content.parts) {
                if (part.inlineData) {
                    base64Image = part.inlineData.data;
                    break; // وجدنا الصورة، نتوقف
                }
            }
        }

        if (!base64Image) {
            return { statusCode: 500, body: JSON.stringify({ error: "لم يتم إنشاء صورة، حاول تغيير الوصف." }) };
        }

        // 4. إرسال الصورة للمتصفح (بدلاً من fs.writeFileSync)
        return {
            statusCode: 200,
            body: JSON.stringify({ image: base64Image })
        };

    } catch (error) {
        console.error("Gemini Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message || "حدث خطأ في الخادم" })
        };
    }
}
