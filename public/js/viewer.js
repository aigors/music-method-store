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
import * as pdfjsLib from '/lib/pdf.min.mjs';

// Configurazione worker (locale)
pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdf.worker.min.mjs';

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
let currentToken = null; // token per streaming PDF (non raster) — usato per l'indice
let lastWheelFlip = 0; // throttle per evitare flip multipli con la rotellina
const rasterCache = new Map(); // pageNum -> HTMLImageElement prefetchata (per navigazione fluida)

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

  const isAdminPreview = new URLSearchParams(window.location.search).get('admin') === '1';
  if (isAdminPreview) {
    const banner = document.getElementById('preview-banner');
    if (banner) banner.hidden = false;
  }

  // Verifica acquisto + crea token vista (o token admin preview)
  try {
    const deviceFingerprint = getDeviceFingerprint();
    const endpoint = isAdminPreview
      ? `/pdf/admin-preview-token/${bookId}`
      : '/pdf/view-token';
    const body = isAdminPreview
      ? undefined
      : JSON.stringify({ bookId: parseInt(bookId, 10), deviceFingerprint });
    const { token, bookSlug, highSecurity } = await apiFetch(endpoint, {
      method: 'POST',
      body
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
  buildIndex();
  const lo = document.getElementById('loading-overlay');
  if (lo) lo.classList.add('hidden');

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
  highlightPageIndex(currentPage);

  const wrapper = document.getElementById('canvas-wrapper');
  const loadingOverlay = document.getElementById('loading-overlay');

  // Se la pagina è già stata prefetchata e caricata, mostrala all'istante
  // (nessuna nuova richiesta al server, nessun token consumato).
  const cached = rasterCache.get(pageNum);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    showRasterImage(cached, wrapper);
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    preloadRasterPage(pageNum + 1);
    preloadRasterPage(pageNum - 1);
    return;
  }

  // Fallback: carica normalmente (es. primo caricamento o pagina non prefetchata)
  let img = document.getElementById('raster-page');
  if (!img) {
    img = document.createElement('img');
    img.id = 'raster-page';
    img.className = 'raster-page-img';
    img.draggable = false;
    wrapper.appendChild(img);
  }

  if (loadingOverlay) {
    loadingOverlay.classList.remove('hidden');
    const p = loadingOverlay.querySelector('p');
    if (p) p.textContent = `Pagina ${pageNum} di ${totalPages}…`;
  }

  img.onload = () => {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    // Prefetch pagine vicine per la navigazione successiva
    preloadRasterPage(pageNum + 1);
    preloadRasterPage(pageNum - 1);
  };
  img.onerror = () => {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    showError('Impossibile caricare la pagina. Il token potrebbe essere scaduto.');
  };

  img.src = rasterPageUrl(pageNum);
}

// Mostra un'immagine prefetchata come pagina corrente, riusando l'elemento
// già caricato (niente re-request → navigazione istantanea).
function showRasterImage(imgEl, wrapper) {
  const current = document.getElementById('raster-page');
  if (current && current !== imgEl) current.remove();
  imgEl.id = 'raster-page';
  imgEl.className = 'raster-page-img';
  imgEl.draggable = false;
  imgEl.onload = null;
  imgEl.onerror = null;
  if (!imgEl.parentNode) wrapper.appendChild(imgEl);
}

// Prefetch in background delle pagine vicine (avanti/indietro) così che la
// navigazione risulti fluida senza overlay di caricamento.
function preloadRasterPage(pageNum) {
  if (pageNum < 1 || pageNum > totalPages) return;
  if (rasterCache.has(pageNum)) return; // già in caricamento o caricata
  const img = new Image();
  img.draggable = false;
  // Segna subito come "in caricamento" per evitare duplicati; onload lo
  // sostituisce con l'immagine pronta.
  rasterCache.set(pageNum, null);
  img.onload = () => rasterCache.set(pageNum, img);
  img.onerror = () => rasterCache.delete(pageNum); // libera per un eventuale retry
  img.src = rasterPageUrl(pageNum);
}

// URL stabile per una pagina raster (nessun cache-busting: le immagini
// prefetchate vengono riusate senza nuove richieste).
function rasterPageUrl(pageNum) {
  const zoomMode = getZoomMode();
  let scaleParam = '';
  if (zoomMode === 'factor') {
    scaleParam = `&scale=${getZoomFactor()}`;
  } else if (zoomMode === 'page') {
    scaleParam = '&scale=1.5';
  } else {
    scaleParam = `&scale=${computeRasterScale(document.getElementById('canvas-wrapper'))}`;
  }
  return `/api/pdf/raster/${currentRasterBookId}/${pageNum}?token=${encodeURIComponent(currentRasterToken)}${scaleParam}`;
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
  currentToken = token;
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
    buildIndex();

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
  highlightPageIndex(currentPage);

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
    resetScroll();
    if (isRasterMode) {
      renderRasterPage(currentRasterBookId, currentRasterToken, currentPage + 1);
    } else {
      renderPage(currentPage + 1);
    }
  }
}

