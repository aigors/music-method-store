'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

const { listBooks, getBookBySlug, getBookById, hasPurchased, PDF_DIR } = require('./db');

/* ============================================================
   HELPER: Rasterizza prima pagina PDF come cover
   ============================================================ */

const COVER_CACHE_DIR = path.join(__dirname, '..', 'data', 'covers');

if (!fs.existsSync(COVER_CACHE_DIR)) fs.mkdirSync(COVER_CACHE_DIR, { recursive: true });

async function rasterizeFirstPage(pdfPath, scale = 1.5) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));

  // Usa @napi-rs/canvas che è compatibile con pdfjs-dist legacy build
  let napiCanvas;
  try {
    napiCanvas = require('@napi-rs/canvas');
  } catch (e) {
    throw new Error('@napi-rs/canvas non installato - necessario per generare cover');
  }

  // Crea CanvasFactory personalizzata per @napi-rs/canvas
  class NapiCanvasFactory {
    constructor({ enableHWA = false } = {}) {
      this.enableHWA = enableHWA;
    }
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

  const loadingTask = pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    canvasFactory: new NapiCanvasFactory()
  });
  const pdfDoc = await loadingTask.promise;

  if (pdfDoc.numPages < 1) {
    throw new Error('PDF non ha pagine');
  }

  const page = await pdfDoc.getPage(1);
  const viewport = page.getViewport({ scale });

  // Crea canvas usando @napi-rs/canvas
  const canvas = napiCanvas.createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');

  // Riempie lo sfondo di bianco (come fa il browser)
  context.fillStyle = 'white';
  context.fillRect(0, 0, viewport.width, viewport.height);

  const renderContext = {
    canvasContext: context,
    viewport: viewport,
    intent: 'display'
  };

  const renderTask = page.render(renderContext);
  await renderTask.promise;

  return canvas.toBuffer('image/png');
}

/**
 * Controlla se un buffer PNG è quasi completamente trasparente o bianco/vuoto.
 * In Node.js con disableFontFace: true, pdfjs-dist rende il testo con alpha=0
 * (trasparente), quindi l'immagine risulta vuota quando viene sovrapposta a
 * un fondo bianco. Questa funzione controlla anche il canale alpha.
 */
function isBlankImage(pngBuf) {
  try {
    const { createCanvas, Image } = require('@napi-rs/canvas');
    const img = new Image();
    img.src = pngBuf;
    const tmpCanvas = createCanvas(img.width, img.height);
    const ctx = tmpCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, img.width, img.height);
    const data = imageData.data;

    const RGB_THRESHOLD = 230;
    const ALPHA_THRESHOLD = 30; // alpha sotto 30 = praticamente trasparente
    let visiblePixels = 0;
    const totalSampled = Math.min(600, data.length / 4);
    const step = Math.max(4, Math.floor(data.length / 4 / totalSampled));
    for (let i = 0; i < data.length; i += step * 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      // Pixel visibile: ha alpha sufficiente E colore non-bianco
      if (a > ALPHA_THRESHOLD && (r < RGB_THRESHOLD || g < RGB_THRESHOLD || b < RGB_THRESHOLD)) {
        visiblePixels++;
      }
    }
    const ratio = visiblePixels / totalSampled;
    return ratio < 0.01;
  } catch (e) {
    console.warn('[catalog] isBlankImage error:', e.message);
    return false;
  }
}

/**
 * Genera una cover colorata con titolo/autore usando @napi-rs/canvas.
 * Usata quando la rasterizzazione del PDF produce un'immagine vuota.
 */
function generateCanvasCover(bookId, title, author) {
  const { createCanvas } = require('@napi-rs/canvas');

  const W = 400, H = 560;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Colore di sfondo basato sull'ID del libro
  const palettes = [
    { bg: '#1a73e8', accent: '#4285f4' },
    { bg: '#34a853', accent: '#43a047' },
    { bg: '#ea4335', accent: '#e53935' },
    { bg: '#fbbc04', accent: '#f9a825' },
    { bg: '#673ab7', accent: '#7e57c2' },
    { bg: '#00bcd4', accent: '#00acc1' },
    { bg: '#ff5722', accent: '#ff7043' },
    { bg: '#795548', accent: '#8d6e63' }
  ];
  const palette = palettes[(bookId - 1) % palettes.length];

  // Sfondo gradiente
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, palette.bg);
  grad.addColorStop(1, palette.accent);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Primo carattere del titolo (grande)
  const firstChar = (title || '?').charAt(0).toUpperCase();
  ctx.fillStyle = 'rgba(255,255,255,0.2)';
  ctx.font = 'bold 200px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(firstChar, W / 2, H / 2 - 20);

  // Titolo
  ctx.fillStyle = 'white';
  ctx.font = 'bold 24px sans-serif';
  const maxW = W - 60;
  const titleLines = wrapText(ctx, title || 'Senza titolo', maxW);
  const titleY = H / 2 + 40;
  for (let i = 0; i < titleLines.length; i++) {
    ctx.fillText(titleLines[i], W / 2, titleY + i * 30);
  }

  // Autore
  if (author) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '16px sans-serif';
    const authorY = titleY + titleLines.length * 30 + 15;
    ctx.fillText(author, W / 2, authorY);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Spezza testo in righe che entrano in maxWidth.
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function getCoverImage(bookId) {
  const book = getBookById(bookId);
  if (!book) throw new Error('Libro non trovato');

  const sourcePath = path.join(PDF_DIR, book.pdfFile);
  if (!fs.existsSync(sourcePath)) throw new Error('File PDF sorgente mancante');

  // Cache key basato su bookId e mtime del PDF sorgente
  const stat = fs.statSync(sourcePath);
  const cacheKey = `${bookId}-${stat.mtimeMs}-${stat.size}`;
  const cacheFile = path.join(COVER_CACHE_DIR, `${cacheKey}.png`);

  // Se cached, restituisci direttamente
  if (fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile);
  }

  // Rasterizza
  let pngBuffer = await rasterizeFirstPage(sourcePath);

  // Se il PDF è piccolo (<100KB = probabilmente placeholder) e l'immagine risulta vuota,
  // genera una cover colorata con titolo/autore usando @napi-rs/canvas.
  // PDF grandi contengono sempre immagini reali → non serve il fallback.
  if (stat.size < 100_000 && isBlankImage(pngBuffer)) {
    pngBuffer = generateCanvasCover(bookId, book.title, book.author);
  }

  // Salva in cache
  fs.writeFileSync(cacheFile, pngBuffer);

  return pngBuffer;
}

