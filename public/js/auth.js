/**
 * Music Method Store — Auth pages logic
 */

import { apiFetch, showAlert, hideAlert, showElement } from './main.js';

// ============================================================
// Login
// ============================================================
export async function handleLogin(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  hideAlert('login-error');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Invio…';

  const formData = new FormData(form);
  const email = formData.get('email');
  const password = formData.get('password');

  try {
    await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    // Redirect a 2FA
    const redirect = new URLSearchParams(window.location.search).get('redirect') || '/catalogo';
    window.location.href = `/2fa?redirect=${encodeURIComponent(redirect)}`;
  } catch (err) {
    showAlert('login-error', err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// ============================================================
// Register
// ============================================================
export async function handleRegister(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  hideAlert('register-error');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Registrazione…';

  const formData = new FormData(form);
  const email = formData.get('email');
  const password = formData.get('password');
  const password2 = formData.get('password2');
  const firstName = formData.get('firstName');
  const lastName = formData.get('lastName');
  const birthPlace = formData.get('birthPlace');

  // Combina i campi giorno/mese/anno in formato YYYY-MM-DD
  const day = (formData.get('birthDay') || '').trim();
  const month = (formData.get('birthMonth') || '').trim();
  const year = (formData.get('birthYear') || '').trim();
  const birthDate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

  try {
    await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, password2, firstName, lastName, birthDate, birthPlace })
    });
    const redirect = new URLSearchParams(window.location.search).get('redirect') || '/catalogo';
    window.location.href = `/2fa?redirect=${encodeURIComponent(redirect)}`;
  } catch (err) {
    showAlert('register-error', err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// ============================================================
// Forgot password
// ============================================================
export async function handleForgotPassword(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  hideAlert('forgot-error');
  hideAlert('forgot-success');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Invio…';

  const email = new FormData(form).get('email');

  try {
    await apiFetch('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    showAlert('forgot-success', 'Se l\'email è registrata, riceverai un link per reimpostare la password.');
    showElement('forgot-success', true);
    form.reset();
  } catch (err) {
    showAlert('forgot-error', err.message);
    showElement('forgot-error', true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// ============================================================
// Reset password (nuova password da token)
// ============================================================
export async function handleResetPassword(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn.textContent;

  hideAlert('reset-error');
  hideAlert('reset-success');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Aggiornamento…';

  const formData = new FormData(form);
  const password = formData.get('password');
  const password2 = formData.get('password2');

  if (password !== password2) {
    showAlert('reset-error', 'Le password non coincidono');
    showElement('reset-error', true);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
    return;
  }

  // Token dall'URL
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    showAlert('reset-error', 'Link non valido o scaduto. Richiedi un nuovo recupero.');
    showElement('reset-error', true);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
    return;
  }

  try {
    await apiFetch('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password })
    });
    showAlert('reset-success', 'Password aggiornata. Ora puoi accedere con la nuova password.');
    showElement('reset-success', true);
    form.reset();
    // Link al login dopo qualche secondo
    setTimeout(() => { window.location.href = '/login'; }, 2500);
  } catch (err) {
    showAlert('reset-error', err.message);
    showElement('reset-error', true);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
  }
}

// ============================================================
// 2FA
// ============================================================
export async function handle2FA(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = document.getElementById('2fa-submit');
  const codeInput = document.getElementById('code');
  const originalText = submitBtn.textContent;

  hideAlert('2fa-error');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifica…';

  const code = codeInput.value.trim();

  try {
    await apiFetch('/auth/2fa', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    // Redirect alla destinazione originale
    const redirect = new URLSearchParams(window.location.search).get('redirect') || '/catalogo';
    window.location.href = redirect;
  } catch (err) {
    showAlert('2fa-error', err.message || 'Errore sconosciuto. Riprova.');
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
    // Pulisci il campo e metti il focus per il prossimo tentativo
    codeInput.value = '';
    codeInput.focus();
  }
}

export async function handleResend() {
  const btn = document.getElementById('resend-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Invio…';

  try {
    await apiFetch('/auth/2fa/resend', { method: 'POST' });
    btn.textContent = 'Codice inviato!';
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
  } catch (err) {
    btn.textContent = originalText;
    btn.disabled = false;
    showAlert('2fa-error', err.message);
  }
}

// Inizializza email nel 2FA
document.addEventListener('DOMContentLoaded', async () => {
  const emailEl = document.getElementById('2fa-email');
  if (emailEl) {
    try {
      const { user } = await apiFetch('/auth/me');
      if (user?.email) emailEl.textContent = user.email;
    } catch { /* ignore */ }
  }
});