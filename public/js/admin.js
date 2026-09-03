/**
 * Music Method Store — Admin Panel logic
 */

import { apiFetch } from '/js/main.js';

const ADMIN = {
  books: [],
  users: []
};

/* ============================================================
   Utility
   ============================================================ */
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-hidden');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('it-IT', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  } catch {
    return iso;
  }
}

/* ============================================================
   Stats
   ============================================================ */
async function loadStats() {
  try {
    const data = await apiFetch('/admin/stats');
    document.getElementById('stat-users-active').textContent = data.users.active;
    document.getElementById('stat-users-inactive').textContent = data.users.inactive;
    document.getElementById('stat-books-active').textContent = data.books.active;
    document.getElementById('stat-books-inactive').textContent = data.books.inactive;
    document.getElementById('stat-orders').textContent = data.orders;
    document.getElementById('stat-revenue').textContent = data.revenueEur;
    document.getElementById('stats-section').hidden = false;
  } catch (e) {
    console.error('Stats error:', e);
  }
}

/* ============================================================
   Users
   ============================================================ */
async function loadUsers() {
  const loading = document.getElementById('users-loading');
  const container = document.getElementById('users-table-container');
  const empty = document.getElementById('users-empty');
  loading.hidden = false;
  container.hidden = true;
  empty.hidden = true;
  try {
    const { users } = await apiFetch('/admin/users');
    ADMIN.users = users;
    loading.hidden = true;
    if (users.length === 0) {
      empty.hidden = false;
      return;
    }
    container.hidden = false;
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = users.map(u => `
      <tr>
        <td>${u.id}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td>
          <span class="badge ${u.isActive ? 'badge-active' : 'badge-inactive'}">
            ${u.isActive ? 'Attivo' : 'Disattivato'}
          </span>
        </td>
        <td>${u.isAdmin ? '👑 Sì' : '—'}</td>
        <td class="actions-cell">
          ${u.isAdmin ? '' : `
            ${u.isActive
              ? `<button class="btn btn-sm btn-warning" data-action="deactivate" data-id="${u.id}">Disattiva</button>`
              : `<button class="btn btn-sm btn-success" data-action="activate" data-id="${u.id}">Riattiva</button>`}
            <button class="btn btn-sm btn-danger" data-action="delete-user" data-id="${u.id}" data-email="${escapeHtml(u.email)}">Elimina</button>
          `}
        </td>
      </tr>
    `).join('');
  } catch (e) {
    loading.hidden = true;
    showToast('Errore caricamento utenti: ' + e.message, 'error');
  }
}

async function handleUserAction(action, id, email) {
  if (action === 'delete-user') {
    if (!confirm(`Sei sicuro di voler ELIMINARE definitivamente l'utente "${email}"?\nTutti i suoi acquisti e dati verranno rimossi.`)) return;
  }
  if (action === 'deactivate') {
    if (!confirm(`Disattivare l'utente "${email}"? Non potrà più accedere.`)) return;
  }

  try {
    if (action === 'activate') await apiFetch(`/admin/users/${id}/activate`, { method: 'POST' });
    else if (action === 'deactivate') await apiFetch(`/admin/users/${id}/deactivate`, { method: 'POST' });
    else if (action === 'delete-user') await apiFetch(`/admin/users/${id}`, { method: 'DELETE' });

    showToast('Operazione completata', 'success');
    await Promise.all([loadUsers(), loadStats()]);
  } catch (e) {
    showToast('Errore: ' + e.message, 'error');
  }
}

/* ============================================================
   Books
   ============================================================ */
