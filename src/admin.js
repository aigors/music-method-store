'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const {
  listUsers,
  setUserActive,
  deleteUser,
  listBooksAdmin,
  createBook,
  updateBook,
  deleteBook,
  getBookById,
  getDb,
  PDF_DIR
} = require('./db');

/* ============================================================
   MULTER (upload PDF)
   ============================================================ */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });
    cb(null, PDF_DIR);
  },
  filename: (req, file, cb) => {
    // Mantieni il nome file originale (sanitizzato)
    const originalName = file.originalname;
    const sanitized = originalName
      .replace(/[^a-zA-Z0-9._-]/g, '_')  // sostituisci caratteri speciali
      .replace(/_+/g, '_')                // comprimi underscore multipli
      .replace(/^_|_$/g, '');             // rimuovi underscore iniziali/finali
    // Evita collisioni: se esiste già, aggiungi timestamp
    const targetPath = path.join(PDF_DIR, sanitized);
    if (fs.existsSync(targetPath)) {
      const ext = path.extname(sanitized);
      const base = path.basename(sanitized, ext);
      const uniqueName = `${base}-${Date.now()}${ext}`;
      cb(null, uniqueName);
    } else {
      cb(null, sanitized);
    }
  }
});

function fileFilter(req, file, cb) {
  if (file.mimetype === 'application/pdf') {
    cb(null, true);
  } else {
    cb(new Error('Solo file PDF sono ammessi'), false);
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

/* ============================================================
   ROUTER ADMIN (montato con requireAuth + requireAdmin)
   ============================================================ */

const router = express.Router();

/* ------------------------------------------------------------
   Dashboard / Stats
   ------------------------------------------------------------ */
router.get('/stats', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT COUNT(*) AS c FROM users WHERE isActive = 1').get().c;
  const usersInactive = db.prepare('SELECT COUNT(*) AS c FROM users WHERE isActive = 0').get().c;
  const books = db.prepare('SELECT COUNT(*) AS c FROM books WHERE isActive = 1').get().c;
  const booksInactive = db.prepare('SELECT COUNT(*) AS c FROM books WHERE isActive = 0').get().c;
  const orders = db.prepare("SELECT COUNT(*) AS c FROM purchases WHERE status = 'COMPLETED'").get().c;
  const revenue = db.prepare("SELECT COALESCE(SUM(amountCents), 0) AS s FROM purchases WHERE status = 'COMPLETED'").get().s;

  res.json({
    users: { active: users, inactive: usersInactive },
    books: { active: books, inactive: booksInactive },
    orders,
    revenueCents: revenue,
    revenueEur: (revenue / 100).toFixed(2)
  });
});

/* ------------------------------------------------------------
   Gestione UTENTI
   ------------------------------------------------------------ */

router.get('/users', (req, res) => {
  const users = listUsers({ includeInactive: true });
  res.json({
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      createdAt: u.createdAt,
      isActive: !!u.isActive,
      isAdmin: !!u.isAdmin
    }))
  });
});

router.post('/users/:id/activate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.session.user.id === id) {
    return res.status(400).json({ error: 'Non puoi modificare il tuo stesso stato' });
  }
  const ok = setUserActive(id, true);
  if (!ok) return res.status(404).json({ error: 'Utente non trovato' });
  res.json({ ok: true, message: 'Utente riattivato' });
});

router.post('/users/:id/deactivate', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.session.user.id === id) {
    return res.status(400).json({ error: 'Non puoi disattivare te stesso' });
  }
  if (id === 1) {
    return res.status(400).json({ error: 'Non puoi disattivare l\'utente demo' });
  }
  const ok = setUserActive(id, false);
  if (!ok) return res.status(404).json({ error: 'Utente non trovato' });
  res.json({ ok: true, message: 'Utente disattivato' });
});

router.delete('/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.session.user.id === id) {
    return res.status(400).json({ error: 'Non puoi eliminare te stesso' });
  }
  if (id === 1) {
    return res.status(400).json({ error: 'Non puoi eliminare l\'utente demo' });
  }
  const ok = deleteUser(id);
  if (!ok) return res.status(404).json({ error: 'Utente non trovato' });
  res.json({ ok: true, message: 'Utente eliminato' });
});

/* ------------------------------------------------------------
   Gestione LIBRI (catalogo)
   ------------------------------------------------------------ */

