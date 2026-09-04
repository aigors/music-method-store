'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'db.sqlite');
const CACHE_DIR = process.env.CACHE_DIR || path.join(DATA_DIR, 'cache');
const PDF_DIR = process.env.PDF_DIR || path.join(DATA_DIR, 'pdfs');

let db;

/**
 * Inizializza DB, cartelle e schema.
 */
function initDb() {
  // Crea cartelle dati se non esistono
  for (const dir of [DATA_DIR, CACHE_DIR, PDF_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Connessione
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ---- SCHEMA ----
  const schema = `
    -- Utenti
    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      email        TEXT    NOT NULL UNIQUE,
      passwordHash TEXT    NOT NULL,
      createdAt    TEXT    NOT NULL DEFAULT (datetime('now')),
      isActive     INTEGER NOT NULL DEFAULT 1,
      isAdmin      INTEGER NOT NULL DEFAULT 0,
      -- Dati anagrafici (obbligatori per utenti registrati, vuoti per demo/admin)
      firstName    TEXT,
      lastName     TEXT,
      birthDate    TEXT,
      birthPlace   TEXT
    );

    -- Token recupero password (30 min, one-time)
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token     TEXT    NOT NULL UNIQUE,
      expiresAt TEXT    NOT NULL,            -- ISO8601
      used      INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reset_token_user ON password_reset_tokens(userId);

    -- Codici 2FA temporanei (15 min)
    CREATE TABLE IF NOT EXISTS two_fa_codes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code      TEXT    NOT NULL,        -- 6 cifre, hashato per sicurezza
      expiresAt TEXT    NOT NULL,        -- ISO8601
      used      INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_twofa_user ON two_fa_codes(userId);

    -- Catalogo metodi (PDF)
    CREATE TABLE IF NOT EXISTS books (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      slug            TEXT    NOT NULL UNIQUE,
      title           TEXT    NOT NULL,
      author          TEXT    NOT NULL,
      description     TEXT    NOT NULL DEFAULT '',
      priceCents      INTEGER NOT NULL,       -- prezzo in centesimi
      pdfFile         TEXT    NOT NULL,       -- nome file in ./data/pdfs/
      coverFile       TEXT,                   -- opzionale
      pages           INTEGER NOT NULL DEFAULT 0,
      isActive        INTEGER NOT NULL DEFAULT 1,
      createdAt       TEXT    NOT NULL DEFAULT (datetime('now')),
      -- Protezione avanzata (Fase 2-3)
      highSecurity    INTEGER NOT NULL DEFAULT 0,        -- 1 = rasterizzazione immagini
      watermarkOpacity REAL   DEFAULT 0.25,              -- opacità watermark visibile 0-1
      watermarkText   TEXT,                              -- testo custom watermark (default: email+timestamp)
      watermarkPages  TEXT                               -- pagine watermark: "all", "1-3", "last-2", "first-last"
    );

    -- Acquisti (un record per ordine completato)
    CREATE TABLE IF NOT EXISTS purchases (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      userId        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bookId        INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
      paypalOrderId TEXT    NOT NULL UNIQUE,
      amountCents   INTEGER NOT NULL,
      currency      TEXT    NOT NULL DEFAULT 'EUR',
      status        TEXT    NOT NULL DEFAULT 'COMPLETED', -- COMPLETED | REFUNDED
      createdAt     TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(userId);
    CREATE INDEX IF NOT EXISTS idx_purchases_book ON purchases(bookId);

    -- Token di visualizzazione PDF (short-lived, one-time o few-use)
    CREATE TABLE IF NOT EXISTS view_tokens (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      userId    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bookId    INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      token     TEXT    NOT NULL UNIQUE,     -- UUID v4
      expiresAt TEXT    NOT NULL,            -- ISO8601 (es. +10 min)
      maxUses   INTEGER NOT NULL DEFAULT 1,
      uses      INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT    NOT NULL DEFAULT (datetime('now')),
      -- Device binding (Fase 1)
      device_fp TEXT,                        -- hash fingerprint client (UA + screen + tz + lang)
      ip_prefix TEXT,                        -- IP prefix (/16 IPv4, /64 IPv6)
      user_agent TEXT,                       -- UA completo per audit
      created_ip TEXT,                       -- IP creazione token
      source     TEXT DEFAULT NULL           -- 'admin_preview' per token di test admin
    );
    CREATE INDEX IF NOT EXISTS idx_view_tokens_user_book ON view_tokens(userId, bookId);
  `;

  db.exec(schema);

  // Migrazione: aggiungi source a view_tokens se non esiste
  try {
    db.prepare('ALTER TABLE view_tokens ADD COLUMN source TEXT DEFAULT NULL').run();
  } catch (e) { /* colonna già esistente */ }

  // Migrazione: aggiungi isAdmin se non esiste (per DB esistenti)
  try {
    db.prepare('ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0').run();
  } catch (e) {
    // Colonna già esistente, ignora
  }

  // Migrazione: aggiungi dati anagrafici users (campi profilo)
  const profileMigrations = [
    'ALTER TABLE users ADD COLUMN firstName TEXT',
    'ALTER TABLE users ADD COLUMN lastName TEXT',
    'ALTER TABLE users ADD COLUMN birthDate TEXT',
    'ALTER TABLE users ADD COLUMN birthPlace TEXT'
  ];
  for (const sql of profileMigrations) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      // Colonna già esistente, ignora
    }
  }

  // Migrazione: aggiungi campi protezione avanzata books (Fase 1-3)
  const bookMigrations = [
    'ALTER TABLE books ADD COLUMN highSecurity INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE books ADD COLUMN watermarkOpacity REAL DEFAULT 0.25',
    'ALTER TABLE books ADD COLUMN watermarkText TEXT',
    'ALTER TABLE books ADD COLUMN watermarkPages TEXT'
  ];
  for (const sql of bookMigrations) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      // Colonna già esistente, ignora
    }
  }

  // Migrazione: aggiungi campi device binding view_tokens (Fase 1)
  const tokenMigrations = [
    'ALTER TABLE view_tokens ADD COLUMN device_fp TEXT',
    'ALTER TABLE view_tokens ADD COLUMN ip_prefix TEXT',
    'ALTER TABLE view_tokens ADD COLUMN user_agent TEXT',
    'ALTER TABLE view_tokens ADD COLUMN created_ip TEXT'
  ];
  for (const sql of tokenMigrations) {
    try {
      db.prepare(sql).run();
    } catch (e) {
      // Colonna già esistente, ignora
    }
  }

  // Stampa info
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  console.log(`✅  DB pronto: ${DB_PATH} (utenti: ${count.c})`);
}

