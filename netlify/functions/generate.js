exports.handler = async (event) => {
  try {
    const { prompt, model = "flux", width = "1024", height = "1024", seed = "1" } =
      event.queryStringParameters || {};

    if (!prompt) {
      return { statusCode: 400, body: "Missing prompt" };
    }

    const API_KEY = process.env.POLLINATIONS_API_KEY || "";
    const safeW = Math.min(Math.max(parseInt(width, 10) || 1024, 256), 1536);
    const safeH = Math.min(Math.max(parseInt(height, 10) || 1024, 256), 1536);
    const safeSeed = parseInt(seed, 10) || 1;

    const targetUrl =
      `https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}` +
      `?model=${encodeURIComponent(model)}` +
      `&width=${safeW}&height=${safeH}&seed=${safeSeed}` +
      `&nologo=true` +
      (API_KEY ? `&key=${encodeURIComponent(API_KEY)}` : "");

    // Abort after 25s (before Netlify 30s)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    const res = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return {
        statusCode: res.status,
        body: `Pollinations error: ${res.status} ${res.statusText} ${txt}`.slice(0, 2000),
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": res.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "no-store",
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    const msg = (e && e.name === "AbortError")
      ? "Timeout fetching image from Pollinations"
      : (e?.message || String(e));

    return { statusCode: 500, body: msg };
  }
};