router.get('/books', (req, res) => {
  const books = listBooksAdmin();
  // Debug
  console.log('PDF_DIR in handler:', PDF_DIR);
  console.log('Sample book pdfFile:', books[0]?.pdfFile);
  res.json({
    books: books.map(b => {
      const pdfExists = b.pdfFile ? fs.existsSync(path.join(PDF_DIR, b.pdfFile)) : false;
      return {
        id: b.id,
        slug: b.slug,
        title: b.title,
        author: b.author,
        description: b.description,
        priceCents: b.priceCents,
        priceEur: (b.priceCents / 100).toFixed(2),
        coverFile: b.coverFile,
        pages: b.pages,
        isActive: !!b.isActive,
        pdfFile: b.pdfFile,
        pdfExists,
        createdAt: b.createdAt
      };
    })
  });
});

// Crea libro (con upload PDF opzionale)
router.post('/books', upload.single('pdf'), (req, res) => {
  const { slug, title, author, description, priceCents, pages } = req.body;

  if (!slug || !title || !author || !priceCents) {
    return res.status(400).json({ error: 'slug, title, author, priceCents obbligatori' });
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Lo slug può contenere solo lettere minuscole, numeri e trattini' });
  }

  let pdfFile;
  if (req.file) {
    pdfFile = req.file.filename;
  } else if (req.body.pdfFile) {
    pdfFile = req.body.pdfFile;
  } else {
    return res.status(400).json({ error: 'Serve un PDF (upload o nome file esistente)' });
  }

  try {
    const book = createBook({
      slug,
      title,
      author,
      description: description || '',
      priceCents: parseInt(priceCents, 10),
      pdfFile,
      coverFile: req.body.coverFile || null,
      pages: parseInt(pages, 10) || 0,
      highSecurity: req.body.highSecurity ? 1 : 0,
      watermarkOpacity: parseFloat(req.body.watermarkOpacity) || 0.25,
      watermarkPages: req.body.watermarkPages || null,
      watermarkText: req.body.watermarkText || null
    });
    res.json({ ok: true, book });
  } catch (e) {
    // Rimuovi PDF caricato se l'insert fallisce (es. slug duplicato)
    if (req.file) fs.unlinkSync(path.join(PDF_DIR, req.file.filename));
    return res.status(400).json({ error: 'Errore creazione libro: ' + e.message });
  }
});

// Aggiorna libro
router.put('/books/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = getBookById(id);
  if (!book) return res.status(404).json({ error: 'Libro non trovato' });

  const data = {};
  if (req.body.slug !== undefined) {
    if (!/^[a-z0-9-]+$/.test(req.body.slug)) {
      return res.status(400).json({ error: 'Slug non valido' });
    }
    data.slug = req.body.slug;
  }
  if (req.body.title !== undefined) data.title = req.body.title;
  if (req.body.author !== undefined) data.author = req.body.author;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.priceCents !== undefined) data.priceCents = parseInt(req.body.priceCents, 10);
  if (req.body.coverFile !== undefined) data.coverFile = req.body.coverFile || null;
  if (req.body.pages !== undefined) data.pages = parseInt(req.body.pages, 10) || 0;
  if (req.body.isActive !== undefined) data.isActive = req.body.isActive ? 1 : 0;
  if (req.body.highSecurity !== undefined) data.highSecurity = req.body.highSecurity ? 1 : 0;
  if (req.body.watermarkOpacity !== undefined) data.watermarkOpacity = parseFloat(req.body.watermarkOpacity) || 0.25;
  if (req.body.watermarkPages !== undefined) data.watermarkPages = req.body.watermarkPages || null;
  if (req.body.watermarkText !== undefined) data.watermarkText = req.body.watermarkText || null;

  const ok = updateBook(id, data);
  if (!ok) return res.status(400).json({ error: 'Nessun campo valido da aggiornare' });
  res.json({ ok: true, message: 'Libro aggiornato' });
});

// Soft delete libro
router.delete('/books/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = getBookById(id);
  if (!book) return res.status(404).json({ error: 'Libro non trovato' });
  deleteBook(id);
  res.json({ ok: true, message: 'Libro rimosso dal catalogo' });
});