/**
 * Restituisce l'istanza DB (per query ad-hoc).
 */
function getDb() {
  return db;
}

/* ============================================================
   HELPER USERS
   ============================================================ */

const bcrypt = require('bcryptjs');

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function createUser(email, password, profile = {}) {
  const stmt = db.prepare(
    `INSERT INTO users (email, passwordHash, firstName, lastName, birthDate, birthPlace)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(
    email.toLowerCase().trim(),
    hashPassword(password),
    profile.firstName || null,
    profile.lastName || null,
    profile.birthDate || null,
    profile.birthPlace || null
  );
  return { id: info.lastInsertRowid, email, ...profile };
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ? AND isActive = 1')
    .get(email.toLowerCase().trim());
}

function findUserById(id) {
  return db.prepare('SELECT id, email, createdAt, isActive, isAdmin, firstName, lastName, birthDate, birthPlace FROM users WHERE id = ?')
    .get(id);
}

/* ============================================================
   HELPER ADMIN USERS
   ============================================================ */

function listUsers({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE isActive = 1';
  return db.prepare(
    `SELECT id, email, createdAt, isActive, isAdmin, firstName, lastName, birthDate, birthPlace
     FROM users ${where} ORDER BY createdAt DESC`
  ).all();
}

function setUserActive(userId, active) {
  const stmt = db.prepare('UPDATE users SET isActive = ? WHERE id = ?');
  const info = stmt.run(active ? 1 : 0, userId);
  return info.changes > 0;
}

function deleteUser(userId) {
  // Le FK con ON DELETE CASCADE si occupano di two_fa_codes, purchases, view_tokens
  const stmt = db.prepare('DELETE FROM users WHERE id = ?');
  const info = stmt.run(userId);
  return info.changes > 0;
}

/* ============================================================
   HELPER ADMIN BOOKS
   ============================================================ */

function listBooksAdmin() {
  return db.prepare(
    `SELECT id, slug, title, author, description, priceCents, coverFile, pdfFile, pages, isActive, createdAt,
            highSecurity, watermarkOpacity, watermarkText, watermarkPages
     FROM books ORDER BY title`
  ).all();
}

function updateBook(id, data) {
  const fields = [];
  const values = [];
  const allowed = ['slug', 'title', 'author', 'description', 'priceCents', 'coverFile', 'pages', 'isActive',
                   'highSecurity', 'watermarkOpacity', 'watermarkText', 'watermarkPages', 'pdfFile'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(key === 'highSecurity' ? (data[key] ? 1 : 0) : data[key]);
    }
  }
  if (fields.length === 0) return false;
  values.push(id);
  const stmt = db.prepare(`UPDATE books SET ${fields.join(', ')} WHERE id = ?`);
  const info = stmt.run(...values);
  return info.changes > 0;
}

function deleteBook(id) {
  // Soft delete: isActive = 0 per preservare acquisti (FK RESTRICT su books)
  return setBookActive(id, 0);
}

function setBookActive(id, active) {
  const stmt = db.prepare('UPDATE books SET isActive = ? WHERE id = ?');
  const info = stmt.run(active ? 1 : 0, id);
  return info.changes > 0;
}

/* ============================================================
   HELPER 2FA CODES
   ============================================================ */

function createTwoFaCode(userId) {
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 cifre
  const codeHash = hashPassword(code); // stesso algoritmo
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO two_fa_codes (userId, code, expiresAt) VALUES (?, ?, ?)'
  ).run(userId, codeHash, expiresAt);

  // Cleanup vecchi codici per questo user
  db.prepare(
    "DELETE FROM two_fa_codes WHERE userId = ? AND (used = 1 OR expiresAt < datetime('now'))"
  ).run(userId);

  return code; // ritorna il plain per inviarlo via mail
}

function verifyTwoFaCode(userId, code) {
  const row = db.prepare(
    "SELECT * FROM two_fa_codes WHERE userId = ? AND used = 0 AND expiresAt > datetime('now') ORDER BY createdAt DESC LIMIT 1"
  ).get(userId);

  if (!row) return { ok: false, reason: 'scaduto_o_inesistente' };
  if (!checkPassword(code, row.code)) return { ok: false, reason: 'codice_errato' };

  // Marca come usato
  db.prepare('UPDATE two_fa_codes SET used = 1 WHERE id = ?').run(row.id);
  return { ok: true };
}

/* ============================================================
   HELPER CATALOGO (books)
   ============================================================ */

function listBooks({ onlyActive = true } = {}) {
  const where = onlyActive ? 'WHERE isActive = 1' : '';
  return db.prepare(
    `SELECT id, slug, title, author, description, priceCents, coverFile, pages
     FROM books ${where} ORDER BY title`
  ).all();
}

function getBookBySlug(slug) {
  return db.prepare('SELECT * FROM books WHERE slug = ?').get(slug);
}

function getBookById(id) {
  return db.prepare('SELECT * FROM books WHERE id = ?').get(id);
}

function createBook(data) {
  const stmt = db.prepare(`
    INSERT INTO books (slug, title, author, description, priceCents, pdfFile, coverFile, pages,
                       highSecurity, watermarkOpacity, watermarkText, watermarkPages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    data.slug,
    data.title,
    data.author,
    data.description || '',
    data.priceCents,
    data.pdfFile,
    data.coverFile || null,
    data.pages || 0,
    data.highSecurity ? 1 : 0,
    data.watermarkOpacity ?? 0.25,
    data.watermarkText || null,
    data.watermarkPages || null
  );
  return { id: info.lastInsertRowid, ...data };
}

/* ============================================================
   HELPER PURCHASES
   ============================================================ */

function hasPurchased(userId, bookId) {
  return db.prepare(
    "SELECT 1 FROM purchases WHERE userId = ? AND bookId = ? AND status = 'COMPLETED' LIMIT 1"
  ).get(userId, bookId);
}

function createPurchase(userId, bookId, paypalOrderId, amountCents, currency = 'EUR') {
  const stmt = db.prepare(`
    INSERT INTO purchases (userId, bookId, paypalOrderId, amountCents, currency, status)
    VALUES (?, ?, ?, ?, ?, 'COMPLETED')
  `);
  stmt.run(userId, bookId, paypalOrderId, amountCents, currency);
}

function listPurchases(userId) {
  return db.prepare(`
    SELECT p.id AS purchaseId, p.paypalOrderId, p.amountCents, p.currency,
           p.createdAt AS purchasedAt,
           b.id AS bookId, b.slug, b.title, b.author, b.description,
           b.coverFile, b.pages, b.isActive, b.highSecurity
    FROM purchases p
    JOIN books b ON b.id = p.bookId
    WHERE p.userId = ? AND p.status = 'COMPLETED'
    ORDER BY p.createdAt DESC
  `).all(userId);
}

/* ============================================================
   HELPER VIEW TOKENS (streaming PDF)
   ============================================================ */

const { randomUUID } = require('crypto');

function createViewToken(userId, bookId, ttlMinutes = 10, maxUses = 1, deviceFp = null, ipPrefix = null, userAgent = null, createdIp = null, source = null) {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO view_tokens (userId, bookId, token, expiresAt, maxUses, device_fp, ip_prefix, user_agent, created_ip, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, bookId, token, expiresAt, maxUses, deviceFp, ipPrefix, userAgent, createdIp, source);

  return { token, expiresAt };
}

/**
 * Estrae prefix IP per tolleranza mobile (/16 IPv4, /64 IPv6)
 */
function getIpPrefix(ip) {
  if (!ip) return null;
  // Rimuovi ::ffff: prefix se presente (IPv4 mappato)
  const cleanIp = ip.replace(/^::ffff:/, '');
  if (cleanIp.includes(':')) {
    // IPv6 - primi 4 gruppi (/64)
    return cleanIp.split(':').slice(0, 4).join(':');
  }
  // IPv4 - primi 2 ottetti (/16)
  return cleanIp.split('.').slice(0, 2).join('.');
}

/**
 * Genera hash fingerprint da dati client
 */
function hashDeviceFingerprint(fp) {
  if (!fp) return null;
  const crypto = require('crypto');
  const str = `${fp.ua}|${fp.screen}|${fp.tz}|${fp.lang}`;
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 32);
}

