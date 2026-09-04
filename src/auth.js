'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const {
  createUser,
  findUserByEmail,
  findUserById,
  checkPassword,
  createTwoFaCode,
  verifyTwoFaCode,
  createPasswordResetToken,
  getPasswordResetToken,
  markPasswordResetTokenUsed,
  updateUserPassword
} = require('./db');

const { sendTwoFaEmail, sendPasswordResetEmail } = require('./mail');

/* ============================================================
   RATE LIMITING (solo sugli endpoint sensibili tipo login/2FA —
   NON su /me e /logout, che vengono chiamati a ogni caricamento pagina)
   ============================================================ */
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Troppi tentativi, riprova tra 15 minuti.' }
});

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
router.post('/login', strictLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e password obbligatori' });
  }
  const user = findUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: 'Utente non registrato' });
  }
  if (!checkPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Password errata' });
  }
  const code = createTwoFaCode(user.id);
  await sendTwoFaEmail(user.email, code);
  req.session.pendingTwoFaUserId = user.id;
  req.session.user = {
    id: user.id, email: user.email, twoFaVerified: false, isAdmin: !!user.isAdmin,
    firstName: user.firstName, lastName: user.lastName,
    birthDate: user.birthDate, birthPlace: user.birthPlace
  };
  res.json({ ok: true, message: 'Codice 2FA inviato a ' + user.email });
});

// Registrazione: crea utente + invia codice 2FA
router.post('/register', strictLimiter, async (req, res) => {
  const { email, password, password2, firstName, lastName, birthDate, birthPlace } = req.body;

  if (!email || !password || !password2) {
    return res.status(400).json({ error: 'Tutti i campi obbligatori' });
  }
  if (password !== password2) {
    return res.status(400).json({ error: 'Le password non coincidono' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password minima 8 caratteri' });
  }
  // Dati anagrafici obbligatori per gli utenti registrati
  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'Nome e cognome obbligatori' });
  }
  if (!birthDate || !birthPlace) {
    return res.status(400).json({ error: 'Data e luogo di nascita obbligatori' });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: 'Email già registrata' });
  }
  const user = createUser(email, password, { firstName, lastName, birthDate, birthPlace });
  const code = createTwoFaCode(user.id);
  await sendTwoFaEmail(user.email, code);
  req.session.pendingTwoFaUserId = user.id;
  req.session.user = { id: user.id, email: user.email, twoFaVerified: false, ...user };
  res.json({ ok: true, message: 'Registrato. Codice 2FA inviato.' });
});

// Verifica codice 2FA
router.post('/2fa', strictLimiter, (req, res) => {
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
router.post('/2fa/resend', strictLimiter, async (req, res) => {
  const userId = req.session.pendingTwoFaUserId;
  if (!userId) return res.status(400).json({ error: 'Nessuna verifica in corso' });
  const user = findUserById(userId);
  if (!user) return res.status(404).json({ error: 'Utente non trovato' });
  const code = createTwoFaCode(userId);
  await sendTwoFaEmail(user.email, code);
  res.json({ ok: true });
});

/* ============================================================
   RECUPERO PASSWORD (dimenticata)
   ============================================================ */

// POST /api/auth/forgot-password — invia email con link di reset
router.post('/forgot-password', strictLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Inserisci la tua email' });
  }

  const user = findUserByEmail(email);

  // Rispondi in modo generico per non rivelare se l'email esiste
  if (user) {
    const { token } = createPasswordResetToken(user.id);
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;
    await sendPasswordResetEmail(user.email, resetUrl);
  }

  res.json({ ok: true, message: 'Se l\'email è registrata, riceverai un link per reimpostare la password.' });
});

// POST /api/auth/reset-password — imposta nuova password con token
router.post('/reset-password', strictLimiter, (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token e nuova password obbligatori' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password minima 8 caratteri' });
  }

  const reset = getPasswordResetToken(token);
  if (!reset) {
    return res.status(400).json({ error: 'Link non valido o scaduto. Richiedi un nuovo recupero.' });
  }

  updateUserPassword(reset.userId, password);
  markPasswordResetTokenUsed(token);

  // Se l'utente è loggato con sessione 2FA non verificata, mantieni pulita la sessione
  res.json({ ok: true, message: 'Password aggiornata. Ora puoi accedere con la nuova password.' });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mms.sid');
    res.json({ ok: true });
  });
});

module.exports = { router, requireAuth, requireTwoFaVerified, requireAdmin };