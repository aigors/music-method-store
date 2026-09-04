/**
 * Music Method Store — Catalog page logic
 */

import { apiFetch, showAlert, hideAlert, setLoading, showElement } from './main.js';

export async function loadCatalog() {
  hideAlert('catalog-error');
  setLoading('catalog-loading', true);
  showElement('catalog-grid', false);
  showElement('catalog-empty', false);

  try {
    const { books } = await apiFetch('/catalog');
    renderCatalog(books);
  } catch (err) {
    showAlert('catalog-error', err.message);
    showElement('catalog-error', true);
  } finally {
    setLoading('catalog-loading', false);
  }
}

export function renderCatalog(books) {
  const grid = document.getElementById('catalog-grid');
  const empty = document.getElementById('catalog-empty');

  if (!books || books.length === 0) {
    showElement('catalog-empty', true);
    showElement('catalog-grid', false);
    return;
  }

  showElement('catalog-empty', false);
  showElement('catalog-grid', true);

  grid.innerHTML = books.map(book => `
    <article class="book-card" data-book-id="${book.id}">
      <div class="book-cover">
        ${book.coverUrl
          ? `<img src="${book.coverUrl}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`
          : book.coverFile
            ? `<img src="/covers/${book.coverFile}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`
            : `<div class="book-cover-fallback">${book.title.charAt(0)}</div>`
        }
        ${book.purchased ? '<span class="badge badge-owned" style="position:absolute;top:0.75rem;right:0.75rem;">Acquistato</span>' : ''}
      </div>
      <div class="book-body">
        <h3 class="book-title">${escapeHtml(book.title)}</h3>
        <p class="book-author">${escapeHtml(book.author)}</p>
        <p class="book-desc">${escapeHtml(book.description || 'Nessuna descrizione disponibile.')}</p>
        <div class="book-meta">
          <div>
            <span class="book-price">${book.priceEur} €</span>
            ${book.pages ? `<span class="book-pages"> · ${book.pages} pag.</span>` : ''}
          </div>
        </div>
        <div class="book-actions">
          ${book.purchased
            ? `<a href="/viewer/${book.id}" class="btn btn-primary btn-block">Leggi ora</a>`
            : `<button type="button" class="btn btn-primary btn-block buy-btn" data-book-id="${book.id}">Acquista</button>`
          }
        </div>
      </div>
    </article>
  `).join('');

  // Bind buy buttons
  grid.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', () => handleBuy(btn.dataset.bookId));
  });
}

async function handleBuy(bookId) {
  const btn = document.querySelector(`.buy-btn[data-book-id="${bookId}"]`);
  if (!btn) return;
  const originalText = btn.textContent;

  try {
    // Verifica se loggato
    const meData = await apiFetch('/auth/me');
    const user = meData && meData.user;
    if (!user) {
      window.location.href = `/login?redirect=/catalogo`;
      return;
    }
    if (!user.twoFaVerified) {
      window.location.href = `/2fa?redirect=/catalogo`;
      return;
    }

    // Crea ordine PayPal
    btn.disabled = true;
    btn.textContent = 'Reindirizzamento a PayPal…';

    const orderData = await apiFetch('/payment/create-order', {
      method: 'POST',
      body: JSON.stringify({ bookId: parseInt(bookId, 10) })
    });
    const orderId = orderData && orderData.orderId;

    if (!orderId) {
      throw new Error('Ordine non creato. Riprova.');
    }

    // Avvia PayPal Buttons
    initPaypalButton(bookId, orderId);
  } catch (err) {
    console.error('[handleBuy]', err);
    btn.disabled = false;
    btn.textContent = originalText;
    showAlert('catalog-error', err.message || 'Errore sconosciuto. Riprova.');
    showElement('catalog-error', true);
  }
}

function initPaypalButton(bookId, orderId) {
  // Carica PayPal SDK dinamicamente se non già presente
  if (window.paypal) {
    renderPaypalButton(bookId, orderId);
    return;
  }

  const clientId = getPaypalClientId();
  console.log('[PayPal] Client ID:', clientId ? clientId.substring(0, 10) + '…' : 'VUOTO');

  if (!clientId) {
    console.error('[PayPal] Client ID mancante — impossibile caricare lo SDK');
    const btn = document.querySelector(`.buy-btn[data-book-id="${bookId}"]`);
    if (btn) { btn.disabled = false; btn.textContent = 'Acquista'; }
    showAlert('catalog-error', 'Configurazione PayPal mancante. Contatta l\'amministratore.');
    showElement('catalog-error', true);
    return;
  }

  const script = document.createElement('script');
  script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=EUR&locale=it_IT`;
  script.onload = () => {
    console.log('[PayPal] SDK caricato, window.paypal:', !!window.paypal);
    renderPaypalButton(bookId, orderId);
  };
  script.onerror = (e) => {
    console.error('[PayPal] Errore caricamento SDK:', e);
    const btn = document.querySelector(`.buy-btn[data-book-id="${bookId}"]`);
    if (btn) { btn.disabled = false; btn.textContent = 'Acquista'; }
    showAlert('catalog-error', 'Impossibile caricare PayPal. Riprova più tardi.');
    showElement('catalog-error', true);
  };
  document.head.appendChild(script);
}

function getPaypalClientId() {
  // Viene dall'endpoint /api/config
  return window.MMS_PAYPAL_CLIENT_ID || '';
}

function renderPaypalButton(bookId, orderId) {
  const btn = document.querySelector(`.buy-btn[data-book-id="${bookId}"]`);
  if (!btn) {
    console.error('[PayPal] Container non trovato per book', bookId);
    return;
  }

  // PayPal SDK v5 non permette di renderizzare dentro un <button> — sostituiamo con <div>
  const container = document.createElement('div');
  container.className = 'paypal-btn-container';
  container.style.width = '100%';
  btn.parentNode.replaceChild(container, btn);

  console.log('[PayPal] Rendering pulsanti, orderId:', orderId);

  try {
    window.paypal.Buttons({
      createOrder: () => orderId,
      onApprove: async (data, actions) => {
        try {
          console.log('[PayPal] onApprove fired, orderID:', data.orderID);
          const result = await apiFetch('/payment/capture-order', {
            method: 'POST',
            body: JSON.stringify({ orderId: data.orderID })
          });
          console.log('[PayPal] capture result:', result);
          loadCatalog();
        } catch (err) {
          console.error('[PayPal] Capture error:', err);
          throw err;
        }
      },
      onCancel: () => {
        console.log('[PayPal] Checkout annullato');
        loadCatalog();
      },
      onError: (err) => {
        console.error('[PayPal] Errore:', err);
        loadCatalog();
      }
    }).render(container);
    console.log('[PayPal] Buttons.render() completato');
  } catch (err) {
    console.error('[PayPal] Errore rendering:', err);
    showAlert('catalog-error', 'Errore nel rendering PayPal: ' + err.message);
    showElement('catalog-error', true);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Inizializza client ID PayPal all'avvio
(async () => {
  try {
    const config = await fetch('/api/config').then(r => r.json());
    window.MMS_PAYPAL_CLIENT_ID = config.paypalClientId;
  } catch { /* ignore */ }
})();