/**
 * Valida fingerprint del token contro richiesta corrente
 */
function validateTokenFingerprint(tokenRow, currentFp, currentIpPrefix, currentUa) {
  // Se token non ha fingerprint (vecchio), permetta per backward compatibilità
  if (!tokenRow.device_fp) return { ok: true, legacy: true };

  // Verifica User-Agent (obbligatorio)
  if (tokenRow.user_agent && currentUa && tokenRow.user_agent !== currentUa) {
    return { ok: false, reason: 'user_agent_mismatch' };
  }

  // Verifica IP prefix (tollerante)
  if (tokenRow.ip_prefix && currentIpPrefix && tokenRow.ip_prefix !== currentIpPrefix) {
    return { ok: false, reason: 'ip_prefix_mismatch' };
  }

  // Verifica device fingerprint hash
  if (currentFp) {
    const currentHash = hashDeviceFingerprint(currentFp);
    if (tokenRow.device_fp !== currentHash) {
      return { ok: false, reason: 'device_fp_mismatch' };
    }
  }

  return { ok: true };
}

function consumeViewToken(token, userId, bookId, currentFp = null, currentIp = null, currentUa = null) {
  const row = db.prepare(
    "SELECT * FROM view_tokens WHERE token = ? AND userId = ? AND bookId = ? AND expiresAt > datetime('now') AND uses < maxUses"
  ).get(token, userId, bookId);

  if (!row) return { ok: false, reason: 'token_non_valido_o_scaduto' };

  // Valida fingerprint se forniti
  const currentIpPrefix = getIpPrefix(currentIp);
  const fpCheck = validateTokenFingerprint(row, currentFp, currentIpPrefix, currentUa);
  if (!fpCheck.ok) {
    return { ok: false, reason: fpCheck.reason };
  }

  db.prepare('UPDATE view_tokens SET uses = uses + 1 WHERE id = ?').run(row.id);
  return { ok: true, legacy: fpCheck.legacy };
}

