import { GoogleGenerativeAI } from "@google/generative-ai";

export async function handler(event, context) {
    // السماح فقط بطلبات POST
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

        console.log(`Using Model: gemini-2.5-flash-image for prompt: ${userPrompt}`);

        // 1. إعداد الاتصال بجوجل
        const genAI = new GoogleGenerativeAI(apiKey);

        // 2. تحديد الموديل بالاسم الذي طلبته
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash-image",
            generationConfig: {
                responseMimeType: "image/jpeg" // إجبار الموديل على إخراج صورة
            }
        });

        // 3. إرسال الطلب
        const result = await model.generateContent(userPrompt);
        const response = result.response;

        // 4. استخراج بيانات الصورة (Base64)
        // في هذا الإصدار، الصورة تأتي عادة في inlineData
        let base64Image = null;
        
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
            console.error("No image found in response:", JSON.stringify(response));
            return { 
                statusCode: 500, 
                body: JSON.stringify({ error: "النموذج لم يرسل صورة. تأكد من أن حسابك يدعم هذا الموديل." }) 
            };
        }

        // 5. إرجاع الصورة للموقع
        return {
            statusCode: 200,
            body: JSON.stringify({ image: base64Image })
        };

    } catch (error) {
        console.error("Gemini API Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                error: error.message || "حدث خطأ أثناء الاتصال بجوجل",
                details: error.toString()
            })
        };
    }
}
