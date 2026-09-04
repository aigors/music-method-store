'use strict';

const express = require('express');
const router = express.Router();
const paypal = require('@paypal/checkout-server-sdk');
const { getBookById, hasPurchased, createPurchase } = require('./db');

/* ============================================================
   CONFIG PAYPAL (server-side only)
   ============================================================ */

let paypalClient = null;

// Mappa orderId → { userId, bookId } — usata perché PayPal non restituisce custom_id nel capture
const pendingOrders = new Map();

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
      landing_page: 'NO_PREFERENCE',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'PAY_NOW',
      return_url: `${process.env.BASE_URL}/payment/success`,
      cancel_url: `${process.env.BASE_URL}/payment/cancel`
    }
  });

  try {
    console.log('[PayPal] Creating order for user:', userId, 'book:', bookId, 'amount:', amount);
    const order = await getPaypalClient().execute(request);
    const orderId = order.result.id;
    console.log('[PayPal] Order created:', orderId);

    // Salva la mappatura per recuperarla al capture (PayPal non restituisce custom_id)
    pendingOrders.set(orderId, { userId, bookId });

    res.json({ orderId });
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
    console.log('[PayPal] Capture order:', orderId, 'by user:', userId);
    const capture = await getPaypalClient().execute(request);
    const result = capture.result;
    console.log('[PayPal] Capture result status:', result.status);

    if (result.status === 'COMPLETED') {
      // Recupera la mappatura salvata alla creazione dell'ordine
      const pending = pendingOrders.get(orderId);
      pendingOrders.delete(orderId);

      if (pending && pending.userId === userId && pending.bookId) {
        console.log('[PayPal] Capture result keys:', Object.keys(result));
        console.log('[PayPal] purchase_units:', JSON.stringify(result.purchase_units, null, 2));
        const pu = result.purchase_units && result.purchase_units[0];
        if (!pu) {
          console.error('[PayPal] purchase_units vuoto nella risposta');
          const book = require('./db').getBookById(pending.bookId);
          const amountCents = book ? book.priceCents : 0;
          createPurchase(userId, pending.bookId, result.id, amountCents, 'EUR');
          console.log('[PayPal] ✅ Purchase created (fallback) for user', userId, 'book', pending.bookId);
          return res.json({ ok: true, purchaseId: result.id });
        }
        // Estrai importo in modo difensivo (la struttura può variare)
        const amountValue = pu.amount?.value || pu.payments?.captures?.[0]?.amount?.value;
        const currency = pu.amount?.currency_code || pu.payments?.captures?.[0]?.amount?.currency_code || 'EUR';
        const amountCents = amountValue ? Math.round(parseFloat(amountValue) * 100) : 0;
        console.log('[PayPal] Amount:', amountValue, currency, '→ cents:', amountCents);
        createPurchase(userId, pending.bookId, result.id, amountCents, currency);
        console.log('[PayPal] ✅ Purchase created for user', userId, 'book', pending.bookId);
        return res.json({ ok: true, purchaseId: result.id });
      }
      console.warn('[PayPal] Pending order non trovata o userId mismatch');
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