function getViewToken(token) {
  return db.prepare(
    'SELECT * FROM view_tokens WHERE token = ?'
  ).get(token);
}

/**
 * Restituisce il source di un token (es. 'admin_preview')
 */
function getTokenSource(token) {
  const row = db.prepare('SELECT source FROM view_tokens WHERE token = ?').get(token);
  return row ? row.source : null;
}

/* ============================================================
   HELPER RESET PASSWORD (token via email)
   ============================================================ */

const { randomBytes } = require('crypto');

/**
 * Crea un token di reset password (one-time, scadenza configurabile).
 * @param {number} userId
 * @param {number} ttlMinutes - scadenza in minuti (default 30)
 * @returns {Object} { token, expiresAt }
 */
function createPasswordResetToken(userId, ttlMinutes = 30) {
  const token = randomBytes(32).toString('hex'); // 64 hex chars
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO password_reset_tokens (userId, token, expiresAt) VALUES (?, ?, ?)'
  ).run(userId, token, expiresAt);

  // Invalida i token precedenti non ancora usati per questo utente
  db.prepare(
    "UPDATE password_reset_tokens SET used = 1 WHERE userId = ? AND used = 0 AND token != ?"
  ).run(userId, token);

  return { token, expiresAt };
}

/**
 * Recupera un token reset non scaduto e non usato.
 */
