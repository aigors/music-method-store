#!/usr/bin/env node
/**
 * Cleanup script — rimuove file temporanei e token scaduti
 * Esegui con: npm run cleanup
 * Puoi anche schedularlo via cron (es. ogni ora)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initDb, cleanup } = require('../src/db');
const { cleanupRasterCache } = require('../src/pdf-raster');

console.log('\n🧹  Cleanup avviato...\n');

initDb();

// 1. Cleanup DB (token 2FA e view token scaduti)
cleanup();
console.log('✅  DB pulito (token scaduti rimossi)');

// 2. Cleanup file cache PDF watermarkati più vecchi di 24h
const cacheDir = path.resolve(__dirname, '..', 'data', 'cache');
if (fs.existsSync(cacheDir)) {
  const now = Date.now();
  let removed = 0;
  for (const file of fs.readdirSync(cacheDir)) {
    const filePath = path.join(cacheDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch { /* ignore */ }
  }
  console.log(`✅  Cache PDF: ${removed} file rimossi`);
}

// 3. Cleanup cache raster (immagini pagine highSecurity)
const rasterRemoved = cleanupRasterCache();
console.log(`✅  Cache raster: ${rasterRemoved} file rimossi`);

// 3. Opzionale: log dimensione cartelle
const pdfDir = path.resolve(__dirname, '..', 'data', 'pdfs');
const dataDir = path.resolve(__dirname, '..', 'data');

function getDirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let size = 0;
  for (const file of fs.readdirSync(dir)) {
    const fp = path.join(dir, file);
    try { size += fs.statSync(fp).size; } catch {}
  }
  return size;
}

console.log('\n📊  Spazio disco:');
console.log(`  PDFs sorgenti:   ${(getDirSize(pdfDir) / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Cache watermark: ${(getDirSize(cacheDir) / 1024 / 1024).toFixed(2)} MB`);
const rasterDir = path.resolve(__dirname, '..', 'data', 'raster');
console.log(`  Cache raster:    ${(getDirSize(rasterDir) / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Totale data/:    ${(getDirSize(dataDir) / 1024 / 1024).toFixed(2)} MB`);

console.log('\n✨  Cleanup completato.\n');