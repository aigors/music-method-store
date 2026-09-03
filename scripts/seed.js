#!/usr/bin/env node
/**
 * Seed script — popola il database con dati di esempio
 * Esegui con: npm run seed
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { initDb, getDb, createUser, createBook } = require('../src/db');

console.log('\n🌱  Seeding database...\n');

initDb();
const db = getDb();

// 1. Utente demo
const demoEmail = 'demo@musicstore.local';
const demoPass = 'Demo1234!';

let user = db.prepare('SELECT * FROM users WHERE email = ?').get(demoEmail);
if (!user) {
  user = createUser(demoEmail, demoPass);
  console.log(`✅  Utente demo creato: ${demoEmail} / ${demoPass}`);
} else {
  console.log(`ℹ️  Utente demo già esistente: ${demoEmail}`);
}

// 1b. Utente admin (con privilegi amministrativi)
const adminEmail = 'admin@musicstore.local';
const adminPass = 'Admin1234!';

let admin = db.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
if (!admin) {
  admin = createUser(adminEmail, adminPass);
  // Promuovi admin
  db.prepare('UPDATE users SET isAdmin = 1 WHERE id = ?').run(admin.id);
  console.log(`✅  Utente admin creato: ${adminEmail} / ${adminPass}`);
} else {
  console.log(`ℹ️  Utente admin già esistente: ${adminEmail}`);
}

// 2. PDF di esempio (se non esistono, crea placeholder)
const pdfDir = path.resolve(__dirname, '..', 'data', 'pdfs');
if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });

function createPlaceholderPdf(filename, title) {
  const filepath = path.join(pdfDir, filename);
  if (fs.existsSync(filepath)) return;

  // Crea un PDF minimale con pdf-lib
  const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
  (async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]); // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    page.drawText(title, { x: 72, y: 750, size: 28, font: fontBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText('Metodo musicale di esempio', { x: 72, y: 710, size: 16, font, color: rgb(0.4, 0.4, 0.4) });
    page.drawText('Questo è un PDF di placeholder per test.', { x: 72, y: 680, size: 12, font, color: rgb(0.5, 0.5, 0.5) });
    page.drawText('Sostituisci con il tuo PDF reale in data/pdfs/', { x: 72, y: 650, size: 11, font, color: rgb(0.6, 0.6, 0.6) });
    page.drawText('Le pagine reali verranno filigranate all\'accesso.', { x: 72, y: 630, size: 11, font, color: rgb(0.6, 0.6, 0.6) });

    const bytes = await pdfDoc.save();
    fs.writeFileSync(filepath, bytes);
    console.log(`📄  Creato placeholder: ${filename}`);
  })();
}

// 3. Catalogo di esempio
const books = [
  {
    slug: 'metodo-chitarra-base',
    title: 'Metodo Chitarra Base',
    author: 'Marco Rossi',
    description: 'Il metodo completo per iniziare a suonare la chitarra: accordi, ritmici, arpeggi, prima posizione. Include esercizi progressivi e brani facili.',
    priceCents: 1499, // 14.99 €
    pdfFile: 'metodo-chitarra-base.pdf',
    coverFile: null,
    pages: 52
  },
  {
    slug: 'scale-arpeggi-pianoforte',
    title: 'Scale e Arpeggi per Pianoforte',
    author: 'Laura Bianchi',
    description: 'Tutte le scale maggiori, minori, modali e gli arpeggi corrispondenti. Ditazioni standard, esercizi di velocità, applicazione armonica.',
    priceCents: 1999,
    pdfFile: 'scale-arpeggi-pianoforte.pdf',
    coverFile: null,
    pages: 84
  },
  {
    slug: 'teoria-musicale-pratica',
    title: 'Teoria Musicale Pratica',
    author: 'Giuseppe Verdi',
    description: 'Dalle basi della notazione all\'armonia funzionale: intervalli, accordi, cadenze, modulazioni. Esercizi svolti e dettati melodici.',
    priceCents: 2499,
    pdfFile: 'teoria-musicale-pratica.pdf',
    coverFile: null,
    pages: 120
  },
  {
    slug: 'batteria-ritmica-fondamentale',
    title: 'Batteria: Ritmica Fondamentale',
    author: 'Antonio Neri',
    description: 'Groove rock, pop, funk, latin. Rudimenti, independence, fill, lettura partiture. Con basi audio scaricabili (link nel PDF).',
    priceCents: 1799,
    pdfFile: 'batteria-ritmica-fondamentale.pdf',
    coverFile: null,
    pages: 68
  },
  {
    slug: 'canto-tecnica-respirazione',
    title: 'Canto: Tecnica e Respirazione',
    author: 'Sofia Marino',
    description: 'Appoggio, risonanza, registro, agilità. Esercizi giornalieri, vocalizzi, cura della voce. Adatto a principianti e intermedi.',
    priceCents: 2199,
    pdfFile: 'canto-tecnica-respirazione.pdf',
    coverFile: null,
    pages: 76
  }
];

for (const book of books) {
  const existing = db.prepare('SELECT * FROM books WHERE slug = ?').get(book.slug);
  if (!existing) {
    createPlaceholderPdf(book.pdfFile, book.title);
    createBook(book);
    console.log(`✅  Libro aggiunto: ${book.title}`);
  } else {
    console.log(`ℹ️  Libro già presente: ${book.title}`);
  }
}

// 4. Acquisto demo per l'utente demo (opzionale)
const userId = user.id;
for (const book of books) {
  const b = db.prepare('SELECT id FROM books WHERE slug = ?').get(book.slug);
  if (b) {
    const exists = db.prepare('SELECT 1 FROM purchases WHERE userId = ? AND bookId = ?').get(userId, b.id);
    if (!exists) {
      db.prepare(`
        INSERT INTO purchases (userId, bookId, paypalOrderId, amountCents, currency, status)
        VALUES (?, ?, ?, ?, 'EUR', 'COMPLETED')
      `).run(userId, b.id, `SEED_${Date.now()}_${b.id}`, book.priceCents);
      console.log(`✅  Acquisto demo registrato: ${book.title}`);
    }
  }
}

console.log('\n✨  Seed completato!\n');
console.log('Utente demo:');
console.log(`  Email: ${demoEmail}`);
console.log(`  Password: ${demoPass}`);
console.log('Utente admin:');
console.log(`  Email: ${adminEmail}`);
console.log(`  Password: ${adminPass}`);
console.log('\nAvvia il server con: npm start\n');