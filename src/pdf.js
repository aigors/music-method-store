'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');

// pdfjs-dist legacy per estrazione outline (sommario) server-side
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

const { getBookById, hasPurchased, createViewToken, consumeViewToken, cleanup, getIpPrefix, hashDeviceFingerprint, getTokenSource } = require('./db');
const { logTokenCreate, logStreamChunk, logTokenReuse, ACTIONS } = require('./audit');

const PDF_DIR = process.env.PDF_DIR || path.resolve(__dirname, '..', 'data', 'pdfs');
const CACHE_DIR = process.env.CACHE_DIR || path.resolve(__dirname, '..', 'data', 'cache');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ============================================================
   ESTRAZIONE OUTLINE (sommario/indice) dal PDF
   ============================================================ */

// CanvasFactory per @napi-rs/canvas (come in pdf-raster.js / catalog.js)
function makeCanvasFactory() {
  let napiCanvas;
  try {
    napiCanvas = require('@napi-rs/canvas');
  } catch (e) {
    throw new Error('@napi-rs/canvas non installato');
  }
  class NapiCanvasFactory {
    constructor({ enableHWA = false } = {}) { this.enableHWA = enableHWA; }
    create(width, height) {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      const canvas = napiCanvas.createCanvas(width, height);
      const context = canvas.getContext('2d', { willReadFrequently: !this.enableHWA });
      return { canvas, context };
    }
    reset(canvasAndContext, width, height) {
      if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    }
    destroy(canvasAndContext) {
      if (!canvasAndContext.canvas) throw new Error('Canvas is not specified');
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    }
  }
  return new NapiCanvasFactory();
}

/**
 * Risolve la destinazione di una voce di outline verso il numero di pagina (1-indexed).
 * Supporta dest come array ([ref, ...]) o come named destination (stringa).
 */
async function resolveOutlinePage(pdfDoc, dest) {
  if (!dest) return null;
  let target = dest;
  if (typeof dest === 'string') {
    try { target = await pdfDoc.getDestination(dest); } catch { return null; }
    if (!target) return null;
  }
  const ref = target[0];
  if (!ref || typeof ref === 'string' || typeof ref === 'number') return null;
  try {
    const pageIndex = await pdfDoc.getPageIndex(ref);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

async function walkOutline(pdfDoc, items) {
  const out = [];
  for (const item of items || []) {
    const page = await resolveOutlinePage(pdfDoc, item.dest);
    const children = item.items && item.items.length ? await walkOutline(pdfDoc, item.items) : [];
    out.push({
      title: (item.title || '').trim(),
      page: page || null,
      children
    });
  }
  return out;
}

/**
 * Estrae il sommario (outline) del PDF, con cache su disco chiave (bookId, mtime).
 * Ritorna [] se il PDF non ha outline.
 */
async function getOutlineForBook(bookId) {
  const book = getBookById(bookId);
  if (!book) return [];
  const sourcePath = path.join(PDF_DIR, book.pdfFile);
  if (!fs.existsSync(sourcePath)) return [];

  const stat = fs.statSync(sourcePath);
  const cacheFile = path.join(CACHE_DIR, `outline-${bookId}-${stat.mtimeMs}.json`);
  if (fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}
  }

  const data = new Uint8Array(fs.readFileSync(sourcePath));
  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    canvasFactory: makeCanvasFactory()
  });

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
    const outline = await pdfDoc.getOutline();
    const result = outline && outline.length ? await walkOutline(pdfDoc, outline) : [];
    // Cache anche il risultato vuoto (il nome file include mtime → si invalida
    // da solo quando il PDF cambia): evita il re-parse a ogni apertura del viewer.
    try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch {}
    return result;
  } catch (err) {
    console.error('Outline error:', err.message);
    return [];
  }
}

/* ============================================================
   WATERMARK dinamico (visibile + forense invisibile LSB)
   ============================================================ */

/**
 * Converte stringa in array di bit
 */
function stringToBits(str) {
  const bits = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    for (let b = 7; b >= 0; b--) {
      bits.push((code >> b) & 1);
    }
  }
  return bits;
}

