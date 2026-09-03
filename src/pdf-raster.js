'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// pdfjs-dist per rasterizzazione server-side
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

const { getBookById, hasPurchased, consumeViewToken, getIpPrefix, cleanup } = require('./db');
const { logRasterPage, ACTIONS } = require('./audit');

const PDF_DIR = process.env.PDF_DIR || path.resolve(__dirname, '..', 'data', 'pdfs');
const RASTER_CACHE_DIR = process.env.RASTER_CACHE_DIR || path.resolve(__dirname, '..', 'data', 'raster');

if (!fs.existsSync(RASTER_CACHE_DIR)) fs.mkdirSync(RASTER_CACHE_DIR, { recursive: true });

/* ============================================================
   RASTERIZZAZIONE PDF -> IMMAGINE (server-side con pdfjs-dist)
   ============================================================ */

/**
 * Rasterizza una pagina PDF a PNG
 * @param {string} pdfPath - percorso file PDF sorgente
 * @param {number} pageNum - numero pagina (1-indexed)
 * @param {number} scale - fattore scala (es. 2 = 2x DPI)
 * @returns {Promise<Buffer>} - buffer PNG
 */
async function rasterizePage(pdfPath, pageNum, scale = 2) {
  // pdfjs-dist in Node richiede un'alternativa per canvas
  // Usiamo la versione legacy che funziona con node-canvas o canvas mock

  const data = new Uint8Array(fs.readFileSync(pdfPath));

  // Carica documento
  const loadingTask = pdfjsLib.getDocument({ data, disableFontFace: true, isEvalSupported: false });
  const pdfDoc = await loadingTask.promise;

  if (pageNum < 1 || pageNum > pdfDoc.numPages) {
    throw new Error(`Pagina ${pageNum} non esiste (totale: ${pdfDoc.numPages})`);
  }

  const page = await pdfDoc.getPage(pageNum);

  // Calcola viewport con scala
  const viewport = page.getViewport({ scale });

  // Per rasterizzazione server-side in Node, usiamo un canvas virtuale
  // pdfjs-dist legacy build in Node richiede un'implementazione canvas
  // Usiamo node-canvas (installato) come primario, fallback a OffscreenCanvas nativo

  let canvas;
  try {
    // node-canvas è installato come dipendenza - usa questo per compatibilità pdfjs-dist
    const Canvas = require('canvas');
    canvas = new Canvas(viewport.width, viewport.height);
  } catch {
    // Fallback: OffscreenCanvas nativo (Node 18+)
    canvas = new OffscreenCanvas(viewport.width, viewport.height);
  }

  const context = canvas.getContext('2d');

  // Renderizza
  const renderContext = {
    canvasContext: context,
    viewport: viewport,
    intent: 'print' // migliore qualità per stampa
  };

  const renderTask = page.render(renderContext);
  await renderTask.promise;

  // Converti a PNG buffer
  if (canvas.convertToBlob) {
    // OffscreenCanvas
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return Buffer.from(await blob.arrayBuffer());
  } else {
    // node-canvas
    return canvas.toBuffer('image/png');
  }
}

/**
 * Rasterizza con cache su filesystem
 */
async function getRasterPage(bookId, pageNum, token, scale = 2) {
  const book = getBookById(bookId);
  if (!book) throw new Error('Libro non trovato');

  const sourcePath = path.join(PDF_DIR, book.pdfFile);
  if (!fs.existsSync(sourcePath)) throw new Error('File PDF sorgente mancante');

  // Directory cache per questo libro+token
  const tokenPrefix = token.substring(0, 8);
  const bookCacheDir = path.join(RASTER_CACHE_DIR, String(bookId), tokenPrefix);
  if (!fs.existsSync(bookCacheDir)) fs.mkdirSync(bookCacheDir, { recursive: true });

  const cacheFile = path.join(bookCacheDir, `page-${pageNum}-scale-${scale}.png`);

  // Se cached, restituisci direttamente
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    // TTL 24 ore
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) {
      return fs.readFileSync(cacheFile);
    }
  }

  // Rasterizza
  const pngBuffer = await rasterizePage(sourcePath, pageNum, scale);

  // Salva in cache
  fs.writeFileSync(cacheFile, pngBuffer);

  return pngBuffer;
}

/* ============================================================
   ENDPOINT /api/pdf/raster/:bookId/:pageNum
   ============================================================ */

// GET /api/pdf/raster/:bookId/:pageNum?token=...&scale=...
router.get('/raster/:bookId/:pageNum', async (req, res) => {
  const startTime = Date.now();
  const bookId = parseInt(req.params.bookId, 10);
  const pageNum = parseInt(req.params.pageNum, 10);
  const token = req.query.token;
  const scale = Math.min(Math.max(parseFloat(req.query.scale) || 2, 0.5), 4); // clamp 0.5-4

  const userId = req.session?.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'Non autenticato' });
  }

  const userEmail = req.session.user.email;

  // Verifica acquisto
  if (!hasPurchased(userId, bookId)) {
    return res.status(403).json({ error: 'Non hai acquistato questo metodo' });
  }

  // Verifica token + fingerprint (come /stream)
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || '';

  const tokenCheck = consumeViewToken(token, userId, bookId, null, clientIp, userAgent);
  if (!tokenCheck.ok) {
    // Log fingerprint mismatch
    if (tokenCheck.reason && tokenCheck.reason.includes('mismatch')) {
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
    return res.status(403).json({ error: tokenCheck.reason });
  }

  const book = getBookById(bookId);
  if (!book || !book.highSecurity) {
    return res.status(400).json({ error: 'Rasterizzazione non abilitata per questo libro' });
  }

  if (pageNum < 1 || pageNum > (book.pages || 1)) {
    return res.status(404).json({ error: 'Pagina non trovata' });
  }

  try {
    const pngBuffer = await getRasterPage(bookId, pageNum, token, scale);

    // Audit log
    logRasterPage({
      userId,
      bookId,
      token,
      ip: clientIp,
      ua: userAgent,
      pageNum,
      scale,
      success: true,
      latencyMs: Date.now() - startTime
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', pngBuffer.length);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${book.slug}-p${pageNum}.png"`);
    // Referrer policy per evitare leakage
    res.setHeader('Referrer-Policy', 'no-referrer');

    res.send(pngBuffer);
  } catch (err) {
    console.error('Raster error:', err);
    logRasterPage({
      userId,
      bookId,
      token,
      ip: clientIp,
      ua: userAgent,
      pageNum,
      scale,
      success: false,
      reason: err.message,
      latencyMs: Date.now() - startTime
    });
    res.status(500).json({ error: 'Errore rasterizzazione pagina' });
  }
});

/* ============================================================
   CLEANUP CACHE RASTER (chiamato da cleanup.js)
   ============================================================ */

function cleanupRasterCache() {
  if (!fs.existsSync(RASTER_CACHE_DIR)) return 0;

  let removed = 0;
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24h

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        // Rimuovi directory vuote
        try {
          if (fs.readdirSync(fullPath).length === 0) {
            fs.rmdirSync(fullPath);
          }
        } catch {}
      } else {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(fullPath);
          removed++;
        }
      }
    }
  }

  walk(RASTER_CACHE_DIR);
  return removed;
}

module.exports = {
  router,
  rasterizePage,
  getRasterPage,
  cleanupRasterCache
};