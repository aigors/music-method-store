#!/usr/bin/env node
/**
 * Seed script — inizializza il DB con l'utente admin
 *
 * Uso:
 *   node scripts/seed.js                → password di default (Admin1234!)
 *   node scripts/seed.js MiaPassword!   → password scelta
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initDb, getDb, createUser } = require('../src/db');

const DATA_DIR = path.resolve(__dirname, '..', 'data');

// ── Password da riga di comando ──────────────────────────────
const adminPass = process.argv[2] || 'Admin1234!';
const defaultUsed = !process.argv[2];

if (defaultUsed) {
  console.log('\n⚠️   Nessuna password specificata — uso default: Admin1234!');
  console.log('    Per scegliere la tua password:  node scripts/seed.js <password>\n');
}

// ── Init DB ──────────────────────────────────────────────────
console.log('🌱  Inizializzazione database…\n');
initDb();
const db = getDb();

// ── Admin user ───────────────────────────────────────────────
const adminEmail = 'admin@musicstore.local';
const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);

if (existing) {
  // Aggiorna la password se l'utente esiste già
  if (!defaultUsed) {
    const { hashPassword } = require('../src/db');
    const newHash = hashPassword(adminPass);
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(newHash, existing.id);
    console.log(`✅  Password admin aggiornata: ${adminEmail}`);
  } else {
    console.log(`ℹ️   Utente admin già esistente: ${adminEmail} — password invariata`);
  }
} else {
  createUser(adminEmail, adminPass);
  db.prepare('UPDATE users SET isAdmin = 1 WHERE id = (SELECT id FROM users WHERE email = ?)').run(adminEmail);
  console.log(`✅  Utente admin creato: ${adminEmail}`);
}

// ── Pulizia cartelle cache ────────────────────────────────────
const folders = [
  { dir: 'pdfs',   label: 'PDF di esempio' },
  { dir: 'raster', label: 'Raster / thumbnail' },
  { dir: 'covers', label: 'Cover cache' },
];

for (const { dir, label } of folders) {
  const target = path.join(DATA_DIR, dir);
  if (!fs.existsSync(target)) continue;
  let count = 0;
  for (const entry of fs.readdirSync(target)) {
    const full = path.join(target, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      fs.unlinkSync(full);
    }
    count++;
  }
  console.log(`🗑️   ${label} (${count} voci): ${target}`);
}

console.log('\n✨  Fatto!\n');
console.log('Email:    ', adminEmail);
console.log('Password: ', adminPass);
console.log('\nAvvia il server con:  npm start\n');
