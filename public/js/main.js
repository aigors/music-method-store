/**
 * Music Method Store — Common utilities
 */

export const API_BASE = '/api';

// ============================================================
// Fetch wrapper con gestione errori e sessione
// ============================================================
export async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include' // importante per session cookie
  });

  // Legge il corpo una sola volta (riusabile per 401/403 e altri errori)
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  // Se 401/403 → redirect a login
  if (response.status === 401 || response.status === 403) {
    if (data && data.redirect) {
      window.location.href = data.redirect;
      return null;
    }
  }

  if (!response.ok) {
    throw new Error((data && data.error) || `HTTP ${response.status}`);
  }

  if (response.status === 204 || data === null) return null;
  return data;
}

// ============================================================
// UI Helpers
// ============================================================
export function showAlert(containerId, message, type = 'error') {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.textContent = message;
  container.className = `alert alert-${type}`;
  container.hidden = false;
}

export function hideAlert(containerId) {
  const container = document.getElementById(containerId);
  if (container) container.hidden = true;
}

export function setLoading(elementId, loading) {
  const el = document.getElementById(elementId);
  if (el) el.hidden = !loading;
}

export function showElement(elementId, show = true) {
  const el = document.getElementById(elementId);
  if (el) el.hidden = !show;
}

// ============================================================
// Auth navigation (header)
// ============================================================
let currentUser = null;

export async function updateAuthNav() {
  const authNav = document.getElementById('auth-nav');
  if (!authNav) return;

  try {
    const { user } = await apiFetch('/auth/me');
    currentUser = user;
  } catch {
    currentUser = null;
  }

  if (currentUser) {
    const email = currentUser.email.length > 25
      ? currentUser.email.slice(0, 22) + '…'
      : currentUser.email;
    const adminLink = currentUser.isAdmin ? '<a href="/admin" class="nav-link">Admin</a>' : '';
    authNav.innerHTML = `
      <span class="nav-link user-email" style="color: var(--text-muted); font-weight: 400;">
        👤 ${email}
      </span>
      ${adminLink}
      <a href="/account" class="nav-link">Account</a>
      <button type="button" class="btn btn-link" id="logout-btn">Esci</button>
    `;
    document.getElementById('logout-btn')?.addEventListener('click', doLogout);
  } else {
    authNav.innerHTML = `
      <a href="/login" class="nav-link">Accedi</a>
      <a href="/registrati" class="btn btn-primary" style="padding: 0.4rem 1rem; font-size: 0.9rem;">Registrati</a>
    `;
  }
}

async function doLogout() {
  try {
    await apiFetch('/auth/logout', { method: 'POST' });
  } catch (e) {
    console.error('Logout error:', e);
  }
  // Reindirizza sempre alla home (catalogo) dopo il logout,
  // indipendentemente dalla pagina corrente (account, viewer, admin…)
  currentUser = null;
  window.location.href = '/';
}

// Inizializza nav all'avvio
document.addEventListener('DOMContentLoaded', updateAuthNav);

// Esporta per uso in altri moduli
export { currentUser };