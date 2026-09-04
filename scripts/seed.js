#!/usr/bin/env node
/**
 * Seed script — inizializza il DB con l'utente admin
 *
 * Uso:
 *   node scripts/seed.js                → password di default (Admin1234!)
 *   node scripts/seed.js MiaPassword!   → password scelta
 */

require('dotenv').config();
const { initDb, getDb, createUser } = require('../src/db');

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

console.log('\n✨  Fatto!\n');
console.log('Email:    ', adminEmail);
console.log('Password: ', adminPass);
console.log('\nAvvia il server con:  npm start\n');
