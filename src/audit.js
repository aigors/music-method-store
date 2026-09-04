'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = process.env.AUDIT_LOG_DIR || path.resolve(__dirname, '..', 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'pdf-access.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

/**
 * Hash per anonimizzare IP e UA nei log (GDPR-friendly)
 */
function hashIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);
}

function hashUa(ua) {
  if (!ua) return 'unknown';
  return crypto.createHash('sha256').update(ua).digest('hex').substring(0, 16);
}

/**
 * Logga un evento di accesso PDF in formato JSON Lines
 * @param {Object} event - Evento da loggare
 * @param {string} event.action - Tipo azione: 'token_create', 'stream_chunk', 'raster_page', 'token_reuse', 'token_expired', 'token_invalid'
 * @param {number} event.userId - ID utente
 * @param {number} event.bookId - ID libro
 * @param {string} event.token - Token (verrà troncato)
 * @param {string} event.ip - IP client
 * @param {string} event.ua - User-Agent
 * @param {number} [event.pageNum] - Numero pagina (per raster/stream)
 * @param {boolean} event.success - Successo operazione
 * @param {string} [event.reason] - Motivo fallimento
 * @param {number} [event.latencyMs] - Latenza in ms
 * @param {Object} [event.meta] - Metadati aggiuntivi
 */
function logPdfAccess(event) {
  const timestamp = new Date().toISOString();
  const tokenPrefix = event.token ? event.token.substring(0, 8) : 'none';

  const logEntry = {
    ts: timestamp,
    action: event.action,
    userId: event.userId,
    bookId: event.bookId,
    tokenPrefix,
    ipHash: hashIp(event.ip),
    uaHash: hashUa(event.ua),
    page: event.pageNum || null,
    success: event.success,
    reason: event.reason || null,
    latencyMs: event.latencyMs || null,
    meta: event.meta || null
  };

  const line = JSON.stringify(logEntry) + '\n';

  // Append atomico (appendFileSync è atomico per singole scritture)
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error('Audit log write error:', err);
  }
}

/**
 * Azioni predefinite per consistenza
 */
const ACTIONS = {
  TOKEN_CREATE: 'token_create',
  STREAM_CHUNK: 'stream_chunk',
  RASTER_PAGE: 'raster_page',
  TOKEN_REUSE: 'token_reuse',        // stesso token da device/IP diverso
  TOKEN_EXPIRED: 'token_expired',    // token scaduto usato
  TOKEN_INVALID: 'token_invalid',    // token inesistente/tampered
  TOKEN_FINGERPRINT_MISMATCH: 'token_fingerprint_mismatch',
  HIGH_SECURITY_ACCESS: 'high_security_access'
};

/**
 * Wrapper per loggare creazione token
 */
function logTokenCreate({ userId, bookId, token, ip, ua, highSecurity, latencyMs }) {
  logPdfAccess({
    action: ACTIONS.TOKEN_CREATE,
    userId,
    bookId,
    token,
    ip,
    ua,
    success: true,
    latencyMs,
    meta: { highSecurity: !!highSecurity }
  });
}

/**
 * Wrapper per loggare streaming chunk
 */
function logStreamChunk({ userId, bookId, token, ip, ua, pageNum, chunkNum, success, reason, latencyMs }) {
  logPdfAccess({
    action: ACTIONS.STREAM_CHUNK,
    userId,
    bookId,
    token,
    ip,
    ua,
    pageNum,
    success,
    reason,
    latencyMs,
    meta: { chunkNum }
  });
}

/**
 * Wrapper per loggare pagina rasterizzata
 */
function logRasterPage({ userId, bookId, token, ip, ua, pageNum, scale, success, reason, latencyMs }) {
  logPdfAccess({
    action: ACTIONS.RASTER_PAGE,
    userId,
    bookId,
    token,
    ip,
    ua,
    pageNum,
    success,
    reason,
    latencyMs,
    meta: { scale }
  });
}

/**
 * Wrapper per loggare riutilizzo token (device/IP diverso)
 */
function logTokenReuse({ userId, bookId, token, ip, ua, originalIpHash, originalUaHash }) {
  logPdfAccess({
    action: ACTIONS.TOKEN_REUSE,
    userId,
    bookId,
    token,
    ip,
    ua,
    success: false,
    reason: 'device_or_ip_mismatch',
    meta: { originalIpHash, originalUaHash }
  });
}

/**
 * Legge log file e restituisce array di entry (per report)
 * @param {Object} options
 * @param {number} [options.lines] - Max righe da leggere (da fondo)
 * @param {string} [options.since] - ISO date, solo entry dopo questa data
 * @param {string} [options.action] - Filtra per action
 * @param {number} [options.userId] - Filtra per userId
 */
function readAuditLog({ lines = 1000, since = null, action = null, userId = null } = {}) {
  if (!fs.existsSync(LOG_FILE)) return [];

  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const allLines = content.trim().split('\n').filter(l => l.length > 0);

  let entries = allLines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);

  if (since) {
    const sinceTs = new Date(since).getTime();
    entries = entries.filter(e => new Date(e.ts).getTime() >= sinceTs);
  }

  if (action) {
    entries = entries.filter(e => e.action === action);
  }

  if (userId) {
    entries = entries.filter(e => e.userId === userId);
  }

  // Prendi ultime N righe
  return entries.slice(-lines);
}

/**
 * Statistiche rapide per dashboard
 */
function getAuditStats({ since = null } = {}) {
  const entries = readAuditLog({ since, lines: 100000 });

  const stats = {
    total: entries.length,
    byAction: {},
    byUser: {},
    byBook: {},
    successRate: 0,
    anomalies: 0
  };

  let successCount = 0;

  for (const e of entries) {
    stats.byAction[e.action] = (stats.byAction[e.action] || 0) + 1;
    stats.byUser[e.userId] = (stats.byUser[e.userId] || 0) + 1;
    stats.byBook[e.bookId] = (stats.byBook[e.bookId] || 0) + 1;
    if (e.success) successCount++;
    if (!e.success && (e.action === ACTIONS.TOKEN_REUSE || e.action === ACTIONS.TOKEN_FINGERPRINT_MISMATCH)) {
      stats.anomalies++;
    }
  }

  stats.successRate = stats.total > 0 ? (successCount / stats.total * 100).toFixed(1) : 0;

  // Top 10
  stats.topUsers = Object.entries(stats.byUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([userId, count]) => ({ userId: parseInt(userId), count }));

  stats.topBooks = Object.entries(stats.byBook)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([bookId, count]) => ({ bookId: parseInt(bookId), count }));

  return stats;
}

module.exports = {
  logPdfAccess,
  logTokenCreate,
  logStreamChunk,
  logRasterPage,
  logTokenReuse,
  readAuditLog,
  getAuditStats,
  ACTIONS,
  LOG_FILE
};