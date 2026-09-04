/**
 * Music Method Store — Account page logic
 */

import { apiFetch, showAlert, hideAlert, setLoading, showElement } from './main.js';

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
    document.getElementById('profile-since').textContent =
      user.createdAt ? new Date(user.createdAt).toLocaleDateString('it-IT', { day:'numeric', month:'long', year:'numeric' }) : '—';
    document.getElementById('profile-avatar').textContent =
      (user.firstName || user.email).charAt(0).toUpperCase();

    // Mostra contenuto e aggancia listener PRIMA delle chiamate async,
    // così i bottoni funzionano anche se un caricamento secondario fallisce
    showElement('account-loading', false);
    showElement('account-content', true);

    // Cambia password (il logout è già nel header, gestito da main.js)
    document.getElementById('show-change-password')?.addEventListener('click', toggleChangePassword);
    document.getElementById('change-password-form')?.addEventListener('submit', handleChangePassword);

    // Carica acquisti + sommario
    await loadPurchasesSummary();
    await loadPurchasesList();
  } catch (err) {
    showAlert('account-error', err.message);
    showElement('account-loading', false);
    showElement('account-error', true);
  }
}

/* ── Sommario acquisti ──────────────────────────────────── */

let purchaseSummary = null;

async function loadPurchasesSummary() {
  try {
    const { summary } = await apiFetch('/purchases');
    purchaseSummary = summary;
    document.getElementById('summary-count').textContent = summary.count;
    document.getElementById('summary-spent').textContent = `${summary.totalEur} €`;
  } catch {
    document.getElementById('summary-count').textContent = '0';
    document.getElementById('summary-spent').textContent = '0 €';
  }
}

/* ── Lista acquisti (ultimi 5 + link alla pagina dedicata) ── */

async function loadPurchasesList() {
  const list = document.getElementById('purchases-list');
  const empty = document.getElementById('purchases-empty');
  const allLink = document.getElementById('purchases-all');

  try {
    const { purchases } = await apiFetch('/purchases');

    if (!purchases || purchases.length === 0) {
      showElement('purchases-list', false);
      showElement('purchases-empty', true);
      showElement('purchases-all', false);
      return;
    }

    showElement('purchases-empty', false);
    showElement('purchases-list', true);
    showElement('purchases-all', purchases.length > 0);

    // Mostra al massimo 5 acquisti più recenti
    const shown = purchases.slice(0, 5);

    list.innerHTML = shown.map(p => `
      <div class="purchase-item">
        <div class="purchase-item-info">
          <div class="purchase-item-title">${escapeHtml(p.title)}</div>
          <div class="purchase-item-meta">
            ${escapeHtml(p.author)} · ${p.pages ? p.pages + ' pag.' : '—'} ·
            ${(p.amountCents / 100).toFixed(2)} €
            ${!p.isActive ? '<span class="badge badge-inactive">Non in catalogo</span>' : ''}
          </div>
        </div>
        <a href="/viewer/${p.bookId}" class="btn btn-primary">Leggi</a>
      </div>
    `).join('');

  } catch {
    showElement('purchases-list', false);
    showElement('purchases-empty', true);
    showElement('purchases-all', false);
  }
}

/* ── Cambia password ─────────────────────────────────────── */

function toggleChangePassword() {
  const wrap = document.getElementById('change-password-wrap');
  const isVisible = !wrap.hidden;
  wrap.hidden = isVisible;
  if (!isVisible) {
    hideAlert('pw-error');
    hideAlert('pw-success');
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  hideAlert('pw-error');
  hideAlert('pw-success');

  const form = e.target;
  const currentPassword = form.currentPassword.value.trim();
  const newPassword    = form.newPassword.value.trim();
  const newPassword2   = form.newPassword2.value.trim();

  if (!currentPassword || !newPassword || !newPassword2) {
    showAlert('pw-error', 'Compila tutti i campi');
    return;
  }
  if (newPassword !== newPassword2) {
    showAlert('pw-error', 'Le nuove password non coincidono');
    return;
  }
  if (newPassword.length < 8) {
    showAlert('pw-error', 'Password minima 8 caratteri');
    return;
  }

  const btn = form.querySelector('button[type="submit"]');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Aggiornamento…';

  try {
    const result = await apiFetch('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword, newPassword2 })
    });
    showAlert('pw-success', result?.message || 'Password aggiornata con successo', 'success');
    form.reset();
  } catch (err) {
    showAlert('pw-error', err.message || 'Errore durante l\'aggiornamento');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ── Logout ──────────────────────────────────────────────── */

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