/**
 * Embed bit nei LSB dei pixel di un'immagine JPEG/PNG embeddata
 * Nota: pdf-lib non espone accesso diretto ai pixel delle immagini embeddate.
 * Questa funzione è un placeholder per futura implementazione con node-canvas
 * o manipolazione diretta del stream PDF.
 *
 * Per ora implementiamo un watermark invisibile alternativo:
 * - Aggiunge pattern di testo invisibile (opacity 0, render mode 3 = invisible)
 * - Sopravvive a estrazione testo ma non a screenshot
 * - Versione futura: LSB su immagini rasterizzate
 */
async function embedInvisibleWatermark(pdfDoc, page, payload, options = {}) {
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Testo invisibile (render mode 3 = invisible, opacity 0)
  // Posizionato in area margine bianco (bottom-left)
  const text = `WM:${payload}`;
  page.drawText(text, {
    x: 10,
    y: 10,
    size: 1,
    font,
    color: rgb(1, 1, 1), // bianco su bianco
    opacity: 0,           // completamente trasparente
    renderMode: 3         // invisible text (né fill né stroke)
  });

  // Secondo watermark invisibile in area opposta
  page.drawText(text, {
    x: width - 10,
    y: height - 10,
    size: 1,
    font,
    color: rgb(1, 1, 1),
    opacity: 0,
    renderMode: 3
  });
}

/**
 * Watermark visibile configurabile
 */
function drawVisibleWatermark(page, { width, height, font, fontBold, text, opacity, fontSize, angle, pages, spacingX, spacingY }) {
  // Watermark diagonale ripetuto
  const spX = spacingX || 180;
  const spY = spacingY || 140;
  const cols = Math.ceil(width / spX) + 1;
  const rows = Math.ceil(height / spY) + 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * spacingX - (row % 2) * (spacingX / 2);
      const y = row * spacingY;

      page.drawText(text, {
        x, y,
        size: fontSize || 10,
        font,
        color: rgb(0.4, 0.4, 0.4),
        opacity: opacity || 0.2,
        rotate: degrees(angle || 30)
      });
    }
  }

  // Header in alto a destra
  page.drawText(`Utente: ${text.split(' — ')[1] || ''}`, {
    x: width - 220, y: height - 30,
    size: 8, font: fontBold, color: rgb(0.2, 0.2, 0.2), opacity: 0.5
  });
  const timestamp = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  page.drawText(`Accesso: ${timestamp}`, {
    x: width - 220, y: height - 42,
    size: 8, font, color: rgb(0.2, 0.2, 0.2), opacity: 0.5
  });
}

/**
 * Applica watermark completo (visibile + invisibile) con opzioni per-book
 * @param {string} sourcePdfPath - PDF sorgente
 * @param {string} userEmail - email utente
 * @param {string} outputPdfPath - output
 * @param {Object} book - record libro con config watermark (highSecurity, watermarkOpacity, watermarkText, watermarkPages)
 * @param {number} userId - ID utente per watermark forense
 */
