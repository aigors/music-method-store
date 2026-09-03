'use strict';

const express = require('express');
const router = express.Router();
const paypal = require('@paypal/checkout-server-sdk');
const { getBookById, hasPurchased, createPurchase } = require('./db');

/* ============================================================
   CONFIG PAYPAL (server-side only)
   ============================================================ */

let paypalClient = null;

function getPaypalClient() {
  if (paypalClient) return paypalClient;

  const env = process.env.PAYPAL_ENV === 'live'
    ? paypal.core.LiveEnvironment
    : paypal.core.SandboxEnvironment;

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET non configurati');
  }

  paypalClient = new paypal.core.PayPalHttpClient(new env(clientId, clientSecret));
  return paypalClient;
}

/* ============================================================
   API PAGAMENTI (richiede auth via middleware in app.js)
   ============================================================ */

// POST /api/payment/create-order — crea ordine PayPal
router.post('/create-order', async (req, res) => {
  const { bookId } = req.body;
  const userId = req.session.user.id;

  if (!bookId) {
    return res.status(400).json({ error: 'bookId mancante' });
  }

  const book = getBookById(bookId);
  if (!book || !book.isActive) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  if (hasPurchased(userId, bookId)) {
    return res.status(409).json({ error: 'Hai già acquistato questo metodo' });
  }

  const amount = (book.priceCents / 100).toFixed(2);
  const currency = 'EUR';

  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer('return=representation');
  request.requestBody({
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: currency, value: amount },
      description: `Metodo musicale: ${book.title} (${book.author})`,
      custom_id: `${userId}:${bookId}`
    }],
    application_context: {
      brand_name: 'Music Method Store',
      locale: 'it-IT',
      landing_page: 'LOGIN',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: `${process.env.BASE_URL}/payment/success`,
      cancel_url: `${process.env.BASE_URL}/payment/cancel`
    }
  });

  try {
    const order = await getPaypalClient().execute(request);
    res.json({ orderId: order.result.id });
  } catch (err) {
    console.error('PayPal create order error:', err);
    res.status(500).json({ error: 'Errore creazione ordine PayPal' });
  }
});

// POST /api/payment/capture-order — cattura ordine dopo approvazione
router.post('/capture-order', async (req, res) => {
  const { orderId } = req.body;
  const userId = req.session.user.id;

  if (!orderId) {
    return res.status(400).json({ error: 'orderId mancante' });
  }

  const request = new paypal.orders.OrdersCaptureRequest(orderId);
  request.requestBody({});

  try {
    const capture = await getPaypalClient().execute(request);
    const result = capture.result;

    if (result.status === 'COMPLETED') {
      const pu = result.purchase_units[0];
      const [uid, bid] = (pu.custom_id || '').split(':').map(Number);

      if (uid === userId && bid) {
        const amountCents = Math.round(parseFloat(pu.amount.value) * 100);
        createPurchase(uid, bid, result.id, amountCents, pu.amount.currency_code);
        return res.json({ ok: true, purchaseId: result.id });
      }
    }

    res.status(400).json({ error: 'Pagamento non completato', status: result.status });
  } catch (err) {
    console.error('PayPal capture error:', err);
    res.status(500).json({ error: 'Errore cattura pagamento' });
  }
});

// POST /api/payment/webhook — webhook PayPal (opzionale)
router.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (webhookId) {
    console.log('🔔  Webhook PayPal ricevuto:', req.body);
  }
  res.sendStatus(200);
});

module.exports = router;