// Rigenera cover (pulisce cache e rigenera)
router.post('/books/:id/regenerate-cover', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = getBookById(id);
  if (!book) return res.status(404).json({ error: 'Libro non trovato' });

  const sourcePath = path.join(PDF_DIR, book.pdfFile);
  if (!book.pdfFile || !fs.existsSync(sourcePath)) {
    return res.status(400).json({ error: 'File PDF sorgente mancante, impossibile generare cover' });
  }

  try {
    const COVER_CACHE_DIR = path.join(__dirname, '..', 'data', 'covers');

    // Trova e rimuovi tutti i file cache per questo bookId
    if (fs.existsSync(COVER_CACHE_DIR)) {
      const files = fs.readdirSync(COVER_CACHE_DIR);
      for (const file of files) {
        if (file.startsWith(`${id}-`) && file.endsWith('.png')) {
          fs.unlinkSync(path.join(COVER_CACHE_DIR, file));
        }
      }
    }

    // Forza rigenerazione chiamando l'endpoint cover (o generando direttamente)
    const catalogModule = require('./catalog');
    const getCoverImage = catalogModule.getCoverImage || catalogModule.default?.getCoverImage;
    if (!getCoverImage) {
      throw new Error('Funzione getCoverImage non disponibile');
    }
    await getCoverImage(id);

    res.json({ ok: true, message: 'Cover rigenerata con successo' });
  } catch (e) {
    console.error('Regenerate cover error:', e);
    res.status(500).json({ error: 'Errore rigenerazione cover: ' + e.message });
  }
});

// Verifica se cover può essere generata
router.get('/books/:id/cover-status', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = getBookById(id);
  if (!book) return res.status(404).json({ error: 'Libro non trovato' });

  const sourcePath = path.join(PDF_DIR, book.pdfFile);
  const pdfExists = book.pdfFile ? fs.existsSync(sourcePath) : false;

  // Verifica se c'è cache valida
  const COVER_CACHE_DIR = path.join(__dirname, '..', 'data', 'covers');
  let cached = false;
  if (pdfExists && fs.existsSync(COVER_CACHE_DIR)) {
    const stat = fs.statSync(sourcePath);
    const cacheKey = `${id}-${stat.mtimeMs}-${stat.size}`;
    const cacheFile = path.join(COVER_CACHE_DIR, `${cacheKey}.png`);
    cached = fs.existsSync(cacheFile);
  }

  res.json({
    bookId: id,
    pdfExists,
    coverCached: cached,
    canGenerate: pdfExists
  });
});

// Upload/sostituzione PDF
router.post('/books/:id/upload', upload.single('pdf'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = getBookById(id);
  if (!book) return res.status(404).json({ error: 'Libro non trovato' });
  if (!req.file) return res.status(400).json({ error: 'Nessun PDF caricato' });

  // Rimuovi vecchio PDF se gestito da noi (non placeholder seed)
  if (book.pdfFile && book.pdfFile.startsWith(`${id}-`)) {
    const oldPath = path.join(PDF_DIR, book.pdfFile);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  updateBook(id, { pdfFile: req.file.filename });
  res.json({ ok: true, pdfFile: req.file.filename, message: 'PDF aggiornato' });
});

// Associa PDF esistente (scegli tra file caricati)
router.post('/books/:id/associate-pdf', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const book = getBookById(id);
  if (!book) return res.status(404).json({ error: 'Libro non trovato' });

  const { pdfFile } = req.body;
  if (!pdfFile) return res.status(400).json({ error: 'Nome file PDF richiesto' });

  // Verifica che il file esista in PDF_DIR
  const filePath = path.join(PDF_DIR, pdfFile);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File PDF non trovato nella cartella uploads' });
  }

  // Rimuovi vecchio PDF se gestito da noi (non placeholder seed)
  if (book.pdfFile && book.pdfFile.startsWith(`${id}-`)) {
    const oldPath = path.join(PDF_DIR, book.pdfFile);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  updateBook(id, { pdfFile });
  res.json({ ok: true, pdfFile, message: 'PDF associato al metodo' });
});

// Lista file PDF disponibili in uploads
router.get('/pdfs/available', (req, res) => {
  try {
    if (!fs.existsSync(PDF_DIR)) {
      return res.json({ files: [] });
    }
    const files = fs.readdirSync(PDF_DIR)
      .filter(f => f.toLowerCase().endsWith('.pdf'))
      .map(f => {
        const stat = fs.statSync(path.join(PDF_DIR, f));
        return {
          filename: f,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
          modified: stat.mtime.toISOString()
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified)); // più recenti primi
    res.json({ files });
  } catch (e) {
    console.error('Error listing PDFs:', e);
    res.status(500).json({ error: 'Errore lettura cartella PDF' });
  }
});

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
