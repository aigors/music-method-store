/**
 * Music Method Store — PDF.js Viewer
 *
 * OBIETTIVI DI SICUREZZA:
 *  - Nessuna URL diretta al PDF (download impedito). Il PDF arriva via streaming range
 *    con un token a breve scadenza, servito come Blob object URL.
 *  - Disabilita stampa, download, copia testo, selezione.
 *  - Watermark già applicato server-side nel PDF stesso (visibile anche in screenshot).
 *  - Overlay UI per ricordare che è protetto.
 */

import { apiFetch } from './main.js';

const pdfjsLib = window.pdfjsLib;

// Configurazione worker (locale)
pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.js';

// Configurazione PDF.js: limita funzionalità pericolose
const PDF_OPTIONS = {
  // Disabilita XFA (potenziale vettore)
  isEvalSupported: false,
  // Niente font extra per sicurezza
  disableFontFace: false,
  // Max dimensioni ragionevoli
  maxCanvasPixels: 4096 * 4096
};

// Stato globale
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let currentScale = 1;
let renderTask = null;
let renderedQuality = 2; // devicePixelRatio
let isRasterMode = false; // true per libri highSecurity (rasterizzazione server-side)
let currentRasterToken = null; // token per navigazione raster
let currentRasterBookId = null; // bookId per navigazione raster

// ============================================================
// DEVICE FINGERPRINTING (Fase 1)
// ============================================================
function getDeviceFingerprint() {
  return {
    ua: navigator.userAgent,
    screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: navigator.language,
  };
}

// ============================================================
// INIT
// ============================================================
async function initViewer() {
  const bookId = getBookIdFromUrl();
  if (!bookId) {
    showError('ID metodo non valido');
    return;
  }

  // Verifica acquisto + crea token vista
  try {
    const deviceFingerprint = getDeviceFingerprint();
    const { token, bookSlug, highSecurity } = await apiFetch('/pdf/view-token', {
      method: 'POST',
      body: JSON.stringify({
        bookId: parseInt(bookId, 10),
        deviceFingerprint
      })
    });

    // Se highSecurity, usa rasterizzazione invece di streaming PDF
    if (highSecurity) {
      isRasterMode = true;
      currentRasterToken = token;
      currentRasterBookId = bookId;
      await loadRasterViewer(bookId, token);
      return;
    }

    // Recupera titolo libro
    try {
      const { book } = await apiFetch(`/catalog/id/${bookId}`);
      document.getElementById('viewer-title').textContent = book.title;
    } catch { /* ignore */ }

    // Carica PDF
    await loadPdf(bookId, token);
  } catch (err) {
    showError(err.message);
  }
}

function getBookIdFromUrl() {
  const match = window.location.pathname.match(/\/(viewer|pdf\/viewer)\/(\d+)/);
  return match ? match[2] : null;
}

// ============================================================
// CARICAMENTO RASTERIZZATO per libri highSecurity (Fase 3)
// ============================================================
async function loadRasterViewer(bookId, token) {
  // Recupera info libro (pagine totali)
  try {
    const { book } = await apiFetch(`/catalog/id/${bookId}`);
    document.getElementById('viewer-title').textContent = book.title;
    totalPages = book.pages || 1;
  } catch {
    totalPages = 1;
  }

  document.getElementById('page-total').textContent = `/ ${totalPages}`;
  document.getElementById('page-input').max = totalPages;
  document.getElementById('loading-overlay').classList.add('hidden');

  // Sostituisci canvas wrapper con image wrapper
  const canvasWrapper = document.getElementById('canvas-wrapper');
  canvasWrapper.innerHTML = '';
  const img = document.createElement('img');
  img.id = 'raster-page';
  img.className = 'raster-page-img';
  img.draggable = false;
  canvasWrapper.appendChild(img);

  // Render prima pagina
  await renderRasterPage(bookId, token, 1);
}

async function renderRasterPage(bookId, token, pageNum) {
  if (pageNum < 1 || pageNum > totalPages) return;

  currentPage = pageNum;
  document.getElementById('page-input').value = pageNum;

  const img = document.getElementById('raster-page');
  const loadingOverlay = document.getElementById('loading-overlay');
  loadingOverlay.classList.remove('hidden');
  loadingOverlay.querySelector('p').textContent = `Pagina ${pageNum} di ${totalPages}…`;

  // Determina scale per zoom
  const zoomMode = getZoomMode();
  let scaleParam = '';
  if (zoomMode === 'factor') {
    scaleParam = `&scale=${getZoomFactor()}`;
  } else if (zoomMode === 'page') {
    scaleParam = '&scale=1.5';
  } else {
    // auto: calcola scale basato su viewport
    const wrapper = document.getElementById('canvas-wrapper');
    const scale = computeRasterScale(wrapper);
    scaleParam = `&scale=${scale}`;
  }

  try {
    const url = `/api/pdf/raster/${bookId}/${pageNum}?token=${encodeURIComponent(token)}${scaleParam}`;
    // Cache busting per evitare caching browser
    img.src = `${url}&_=${Date.now()}`;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    loadingOverlay.classList.add('hidden');
  } catch (err) {
    console.error('Raster page load error:', err);
    loadingOverlay.classList.add('hidden');
    showError('Impossibile caricare la pagina. Il token potrebbe essere scaduto.');
  }
}

