const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MODEL_COSTS = {
  'imagen-4': 1,
  'klein': 2,
  'klein-large': 4,
  'gptimage': 5,
  'openai-large': 3,
  'openai-fast': 1,
  'openai': 1
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 24000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetryTimeout(url, options = {}, timeoutMs = 24000, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;

      if (res.status >= 500 && res.status <= 599) {
        const txt = await res.text().catch(() => '');
        lastErr = new Error(`Upstream Error: ${res.status} - ${txt}`);
        await sleep(900 + i * 700);
        continue;
      }

      const txt = await res.text().catch(() => '');
      throw new Error(`Request Failed: ${res.status} - ${txt}`);
    } catch (e) {
      lastErr = e;
      if (e?.name === 'AbortError') {
        await sleep(900 + i * 700);
        continue;
      }
      await sleep(900 + i * 700);
    }
  }
  throw lastErr || new Error("Request failed");
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let uploadedFileName = null;

  try {
    const body = JSON.parse(event.body || "{}");
    let { prompt, username, pi_uid, model, width, height, messages } = body;

    // ✅ السماح بـ prompt أو messages
    if ((!prompt && (!messages || messages.length === 0)) || !username || !pi_uid) {
      return { statusCode: 400, body: JSON.stringify({ error: "بيانات ناقصة" }) };
    }

    // ✅ لو prompt مش موجود في الشات — استخرجه من messages
    if (!prompt && Array.isArray(messages)) {
      const lastUser = [...messages].reverse().find(m => m.role === 'user' && m.content);
      prompt = lastUser?.content || "";
    }

    const selectedModel = (model ? model.trim() : 'imagen-4');
    const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || "";

    const isChat =
      selectedModel.includes('openai') ||
      selectedModel.includes('gpt-5') ||
      (messages && messages.length > 0);

    const cost = MODEL_COSTS[selectedModel] || 5;

    // 1️⃣ Check balance
    const { data: userCheck, error: checkError } = await supabase
      .from('users')
      .select('token_balance')
      .eq('pi_uid', pi_uid)
      .single();

    if (checkError || !userCheck) {
      return { statusCode: 403, body: JSON.stringify({ error: 'User Check Failed' }) };
    }

    if ((userCheck.token_balance || 0) < cost) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS', currentBalance: userCheck.token_balance || 0 })
      };
    }

    let botReply = null;
    let finalImageUrl = null;

    // ===================== CHAT =====================
    if (isChat) {
      console.log("Processing Chat:", selectedModel);

      let finalMessages = Array.isArray(messages) ? [...messages] : [];
      const systemMsg = { role: "system", content: "You are a helpful assistant. Use Markdown for code." };

      if (finalMessages.length === 0 || finalMessages[0].role !== 'system') {
        finalMessages.unshift(systemMsg);
      }
      if (finalMessages.length === 1 && prompt) {
        finalMessages.push({ role: "user", content: prompt });
      }

      const headers = { "Content-Type": "application/json" };
      if (POLLINATIONS_KEY) headers["Authorization"] = `Bearer ${POLLINATIONS_KEY}`;

      const chatUrl = POLLINATIONS_KEY
        ? `https://gen.pollinations.ai/v1/chat/completions?key=${encodeURIComponent(POLLINATIONS_KEY)}`
        : `https://gen.pollinations.ai/v1/chat/completions`;

      const chatResponse = await fetchWithRetryTimeout(chatUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: selectedModel,
          messages: finalMessages
        })
      }, 24000, 1);

      if (!chatResponse.ok) {
        const errTxt = await chatResponse.text().catch(() => "");
        throw new Error(`Chat API Error: ${chatResponse.status} - ${errTxt}`);
      }

      const chatData = await chatResponse.json();
      botReply = chatData?.choices?.[0]?.message?.content || "No response from AI";
    }

    // ===================== IMAGE (✅ توليد + رفع + حفظ) =====================
    else {
      console.log("Processing Image:", selectedModel);

      const safeWidth = Math.max(256, Math.min(2048, Number(width) || 1024));
      const safeHeight = Math.max(256, Math.min(2048, Number(height) || 1024));
      const seed = Math.floor(Math.random() * 1000000);

      let genUrl =
        `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}` +
        `?model=${encodeURIComponent(selectedModel)}` +
        `&width=${safeWidth}&height=${safeHeight}` +
        `&seed=${seed}&nologo=true`;

      if (POLLINATIONS_KEY) genUrl += `&key=${encodeURIComponent(POLLINATIONS_KEY)}`;

      // ✅ (A) أول طلب: ناخد الرابط النهائي بعد redirect
      let firstRes;
      try {
        firstRes = await fetchWithRetryTimeout(genUrl, {
          method: "GET",
          headers: {
            "Accept": "image/*",
            "User-Agent": "Mozilla/5.0"
          }
        }, 24000, 2);
      } catch (e) {
        if (e?.name === "AbortError") {
          return { statusCode: 504, body: JSON.stringify({ error: "IMAGE_TIMEOUT" }) };
        }
        return { statusCode: 502, body: JSON.stringify({ error: "IMAGE_UPSTREAM_FAILED", message: e?.message }) };
      }

      if (!firstRes.ok) {
        const txt = await firstRes.text().catch(() => "");
        throw new Error(`Image Gen Failed: ${firstRes.status} - ${txt}`);
      }

      const providerFinalUrl = firstRes.url || genUrl;

      // اقفل body بتاع أول استجابة
      try { firstRes.body?.cancel(); } catch {}

      // ✅ (B) حمّل bytes من الرابط النهائي
      const imgRes = await fetchWithRetryTimeout(providerFinalUrl, {
        method: "GET",
        headers: {
          "Accept": "image/*",
          "User-Agent": "Mozilla/5.0",
          "Cache-Control": "no-cache"
        }
      }, 24000, 2);

      if (!imgRes.ok) {
        const txt = await imgRes.text().catch(() => "");
        throw new Error(`Image Download Failed: ${imgRes.status} - ${txt}`);
      }

      const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
      const ext = contentType.includes('png')
        ? 'png'
        : contentType.includes('webp')
          ? 'webp'
          : 'jpg';

      const buffer = Buffer.from(await imgRes.arrayBuffer());

      uploadedFileName = `${username}_${Date.now()}_${Math.floor(Math.random() * 9999)}.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from('nano_images')
        .upload(uploadedFileName, buffer, { contentType, upsert: false });

      if (uploadError) throw uploadError;

      const { data: publicUrlData } = supabase.storage
        .from('nano_images')
        .getPublicUrl(uploadedFileName);

      finalImageUrl = publicUrlData?.publicUrl || null;
      if (!finalImageUrl) throw new Error("Failed to get public URL");
    }

    // 3️⃣ Deduct tokens
    const { data: userFinal } = await supabase
      .from('users')
      .select('token_balance')
      .eq('pi_uid', pi_uid)
      .single();

    if (!userFinal || (userFinal.token_balance || 0) < cost) {
      throw new Error("INSUFFICIENT_TOKENS_LATE");
    }

    const newBalance = (userFinal.token_balance || 0) - cost;
    await supabase.from('users').update({ token_balance: newBalance }).eq('pi_uid', pi_uid);

    // ===================== SAVE =====================
    if (isChat) {
      const { error: insertError } = await supabase.from('user_images').insert([{
        pi_uid,
        pi_username: username,
        prompt,
        bot_response: botReply,
        type: 'text'
      }]);

      if (insertError) console.error("Chat Insert Error:", insertError);

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, reply: botReply, newBalance, type: 'text' })
      };
    } else {
      // ✅ حفظ الصورة فقط بالأعمدة الموجودة عندك
      const { error: insertError } = await supabase.from('user_images').insert([{
        pi_uid,
        pi_username: username,
        prompt,
        image_url: finalImageUrl,
        type: 'image'
      }]);

      if (insertError) console.error("Image Insert Error:", insertError);

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, imageUrl: finalImageUrl, newBalance, type: 'image' })
      };
    }

  } catch (error) {
    console.error("Handler Error:", error);

    if (uploadedFileName) {
      try { await supabase.storage.from('nano_images').remove([uploadedFileName]); } catch {}
    }

    if (error.message === "INSUFFICIENT_TOKENS_LATE") {
      return { statusCode: 403, body: JSON.stringify({ error: 'INSUFFICIENT_TOKENS' }) };
    }

    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
