const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

const PI_HORIZON_URL = 'https://api.testnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Testnet';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (statusCode, payload) => ({
  statusCode,
  headers,
  body: JSON.stringify(payload),
});

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function isValidAmount(n) {
  return Number.isFinite(n) && n > 0;
}
function clampBalance(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, num);
}
function isValidStellarPublicKey(address) {
  try {
    return StellarSdk.StrKey.isValidEd25519PublicKey(address);
  } catch (_) {
    return false;
  }
}

/**
 * ✅ مستحقات الدليفري:
 * total_pi - platform_fee_pi
 * fallback: price_pi + delivery_fee_pi
 * fallback: delivery_fee_pi
 */
function deliveryPayoutFromSnapshot(snapshot) {
  const s = snapshot || {};
  const total = toNum(s.total_pi);
  const platform = toNum(s.platform_fee_pi);

  if (total > 0) {
    const payout = total - platform;
    return payout > 0 ? payout : 0;
  }

  const price = toNum(s.price_pi);
  const deliveryFee = toNum(s.delivery_fee_pi);
  if (price > 0 || deliveryFee > 0) return Math.max(0, price + deliveryFee);

  return Math.max(0, deliveryFee);
}

// ✅ createClient جوّه runtime بعد التأكد من env
function getDb() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    throw new Error(`Missing env: ${missing.join(', ')}`);
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

async function getWithdrawnSum(db, uid) {
  const { data, error } = await db
    .from('withdrawals')
    .select('amount')
    .eq('pi_user_id', uid)
    .limit(5000);

  if (error) throw new Error(error.message);
  return (data || []).reduce((sum, r) => sum + toNum(r.amount), 0);
}

async function getEarnedSum(db, uid) {
  // 1) delivery_wallet (اختياري)
  const walletRes = await db
    .from('delivery_wallet')
    .select('balance_pi')
    .eq('delivery_id', uid)
    .maybeSingle();

  if (!walletRes.error && walletRes.data && walletRes.data.balance_pi !== null) {
    return toNum(walletRes.data.balance_pi);
  }

  // 2) delivery_earnings
  const earnRes = await db
    .from('delivery_earnings')
    .select('amount_pi')
    .eq('delivery_id', uid)
    .limit(5000);

  if (!earnRes.error && earnRes.data && earnRes.data.length) {
    return (earnRes.data || []).reduce((sum, r) => sum + toNum(r.amount_pi), 0);
  }

  // 3) fallback من orders
  const ordersRes = await db
    .from('orders')
    .select('pricing_snapshot')
    .eq('delivery_id', uid)
    .eq('status', 'delivered')
    .limit(5000);

  if (ordersRes.error) throw new Error(ordersRes.error.message);

  return (ordersRes.data || []).reduce((sum, o) => {
    return sum + deliveryPayoutFromSnapshot(o?.pricing_snapshot);
  }, 0);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;
    if (!APP_WALLET_SECRET) return json(500, { error: 'APP_WALLET_SECRET is not defined' });

    const db = getDb(); // ✅ هنا بس

    const body = JSON.parse(event.body || '{}');

    const uid = body.uid;
    const username = body.username || null;
    const walletAddress = (body.walletAddress || '').trim();
    const withdrawAmount = Number(body.amount);

    if (!uid || !walletAddress || body.amount === undefined) {
      return json(400, { error: 'بيانات ناقصة', required: ['uid', 'amount', 'walletAddress'] });
    }
    if (!isValidAmount(withdrawAmount)) return json(400, { error: 'قيمة السحب غير صحيحة' });
    if (!isValidStellarPublicKey(walletAddress)) {
      return json(400, { error: 'عنوان المحفظة غير صحيح (Stellar/Pi address)' });
    }

    // رصيد الدليفري = (منتجات + توصيل) - مسحوبات
    const earned = await getEarnedSum(db, uid);
    const withdrawn = await getWithdrawnSum(db, uid);
    const currentBalance = clampBalance(earned - withdrawn);

    if (currentBalance < withdrawAmount) {
      return json(400, {
        error: 'رصيد حسابك غير كافٍ',
        balance: Number(currentBalance.toFixed(7)),
        requested: Number(withdrawAmount.toFixed(7)),
      });
    }

    // تحويل على testnet
    const server = new StellarSdk.Horizon.Server(PI_HORIZON_URL);
    const sourceKeys = StellarSdk.Keypair.fromSecret(APP_WALLET_SECRET);
    const sourceAccount = await server.loadAccount(sourceKeys.publicKey());

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: withdrawAmount.toFixed(7),
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(sourceKeys);

    const result = await server.submitTransaction(tx);

    // تسجيل في withdrawals
    const { error: insertErr } = await db.from('withdrawals').insert([
      { pi_user_id: uid, username, amount: withdrawAmount, wallet_address: walletAddress, txid: result.hash },
    ]);

    const balanceAfter = clampBalance(currentBalance - withdrawAmount);

    if (insertErr) {
      return json(200, {
        success: true,
        txid: result.hash,
        message: 'تم التحويل (لكن فشل تسجيل العملية في قاعدة البيانات)',
        db_error: insertErr.message,
        balance_before: Number(currentBalance.toFixed(7)),
        withdrawn: Number(withdrawAmount.toFixed(7)),
        balance_after: Number(balanceAfter.toFixed(7)),
      });
    }

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
      balance_before: Number(currentBalance.toFixed(7)),
      withdrawn: Number(withdrawAmount.toFixed(7)),
      balance_after: Number(balanceAfter.toFixed(7)),
    });
  } catch (err) {
    console.error('withdraw error:', err);
    return json(500, { error: 'فشلت المعاملة', details: err?.message || 'Unknown error' });
  }
};
