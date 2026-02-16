const fetch = require('node-fetch');

exports.handler = async (event) => {
    try {
        // جلب سعر Pi Network (IOU) مقابل الدولار
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=pi-network&vs_currencies=usd');
        
        if (!response.ok) throw new Error("API Error");
        
        const data = await response.json();
        const price = data['pi-network'].usd;

        return {
            statusCode: 200,
            headers: {
                "Cache-Control": "public, max-age=10" // تخزين مؤقت لمدة 10 ثواني
            },
            body: JSON.stringify({ price: price })
        };
    } catch (error) {
        console.error("Price Fetch Error", error);
        // سعر احتياطي تقريبي في حالة فشل الاتصال (مثلاً 50 دولار)
        return { statusCode: 200, body: JSON.stringify({ price: 50.0 }) };
    }
};
