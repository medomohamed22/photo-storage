const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MODEL_COSTS = {
  // Image
  'imagen-4': 1,
  'klein': 2,
  'klein-large': 4,
  'gptimage': 5,

  // Chat
  'openai-large': 3,
  'openai-fast': 1,
  'openai': 1
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    },
    body: JSON.stringify(obj)
  };
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

      // Retry على 5xx و 429 (ضغط)
      if (res.status >= 500 || res.status === 429) {
        const txt = await res.text().catch(() => '');
        lastErr = new Error(`Upstream Error: ${res.status} - ${txt}`);
        await sleep(900 + i * 700);
        continue;
      }

      // 4xx غالبًا مش هتفيد retry
      const txt = await res.text().catch(() => '');
      throw new Error(`Request Failed: ${res.status} - ${txt}`);
    } catch (e) {
      lastErr = e;
      await sleep(900 + i * 700);
    }
  }
  throw lastErr || new Error("Request failed");
}

function safeTrim(x) {
  return String(x || '').trim();
}

function detectIsChat(selectedModel, messages) {
  // ✅ فرونتك بيبعت messages للشات وprompt للصورة
  if (Array.isArray(messages) && messages.length > 0) return true;

  // ✅ أو موديل شات معروف
  const m = safeTrim(selectedModel).toLowerCase();
  if (!m) return false;
  return (
    m === 'openai' ||
    m === 'openai-fast' ||
    m === 'openai-large' ||
    m.includes('gpt-5') // لو أضفت ids فيها gpt-5
  );
}

/**
 * ✅ FIX: Atomic token deduction بدون supabase.raw
 * - لازم تكون عامل في Supabase function:
 *   public.atomic_deduct_tokens(p_pi_uid text, p_cost int) returns int
 */
async function atomicDeductTokens(pi_uid, cost) {
  const { data, error } = await supabase.rpc('atomic_deduct_tokens', {
    p_pi_uid: pi_uid,
    p_cost: Number(cost)
  });

  if (error) {
    const msg = String(error.message || "").toUpperCase();
    if (msg.includes("INSUFFICIENT_TOKENS")) {
      return { ok: false };
    }
    // أي خطأ آخر
    throw error;
  }

  return { ok: true, newBalance: Number(data || 0) };
}

exports.handler = async (event) => {
  // ✅ CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return json(204, { ok: true });
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }

  let uploadedFileName = null;

  try {
    const body = JSON.parse(event.body || "{}");
    let { prompt, username, pi_uid, model, width, height, messages } = body;

    username = safeTrim(username);
    pi_uid = safeTrim(pi_uid);
    model = safeTrim(model);

    // ✅ السماح بـ prompt أو messages
    const hasMessages = Array.isArray(messages) && messages.length > 0;
    prompt = safeTrim(prompt);

    if ((!prompt && !hasMessages) || !username || !pi_uid) {
      return json(400, { error: "Missing data" });
    }

    // ✅ لو prompt مش موجود في الشات — استخرجه من messages (آخر user)
    if (!prompt && hasMessages) {
      const lastUser = [...messages].reverse().find(m => m?.role === 'user' && m?.content);
      prompt = safeTrim(lastUser?.content);
    }

    const selectedModel = model || 'imagen-4';
    const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY || "";
    const isChat = detectIsChat(selectedModel, messages);
    const cost = MODEL_COSTS[selectedModel] || 5;

    // ===================== 1) CHECK BALANCE =====================
    const { data: userCheck, error: checkError } = await supabase
      .from('users')
      .select('token_balance')
      .eq('pi_uid', pi_uid)
      .single();

    if (checkError || !userCheck) {
      return json(403, { error: 'User Check Failed' });
    }

    const currentBalance = Number(userCheck.token_balance || 0);
    if (currentBalance < cost) {
      return json(403, {
        error: 'INSUFFICIENT_TOKENS',
        required: cost,
        currentBalance
      });
    }

    let botReply = null;
    let finalImageUrl = null;

    // ===================== 2) CHAT =====================
    if (isChat) {
      console.log("Processing Chat:", selectedModel);

      let finalMessages = hasMessages ? [...messages] : [];
      const systemMsg = { role: "system", content: "You are a helpful assistant. Use Markdown for code." };

      // ✅ حط system مرة واحدة
      if (finalMessages.length === 0 || finalMessages[0]?.role !== 'system') {
        finalMessages.unshift(systemMsg);
      }

      // ✅ لو مفيش messages أصلاً بس عندنا prompt
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

      const chatData = await chatResponse.json().catch(() => ({}));
      botReply = chatData?.choices?.[0]?.message?.content || "No response from AI";
    }

    // ===================== 2) IMAGE =====================
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

      // (A) خد الـ final url بعد redirect
      let firstRes;
      try {
        firstRes = await fetchWithRetryTimeout(genUrl, {
          method: "GET",
          headers: { "Accept": "image/*", "User-Agent": "Mozilla/5.0" }
        }, 24000, 2);
      } catch (e) {
        if (e?.name === "AbortError") {
          return json(504, { error: "IMAGE_TIMEOUT" });
        }
        return json(502, { error: "IMAGE_UPSTREAM_FAILED", message: e?.message });
      }

      if (!firstRes.ok) {
        const txt = await firstRes.text().catch(() => "");
        throw new Error(`Image Gen Failed: ${firstRes.status} - ${txt}`);
      }

      const providerFinalUrl = firstRes.url || genUrl;
      try { firstRes.body?.cancel(); } catch {}

      // (B) حمّل bytes
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

    // ===================== 3) DEDUCT TOKENS (بعد النجاح) =====================
    const deducted = await atomicDeductTokens(pi_uid, cost);
    if (!deducted.ok) {
      // ✅ لو فشل الخصم، امسح الصورة اللي اترفعت (عشان مايتاخدش فايدة بدون خصم)
      if (uploadedFileName) {
        try { await supabase.storage.from('nano_images').remove([uploadedFileName]); } catch {}
      }
      return json(403, { error: 'INSUFFICIENT_TOKENS', required: cost });
    }

    const newBalance = deducted.newBalance;

    // ===================== 4) SAVE TO user_images =====================
    if (isChat) {
      const { error: insertError } = await supabase.from('user_images').insert([{
        pi_uid,
        pi_username: username,
        prompt,
        bot_response: botReply,
        type: 'text'
      }]);

      if (insertError) console.error("Chat Insert Error:", insertError);

      return json(200, { success: true, reply: botReply, newBalance, type: 'text' });
    } else {
      const { error: insertError } = await supabase.from('user_images').insert([{
        pi_uid,
        pi_username: username,
        prompt,
        image_url: finalImageUrl,
        type: 'image'
      }]);

      if (insertError) console.error("Image Insert Error:", insertError);

      return json(200, { success: true, imageUrl: finalImageUrl, newBalance, type: 'image' });
    }

  } catch (error) {
    console.error("Handler Error:", error);

    // لو رفعنا ملف وفشلنا بعده، نمسحه
    if (uploadedFileName) {
      try { await supabase.storage.from('nano_images').remove([uploadedFileName]); } catch {}
    }

    const msg = String(error?.message || "");

    // لو RPC رمت exception
    if (msg.toUpperCase().includes("INSUFFICIENT_TOKENS")) {
      return json(403, { error: "INSUFFICIENT_TOKENS" });
    }

    // upstream errors
    if (msg.toLowerCase().includes("upstream") || msg.includes("Image") || msg.includes("Chat API Error")) {
      return json(502, { error: "UPSTREAM_FAILED", message: msg });
    }

    return json(500, { error: msg || "Server error" });
  }
};
