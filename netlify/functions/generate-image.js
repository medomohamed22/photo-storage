// netlify/functions/generate-image.js

exports.handler = async function(event, context) {
    // 1. السماح فقط بطلبات POST
    if (event.httpMethod !== "POST") {
        return { statusCode: 405, body: "Method Not Allowed" };
    }

    try {
        // 2. استلام النص (Prompt) من الفرونت إند
        const body = JSON.parse(event.body);
        const userPrompt = body.prompt;

        if (!userPrompt) {
            return { statusCode: 400, body: JSON.stringify({ error: "الرجاء إدخال وصف للصورة" }) };
        }

        // 3. جلب مفتاح API من إعدادات Netlify (البيئة)
        const API_KEY = process.env.GEMINI_API_KEY; 

        if (!API_KEY) {
            return { statusCode: 500, body: JSON.stringify({ error: "API Key غير موجود في السيرفر" }) };
        }

        // 4. إرسال الطلب إلى Google Imagen 3 API
        // ملاحظة: هذا الرابط لـ Imagen عبر Gemini API
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${API_KEY}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                instances: [
                    { prompt: userPrompt }
                ],
                parameters: {
                    sampleCount: 1, // عدد الصور
                    aspectRatio: "1:1" // الأبعاد
                }
            })
        });

        const data = await response.json();

        // 5. التحقق من الخطأ القادم من جوجل
        if (!response.ok) {
            console.error("Google API Error:", data);
            return {
                statusCode: response.status,
                body: JSON.stringify({ error: data.error?.message || "فشل توليد الصورة من المصدر" })
            };
        }

        // 6. إرجاع الصورة (Base64) إلى الفرونت إند
        // Imagen يعيد الصورة عادةً داخل predictions[0].bytesBase64Encoded
        const imageBase64 = data.predictions?.[0]?.bytesBase64Encoded; // أو data.images[0] حسب إصدار الـ API

        if (!imageBase64) {
             return { statusCode: 500, body: JSON.stringify({ error: "لم يتم استلام بيانات الصورة" }) };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ image: imageBase64 })
        };

    } catch (error) {
        console.error("Server Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: "حدث خطأ داخلي في السيرفر" })
        };
    }
};
