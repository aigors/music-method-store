/**
 * Music Method Store — Purchases page logic ("I miei metodi")
 */

import { apiFetch, showAlert, hideAlert, setLoading, showElement } from './main.js';

async function loadPurchases() {
  hideAlert('purchases-error');
  setLoading('purchases-loading', true);
  showElement('purchases-grid', false);
  showElement('purchases-empty', false);

  try {
    const { purchases } = await apiFetch('/purchases');
    renderPurchases(purchases);
  } catch (err) {
    showAlert('purchases-error', err.message);
    showElement('purchases-error', true);
  } finally {
    setLoading('purchases-loading', false);
  }
}

function renderPurchases(purchases) {
  const grid = document.getElementById('purchases-grid');
  const empty = document.getElementById('purchases-empty');

  if (!purchases || purchases.length === 0) {
    showElement('purchases-empty', true);
    showElement('purchases-grid', false);
    return;
  }

  showElement('purchases-empty', false);
  showElement('purchases-grid', true);

  grid.innerHTML = purchases.map(p => {
    const purchasedDate = new Date(p.purchasedAt).toLocaleDateString('it-IT', {
      day: 'numeric', month: 'long', year: 'numeric'
    });
    const amount = p.amountCents != null ? (p.amountCents / 100).toFixed(2) : '—';

    return `
      <article class="book-card" data-book-id="${p.bookId}">
        <div class="book-cover">
          <img src="/api/catalog/cover/${p.bookId}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
          <div class="book-cover-fallback" style="display:none;">${p.title.charAt(0)}</div>
          ${!p.isActive ? '<span class="badge badge-inactive" style="position:absolute;top:0.75rem;right:0.75rem;">Non più in catalogo</span>' : ''}
        </div>
        <div class="book-body">
          <h3 class="book-title">${escapeHtml(p.title)}</h3>
          <p class="book-author">${escapeHtml(p.author)}</p>
          <p class="book-desc">${escapeHtml(p.description || 'Nessuna descrizione disponibile.')}</p>
          <div class="book-meta">
            <div>
              <span class="book-price">Pagato: ${amount} €</span>
              ${p.pages ? `<span class="book-pages"> · ${p.pages} pag.</span>` : ''}
            </div>
          </div>
          <div class="book-meta-info">
            Acquistato il ${purchasedDate}
          </div>
          <div class="book-actions" style="margin-top:0.75rem;">
            <a href="/viewer/${p.bookId}" class="btn btn-primary btn-block">Leggi ora</a>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Avvia il caricamento
document.addEventListener('DOMContentLoaded', loadPurchases);
