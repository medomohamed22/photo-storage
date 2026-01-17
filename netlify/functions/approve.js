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
    const response = await fetch(`${PI_API_BASE}/payments/${paymentId}/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${PI_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      return { statusCode: 200, body: JSON.stringify({ approved: true }) };
    } else {
      const error = await response.json();
      return { statusCode: response.status, body: JSON.stringify({ error }) };
    }
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
