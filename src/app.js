'use strict';

const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { router: authRouter, requireAuth, requireTwoFaVerified, requireAdmin } = require('./auth');
const catalogRouter = require('./catalog');
const paymentRouter = require('./payment');
const pdfRouter = require('./pdf');
const pdfRasterRouter = require('./pdf-raster');
const adminRouter = require('./admin');
const { PDF_DIR } = require('./db');

/**
 * Crea l'applicazione Express configurata.
 */
function createApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === 'production';

  // ========================================================
  // Sicurezza di base (Helmet) — CSP con nonce per script inline
  // ========================================================
  // Middleware per generare CSP nonce per request
  app.use((req, res, next) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals.cspNonce = nonce;
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`], // nonce per script inline
        styleSrc: ["'self'", "'unsafe-inline'"], // style inline per PDF.js canvas
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Trusted Types
        trustedTypes: ["viewer", "allow-duplicates"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' }, // no-referrer per privacy
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false
  }));

  // Trusted Types header (richiede CSP trustedTypes directive)
  app.use((req, res, next) => {
    res.setHeader('Trusted-Types', 'viewer');
    next();
  });

  // ========================================================
  // Parsing
  // ========================================================
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  // ========================================================
  // Static files (public/)
  // ========================================================
  const publicDir = path.join(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { maxAge: isProd ? '30d' : 0 }));
  }

  // Copertine libri (salvate in data/pdfs/, nome file = book.coverFile)
  if (fs.existsSync(PDF_DIR)) {
    app.use('/covers', express.static(PDF_DIR, { maxAge: isProd ? '7d' : 0 }));
  }

  // ========================================================
  // Sessione
  // ========================================================
  const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  if (!process.env.SESSION_SECRET && isProd) {
    console.warn('\n⚠  ATTENZIONE: SESSION_SECRET non impostato in produzione!\n');
  }

  app.use(session({
    name: 'mms.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 8
    }
  }));

  // ========================================================
  // Rate limiting
  // ========================================================
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Troppe richieste, riprova tra un minuto.' }
  });
  app.use(globalLimiter);

  const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Troppi tentativi, riprova tra 15 minuti.' }
  });

  // ========================================================
  // Helper: user in locals
  // ========================================================
  app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
  });

  // ========================================================
  // Config pubblica per frontend
  // ========================================================
  app.get('/api/config', (req, res) => {
    res.json({
      paypalClientId: process.env.PAYPAL_CLIENT_ID,
      baseUrl: process.env.BASE_URL
    });
  });

  // ========================================================
  // API ROUTERS (sotto /api/*)
  // ========================================================
  app.use('/api/auth', strictLimiter, authRouter);
  app.use('/api/catalog', catalogRouter);
  app.use('/api/payment', requireAuth, paymentRouter);
  app.use('/api/pdf', requireAuth, requireTwoFaVerified, pdfRouter);
  app.use('/api/pdf', requireAuth, requireTwoFaVerified, pdfRasterRouter.router);
  app.use('/api/admin', requireAuth, requireAdmin, adminRouter);

  // ========================================================
  // Helper: serve file HTML con CSP nonce injection
  // ========================================================
  function serveHtmlPage(req, res, filename) {
    const filePath = path.join(publicDir, filename);
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) return res.status(500).send('Errore caricamento pagina');
      const nonce = res.locals.cspNonce;
      const rendered = content.replace(/\{\{cspNonce\}\}/g, nonce);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rendered);
    });
  }

  // ========================================================
  // PAGINE HTML (servite da public/ con URL puliti)
  // ========================================================

  // Home → catalogo
  app.get('/', (req, res) => {
    serveHtmlPage(req, res, 'index.html');
  });

  // Catalogo
  app.get('/catalogo', (req, res) => {
    serveHtmlPage(req, res, 'catalog.html');
  });
  app.get('/catalog', (req, res) => {
    serveHtmlPage(req, res, 'catalog.html');
  });

  // Login
  app.get('/login', (req, res) => {
    serveHtmlPage(req, res, 'login.html');
  });
  app.get('/auth/login', (req, res) => {
    serveHtmlPage(req, res, 'login.html');
  });

  // Registrazione
  app.get('/registrati', (req, res) => {
    serveHtmlPage(req, res, 'register.html');
  });
  app.get('/register', (req, res) => {
    serveHtmlPage(req, res, 'register.html');
  });
  app.get('/auth/register', (req, res) => {
    serveHtmlPage(req, res, 'register.html');
  });

  // 2FA
  app.get('/2fa', (req, res) => {
    serveHtmlPage(req, res, '2fa.html');
  });
  app.get('/auth/2fa', (req, res) => {
    serveHtmlPage(req, res, '2fa.html');
  });

  // Viewer PDF (richiede login + 2FA + token — gestito lato client)
  // Serve viewer.html con CSP nonce
  function serveViewer(req, res) {
    const viewerPath = path.join(publicDir, 'viewer.html');
    fs.readFile(viewerPath, 'utf8', (err, content) => {
      if (err) return res.status(500).send('Errore caricamento viewer');
      const nonce = res.locals.cspNonce;
      const rendered = content.replace(/\{\{cspNonce\}\}/g, nonce);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rendered);
    });
  }

  app.get('/viewer/:bookId', serveViewer);
  app.get('/pdf/viewer/:bookId', serveViewer);

  // Account / acquisti
  app.get('/account', (req, res) => {
    serveHtmlPage(req, res, 'account.html');
  });

  // Pannello admin (richiede login + 2FA + isAdmin) - serve con CSP nonce
  function serveAdmin(req, res) {
    if (!req.session.user?.isAdmin) {
      return res.status(403).sendFile(path.join(publicDir, '404.html'));
    }
    const adminPath = path.join(publicDir, 'admin.html');
    fs.readFile(adminPath, 'utf8', (err, content) => {
      if (err) return res.status(500).send('Errore caricamento admin');
      const nonce = res.locals.cspNonce;
      const rendered = content.replace(/\{\{cspNonce\}\}/g, nonce);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(rendered);
    });
  }

  app.get('/admin', requireAuth, requireTwoFaVerified, serveAdmin);

  // PayPal return URLs (richiedono login per completare l'acquisto)
  app.get('/payment/success', requireAuth, requireTwoFaVerified, (req, res) => {
    serveHtmlPage(req, res, 'payment-success.html');
  });
  app.get('/payment/cancel', requireAuth, requireTwoFaVerified, (req, res) => {
    serveHtmlPage(req, res, 'payment-cancel.html');
  });

  // ========================================================
  // 404 & error handler
  // ========================================================
  app.use((req, res) => {
    const filePath = path.join(publicDir, '404.html');
    fs.readFile(filePath, 'utf8', (err, content) => {
      if (err) return res.status(404).send('Pagina non trovata');
      const nonce = res.locals.cspNonce;
      const rendered = content.replace(/\{\{cspNonce\}\}/g, nonce);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(404).send(rendered);
    });
  });

  app.use((err, req, res, next) => {
    console.error('❌  Errore server:', err);
    const status = err.status || 500;
    res.status(status).json({
      error: isProd ? 'Errore interno del server' : err.message
    });
  });

  return app;
}

module.exports = { createApp };