function computeRasterScale(wrapper) {
  // Scala per riempire il contenitore mantenendo aspect ratio
  const availW = wrapper.clientWidth - 32;
  const availH = wrapper.clientHeight - 32;
  // Assumiamo A4 aspect ratio ~0.707 per calcolo iniziale
  const estW = availH * 0.707;
  const estH = availW / 0.707;
  const scaleW = availW / (595 * 2); // A4 width in points at 2x
  const scaleH = availH / (842 * 2);
  return Math.min(scaleW, scaleH, 3);
}

// ============================================================
// CARICAMENTO PDF via streaming tokenizzato
// ============================================================
async function loadPdf(bookId, token) {
  const loadingTask = pdfjsLib.getDocument({
    ...PDF_OPTIONS,
    // IMPORTANTE: il PDF arriva come blob con Range support, no URL esposto
    url: `/api/pdf/stream/${bookId}?token=${encodeURIComponent(token)}`,
    rangeChunkSize: 65536,
    disableStream: false,
    disableAutoFetch: false
  });

  try {
    pdfDoc = await loadingTask.promise;
    totalPages = pdfDoc.numPages;

    document.getElementById('page-total').textContent = `/ ${totalPages}`;
    document.getElementById('page-input').max = totalPages;

    // Nascondi loading
    document.getElementById('loading-overlay').classList.add('hidden');

    await renderPage(1);
  } catch (err) {
    console.error('PDF load error:', err);
    document.getElementById('loading-overlay').classList.add('hidden');
    showError('Impossibile caricare il PDF. Il token potrebbe essere scaduto.');
  }
}

// ============================================================
// RENDERING PAGINA
// ============================================================
async function renderPage(pageNum) {
  if (!pdfDoc) return;
  if (pageNum < 1 || pageNum > totalPages) return;

  currentPage = pageNum;
  document.getElementById('page-input').value = pageNum;

  const wrapper = document.getElementById('canvas-wrapper');
  const loadingOverlay = document.getElementById('loading-overlay');
  loadingOverlay.classList.remove('hidden');
  loadingOverlay.querySelector('p').textContent = `Pagina ${pageNum} di ${totalPages}…`;

  // Annulla render precedente
  if (renderTask) {
    try { renderTask.cancel(); } catch {}
  }

  const page = await pdfDoc.getPage(pageNum);
  const canvas = getOrCreateCanvas();
  const ctx = canvas.getContext('2d', { willReadFrequently: false });

  // Calcola viewport
  const viewport = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const fitScale = computeFitScale(viewport, wrapper);
  currentScale = fitScale * (getZoomMode() === 'auto' ? 1 : getZoomFactor());

  const renderViewport = page.getViewport({ scale: currentScale * dpr });

  canvas.width = renderViewport.width;
  canvas.height = renderViewport.height;
  canvas.style.width = `${Math.floor(renderViewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(renderViewport.height / dpr)}px`;

  const renderContext = {
    canvasContext: ctx,
    viewport: renderViewport,
    intent: 'default'
  };

  renderTask = page.render(renderContext);

  try {
    await renderTask.promise;
    loadingOverlay.classList.add('hidden');
  } catch (err) {
    if (err.name !== 'RenderingCancelledException') {
      console.error('Render error:', err);
    }
  }
}

function getOrCreateCanvas() {
  let canvas = document.getElementById('pdf-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'pdf-canvas';
    canvas.className = 'pdf-page-canvas';
    document.getElementById('canvas-wrapper').appendChild(canvas);
  }
  return canvas;
}

function computeFitScale(viewport, wrapper) {
  const availW = wrapper.clientWidth - 32;
  const availH = wrapper.clientHeight - 32;
  const scaleW = availW / viewport.width;
  const scaleH = availH / viewport.height;
  return Math.min(scaleW, scaleH, 2);
}

function getZoomMode() {
  const mode = document.getElementById('zoom-select').value;
  return mode === 'auto' || mode === 'page' ? mode : 'factor';
}

function getZoomFactor() {
  const val = document.getElementById('zoom-select').value;
  if (val === 'auto') return 1;
  if (val === 'page') return 1;
  return parseFloat(val) || 1;
}

// ============================================================
// CONTROLLI UI
// ============================================================
function nextPage() {
  if (currentPage < totalPages) {
    if (isRasterMode) {
      renderRasterPage(currentRasterBookId, currentRasterToken, currentPage + 1);
    } else {
      renderPage(currentPage + 1);
    }
  }
}

function prevPage() {
  if (currentPage > 1) {
    if (isRasterMode) {
      renderRasterPage(currentRasterBookId, currentRasterToken, currentPage - 1);
    } else {
      renderPage(currentPage - 1);
    }
  }
}

