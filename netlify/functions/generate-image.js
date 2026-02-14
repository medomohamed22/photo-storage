// netlify/functions/generate-image.js
import { GoogleGenerativeAI } from "@google/generative-ai";

export async function handler(event, context) {
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        const body = JSON.parse(event.body);
        const userPrompt = body.prompt;
        const apiKey = process.env.GEMINI_API_KEY;

        if (!apiKey) {
            return { statusCode: 500, body: JSON.stringify({ error: "API Key missing" }) };
        }

        // 1. إعداد المكتبة المستقرة
        const genAI = new GoogleGenerativeAI(apiKey);

        // 2. اختيار الموديل (Gemini 2.0 Flash Experimental)
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-exp",
            generationConfig: {
                responseMimeType: "image/jpeg" // أمر صريح بإخراج صورة
            }
        });

        // 3. إرسال الطلب
        const result = await model.generateContent(userPrompt);
        const response = await result.response;
        
        // 4. استخراج الصورة من الرد
        // المكتبة المستقرة تعيد البيانات بشكل مختلف قليلاً لكن يمكننا الوصول إليها
        // عادة في Gemini 2.0 الصور تأتي في candidates[0].content.parts
        // لكن بما أن SDK قد لا يحلل الصور تلقائياً في هذا الإصدار، سنبحث في الرد الخام
        
        let base64Image = null;
        
        // محاولة الوصول للبيانات الخام
        const candidates = response.candidates;
        if (candidates && candidates[0].content && candidates[0].content.parts) {
            for (const part of candidates[0].content.parts) {
                if (part.inlineData && part.inlineData.data) {
                    base64Image = part.inlineData.data;
                    break;
                }
            }
        }

        if (!base64Image) {
            console.log("Full Response:", JSON.stringify(response));
            return { statusCode: 500, body: JSON.stringify({ error: "لم يقم النموذج بتوليد صورة (قد يكون الموديل مشغولاً أو الوصف غير مسموح)." }) };
        }

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
