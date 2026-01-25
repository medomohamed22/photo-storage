// netlify/functions/withdraw.js
'use strict';

const StellarSdk = require('stellar-sdk');
const { createClient } = require('@supabase/supabase-js');

/* ================== CONFIG ================== */
// ملاحظة هامة: تم إزالة القيم النصية (Hardcoded) لمنع أخطاء الأمان في Netlify
// يجب التأكد من إضافة هذه المتغيرات في لوحة تحكم Netlify: Site Settings > Environment Variables

const SUPABASE_URL = 'https://axjkwrssmofzavaoqutq.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// App wallet (TESTNET secret)
const APP_WALLET_SECRET = process.env.APP_WALLET_SECRET;

// Pi TESTNET Horizon & Passphrase
const PI_HORIZON_URL = process.env.PI_HORIZON_URL;
const NETWORK_PASSPHRASE = process.env.PI_NETWORK_PASSPHRASE;

// Server-side Supabase client (service role)
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/* ================== HELPERS ================== */
const json = (statusCode, obj) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  },
  body: JSON.stringify(obj),
});

const safeParse = (s) => {
  try { return JSON.parse(s || '{}'); } catch { return {}; }
};

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ================== HANDLER ================== */
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return json(200, { ok: true });

  // POST only
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    // التحقق من وجود المتغيرات الهامة قبل البدء
    if (!SUPABASE_SERVICE_ROLE_KEY) return json(500, { error: 'Missing SUPABASE_SERVICE_ROLE_KEY' });
    if (!APP_WALLET_SECRET) return json(500, { error: 'Missing APP_WALLET_SECRET' });
    if (!PI_HORIZON_URL) return json(500, { error: 'Missing PI_HORIZON_URL' });
    if (!NETWORK_PASSPHRASE) return json(500, { error: 'Missing PI_NETWORK_PASSPHRASE' });

    const body = safeParse(event.body);
    const uid = String(body.uid || '').trim();
    const username = String(body.username || '').trim();
    const walletAddress = String(body.walletAddress || '').trim();
    const withdrawAmount = Number.parseFloat(body.amount);

    if (!uid || !walletAddress || !Number.isFinite(withdrawAmount) || withdrawAmount <= 0) {
      return json(400, { error: 'بيانات ناقصة أو غير صحيحة' });
    }

    /* ---------- 1) Balance check (donations - withdrawals) ---------- */
    const { data: donations, error: e1 } = await supabase
      .from('donations')
      .select('amount')
      .eq('pi_user_id', uid);

    if (e1) throw e1;

    const { data: withdrawals, error: e2 } = await supabase
      .from('withdrawals')
      .select('amount')
      .eq('pi_user_id', uid);

    if (e2) throw e2;

    const totalDonated = (donations || []).reduce((s, r) => s + toNum(r.amount), 0);
    const totalWithdrawn = (withdrawals || []).reduce((s, r) => s + toNum(r.amount), 0);
    const currentBalance = totalDonated - totalWithdrawn;

    if (currentBalance + 1e-12 < withdrawAmount) {
      return json(400, { error: 'رصيد حسابك غير كافٍ' });
    }

    /* ---------- 2) Stellar transfer (Pi Testnet) ---------- */
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
      .setTimeout(60)
      .build();

    tx.sign(sourceKeys);
    const result = await server.submitTransaction(tx);

    /* ---------- 3) Log withdrawal in Supabase ---------- */
    const { error: e3 } = await supabase.from('withdrawals').insert([{
      pi_user_id: uid,
      username: username || null,
      amount: withdrawAmount,
      wallet_address: walletAddress,
      txid: result.hash,
    }]);

    if (e3) throw e3;

    return json(200, {
      success: true,
      txid: result.hash,
      message: 'تم التحويل بنجاح',
    });

  } catch (err) {
    console.error('withdraw error:', err);

    let errorResponse = { error: 'فشلت المعاملة', details: err?.message || 'Unknown' };

    // Stellar/Horizon structured errors
    if (err?.response?.data?.extras?.result_codes) {
      const codes = err.response.data.extras.result_codes;
      const ops = codes.operations ? codes.operations.join(', ') : 'no_op_code';
      errorResponse.details = `Blockchain Error: ${codes.transaction} (${ops})`;

      if (codes.transaction === 'tx_insufficient_fee') {
        errorResponse.error = 'رسوم الشبكة مرتفعة حالياً، حاول مرة أخرى';
      } else if (String(ops).includes('op_underfunded')) {
        errorResponse.error = 'محفظة النظام تحتاج شحن رصيد';
      } else if (String(ops).includes('op_no_destination')) {
        errorResponse.error = 'عنوان المحفظة غير صحيح أو غير مُفعل';
      }
    }

    // common 404 case = wrong horizon URL
    if (err?.response?.status === 404) {
      errorResponse.error = 'Horizon URL غير صحيح (404)';
      errorResponse.details = `راجع PI_HORIZON_URL: ${PI_HORIZON_URL}`;
    }

    return json(500, errorResponse);
  }
};
