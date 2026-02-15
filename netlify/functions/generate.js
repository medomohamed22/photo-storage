// Netlify Function: /.netlify/functions/generate
// Node 18+ has global fetch. If your env is older, keep node-fetch.
// const fetch = require("node-fetch");

exports.handler = async function(event) {
    try {
        const qs = event.queryStringParameters || {};
        const prompt = (qs.prompt || "").trim();
        
        // Defaults
        const model = (qs.model || "imagen-4").trim();
        const width = Number(qs.width || 1024);
        const height = Number(qs.height || 1024);
        const seed = Number(qs.seed || Math.floor(Math.random() * 1000000));
        
        const API_KEY = process.env.POLLINATIONS_API_KEY; // optional
        
        if (!prompt) {
            return {
                statusCode: 400,
                headers: corsHeaders(),
                body: "Missing prompt",
            };
        }
        
        // Build URL safely
        const u = new URL(`https://gen.pollinations.ai/image/${encodeURIComponent(prompt)}`);
        u.searchParams.set("model", model);
        u.searchParams.set("width", String(width));
        u.searchParams.set("height", String(height));
        u.searchParams.set("seed", String(seed));
        u.searchParams.set("nologo", "true");
        
        // Only attach key if present
        if (API_KEY) u.searchParams.set("key", API_KEY);
        
        const response = await fetch(u.toString(), { method: "GET" });
        
        if (!response.ok) {
            const text = await safeText(response);
            return {
                statusCode: response.status,
                headers: corsHeaders(),
                body: text || response.statusText || "Upstream error",
            };
        }
        
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString("base64");
        
        // Keep real content-type if provided (jpeg/png/webp...)
        const contentType = response.headers.get("content-type") || "image/jpeg";
        
        return {
            statusCode: 200,
            headers: {
                ...corsHeaders(),
                "Content-Type": contentType,
                "Cache-Control": "public, max-age=60",
            },
            body: base64Image,
            isBase64Encoded: true,
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: corsHeaders(),
            body: error?.message || "Server error",
        };
    }
};

function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
    };
}

async function safeText(res) {
    try {
        return await res.text();
    } catch {
        return "";
    }
}