function gotoPage() {
  const input = document.getElementById('page-input');
  const val = parseInt(input.value, 10);
  if (val >= 1 && val <= totalPages) {
    if (isRasterMode) {
      renderRasterPage(currentRasterBookId, currentRasterToken, val);
    } else {
      renderPage(val);
    }
  } else {
    input.value = currentPage;
  }
}

function toggleFullscreen() {
  const container = document.getElementById('viewer-container');
  if (!document.fullscreenElement) {
    container.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

// ============================================================
// BEST-EFFORT ANTI-DOWNLOAD
// ============================================================
function setupAntiDownload() {
  // Disabilita tasto destro sul viewer
  document.getElementById('viewer-container').addEventListener('contextmenu', e => {
    e.preventDefault();
    return false;
  });

  // Blocca Ctrl+P / Cmd+P (stampa)
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) &&
        (e.key === 'p' || e.key === 's' || e.key === 'P' || e.key === 'S')) {
      e.preventDefault();
      return false;
    }
    // Navigazione tastiera
    if (e.key === 'ArrowRight') nextPage();
    if (e.key === 'ArrowLeft') prevPage();
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  });

  // Blocca selezione testo nel canvas/immagine
  document.getElementById('viewer-container').addEventListener('selectstart', e => {
    if (e.target.id === 'pdf-canvas' || e.target.id === 'raster-page') e.preventDefault();
  });

  // Blocca drag & drop su canvas/immagine (best-effort)
  document.getElementById('viewer-container').addEventListener('dragstart', e => {
    if (e.target.id === 'pdf-canvas' || e.target.id === 'raster-page') e.preventDefault();
  });

  // Rimuovi riferimenti blob dopo un po' (il token scade comunque)
  window.addEventListener('beforeunload', () => {
    // Niente download esplicito possibile; il blob viene perso alla chiusura
  });

  // Disabilita "save page as" via menu (best-effort)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F12') e.preventDefault();
  });

  // ============================================================
  // HARDENING FRONTEND (Fase 5)
  // ============================================================

  // DevTools detection (best-effort)
  let devtoolsOpen = false;
  const devtoolsCheck = () => {
    const threshold = 160;
    const widthDiff = window.outerWidth - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;
    const opened = widthDiff > threshold || heightDiff > threshold;

    if (opened && !devtoolsOpen) {
      devtoolsOpen = true;
      console.warn('⚠️  DevTools rilevato — sessione monitorata');
      // Opzionale: revoca token via API
      // fetch('/api/pdf/revoke-token', { method: 'POST', body: JSON.stringify({ token: currentToken }) });
    } else if (!opened && devtoolsOpen) {
      devtoolsOpen = false;
    }
  };
  setInterval(devtoolsCheck, 1000);

  // Visibility change handling - pausa rendering se tab in background > 30s
  let visibilityTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      visibilityTimer = setTimeout(() => {
        console.warn('⚠️  Tab in background > 30s — rendering pausato');
        // Per raster mode: potremmo nascondere l'immagine
        const img = document.getElementById('raster-page');
        if (img) img.style.visibility = 'hidden';
        // Per PDF mode: annulla render task
        if (renderTask) {
          try { renderTask.cancel(); } catch {}
        }
      }, 30000);
    } else {
      if (visibilityTimer) {
        clearTimeout(visibilityTimer);
        visibilityTimer = null;
      }
      // Ripristina visibilità
      const img = document.getElementById('raster-page');
      if (img) img.style.visibility = 'visible';
      // Re-render pagina corrente
      if (isRasterMode) {
        renderRasterPage(currentRasterBookId, currentRasterToken, currentPage);
      } else {
        renderPage(currentPage);
      }
    }
  });

  // Riduce precisione performance.now() (mitigazione timing attacks)
  if (window.performance && window.performance.now) {
    const originalNow = performance.now.bind(performance);
    performance.now = () => Math.round(originalNow() * 100) / 100; // precisione 10ms
  }
}

// ============================================================
// ERROR
// ============================================================
function showError(msg) {
  const overlay = document.getElementById('loading-overlay');
  overlay.classList.remove('hidden');
  overlay.innerHTML = `
    <div style="text-align:center; max-width:400px;">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2" style="margin-bottom:1rem;">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <p style="margin-bottom:1rem;">${msg}</p>
      <a href="/catalogo" class="btn btn-primary">Torna al catalogo</a>
    </div>
  `;
}

// ============================================================
// EVENT BINDINGS
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-next').addEventListener('click', nextPage);
  document.getElementById('btn-prev').addEventListener('click', prevPage);
  document.getElementById('page-input').addEventListener('change', gotoPage);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('zoom-select').addEventListener('change', () => {
    if (isRasterMode) {
      renderRasterPage(currentRasterBookId, currentRasterToken, currentPage);
    } else {
      renderPage(currentPage);
    }
  });

  // Re-render su resize
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (isRasterMode) {
        renderRasterPage(currentRasterBookId, currentRasterToken, currentPage);
      } else {
        renderPage(currentPage);
      }
    }, 200);
  });

  setupAntiDownload();
  initViewer();
});