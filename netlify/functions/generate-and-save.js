const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MODEL_COSTS = {
  // Image
  'imagen-4': 1, 'klein': 2, 'klein-large': 4, 'gptimage': 5,
  // Chat
  'openai-large': 3, 'openai-fast': 1, 'openai': 1
};

// دالة مساعدة للرد بـ JSON
function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*", // هام للفرونت إند
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(obj)
  };
}

// دالة مساعدة لتنظيف النصوص
function safeTrim(x) { return String(x || '').trim(); }

// دالة الخصم الذري (Atomic)
async function atomicDeductTokens(pi_uid, cost) {
  // تأكد أنك أنشأت دالة RPC في Supabase اسمها atomic_deduct_tokens
  // إذا لم تكن موجودة، سنستخدم التحديث العادي كبديل مؤقت
  try {
    const { data, error } = await supabase.rpc('atomic_deduct_tokens', {
      p_pi_uid: pi_uid,
      p_cost: Number(cost)
    });
    if (error) throw error;
    return { ok: true, newBalance: Number(data) };
  } catch (e) {
    console.log("RPC failed, falling back to manual update:", e.message);
    // Fallback: جلب الرصيد ثم التحديث (أقل أماناً لكن يعمل)
    const { data: user } = await supabase.from('users').select('token_balance').eq('pi_uid', pi_uid).single();
    if (!user || user.token_balance < cost) return { ok: false };
    
    const newBal = user.token_balance - cost;
    await supabase.from('users').update({ token_balance: newBal }).eq('pi_uid', pi_uid);
    return { ok: true, newBalance: newBal };
  }
}

exports.handler = async (event) => {
  // Handle CORS
  if (event.httpMethod === 'OPTIONS') return json(204, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  let uploadedFileName = null;

  try {
    const body = JSON.parse(event.body || "{}");
    let { prompt, username, pi_uid, model, width, height, messages } = body;

    // تنظيف المدخلات
    username = safeTrim(username);
    pi_uid = safeTrim(pi_uid);
    model = safeTrim(model);
    
    // تحديد هل الطلب شات أم صورة
    const isChat = (Array.isArray(messages) && messages.length > 0) || 
                   model.includes('openai') || 
                   model.includes('gpt');

    // إذا كان شات ولم يتم إرسال prompt، نأخذه من آخر رسالة
    if (isChat && !prompt && Array.isArray(messages)) {
        const lastMsg = messages[messages.length - 1];
        if (lastMsg) prompt = lastMsg.content;
    }

    if (!prompt || !username || !pi_uid) {
      return json(400, { error: "Missing required data (prompt, username, or pi_uid)" });
    }

    const selectedModel = model || 'imagen-4';
    const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || "";
    const cost = MODEL_COSTS[selectedModel] || 5;

    // 1. التحقق من الرصيد (مبدئي)
    const { data: userCheck, error: checkError } = await supabase
      .from('users')
      .select('token_balance')
      .eq('pi_uid', pi_uid)
      .single();

    if (checkError || !userCheck) return json(403, { error: 'User Check Failed' });
    if (userCheck.token_balance < cost) {
      return json(403, { error: 'INSUFFICIENT_TOKENS', currentBalance: userCheck.token_balance });
    }

    let botReply = null;
    let finalImageUrl = null;

    // ===========================
    // 2. تنفيذ العملية (شات أو صورة)
    // ===========================
    
    if (isChat) {
      // --- منطق الشات ---
      console.log("Processing Chat:", selectedModel);
      
      let finalMessages = messages || [];
      // إضافة System Message
      if (!finalMessages.some(m => m.role === 'system')) {
        finalMessages.unshift({ role: "system", content: "You are a helpful assistant. Use Markdown." });
      }

      const chatUrl = `https://gen.pollinations.ai/v1/chat/completions?key=${encodeURIComponent(POLLINATIONS_KEY)}`;
      
      const chatRes = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: selectedModel, messages: finalMessages })
      });

      if (!chatRes.ok) throw new Error(`Chat API Error: ${chatRes.status}`);
      const chatData = await chatRes.json();
      botReply = chatData.choices?.[0]?.message?.content || "No response";

    } else {
      // --- منطق الصور (المعدل والمبسط) ---
      console.log("Processing Image:", selectedModel);

      const safeWidth = width || 1024;
      const safeHeight = height || 1024;
      const seed = Math.floor(Math.random() * 1e9);
      
      // بناء الرابط
      let imgUrl = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}?model=${selectedModel}&width=${safeWidth}&height=${safeHeight}&seed=${seed}&nologo=true`;
      if (POLLINATIONS_KEY) imgUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

      // جلب الصورة (Fetch)
      // ملاحظة: نزيد وقت الانتظار لأن توليد الصور يأخذ وقتًا
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 ثانية

      const imgRes = await fetch(imgUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!imgRes.ok) {
        const errTxt = await imgRes.text();
        throw new Error(`Image Gen Failed: ${imgRes.status} - ${errTxt.substring(0, 100)}`);
      }

      // التأكد أن الرد هو صورة
      const contentType = imgRes.headers.get('content-type');
      if (!contentType || !contentType.startsWith('image/')) {
        throw new Error(`Invalid response type: ${contentType}`);
      }

      // تحويل الـ Stream إلى Buffer
      const arrayBuffer = await imgRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // رفع الصورة إلى Supabase
      const ext = contentType.split('/')[1] || 'jpeg';
      uploadedFileName = `${username}_${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('nano_images')
        .upload(uploadedFileName, buffer, { contentType });

      if (uploadError) throw uploadError;

      // الحصول على الرابط العام
      const { data: publicUrlData } = supabase.storage
        .from('nano_images')
        .getPublicUrl(uploadedFileName);
        
      finalImageUrl = publicUrlData.publicUrl;
    }

    // ===========================
    // 3. خصم الرصيد
    // ===========================
    const deductRes = await atomicDeductTokens(pi_uid, cost);
    if (!deductRes.ok) {
        // إذا فشل الخصم، نحذف الصورة (تنظيف)
        if (uploadedFileName) await supabase.storage.from('nano_images').remove([uploadedFileName]);
        return json(403, { error: 'INSUFFICIENT_TOKENS_LATE' });
    }

    // ===========================
    // 4. حفظ السجل في قاعدة البيانات
    // ===========================
    let dbPayload = {
        pi_uid: pi_uid, // تأكد أن هذا العمود موجود في الجدول
        pi_username: username,
        prompt: prompt,
        type: isChat ? 'text' : 'image'
    };

    if (isChat) {
        dbPayload.bot_response = botReply;
    } else {
        dbPayload.image_url = finalImageUrl;
    }

    const { error: insertError } = await supabase.from('user_images').insert([dbPayload]);

    if (insertError) {
        console.error("DB Insert Error:", insertError);
        // لا نوقف العملية، لكن نسجل الخطأ في اللوج
    }

    // الرد النهائي للفرونت إند
    return json(200, {
        success: true,
        newBalance: deductRes.newBalance,
        reply: botReply,       // للشات
        imageUrl: finalImageUrl, // للصور
        type: isChat ? 'text' : 'image'
    });

  } catch (error) {
    console.error("Handler Error:", error);
    // تنظيف في حال الخطأ
    if (uploadedFileName) await supabase.storage.from('nano_images').remove([uploadedFileName]);
    
    return json(500, { error: error.message || "Internal Server Error" });
  }
};
