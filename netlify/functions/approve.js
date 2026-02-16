const fetch = require('node-fetch');

// إعدادات الباقات (يجب أن تتطابق مع الفرونت إند)
const PACKAGES = {
    150: 1,   // 150 توكين = 1 دولار
    750: 5,   // 750 توكين = 5 دولار
    1500: 10  // 1500 توكين = 10 دولار
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { paymentId } = JSON.parse(event.body);

  if (!paymentId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentId' }) };
  }

  const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
  const PI_API_BASE = 'https://api.minepi.com/v2';

  try {
    // 1. جلب تفاصيل عملية الدفع من شبكة Pi للتأكد من البيانات الحقيقية
    const paymentRes = await fetch(`${PI_API_BASE}/payments/${paymentId}`, {
        headers: { 'Authorization': `Key ${PI_SECRET_KEY}` }
    });
    
    if (!paymentRes.ok) throw new Error("Failed to fetch payment details");
    
    const paymentData = await paymentRes.json();
    const paidAmount = parseFloat(paymentData.amount);
    const metadata = paymentData.metadata; // يحتوي على عدد التوكين المطلوب

    // 2. التحقق من التلاعب
    // هل يوجد metadata؟ وهل نوعه شراء توكين؟
    if (!metadata || metadata.type !== 'tokens' || !PACKAGES[metadata.tokenAmount]) {
        return { statusCode: 400, body: JSON.stringify({ error: "Invalid payment metadata" }) };
    }

    // 3. جلب سعر العملة الحالي من OKX (نفس المصدر المستخدم في الفرونت إند)
    // لضمان أننا نحاسب المستخدم بسعر عادل
    let currentPiPrice = 40.0; // سعر احتياطي
    try {
        const okxRes = await fetch('https://www.okx.com/api/v5/market/ticker?instId=PI-USDT');
        const okxData = await okxRes.json();
        if (okxData.data && okxData.data[0]) {
            currentPiPrice = parseFloat(okxData.data[0].last);
        }
    } catch (e) {
        console.error("Price fetch failed in approve, using backup");
    }

    // 4. الحساب: كم المفروض يدفع؟
    const usdValue = PACKAGES[metadata.tokenAmount]; // كم دولار تساوي هذه الباقة
    const expectedPi = usdValue / currentPiPrice;

    // السماح بهامش خطأ بسيط جداً (10%) بسبب تغير السعر اللحظي بين ضغطة الزر والوصول للسيرفر
    // إذا دفع المستخدم أقل من 90% من المبلغ المطلوب، نرفض العملية
    const minAcceptedAmount = expectedPi * 0.90;

    if (paidAmount < minAcceptedAmount) {
        console.log(`Fraud Attempt! Expected: ${expectedPi}, Paid: ${paidAmount}`);
        // نرفض العملية ولا نوافق عليها
        return { 
            statusCode: 400, 
            body: JSON.stringify({ error: "Price mismatch (Fraud protection)" }) 
        };
    }

    // 5. إذا وصل هنا، المبلغ سليم. نقوم بالموافقة (Approve)
    const approveRes = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}) 
    });

    if (approveRes.ok) {
      return { statusCode: 200, body: JSON.stringify({ approved: true }) };
    } else {
      const error = await approveRes.json();
      return { statusCode: approveRes.status, body: JSON.stringify({ error }) };
    }

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
