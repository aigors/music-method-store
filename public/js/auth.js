/**
 * Music Method Store — Auth pages logic
 */

import { apiFetch, showAlert, hideAlert } from './main.js';

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

  try {
    await apiFetch('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, password2 })
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
// 2FA
// ============================================================
export async function handle2FA(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = document.getElementById('2fa-submit');
  const originalText = submitBtn.textContent;

  hideAlert('2fa-error');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Verifica…';

  const code = form.code.value.trim();

  try {
    await apiFetch('/auth/2fa', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
    // Redirect alla destinazione originale
    const redirect = new URLSearchParams(window.location.search).get('redirect') || '/catalogo';
    window.location.href = redirect;
  } catch (err) {
    showAlert('2fa-error', err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = originalText;
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