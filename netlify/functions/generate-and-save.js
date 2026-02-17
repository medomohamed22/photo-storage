const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MODEL_COSTS = {
  'imagen-4': 1,
  'klein': 2,
  'klein-large': 4,
  'gptimage': 5
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(id);
  }
}

async function fetchWithRetry(url, retries = 2, timeoutMs = 20000) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(url, timeoutMs);
      if (res.ok) return res;

      // retry على 5xx
      if (res.status >= 500) {
        lastErr = new Error(`Upstream ${res.status}: ${await res.text().catch(() => '')}`);
        await sleep(800 + i * 600);
        continue;
      }

      throw new Error(`Fetch failed ${res.status}: ${await res.text().catch(() => '')}`);
    } catch (e) {
      lastErr = e;
      await sleep(800 + i * 600);
    }
  }
  throw lastErr || new Error("Fetch failed");
}

function isAllowedProviderUrl(url) {
  try {
    const u = new URL(url);
    // ✅ اسمح فقط بمصدر Pollinations (أمان)
    return (
      u.hostname === 'gen.pollinations.ai' ||
      u.hostname.endsWith('.pollinations.ai')
    );
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: ""
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let uploadedFileName = null;

  try {
    const body = JSON.parse(event.body || "{}");
    const { username, pi_uid, prompt, model, providerUrl } = body;

    if (!username || !pi_uid || !prompt || !providerUrl) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Missing data" })
      };
    }

    // ✅ تأمين الرابط
    if (!isAllowedProviderUrl(providerUrl)) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Invalid providerUrl" })
      };
    }

    const selectedModel = (model || 'imagen-4').trim();
    const cost = MODEL_COSTS[selectedModel] || 5;

    // 1) Check balance
    const { data: userCheck, error: checkError } = await supabase
      .from('users')
      .select('token_balance')
      .eq('pi_uid', pi_uid)
      .single();

    if (checkError || !userCheck) {
      return {
        statusCode: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "User Check Failed" })
      };
    }

    const currentBalance = Number(userCheck.token_balance || 0);
    if (currentBalance < cost) {
      return {
        statusCode: 403,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "INSUFFICIENT_TOKENS", currentBalance })
      };
    }

    // 2) Download image (سريع لأن التوليد حصل بالفعل على الفرونت)
    const imageRes = await fetchWithRetry(providerUrl, 2, 20000);
    const contentType = imageRes.headers.get("content-type") || "image/jpeg";

    const ext = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : "jpg";

    const buffer = Buffer.from(await imageRes.arrayBuffer());

    // 3) Upload to Supabase Storage
    uploadedFileName = `${username}_${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase
      .storage
      .from('nano_images')
      .upload(uploadedFileName, buffer, { contentType, upsert: false });

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase
      .storage
      .from('nano_images')
      .getPublicUrl(uploadedFileName);

    const finalImageUrl = publicUrlData?.publicUrl;
    if (!finalImageUrl) throw new Error("Failed to get public URL");

    // 4) Deduct tokens AFTER success
    const newBalance = currentBalance - cost;
    const { error: updErr } = await supabase
      .from('users')
      .update({ token_balance: newBalance })
      .eq('pi_uid', pi_uid);

    if (updErr) throw updErr;

    // 5) Save in DB (صور فقط)
    const { error: insertError } = await supabase
      .from('user_images')
      .insert([{
        pi_uid,
        pi_username: username,
        prompt,
        image_url: finalImageUrl,
        type: 'image'
      }]);

    if (insertError) throw insertError;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success: true, imageUrl: finalImageUrl, newBalance })
    };

  } catch (error) {
    console.error("save-generated-image error:", error);

    if (uploadedFileName) {
      await supabase.storage.from('nano_images').remove([uploadedFileName]);
    }

    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: error.message || "Server error" })
    };
  }
};
