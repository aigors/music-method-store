'use strict';

require('dotenv').config();
const { initDb } = require('./src/db');
const { createApp } = require('./src/app');

// Inizializza SQLite (crea schema e cartelle dati) prima di avviare.
initDb();

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log('\n┌────────────────────────────────────────────────────┐');
  console.log('│        Music Method Store — avviato              │');
  console.log('└────────────────────────────────────────────────────┘');
  console.log(`  URL          : ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  console.log(`  PayPal       : ${process.env.PAYPAL_ENV || 'sandbox'}`);
  console.log(`  2FA via mail : ${process.env.SMTP_HOST ? 'SMTP configurato' : 'DEMO (codice nei log)'}`);
  console.log('');
});
