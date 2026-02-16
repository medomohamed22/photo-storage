const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch'); 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// أسعار الموديلات (بالتوكين)
const MODEL_COSTS = {
    // Image models
    'imagen-4': 1,      // Nano Banana (الأرخص والأسرع)
    'klein': 2,         // Flux 4B (جودة متوسطة)
    'klein-large': 4,   // Flux 9B (جودة عالية)
    'gptimage': 5,      // Chat GPT (الأغلى والأذكى)
    // Video models
    'grok-video': 6     // Grok Video Generation
};

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    let uploadedFileName = null;

    try {
        const { 
            prompt, 
            username, 
            pi_uid, 
            model, 
            width, 
            height, 
            mode = 'image',      // 'image' or 'video'
            duration = 5,        // for video: 5-10 seconds
            aspectRatio = '1:1', // for video
            resolution = '720p'  // for video
        } = JSON.parse(event.body);

        if (!prompt || !username || !pi_uid) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing data" }) };
        }

        // تحديد الموديل والتكلفة
        const selectedModel = model || (mode === 'video' ? 'grok-video' : 'imagen-4');
        const cost = MODEL_COSTS[selectedModel] || (mode === 'video' ? 6 : 5);

        // 1. التحقق من الرصيد
        const { data: userCheck, error: checkError } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();

        if (checkError || !userCheck) {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', currentBalance: 0 }) };
        }

        if (userCheck.token_balance < cost) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ 
                    error: 'INSUFFICIENT_TOKENS', 
                    required: cost,
                    currentBalance: userCheck.token_balance 
                }) 
            };
        }

        let finalUrl;
        let fileExtension = 'jpg';
        let contentType = 'image/jpeg';
        let mediaType = mode; // 'image' or 'video'

        if (mode === 'video') {
            // ==================== VIDEO GENERATION ====================
            
            // Grok Video Generation via xAI API
            const XAI_API_KEY = process.env.XAI_API_KEY;
            if (!XAI_API_KEY) {
                throw new Error("XAI_API_KEY not configured");
            }

            // Call xAI Grok Imagine API for video
            const videoRes = await fetch('https://api.x.ai/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${XAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: "grok-imagine-video", // xAI video model
                    prompt: prompt,
                    aspect_ratio: aspectRatio, // "1:1", "16:9", "9:16", "4:3", "21:9"
                    resolution: resolution,    // "720p"
                    duration: duration         // 5-10 seconds
                })
            });

            if (!videoRes.ok) {
                const errorData = await videoRes.text();
                throw new Error(`Video Generation Failed: ${videoRes.status} - ${errorData}`);
            }

            const videoData = await videoRes.json();
            
            // xAI returns video URL in the response
            const videoUrl = videoData.url || videoData.data?.[0]?.url;
            
            if (!videoUrl) {
                throw new Error("No video URL returned from API");
            }

            // Download the video
            const videoDownloadRes = await fetch(videoUrl);
            if (!videoDownloadRes.ok) {
                throw new Error("Failed to download generated video");
            }

            const arrayBuffer = await videoDownloadRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Upload to Supabase Storage
            uploadedFileName = `${username}_${Date.now()}.mp4`;
            fileExtension = 'mp4';
            contentType = 'video/mp4';

            const { error: uploadError } = await supabase.storage
                .from('nano_images') // You might want to rename this bucket to 'media' or create 'videos'
                .upload(uploadedFileName, buffer, { 
                    contentType: contentType,
                    cacheControl: '3600'
                });
            
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from('nano_images')
                .getPublicUrl(uploadedFileName);
            
            finalUrl = publicUrlData.publicUrl;

        } else {
            // ==================== IMAGE GENERATION ====================
            
            const safeWidth = width || 1024;
            const safeHeight = height || 1024;
            const seed = Math.floor(Math.random() * 1000000);
            const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || ""; 

            let targetUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
            if (POLLINATIONS_KEY) targetUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

            const imageRes = await fetch(targetUrl);
            if (!imageRes.ok) throw new Error(`Generation Failed: ${imageRes.statusText}`);
            
            const arrayBuffer = await imageRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // رفع الصورة
            uploadedFileName = `${username}_${Date.now()}.jpg`;
            fileExtension = 'jpg';
            contentType = 'image/jpeg';

            const { error: uploadError } = await supabase.storage
                .from('nano_images')
                .upload(uploadedFileName, buffer, { contentType: contentType });
            
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage
                .from('nano_images')
                .getPublicUrl(uploadedFileName);
            
            finalUrl = publicUrlData.publicUrl;
        }

        // 4. خصم الرصيد (بعد النجاح)
        const { data: userFinal } = await supabase
            .from('users')
            .select('token_balance')
            .eq('pi_uid', pi_uid)
            .single();
        
        if (!userFinal || userFinal.token_balance < cost) {
            throw new Error("INSUFFICIENT_TOKENS_LATE");
        }

        const newBalance = userFinal.token_balance - cost;
        await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

        // 5. حفظ السجل (مع تحديد النوع)
        await supabase.from('user_images').insert([{ 
            pi_username: username, 
            prompt: prompt, 
            image_url: mode === 'image' ? finalUrl : null,
            video_url: mode === 'video' ? finalUrl : null,
            type: mediaType,
            model: selectedModel,
            duration: mode === 'video' ? duration : null,
            aspect_ratio: mode === 'video' ? aspectRatio : null
        }]);

        // 6. إرجاع الاستجابة المناسبة حسب النوع
        const response = {
            success: true,
            newBalance: newBalance,
            type: mediaType
        };

        if (mode === 'video') {
            response.videoUrl = finalUrl;
            response.duration = duration;
        } else {
            response.imageUrl = finalUrl;
        }

        return {
            statusCode: 200,
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error("Handler Error:", error);
        
        // Cleanup uploaded file if exists
        if (uploadedFileName) {
            try {
                await supabase.storage.from('nano_images').remove([uploadedFileName]);
            } catch (cleanupError) {
                console.error("Cleanup error:", cleanupError);
            }
        }
        
        if (error.message === "INSUFFICIENT_TOKENS_LATE") {
            return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) };
        }
        
        if (error.message.includes("XAI_API_KEY")) {
            return { statusCode: 500, body: JSON.stringify({ error: 'Video service not configured' }) };
        }
        
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