async function loadBooks() {
  const loading = document.getElementById('books-loading');
  const container = document.getElementById('books-table-container');
  const empty = document.getElementById('books-empty');
  loading.hidden = false;
  container.hidden = true;
  empty.hidden = true;
  try {
    const { books } = await apiFetch('/admin/books');
    ADMIN.books = books;
    loading.hidden = true;
    if (books.length === 0) {
      empty.hidden = false;
      return;
    }
    container.hidden = false;
    const tbody = document.getElementById('books-tbody');
    tbody.innerHTML = books.map(b => `
      <tr>
        <td>${b.id}</td>
        <td>${escapeHtml(b.title)}</td>
        <td>${escapeHtml(b.author)}</td>
        <td>€${b.priceEur}</td>
        <td>${b.pages}</td>
        <td>
          <span class="badge ${b.isActive ? 'badge-active' : 'badge-inactive'}">
            ${b.isActive ? 'Attivo' : 'Inattivo'}
          </span>
        </td>
        <td>
          ${b.pdfFile
            ? `<span class="pdf-status ${b.pdfExists ? 'pdf-ok' : 'pdf-missing'}">
                 ${b.pdfExists ? '✓' : '✗'} ${escapeHtml(b.pdfFile)}
                 ${!b.pdfExists ? '<span class="pdf-warning"> (file mancante!)</span>' : ''}
               </span>`
            : `<span class="pdf-status pdf-missing">✗ Nessun PDF</span>`}
        </td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-primary" data-action="edit-book" data-id="${b.id}">Modifica</button>
          <button class="btn btn-sm btn-secondary" data-action="upload-book" data-id="${b.id}">PDF</button>
          <button class="btn btn-sm btn-info" data-action="associate-pdf" data-id="${b.id}" title="Associa PDF caricato">📎 Associa</button>
          ${b.pdfFile && b.pdfExists ? `
            <button class="btn btn-sm btn-info" data-action="regenerate-cover" data-id="${b.id}" title="Rigenera cover dalla prima pagina">🔄 Cover</button>
          ` : ''}
          <button class="btn btn-sm btn-danger" data-action="delete-book" data-id="${b.id}" data-title="${escapeHtml(b.title)}">Rimuovi</button>
        </td>
      </tr>
    `).join('');
  } catch (e) {
    loading.hidden = true;
    showToast('Errore caricamento libri: ' + e.message, 'error');
  }
}

/* ============================================================
   Modal Book
   ============================================================ */
