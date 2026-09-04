#!/usr/bin/env node
/**
 * Audit Report - Analizza log accessi PDF e rileva anomalie
 * Uso: node scripts/audit-report.js [--since 2024-01-01] [--format json|text]
 *
 * Rileva:
 * - Token usati da IP prefix diversi (condivisione account)
 * - >50 richieste/minuto per token (scraping)
 * - Pattern download completi (tutte pagine in < 2 min)
 * - Accessi falliti ripetuti (brute force)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { readAuditLog, getAuditStats, ACTIONS, LOG_FILE } = require('../src/audit');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    since: null,
    format: 'text',
    output: null
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--since' && i + 1 < args.length) {
      options.since = args[++i];
    } else if (args[i] === '--format' && i + 1 < args.length) {
      options.format = args[++i];
    } else if (args[i] === '--output' && i + 1 < args.length) {
      options.output = args[++i];
    }
  }
  return options;
}

function analyzeAnomalies(entries) {
  const anomalies = [];

  // Raggruppa per token
  const byToken = {};
  for (const e of entries) {
    if (!byToken[e.tokenPrefix]) byToken[e.tokenPrefix] = [];
    byToken[e.tokenPrefix].push(e);
  }

  // 1. Token usati da IP prefix diversi
  for (const [tokenPrefix, tokenEntries] of Object.entries(byToken)) {
    const ipHashes = new Set(tokenEntries.map(e => e.ipHash));
    const uaHashes = new Set(tokenEntries.map(e => e.uaHash));

    if (ipHashes.size > 1) {
      anomalies.push({
        type: 'token_multiple_ips',
        severity: 'high',
        tokenPrefix,
        userId: tokenEntries[0].userId,
        bookId: tokenEntries[0].bookId,
        details: `${ipHashes.size} IP prefix diversi`,
        count: ipHashes.size,
        ips: Array.from(ipHashes)
      });
    }

    if (uaHashes.size > 1) {
      anomalies.push({
        type: 'token_multiple_uas',
        severity: 'medium',
        tokenPrefix,
        userId: tokenEntries[0].userId,
        bookId: tokenEntries[0].bookId,
        details: `${uaHashes.size} User-Agent diversi`,
        count: uaHashes.size,
        uas: Array.from(uaHashes)
      });
    }
  }

  // 2. Rate eccessivo per token (>50 req/min)
  for (const [tokenPrefix, tokenEntries] of Object.entries(byToken)) {
    // Raggruppa per minuto
    const byMinute = {};
    for (const e of tokenEntries) {
      const minute = e.ts.substring(0, 16); // YYYY-MM-DDTHH:MM
      if (!byMinute[minute]) byMinute[minute] = 0;
      byMinute[minute]++;
    }

    for (const [minute, count] of Object.entries(byMinute)) {
      if (count > 50) {
        anomalies.push({
          type: 'token_high_rate',
          severity: 'high',
          tokenPrefix,
          userId: tokenEntries[0].userId,
          bookId: tokenEntries[0].bookId,
          details: `${count} richieste in ${minute}`,
          count,
          minute
        });
      }
    }
  }

  // 3. Accesso completo rapido (tutte pagine in < 2 min)
  // Cerca pattern: token_create seguito da stream_chunk/raster_page per tutte pagine in < 2 min
  for (const [tokenPrefix, tokenEntries] of Object.entries(byToken)) {
    const createEntry = tokenEntries.find(e => e.action === ACTIONS.TOKEN_CREATE);
    if (!createEntry) continue;

    const createTime = new Date(createEntry.ts).getTime();
    const pageAccesses = tokenEntries.filter(e =>
      e.action === ACTIONS.STREAM_CHUNK || e.action === ACTIONS.RASTER_PAGE
    );

    if (pageAccesses.length === 0) continue;

    const lastAccess = Math.max(...pageAccesses.map(e => new Date(e.ts).getTime()));
    const durationMinutes = (lastAccess - createTime) / 60000;

    // Se ha accesso a molte pagine in poco tempo
    const uniquePages = new Set(pageAccesses.map(e => e.page).filter(p => p !== null));
    const bookId = tokenEntries[0].bookId;

    // Heuristic: se > 80% delle pagine accessibili in < 2 min
    // Nota: non sappiamo quante pagine ha il libro qui, usiamo soglia pagine
    if (uniquePages.size >= 10 && durationMinutes < 2) {
      anomalies.push({
        type: 'rapid_full_access',
        severity: 'medium',
        tokenPrefix,
        userId: tokenEntries[0].userId,
        bookId,
        details: `${uniquePages.size} pagine in ${durationMinutes.toFixed(1)} min`,
        pages: uniquePages.size,
        durationMinutes: durationMinutes.toFixed(1)
      });
    }
  }

  // 4. Tentativi falliti ripetuti per stesso user/book
  const failedByUserBook = {};
  for (const e of entries) {
    if (!e.success) {
      const key = `${e.userId}:${e.bookId}`;
      if (!failedByUserBook[key]) failedByUserBook[key] = [];
      failedByUserBook[key].push(e);
    }
  }

  for (const [key, failedEntries] of Object.entries(failedByUserBook)) {
    if (failedEntries.length >= 10) {
      const [userId, bookId] = key.split(':').map(Number);
      anomalies.push({
        type: 'repeated_failures',
        severity: 'medium',
        userId,
        bookId,
        details: `${failedEntries.length} tentativi falliti`,
        count: failedEntries.length,
        reasons: [...new Set(failedEntries.map(e => e.reason))]
      });
    }
  }

  // 5. Token reuse espliciti (gia loggati come TOKEN_REUSE)
  const reuseEntries = entries.filter(e => e.action === ACTIONS.TOKEN_REUSE);
  for (const e of reuseEntries) {
    anomalies.push({
      type: 'token_reuse_detected',
      severity: 'critical',
      tokenPrefix: e.tokenPrefix,
      userId: e.userId,
      bookId: e.bookId,
      details: 'Token riutilizzato da device/IP diverso',
      meta: e.meta
    });
  }

  return anomalies;
}

function formatTextReport(stats, anomalies, options) {
  let out = '';
  out += '\n╔══════════════════════════════════════════════════════════╗\n';
  out += '║           MUSIC METHOD STORE — AUDIT REPORT              ║\n';
  out += '╚══════════════════════════════════════════════════════════╝\n';
  out += `Periodo: ${options.since || 'tutto'} — Generato: ${new Date().toLocaleString('it-IT')}\n\n`;

  out += '📊  STATISTICHE GENERALI\n';
  out += '────────────────────────\n';
  out += `  Totale eventi:      ${stats.total}\n`;
  out += `  Tasso successo:     ${stats.successRate}%\n`;
  out += `  Anomalie rilevate:  ${anomalies.length}\n\n`;

  out += '  Per azione:\n';
  for (const [action, count] of Object.entries(stats.byAction).sort((a, b) => b[1] - a[1])) {
    out += `    ${action}: ${count}\n`;
  }
  out += '\n';

  out += '  Top 10 utenti:\n';
  for (const u of stats.topUsers) {
    out += `    User #${u.userId}: ${u.count} eventi\n`;
  }
  out += '\n';

  out += '  Top 10 libri:\n';
  for (const b of stats.topBooks) {
    out += `    Book #${b.bookId}: ${b.count} eventi\n`;
  }
  out += '\n';

  if (anomalies.length === 0) {
    out += '✅  NESSUNA ANOMALIA RILEVATA\n';
  } else {
    out += '🚨  ANOMALIE RILEVATE\n';
    out += '─────────────────────\n';

    // Raggruppa per severità
    const bySeverity = { critical: [], high: [], medium: [], low: [] };
    for (const a of anomalies) {
      bySeverity[a.severity].push(a);
    }

    for (const severity of ['critical', 'high', 'medium', 'low']) {
      if (bySeverity[severity].length === 0) continue;

      const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🟢' }[severity];
      out += `\n${icon}  ${severity.toUpperCase()} (${bySeverity[severity].length}):\n`;

      for (const a of bySeverity[severity]) {
        out += `    [${a.type}] Token ${a.tokenPrefix} — User ${a.userId} — Book ${a.bookId}\n`;
        out += `         ${a.details}\n`;
        if (a.meta) out += `         Meta: ${JSON.stringify(a.meta)}\n`;
      }
    }
  }

  out += '\n═══════════════════════════════════════════════════════════\n';
  return out;
}

function formatJsonReport(stats, anomalies, options) {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    period: { since: options.since },
    stats,
    anomalies
  }, null, 2);
}

async function main() {
  const options = parseArgs();

  console.log('📖  Lettura log audit...');
  const entries = readAuditLog({ since: options.since, lines: 100000 });
  console.log(`   ${entries.length} entry lette`);

  const stats = getAuditStats({ since: options.since });
  const anomalies = analyzeAnomalies(entries);

  let report;
  if (options.format === 'json') {
    report = formatJsonReport(stats, anomalies, options);
  } else {
    report = formatTextReport(stats, anomalies, options);
  }

  if (options.output) {
    fs.writeFileSync(options.output, report);
    console.log(`\n💾  Report salvato in: ${options.output}`);
  } else {
    console.log(report);
  }

  // Exit code: 0 = ok, 1 = anomalie critical/high trovate
  const criticalHigh = anomalies.filter(a => a.severity === 'critical' || a.severity === 'high');
  if (criticalHigh.length > 0) {
    console.log(`\n⚠️  ${criticalHigh.length} anomalie critical/high — exit code 1`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌  Errore:', err);
  process.exit(1);
});