async function applyWatermark(sourcePdfPath, userEmail, outputPdfPath, book = {}, userId = null) {
  const pdfBytes = fs.readFileSync(sourcePdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const timestamp = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  // Testo watermark: custom o default
  const customText = book.watermarkText;
  const watermarkText = customText
    ? customText.replace('{email}', userEmail).replace('{timestamp}', timestamp).replace('{userId}', userId || '')
    : `Music Method Store — ${userEmail} — ${timestamp}`;

  // Opacità configurabile (default 0.25)
  const opacity = typeof book.watermarkOpacity === 'number' ? book.watermarkOpacity : 0.25;

  // Pagine da watermarkare
  const watermarkPages = book.watermarkPages || 'all';
  const pageIndices = getPageIndices(watermarkPages, pages.length);

  // Payload forense per watermark invisibile
  const forensicPayload = `${userId || 0}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`;

  for (const pageIndex of pageIndices) {
    if (pageIndex < 0 || pageIndex >= pages.length) continue;
    const page = pages[pageIndex];
    const { width, height } = page.getSize();

    // 1. Watermark visibile
    drawVisibleWatermark(page, {
      width, height, font, fontBold,
      text: watermarkText,
      opacity,
      fontSize: 10,
      angle: 30
    });

    // 2. Watermark invisibile (forense) - se highSecurity o sempre per tracciabilità
    if (book.highSecurity || true) { // sempre per ora
      await embedInvisibleWatermark(pdfDoc, page, forensicPayload);
    }
  }

  const watermarkedBytes = await pdfDoc.save();
  fs.writeFileSync(outputPdfPath, watermarkedBytes);
}

/**
 * Parse watermarkPages string ("all", "1-3", "last-2", "first-last", "1,3,5")
 * @returns {number[]} array di indici pagine (0-based)
 */
function getPageIndices(spec, totalPages) {
  if (!spec || spec === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i);
  }

  const indices = new Set();
  const parts = spec.split(',').map(s => s.trim());

  for (const part of parts) {
    if (part === 'last') {
      indices.add(totalPages - 1);
    } else if (part.startsWith('last-')) {
      const n = parseInt(part.substring(5), 10);
      for (let i = Math.max(0, totalPages - n); i < totalPages; i++) {
        indices.add(i);
      }
    } else if (part === 'first') {
      indices.add(0);
    } else if (part.startsWith('first-')) {
      const n = parseInt(part.substring(6), 10);
      for (let i = 0; i < Math.min(n, totalPages); i++) {
        indices.add(i);
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(s => parseInt(s, 10));
      for (let i = Math.max(0, start - 1); i < Math.min(totalPages, end); i++) {
        indices.add(i);
      }
    } else {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= totalPages) indices.add(p - 1);
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

/* ============================================================
   API PDF (richiede auth + 2FA via middleware in app.js)
   ============================================================ */

// POST /api/pdf/view-token — crea token vista per un libro acquistato
router.post('/view-token', async (req, res) => {
  const startTime = Date.now();
  const { bookId, deviceFingerprint } = req.body;
  const userId = req.session.user.id;
  const userEmail = req.session.user.email;

  const book = getBookById(bookId);
  if (!book || !book.isActive) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  if (!hasPurchased(userId, bookId)) {
    return res.status(403).json({ error: 'Non hai acquistato questo metodo' });
  }

  // Estrai IP e calcola prefix
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const ipPrefix = getIpPrefix(clientIp);
  const userAgent = req.headers['user-agent'] || '';
  const deviceFpHash = deviceFingerprint ? hashDeviceFingerprint(deviceFingerprint) : null;

  // Raster (highSecurity): ogni pagina è una richiesta separata + re-render di
  // zoom/resize, quindi servono molti usi e un TTL più lungo.
  // Streaming PDF: 3 usi bastano per le Range requests.
  const highSecurity = !!book.highSecurity;
  const ttlMinutes = highSecurity ? 60 : 10;
  const maxUses = highSecurity ? Math.max((book.pages || 1) * 3, 300) : 3;

  const { token, expiresAt } = createViewToken(
    userId, bookId, ttlMinutes, maxUses,
    deviceFpHash, ipPrefix, userAgent, clientIp
  );

  // Audit log
  logTokenCreate({
    userId,
    bookId,
    token,
    ip: clientIp,
    ua: userAgent,
    highSecurity: !!book.highSecurity,
    latencyMs: Date.now() - startTime
  });

  res.json({ token, expiresAt, bookId: book.id, bookSlug: book.slug, highSecurity: !!book.highSecurity });
});

// POST /api/pdf/admin-preview-token/:bookId — token di test admin (senza verifica acquisto)
router.post('/admin-preview-token/:bookId', async (req, res) => {
  const userId = req.session.user.id;
  if (!req.session.user.isAdmin) {
    return res.status(403).json({ error: 'Solo gli amministratori possono testare i metodi' });
  }

  const bookId = parseInt(req.params.bookId, 10);
  const book = getBookById(bookId);
  if (!book || !book.isActive) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  // Nessun bind fingerprint (admin testa da qualsiasi device).
  // Raster (highSecurity): una richiesta per pagina + re-render di zoom/resize,
  // quindi molti usi e TTL più lungo.
  const highSecurity = !!book.highSecurity;
  const ttlMinutes = highSecurity ? 60 : 30;
  const maxUses = highSecurity ? Math.max((book.pages || 1) * 3, 300) : 50;

  const { token, expiresAt } = createViewToken(
    userId, bookId, ttlMinutes, maxUses,
    null, null, null, req.ip || 'unknown',
    'admin_preview'
  );

  logTokenCreate({
    userId, bookId, token,
    ip: req.ip || 'unknown',
    ua: req.headers['user-agent'] || '',
    highSecurity: !!book.highSecurity,
    latencyMs: 0
  });

  res.json({ token, expiresAt, bookId: book.id, bookSlug: book.slug, highSecurity: !!book.highSecurity });
});

// GET /api/pdf/stream/:bookId — streaming PDF con token (supporta Range)
router.get('/stream/:bookId', async (req, res) => {
  const startTime = Date.now();
  const bookId = parseInt(req.params.bookId, 10);
  const token = req.query.token;
  const userId = req.session.user.id;
  const userEmail = req.session.user.email;

  // Estrai fingerprint corrente per validazione
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || '';

  // Verifica token + fingerprint
  const tokenCheck = consumeViewToken(token, userId, bookId, null, clientIp, userAgent);

  // Log fingerprint mismatch
  if (!tokenCheck.ok && tokenCheck.reason && tokenCheck.reason.includes('mismatch')) {
    logPdfAccess({
      action: ACTIONS.TOKEN_FINGERPRINT_MISMATCH,
      userId,
      bookId,
      token,
      ip: clientIp,
      ua: userAgent,
      success: false,
      reason: tokenCheck.reason,
      latencyMs: Date.now() - startTime
    });
  }

  if (!tokenCheck.ok) {
    // Log token invalid/expired
    if (tokenCheck.reason === 'token_non_valido_o_scaduto') {
      logPdfAccess({
        action: ACTIONS.TOKEN_INVALID,
        userId,
        bookId,
        token,
        ip: clientIp,
        ua: userAgent,
        success: false,
        reason: tokenCheck.reason,
        latencyMs: Date.now() - startTime
      });
    }
    return res.status(403).json({ error: tokenCheck.reason });
  }

  const book = getBookById(bookId);
  if (!book) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  const sourcePath = path.join(PDF_DIR, book.pdfFile);
  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'File PDF sorgente mancante' });
  }

  // Cache: versione watermarkata per questo token
  const cacheName = `${bookId}_${userId}_${token.substring(0, 8)}.pdf`;
  const cachePath = path.join(CACHE_DIR, cacheName);

  if (!fs.existsSync(cachePath)) {
    try {
      await applyWatermark(sourcePath, userEmail, cachePath, book, userId);
    } catch (err) {
      console.error('Watermark error:', err);
      return res.status(500).json({ error: 'Errore preparazione PDF' });
    }
  }

  // Streaming con Range (PDF.js ne ha bisogno)
  const stat = fs.statSync(cachePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  // Log stream chunk (sample: logga solo primo chunk per richiesta)
  let chunkLogged = false;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    // Log primo chunk
    if (!chunkLogged && start === 0) {
      logStreamChunk({
        userId,
        bookId,
        token,
        ip: clientIp,
        ua: userAgent,
        pageNum: null, // PDF.js non espone pagina per range request
        chunkNum: 0,
        success: true,
        latencyMs: Date.now() - startTime
      });
      chunkLogged = true;
    }

    const file = fs.createReadStream(cachePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Disposition': `inline; filename="${book.slug}.pdf"`,
      'X-Content-Type-Options': 'nosniff'
    });
    file.pipe(res);
  } else {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Content-Disposition', `inline; filename="${book.slug}.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(cachePath).pipe(res);
  }
});

// GET /api/pdf/outline/:bookId — sommario/indice del PDF (metadata)
// Non consuma view token: sono solo metadati. Accesso: acquisto oppure token admin_preview.
router.get('/outline/:bookId', async (req, res) => {
  const bookId = parseInt(req.params.bookId, 10);
  const token = req.query.token;
  const userId = req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Non autenticato' });
  }

  const book = getBookById(bookId);
  if (!book || !book.isActive) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  const tokenSource = getTokenSource(token);
  if (tokenSource !== 'admin_preview' && !hasPurchased(userId, bookId)) {
    return res.status(403).json({ error: 'Non hai acquistato questo metodo' });
  }

  try {
    const outline = await getOutlineForBook(bookId);
    res.json({ outline });
  } catch (err) {
    console.error('Outline endpoint error:', err);
    res.status(500).json({ error: 'Errore estrazione indice' });
  }
});

// POST /api/pdf/cleanup — pulizia cache (admin)
router.post('/cleanup', (req, res) => {
  cleanup();
  const now = Date.now();
  let removed = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    const filePath = path.join(CACHE_DIR, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      removed++;
    }
  }
  res.json({ ok: true, removedFiles: removed });
});

module.exports = router;