function getPasswordResetToken(token) {
  return db.prepare(
    "SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expiresAt > datetime('now')"
  ).get(token);
}

/**
 * Marca un token reset come usato (one-time).
 */
function markPasswordResetTokenUsed(token) {
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE token = ?').run(token);
}

/**
 * Aggiorna la password di un utente.
 */
function updateUserPassword(userId, newPassword) {
  const stmt = db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?');
  return stmt.run(hashPassword(newPassword), userId).changes > 0;
}

/**
 * Recupera l'hash della password di un utente (per verifica password attuale).
 */
function getUserPasswordHash(userId) {
  return db.prepare('SELECT passwordHash FROM users WHERE id = ?').get(userId)?.passwordHash || null;
}

/* ============================================================
   CLEANUP periodico (chiamato da script/cleanup.js)
   ============================================================ */

function cleanup() {
  // 2FA vecchi
  db.prepare("DELETE FROM two_fa_codes WHERE expiresAt < datetime('now') OR used = 1").run();
  // View token scaduti
  db.prepare("DELETE FROM view_tokens WHERE expiresAt < datetime('now')").run();
  // Token reset password scaduti o usati
  db.prepare("DELETE FROM password_reset_tokens WHERE expiresAt < datetime('now') OR used = 1").run();
  // File fisici cache (gestiti da cleanup.js)
}

module.exports = {
  initDb,
  getDb,
  // users
  hashPassword,
  checkPassword,
  createUser,
  findUserByEmail,
  findUserById,
  // admin users
  listUsers,
  setUserActive,
  deleteUser,
  // 2fa
  createTwoFaCode,
  verifyTwoFaCode,
  // reset password
  createPasswordResetToken,
  getPasswordResetToken,
  markPasswordResetTokenUsed,
  updateUserPassword,
  getUserPasswordHash,
  // books
  listBooks,
  getBookBySlug,
  getBookById,
  createBook,
  // admin books
  listBooksAdmin,
  updateBook,
  deleteBook,
  setBookActive,
  // purchases
  hasPurchased,
  createPurchase,
  listPurchases,
  // view tokens
  createViewToken,
  consumeViewToken,
  getViewToken,
  getTokenSource,
  // device binding (Fase 1)
  getIpPrefix,
  hashDeviceFingerprint,
  validateTokenFingerprint,
  // util
  cleanup,
  // constants
  PDF_DIR
};