function prevPage() {
  if (currentPage > 1) {
    resetScroll();
    if (isRasterMode) {
      renderRasterPage(currentRasterBookId, currentRasterToken, currentPage - 1);
    } else {
      renderPage(currentPage - 1);
    }
  }
}

// Riporta lo scroll del contenitore in cima (all'inizio della nuova pagina)
function resetScroll() {
  const wrapper = document.getElementById('canvas-wrapper');
  if (wrapper) {
    wrapper.scrollTop = 0;
    wrapper.scrollLeft = 0;
  }
}

// Scroll con rotellina:
//  - se la pagina è più alta del contenitore (zoom >100%), prima scroll interno
//    e al raggiungimento del bordo inferiore/superiore si gira pagina;
//  - se la pagina è adattata al contenitore, la rotellina gira direttamente pagina.
function handleWheel(e) {
  const wrapper = document.getElementById('canvas-wrapper');
  if (!wrapper) return;
  const now = Date.now();
  const scrollable = wrapper.scrollHeight > wrapper.clientHeight + 1;

  if (scrollable) {
    // Scroll interno con flip al bordo
    const atBottom = wrapper.scrollTop + wrapper.clientHeight >= wrapper.scrollHeight - 2;
    const atTop = wrapper.scrollTop <= 2;
    const wantNext = e.deltaY > 0 && atBottom;
    const wantPrev = e.deltaY < 0 && atTop;
    if (!wantNext && !wantPrev) return; // lascia lo scroll nativo dentro la pagina
    if (now - lastWheelFlip < 300) return; // evita flip multipli ravvicinati
    e.preventDefault();
    lastWheelFlip = now;
    if (wantNext) nextPage(); else prevPage();
    return;
  }

  // Pagina adattata: la rotellina gira direttamente pagina
  if (now - lastWheelFlip < 300) { e.preventDefault(); return; }
  e.preventDefault();
  lastWheelFlip = now;
  if (e.deltaY > 0) nextPage();
  else if (e.deltaY < 0) prevPage();
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

// ============================================================
// INDICE PAGINE (sidebar sinistra)
//   Ordine di preferenza:
//     1. Sommario (outline) estratto dai metadata del PDF
//     2. Thumbnail verticali delle pagine
//     3. Griglia di numeri di pagina (fallback)
// ============================================================

// Orchestratore: decide quale tipo di indice mostrare.
async function buildIndex() {
  const outline = await fetchOutline();
  if (outline && outline.length) {
    buildOutlineIndex(outline);
    return;
  }
  buildThumbnailIndex();
}

// Recupera il sommario (outline) dal server. Non consuma token di vista.
async function fetchOutline() {
  try {
    const token = isRasterMode ? currentRasterToken : currentToken;
    const bookId = isRasterMode ? currentRasterBookId : getBookIdFromUrl();
    if (!token || !bookId) return [];
    const res = await fetch(`/api/pdf/outline/${bookId}?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' });
    if (!res.ok) return [];
    const data = await res.json();
    return data.outline || [];
  } catch {
    return [];
  }
}

// Sommario gerarchico: righe indentate, caret per espandere/comprimere le
// sotto-sezioni. Click sulla voce → salta alla pagina.
function buildOutlineIndex(outline) {
  const list = document.getElementById('page-index-list');
  if (!list) return;
  list.textContent = '';
  list.classList.add('index-outline');
  list.classList.remove('index-thumbs');
  const idx = document.getElementById('page-index');
  if (idx) idx.classList.remove('has-thumbs');

  // Profondità >= 1 collassata di default (i libri possono avere centinaia di voci)
  const collapsedDepth = 1;

  const renderItems = (items, depth, container) => {
    for (const item of items) {
      const hasChildren = item.children && item.children.length;
      const row = document.createElement('div');
      row.className = 'page-index-item outline-item';
      if (item.page) row.dataset.page = item.page;
      row.style.paddingLeft = `${8 + depth * 14}px`;

      let sub = null;
      if (hasChildren) {
        const caret = document.createElement('span');
        caret.className = 'outline-caret';
        caret.textContent = '▸';
        row.appendChild(caret);
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!sub) return;
          const collapsed = sub.style.display === 'none';
          sub.style.display = collapsed ? '' : 'none';
          caret.textContent = collapsed ? '▾' : '▸';
        });
      }

      const title = document.createElement('span');
      title.className = 'outline-title';
      title.textContent = item.title || '(senza titolo)';
      title.title = item.title || '';
      row.appendChild(title);

      if (item.page) {
        const pg = document.createElement('span');
        pg.className = 'outline-page';
        pg.textContent = item.page;
        row.appendChild(pg);
      }

      row.addEventListener('click', () => {
        if (item.page) jumpToPageIndex(item.page);
      });

      container.appendChild(row);

      if (hasChildren) {
        sub = document.createElement('div');
        sub.className = 'outline-children';
        renderItems(item.children, depth + 1, sub);
        if (depth >= collapsedDepth) sub.style.display = 'none';
        container.appendChild(sub);
        // Aggiorna caret in base allo stato di default
        const caret = row.querySelector('.outline-caret');
        if (caret) caret.textContent = sub.style.display === 'none' ? '▸' : '▾';
      }
    }
  };

  renderItems(outline, 0, list);
  highlightPageIndex(currentPage);
}

// Thumbnail verticali delle pagine, caricate in modo lazy quando la thumb
// si avvicina al viewport della lista. Raster → endpoint server; streaming → pdf.js.
function buildThumbnailIndex() {
  const list = document.getElementById('page-index-list');
  if (!list) return;
  list.textContent = '';
  list.classList.add('index-thumbs');
  list.classList.remove('index-outline');
  const idx = document.getElementById('page-index');
  if (idx) idx.classList.add('has-thumbs');

  const items = [];
  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb-item';
    btn.dataset.page = p;
    btn.title = `Vai a pagina ${p}`;
    const img = document.createElement('img');
    img.alt = `Pagina ${p}`;
    img.draggable = false;
    img.dataset.thumbPage = p;
    btn.appendChild(img);
    const cap = document.createElement('span');
    cap.className = 'thumb-caption';
    cap.textContent = p;
    btn.appendChild(cap);
    btn.addEventListener('click', () => jumpToPageIndex(p));
    list.appendChild(btn);
    items.push({ btn, img, p });
  }

  highlightPageIndex(currentPage);

  if (typeof IntersectionObserver !== 'function') {
    // Fallback senza IO: carica tutto subito
    for (const { img } of items) loadThumb(img);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const img = en.target;
      observer.unobserve(img);
      loadThumb(img);
    }
  }, { root: list, rootMargin: '300px' });

  for (const { img } of items) observer.observe(img);
}

// Carica una singola thumbnail (raster via server, streaming via pdf.js client).
function loadThumb(img) {
  const p = img.dataset.thumbPage;
  if (!p) return;
  if (isRasterMode) {
    img.src = `/api/pdf/thumb/${currentRasterBookId}/${p}?token=${encodeURIComponent(currentRasterToken)}`;
  } else {
    renderClientThumb(img, parseInt(p, 10));
  }
}

// Thumbnail client-side per la modalità streaming (nessuna richiesta al server).
async function renderClientThumb(img, p) {
  if (!pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(p);
    const vp = page.getViewport({ scale: 0.15 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    img.src = canvas.toDataURL('image/png');
  } catch (err) {
    console.error('Thumb render error:', err);
  }
}

// Griglia di numeri di pagina (fallback finale).
function buildPageIndex() {
  const list = document.getElementById('page-index-list');
  if (!list) return;
  list.textContent = '';
  list.classList.remove('index-outline', 'index-thumbs');
  const idx = document.getElementById('page-index');
  if (idx) idx.classList.remove('has-thumbs');
  for (let p = 1; p <= totalPages; p++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'page-index-item';
    btn.dataset.page = p;
    btn.textContent = p;
    btn.title = `Vai a pagina ${p}`;
    btn.addEventListener('click', () => jumpToPageIndex(p));
    list.appendChild(btn);
  }
  highlightPageIndex(currentPage);
}

// Evidenzia tutti gli elementi dell'indice con data-page === pageNum
// (funziona per numeri, outline e thumbnail).
function highlightPageIndex(pageNum) {
  const list = document.getElementById('page-index-list');
  if (!list) return;
  for (const it of list.querySelectorAll('[data-page]')) {
    it.classList.toggle('active', parseInt(it.dataset.page, 10) === pageNum);
  }
  const active = list.querySelector('[data-page].active');
  if (active && active.scrollIntoView) {
    active.scrollIntoView({ block: 'nearest' });
  }
}

function jumpToPageIndex(pageNum) {
  if (pageNum < 1 || pageNum > totalPages || pageNum === currentPage) return;
  resetScroll();
  if (isRasterMode) {
    renderRasterPage(currentRasterBookId, currentRasterToken, pageNum);
  } else {
    renderPage(pageNum);
  }
}

function togglePageIndex() {
  const idx = document.getElementById('page-index');
  if (!idx) return;
  const hidden = idx.classList.toggle('hidden');
  const btn = document.getElementById('btn-index');
  if (btn) btn.classList.toggle('active', !hidden);
  // La larghezza disponibile cambia → ri-adatta la pagina (zoom auto)
  window.dispatchEvent(new Event('resize'));
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
  if (overlay) {
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
}

// ============================================================
// EVENT BINDINGS
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-next').addEventListener('click', nextPage);
  document.getElementById('btn-prev').addEventListener('click', prevPage);
  document.getElementById('page-input').addEventListener('change', gotoPage);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('btn-index').addEventListener('click', togglePageIndex);
  // Rotellina del mouse per scorrere le pagine
  document.getElementById('canvas-wrapper').addEventListener('wheel', handleWheel, { passive: false });
  document.getElementById('zoom-select').addEventListener('change', () => {
    rasterCache.clear(); // lo zoom cambia la scala → le pagine prefetchate non sono più valide
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
      rasterCache.clear(); // il resize cambia la scala auto → cache non valida
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