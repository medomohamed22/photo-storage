
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

exports.handler = async (event) => {
    // التحقق من طريقة الطلب
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    
    try {
        const { id, username } = JSON.parse(event.body);

        if (!id || !username) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing id or username" }) };
        }

        // ---------------------------------------------------------
        // خطوة 1: جلب بيانات الصورة أولاً لمعرفة اسم الملف
        // ---------------------------------------------------------
        const { data: imageRecord, error: fetchError } = await supabase
            .from('user_images')
            .select('image_url')
            .match({ id: id, pi_username: username })
            .single(); // نستخدم single لأننا نتوقع نتيجة واحدة

        if (fetchError || !imageRecord) {
            console.error("Image not found or access denied");
            return { statusCode: 404, body: JSON.stringify({ error: "Image not found" }) };
        }

        // ---------------------------------------------------------
        // خطوة 2: استخراج اسم الملف من الرابط
        // ---------------------------------------------------------
        // الرابط يكون عادة: .../storage/v1/object/public/nano_images/username_12345.jpg
        // نحن نحتاج فقط الجزء الأخير: username_12345.jpg
        const fileUrl = imageRecord.image_url;
        const fileName = fileUrl.split('/').pop(); // يأخذ آخر جزء بعد الشرطة المائلة

        if (fileName) {
            // حذف الملف من Storage
            const { error: storageError } = await supabase
                .storage
                .from('nano_images')
                .remove([fileName]);

            if (storageError) {
                console.error("Storage delete error:", storageError);
                // لن نوقف العملية هنا، سنكمل لحذف السجل من الجدول حتى لو فشل حذف الملف
                // لتجنب بقاء سجلات "ميتة" في الجدول
            }
        }

        // ---------------------------------------------------------
        // خطوة 3: حذف السجل من قاعدة البيانات (الجدول)
        // ---------------------------------------------------------
        const { error: dbError } = await supabase
            .from('user_images')
            .delete()
            .match({ id: id, pi_username: username });

        if (dbError) {
            return { statusCode: 500, body: JSON.stringify(dbError) };
        }

        return { statusCode: 200, body: JSON.stringify({ success: true }) };

    } catch (error) {
        console.error("Handler error:", error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