/* ============================================================
   ENDPOINT COVER: /api/catalog/cover/:bookId
   ============================================================ */

// Genera placeholder SVG per cover mancanti
function generatePlaceholderCover(title) {
  const firstChar = (title || '?').charAt(0).toUpperCase();
  const colors = ['#1a73e8', '#34a853', '#ea4335', '#fbbc04', '#673ab7', '#00bcd4', '#ff5722', '#795548'];
  const color = colors[title.charCodeAt(0) % colors.length];

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">
      <rect width="400" height="560" fill="${color}"/>
      <text x="200" y="250" font-family="system-ui, sans-serif" font-size="120" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${escapeXml(firstChar)}</text>
      <text x="200" y="350" font-family="system-ui, sans-serif" font-size="18" fill="rgba(255,255,255,0.9)" text-anchor="middle" dominant-baseline="middle">${escapeXml((title || 'Senza titolo').slice(0, 30))}</text>
    </svg>
  `.trim();

  return Buffer.from(svg, 'utf8');
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// GET /api/catalog/cover/:bookId — prima pagina del PDF come immagine
router.get('/cover/:bookId', async (req, res) => {
  const bookId = parseInt(req.params.bookId, 10);
  const scale = Math.min(Math.max(parseFloat(req.query.scale) || 1.5, 0.5), 3);

  try {
    const pngBuffer = await getCoverImage(bookId);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', pngBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable'); // 24h cache
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pngBuffer);
  } catch (err) {
    console.error('Cover generation error:', err);

    // Fallback: se il PDF non esiste, PDF corrotto, o altri errori di parsing
    const fallbackErrors = [
      'File PDF sorgente mancante',
      'Libro non trovato',
      'Invalid PDF structure',
      'PDF non ha pagine',
      'node-canvas non installato'
    ];
    const isFallbackError = fallbackErrors.some(e => err.message?.includes(e));

    if (isFallbackError) {
      const book = getBookById(bookId);
      const placeholder = generatePlaceholderCover(book?.title);

      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1h cache per placeholder
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(placeholder);
    }

    res.status(404).json({ error: 'Impossibile generare copertina' });
  }
});

/* ============================================================
   API CATALOGO (pubblico — non richiede auth)
   ============================================================ */

// GET /api/catalog — lista metodi (include flag "purchased" per l'utente loggato)
router.get('/', (req, res) => {
  const books = listBooks({ onlyActive: true }).map(b => {
    let purchased = false;
    if (req.session.user?.id) {
      purchased = !!hasPurchased(req.session.user.id, b.id);
    }
    return {
      id: b.id,
      slug: b.slug,
      title: b.title,
      author: b.author,
      description: b.description,
      priceCents: b.priceCents,
      priceEur: (b.priceCents / 100).toFixed(2),
      coverFile: b.coverFile,
      coverUrl: `/api/catalog/cover/${b.id}`, // URL per cover generata dalla prima pagina
      pages: b.pages,
      purchased
    };
  });
  res.json({ books });
});

// GET /api/catalog/:slug — dettaglio per slug
router.get('/:slug', (req, res) => {
  const book = getBookBySlug(req.params.slug);
  if (!book || !book.isActive) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  let purchased = false;
  if (req.session.user?.id) {
    purchased = !!hasPurchased(req.session.user.id, book.id);
  }

  res.json({
    book: {
      id: book.id,
      slug: book.slug,
      title: book.title,
      author: book.author,
      description: book.description,
      priceCents: book.priceCents,
      priceEur: (book.priceCents / 100).toFixed(2),
      coverFile: book.coverFile,
      pages: book.pages,
      purchased
    }
  });
});

// GET /api/catalog/id/:id — dettaglio per ID
router.get('/id/:id', (req, res) => {
  const book = getBookById(req.params.id);
  if (!book || !book.isActive) {
    return res.status(404).json({ error: 'Metodo non trovato' });
  }

  let purchased = false;
  if (req.session.user?.id) {
    purchased = !!hasPurchased(req.session.user.id, book.id);
  }

  res.json({
    book: {
      id: book.id,
      slug: book.slug,
      title: book.title,
      author: book.author,
      description: book.description,
      priceCents: book.priceCents,
      priceEur: (book.priceCents / 100).toFixed(2),
      coverFile: book.coverFile,
      pages: book.pages,
      purchased
    }
  });
});

// Export helper functions for admin use
module.exports = router;
module.exports.getCoverImage = getCoverImage;
module.exports.generatePlaceholderCover = generatePlaceholderCover;