/**
 * Music Method Store — Account page logic
 */

import { apiFetch, showAlert, hideAlert, setLoading, showElement, updateAuthNav } from './main.js';

export async function loadAccount() {
  hideAlert('account-error');
  setLoading('account-loading', true);
  showElement('account-content', false);
  showElement('account-error', false);

  try {
    const { user } = await apiFetch('/auth/me');
    if (!user) {
      window.location.href = '/login?redirect=/account';
      return;
    }

    // Aggiorna UI profilo
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    document.getElementById('profile-name').textContent = fullName;
    document.getElementById('profile-email').textContent = user.email;
    document.getElementById('profile-birthdate').textContent = user.birthDate || '—';
    document.getElementById('profile-birthplace').textContent = user.birthPlace || '—';
    const avatar = document.getElementById('profile-avatar');
    avatar.textContent = (user.firstName || user.email).charAt(0).toUpperCase();
    document.getElementById('profile-since').textContent = new Date().toLocaleDateString('it-IT');

    // Carica acquisti
    await loadPurchases();

    showElement('account-loading', false);
    showElement('account-content', true);

    // Logout button
    document.getElementById('logout-btn')?.addEventListener('click', doLogout);
  } catch (err) {
    showAlert('account-error', err.message);
    showElement('account-loading', false);
    showElement('account-error', true);
  }
}

async function loadPurchases() {
  // Non c'è un endpoint diretto, prendiamo dal catalogo e filtriamo
  const { books } = await apiFetch('/catalog');
  const purchased = books.filter(b => b.purchased);

  const list = document.getElementById('purchases-list');
  const empty = document.getElementById('purchases-empty');

  if (purchased.length === 0) {
    showElement('purchases-list', false);
    showElement('purchases-empty', true);
    return;
  }

  showElement('purchases-empty', false);
  showElement('purchases-list', true);

  list.innerHTML = purchased.map(book => `
    <div class="purchase-item">
      <div class="purchase-item-info">
        <div class="purchase-item-title">${escapeHtml(book.title)}</div>
        <div class="purchase-item-meta">${escapeHtml(book.author)} · ${book.pages || '?'} pag. · ${book.priceEur} €</div>
      </div>
      <a href="/viewer/${book.id}" class="btn btn-primary">Leggi</a>
    </div>
  `).join('');
}

async function doLogout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
    window.location.href = '/catalogo';
  } catch (err) {
    showAlert('account-error', err.message);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}