function openBookModal(book = null, uploadOnly = false) {
  const modal = document.getElementById('book-modal');
  const title = document.getElementById('book-modal-title');
  const form = document.getElementById('book-form');
  const pdfGroup = document.getElementById('book-pdf-group');
  const activeGroup = document.getElementById('book-active-group');
  const protectionGroup = document.getElementById('book-protection-group');
  const submit = document.getElementById('book-submit');
  const pdfHint = document.getElementById('pdf-hint');
  const fileInput = document.getElementById('book-pdf');

  form.reset();

  // Rimuovi required se non è creazione nuovo
  fileInput.required = !book && !uploadOnly;

  if (book && !uploadOnly) {
    // Edit mode: PDF optional (keep existing)
    title.textContent = 'Modifica metodo';
    document.getElementById('book-id').value = book.id;
    document.getElementById('book-slug').value = book.slug;
    document.getElementById('book-title').value = book.title;
    document.getElementById('book-author').value = book.author;
    document.getElementById('book-description').value = book.description || '';
    document.getElementById('book-price').value = (book.priceCents / 100).toFixed(2);
    document.getElementById('book-pages').value = book.pages || '';
    document.getElementById('book-cover').value = book.coverFile || '';
    document.getElementById('book-is-active').checked = !!book.isActive;

    // Protezione avanzata fields
    document.getElementById('book-high-security').checked = !!book.highSecurity;
    document.getElementById('book-watermark-opacity').value = book.watermarkOpacity ?? 0.25;
    document.getElementById('book-watermark-pages').value = book.watermarkPages || '';
    document.getElementById('book-watermark-text').value = book.watermarkText || '';

    pdfGroup.hidden = true;
    activeGroup.hidden = false;
    protectionGroup.hidden = false;
    pdfHint.textContent = 'Lasciare vuoto per mantenere il PDF attuale. Max 50 MB.';
    submit.textContent = 'Aggiorna';
    form.dataset.mode = 'edit';
  } else if (uploadOnly && book) {
    // Upload-only mode: only show PDF field for existing book
    title.textContent = `Sostituisci PDF — ${book.title}`;
    document.getElementById('book-id').value = book.id;
    pdfGroup.hidden = false;
    activeGroup.hidden = true;
    protectionGroup.hidden = true;
    pdfHint.textContent = 'Max 50 MB. Solo PDF. Sostituirà il file attuale.';
    submit.textContent = 'Carica PDF';
    form.dataset.mode = 'upload';
  } else {
    // Create new book
    title.textContent = 'Nuovo metodo';
    document.getElementById('book-id').value = '';
    document.getElementById('book-high-security').checked = false;
    document.getElementById('book-watermark-opacity').value = 0.25;
    document.getElementById('book-watermark-pages').value = '';
    document.getElementById('book-watermark-text').value = '';
    pdfGroup.hidden = false;
    activeGroup.hidden = true;
    protectionGroup.hidden = true;
    pdfHint.textContent = 'Max 50 MB. Solo PDF.';
    submit.textContent = 'Crea';
    form.dataset.mode = 'create';
  }

  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeBookModal() {
  document.getElementById('book-modal').hidden = true;
  document.body.style.overflow = '';
}

async function submitBookForm(e) {
  e.preventDefault();
  const form = document.getElementById('book-form');
  const mode = form.dataset.mode || 'create';
  const id = document.getElementById('book-id').value;
  const fileInput = document.getElementById('book-pdf');

  try {
    if (mode === 'upload') {
      // Upload-only: solo file PDF
      if (fileInput.files.length === 0) {
        showToast('Seleziona un PDF', 'error');
        return;
      }
      const uploadForm = new FormData();
      uploadForm.append('pdf', fileInput.files[0]);
      const resp = await fetch(`/api/admin/books/${id}/upload`, {
        method: 'POST',
        body: uploadForm,
        credentials: 'include'
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      showToast('PDF aggiornato', 'success');
      closeBookModal();
      await loadBooks();
      return;
    }

    if (mode === 'create') {
      // Create new book - requires PDF
      if (fileInput.files.length === 0) {
        showToast('Seleziona un file PDF', 'error');
        return;
      }
      const formData = new FormData();
      formData.append('slug', document.getElementById('book-slug').value.trim());
      formData.append('title', document.getElementById('book-title').value.trim());
      formData.append('author', document.getElementById('book-author').value.trim());
      formData.append('description', document.getElementById('book-description').value.trim());
      formData.append('priceCents', Math.round(parseFloat(document.getElementById('book-price').value) * 100));
      formData.append('pages', document.getElementById('book-pages').value || '0');
      formData.append('coverFile', document.getElementById('book-cover').value.trim());
      formData.append('highSecurity', document.getElementById('book-high-security').checked ? '1' : '0');
      formData.append('watermarkOpacity', document.getElementById('book-watermark-opacity').value || '0.25');
      formData.append('watermarkPages', document.getElementById('book-watermark-pages').value.trim() || '');
      formData.append('watermarkText', document.getElementById('book-watermark-text').value.trim() || '');
      formData.append('pdf', fileInput.files[0]);

      const resp = await fetch('/api/admin/books', {
        method: 'POST',
        body: formData,
        credentials: 'include'
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      showToast('Metodo creato', 'success');
      closeBookModal();
      await Promise.all([loadBooks(), loadStats()]);
      return;
    }

    // Edit mode - update metadata (PDF optional via separate flow)
    const payload = {
      slug: document.getElementById('book-slug').value.trim(),
      title: document.getElementById('book-title').value.trim(),
      author: document.getElementById('book-author').value.trim(),
      description: document.getElementById('book-description').value.trim(),
      priceCents: Math.round(parseFloat(document.getElementById('book-price').value) * 100),
      pages: parseInt(document.getElementById('book-pages').value, 10) || 0,
      coverFile: document.getElementById('book-cover').value.trim() || null,
      isActive: document.getElementById('book-is-active').checked ? 1 : 0,
      highSecurity: document.getElementById('book-high-security').checked ? 1 : 0,
      watermarkOpacity: parseFloat(document.getElementById('book-watermark-opacity').value) || 0.25,
      watermarkPages: document.getElementById('book-watermark-pages').value.trim() || null,
      watermarkText: document.getElementById('book-watermark-text').value.trim() || null
    };
    await apiFetch(`/admin/books/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    showToast('Metodo aggiornato', 'success');
    closeBookModal();
    await Promise.all([loadBooks(), loadStats()]);
  } catch (e) {
    showToast('Errore: ' + e.message, 'error');
  }
}

/* ============================================================
   Table actions delegation
   ============================================================ */
function handleTableClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === 'edit-book') {
    const book = ADMIN.books.find(b => String(b.id) === String(id));
    if (book) openBookModal(book);
    return;
  }
  if (action === 'upload-book') {
    const book = ADMIN.books.find(b => String(b.id) === String(id));
    openBookModal(book, true); // uploadOnly = true
    return;
  }
  if (action === 'associate-pdf') {
    openAssociatePdfModal(id);
    return;
  }
  if (action === 'regenerate-cover') {
    handleRegenerateCover(id);
    return;
  }
  if (action === 'delete-book') {
    const title = btn.dataset.title;
    if (!confirm(`Rimuovere "${title}" dal catalogo?\nGli acquisti esistenti restano validi ma il metodo non sarà più visibile.`)) return;
    handleBookDelete(id);
    return;
  }
  if (['activate', 'deactivate', 'delete-user'].includes(action)) {
    handleUserAction(action, id, btn.dataset.email);
    return;
  }
}

async function handleRegenerateCover(id) {
  const btn = document.querySelector(`button[data-action="regenerate-cover"][data-id="${id}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳';
  }
  try {
    const resp = await apiFetch(`/admin/books/${id}/regenerate-cover`, { method: 'POST' });
    showToast(resp.message || 'Cover rigenerata', 'success');
    // Ricarica libri per aggiornare UI
    await loadBooks();
  } catch (e) {
    showToast('Errore rigenerazione cover: ' + e.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Cover';
    }
  }
}

async function handleBookDelete(id) {
  try {
    await apiFetch(`/admin/books/${id}`, { method: 'DELETE' });
    showToast('Metodo rimosso', 'success');
    await Promise.all([loadBooks(), loadStats()]);
  } catch (e) {
    showToast('Errore: ' + e.message, 'error');
  }
}

/* ============================================================
   Modal Associa PDF esistente
   ============================================================ */
let associatePdfModal = null;
let availablePdfs = [];

async function openAssociatePdfModal(bookId) {
  const book = ADMIN.books.find(b => String(b.id) === String(bookId));
  if (!book) return;

  // Carica lista PDF disponibili
  try {
    const { files } = await apiFetch('/admin/pdfs/available');
    availablePdfs = files;
  } catch (e) {
    showToast('Errore caricamento PDF: ' + e.message, 'error');
    return;
  }

  // Crea modal se non esiste
  if (!associatePdfModal) {
    associatePdfModal = document.createElement('div');
    associatePdfModal.id = 'associate-pdf-modal';
    associatePdfModal.className = 'modal-overlay';
    associatePdfModal.innerHTML = `
      <div class="modal modal-medium">
        <div class="modal-header">
          <h3 id="associate-pdf-title">Associa PDF</h3>
          <button type="button" class="modal-close" id="associate-pdf-close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">Seleziona un file PDF già caricato da associare a questo metodo</p>
          <div id="pdf-list-container" class="pdf-list-container">
            <div class="loading" id="pdf-list-loading">Caricamento...</div>
            <div id="pdf-list-empty" class="empty-state" hidden>Nessun PDF disponibile</div>
            <div id="pdf-list" class="pdf-list"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="associate-pdf-cancel">Annulla</button>
        </div>
      </div>
    `;
    document.body.appendChild(associatePdfModal);

    // Event listeners
    document.getElementById('associate-pdf-close').addEventListener('click', closeAssociatePdfModal);
    document.getElementById('associate-pdf-cancel').addEventListener('click', closeAssociatePdfModal);
    associatePdfModal.addEventListener('click', (e) => {
      if (e.target.id === 'associate-pdf-modal') closeAssociatePdfModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !associatePdfModal.hidden) closeAssociatePdfModal();
    });
  }

  // Aggiorna titolo
  document.getElementById('associate-pdf-title').textContent = `Associa PDF — ${book.title}`;

  // Renderizza lista PDF
  renderPdfList(bookId);

  associatePdfModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeAssociatePdfModal() {
  if (associatePdfModal) {
    associatePdfModal.hidden = true;
    document.body.style.overflow = '';
  }
}

function renderPdfList(bookId) {
  const loading = document.getElementById('pdf-list-loading');
  const empty = document.getElementById('pdf-list-empty');
  const list = document.getElementById('pdf-list');

  loading.hidden = true;

  if (availablePdfs.length === 0) {
    empty.hidden = false;
    list.hidden = true;
    return;
  }

  empty.hidden = true;
  list.hidden = false;

  list.innerHTML = availablePdfs.map(f => `
    <div class="pdf-list-item" data-filename="${escapeHtml(f.filename)}">
      <div class="pdf-info">
        <span class="pdf-name">${escapeHtml(f.filename)}</span>
        <span class="pdf-meta">${f.sizeFormatted} • ${new Date(f.modified).toLocaleString('it-IT')}</span>
      </div>
      <button class="btn btn-sm btn-primary pdf-select-btn" data-filename="${escapeHtml(f.filename)}">Seleziona</button>
    </div>
  `).join('');

  // Click handlers per i bottoni
  list.querySelectorAll('.pdf-select-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const filename = btn.dataset.filename;
      associatePdfToBook(bookId, filename);
    });
  });

  // Click su tutta la riga
  list.querySelectorAll('.pdf-list-item').forEach(item => {
    item.addEventListener('click', () => {
      const filename = item.dataset.filename;
      associatePdfToBook(bookId, filename);
    });
  });
}

async function associatePdfToBook(bookId, filename) {
  try {
    const resp = await apiFetch(`/admin/books/${bookId}/associate-pdf`, {
      method: 'POST',
      body: JSON.stringify({ pdfFile: filename })
    });
    showToast(resp.message || 'PDF associato', 'success');
    closeAssociatePdfModal();
    await loadBooks();
  } catch (e) {
    showToast('Errore associazione PDF: ' + e.message, 'error');
  }
}

/* ============================================================
   Init (no duplicate submit handler needed)
   ============================================================ */
function initUploadModal() {
  // Handler unificato in submitBookForm
}

/* ============================================================
   Main
   ============================================================ */
export async function loadAdmin() {
  // Verify admin access
  try {
    const { user } = await apiFetch('/auth/me');
    if (!user || !user.isAdmin) {
      window.location.href = '/login';
      return;
    }
  } catch {
    window.location.href = '/login';
    return;
  }

  // Init listeners
  document.getElementById('btn-new-book').addEventListener('click', () => openBookModal());
  document.getElementById('book-modal-close').addEventListener('click', closeBookModal);
  document.getElementById('book-modal-cancel').addEventListener('click', closeBookModal);
  document.getElementById('book-form').addEventListener('submit', submitBookForm);
  document.getElementById('users-tbody').addEventListener('click', handleTableClick);
  document.getElementById('books-tbody').addEventListener('click', handleTableClick);

  // Close modal on overlay click
  document.getElementById('book-modal').addEventListener('click', (e) => {
    if (e.target.id === 'book-modal') closeBookModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBookModal();
  });

  await Promise.all([loadStats(), loadUsers(), loadBooks()]);
}
