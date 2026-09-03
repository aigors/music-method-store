'use strict';

const express = require('express');
const router = express.Router();

const {
  createUser,
  findUserByEmail,
  findUserById,
  checkPassword,
  createTwoFaCode,
  verifyTwoFaCode
} = require('./db');

const { sendTwoFaEmail } = require('./mail');

/* ============================================================
   MIDDLEWARE AUTORIZZAZIONE (usati da altri router /api/*)
   ============================================================ */

function requireAuth(req, res, next) {
  if (req.session.user?.id) return next();
  return res.status(401).json({ error: 'Non autenticato', redirect: '/auth/login' });
}

function requireTwoFaVerified(req, res, next) {
  if (req.session.user?.twoFaVerified) return next();
  return res.status(403).json({ error: 'Verifica 2FA richiesta', redirect: '/auth/2fa' });
}

function requireAdmin(req, res, next) {
  if (req.session.user?.isAdmin) return next();
  return res.status(403).json({ error: 'Accesso riservato agli amministratori' });
}

/* ============================================================
   API AUTENTICAZIONE (JSON)
   ============================================================ */

// Stato utente corrente
router.get('/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Login: invia codice 2FA via mail
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password obbligatori' });
  }
  const user = findUserByEmail(email);
  if (!user || !checkPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Credenziali non valide' });
  }
  const code = createTwoFaCode(user.id);
  await sendTwoFaEmail(user.email, code);
  req.session.pendingTwoFaUserId = user.id;
  req.session.user = { id: user.id, email: user.email, twoFaVerified: false, isAdmin: !!user.isAdmin };
  res.json({ ok: true, message: 'Codice 2FA inviato a ' + user.email });
});

// Registrazione: crea utente + invia codice 2FA
router.post('/register', async (req, res) => {
  const { email, password, password2 } = req.body;
  if (!email || !password || !password2) {
    return res.status(400).json({ error: 'Tutti i campi obbligatori' });
  }
  if (password !== password2) {
    return res.status(400).json({ error: 'Le password non coincidono' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password minima 8 caratteri' });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: 'Email già registrata' });
  }
  const user = createUser(email, password);
  const code = createTwoFaCode(user.id);
  await sendTwoFaEmail(user.email, code);
  req.session.pendingTwoFaUserId = user.id;
  req.session.user = { id: user.id, email: user.email, twoFaVerified: false };
  res.json({ ok: true, message: 'Registrato. Codice 2FA inviato.' });
});

// Verifica codice 2FA
router.post('/2fa', (req, res) => {
  const { code } = req.body;
  const userId = req.session.pendingTwoFaUserId;
  if (!userId || !code) {
    return res.status(400).json({ error: 'Codice mancante' });
  }
  const result = verifyTwoFaCode(userId, code.trim());
  if (!result.ok) {
    const msg = result.reason === 'scaduto_o_inesistente'
      ? 'Codice scaduto. Richiedi un nuovo codice.'
      : 'Codice non corretto.';
    return res.status(401).json({ error: msg });
  }
  const user = findUserById(userId);
  delete req.session.pendingTwoFaUserId;
  req.session.user.twoFaVerified = true;
  req.session.user.isAdmin = !!user.isAdmin;
  res.json({ ok: true, message: '2FA verificato' });
});

// Rinvia codice 2FA
router.post('/2fa/resend', async (req, res) => {
  const userId = req.session.pendingTwoFaUserId;
  if (!userId) return res.status(400).json({ error: 'Nessuna verifica in corso' });
  const user = findUserById(userId);
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  const code = createTwoFaCode(userId);
  await sendTwoFaEmail(user.email, code);
  res.json({ ok: true });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mms.sid');
    res.json({ ok: true });
  });
});

module.exports = { router, requireAuth, requireTwoFaVerified, requireAdmin };