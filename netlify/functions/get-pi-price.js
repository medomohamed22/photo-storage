const fetch = require('node-fetch');

exports.handler = async (event) => {
    try {
        // 1. تحديد رابط API الخاص بـ OKX لزوج PI-USDT
        const symbol = "PI-USDT";
        const okxUrl = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}`;

        // 2. طلب البيانات من OKX
        const response = await fetch(okxUrl);
        
        if (!response.ok) {
            throw new Error(`OKX API Error: ${response.statusText}`);
        }
        
        const data = await response.json();

        // 3. التحقق من صحة البيانات واستخراج السعر
        // OKX returns data in { code: "0", data: [ { last: "..." } ] }
        if (data.code !== "0" || !data.data || data.data.length === 0) {
            throw new Error("Invalid Data from OKX");
        }

        // "last" هو سعر آخر عملية تداول (السعر الحالي)
        const price = parseFloat(data.data[0].last);

        return {
            statusCode: 200,
            headers: {
                // تخزين مؤقت لمدة 10 ثواني لتخفيف الضغط على API
                "Cache-Control": "public, max-age=10" 
            },
            body: JSON.stringify({ price: price })
        };

    } catch (error) {
        console.error("Price Fetch Error:", error);
        
        // في حالة فشل OKX (ربما بسبب الحظر الجغرافي للسيرفر)، نستخدم CoinGecko كبديل
        try {
            const fallbackResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=pi-network&vs_currencies=usd');
            const fallbackData = await fallbackResponse.json();
            const fallbackPrice = fallbackData['pi-network'].usd;
            
            return { 
                statusCode: 200, 
                body: JSON.stringify({ price: fallbackPrice, source: "fallback" }) 
            };
        } catch (fallbackError) {
            // إذا فشل المصدران، نرجع خطأ
            return { 
                statusCode: 500, 
                body: JSON.stringify({ error: "Failed to fetch price from OKX and Fallback" }) 
            };
        }
    }
};
