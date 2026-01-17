exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  
  const { paymentId, txid } = JSON.parse(event.body);
  
  if (!paymentId || !txid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing paymentId or txid' }) };
  }
  
  const PI_SECRET_KEY = process.env.PI_SECRET_KEY;
  const PI_API_BASE = 'https://api.minepi.com/v2';
  
  try {
    const response = await fetch(`${PI_API_BASE}/payments/${paymentId}/complete`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txid }),
    });
    
    if (response.ok) {
      const data = await response.json();
      return { statusCode: 200, body: JSON.stringify({ completed: true, data }) };
    } else {
      const error = await response.json();
      return { statusCode: response.status, body: JSON.stringify({ error }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
