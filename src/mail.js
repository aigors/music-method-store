'use strict';

const nodemailer = require('nodemailer');

let transporter = null;

/**
 * Inizializza il trasportatore SMTP se configurato.
 * Altrimenti restituisce null → modalità demo (log su console).
 */
function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  if (!host) return null; // modalità demo

  transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true', // true per 465, false per 587
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  return transporter;
}

/**
 * Invia il codice 2FA via email.
 * @param {string} to - Email destinatario
 * @param {string} code - Codice a 6 cifre (plain text)
 */
async function sendTwoFaEmail(to, code) {
  const tx = getTransporter();

  const subject = 'Il tuo codice di verifica — Music Method Store';
  const text = `Il tuo codice di verifica è: ${code}\n\nScade tra 15 minuti.\nSe non hai richiesto tu questo codice, ignora questa email.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#2c3e50;">Codice di verifica</h2>
      <p>Il tuo codice a 6 cifre:</p>
      <div style="background:#f4f4f4;padding:20px;text-align:center;font-size:32px;letter-spacing:8px;font-family:monospace;color:#2c3e50;border-radius:4px;">
        ${code}
      </div>
      <p style="margin-top:20px;color:#666;font-size:14px;">
        Scade tra 15 minuti. Se non hai richiesto tu questo codice, ignora questa email.
      </p>
      <hr style="margin:20px 0;border:none;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;">Music Method Store</p>
    </div>
  `;

  if (!tx) {
    // ========================================================
    // MODALITA' DEMO — stampa nel log del server
    // ========================================================
    console.log('\n┌──────────────────────────────────────────────┐');
    console.log('│  2FA EMAIL (DEMO — SMTP non configurato)    │');
    console.log('├──────────────────────────────────────────────┤');
    console.log(`│  To:      ${to}`);
    console.log(`│  Code:    ${code}`);
    console.log('└──────────────────────────────────────────────┘\n');
    return { demo: true, code };
  }

  // Invio reale
  const from = process.env.SMTP_FROM || 'Music Method Store <no-reply@example.com>';
  await tx.sendMail({ from, to, subject, text, html });
  console.log(`✉️  Codice 2FA inviato a ${to}`);
  return { demo: false };
}

/**
 * Invia email di recupero password con link di reset.
 * @param {string} to - Email destinatario
 * @param {string} resetUrl - URL completo di reset (con token)
 */
async function sendPasswordResetEmail(to, resetUrl) {
  const tx = getTransporter();

  const subject = 'Recupero password — Music Method Store';
  const text = `Hai richiesto il recupero della password.\n\nApri questo link per impostare una nuova password:\n${resetUrl}\n\nIl link scade tra 30 minuti e può essere usato una sola volta.\nSe non hai richiesto tu il recupero, ignora questa email.`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
      <h2 style="color:#2c3e50;">Recupero password</h2>
      <p>Hai richiesto di reimpostare la tua password. Clicca il pulsante qui sotto:</p>
      <p style="margin:24px 0;">
        <a href="${resetUrl}" style="background:#1a73e8;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none;display:inline-block;">
          Imposta una nuova password
        </a>
      </p>
      <p style="color:#666;font-size:14px;">
        In alternativa, apri questo link nel browser:<br>
        <a href="${resetUrl}" style="color:#1a73e8;">${resetUrl}</a>
      </p>
      <p style="color:#666;font-size:13px;">Il link scade tra 30 minuti e può essere usato una sola volta. Se non hai richiesto tu il recupero, ignora questa email.</p>
      <hr style="margin:20px 0;border:none;border-top:1px solid #eee;">
      <p style="color:#999;font-size:12px;">Music Method Store</p>
    </div>
  `;

  if (!tx) {
    // MODALITA' DEMO — stampa nel log del server
    console.log('\n┌──────────────────────────────────────────────┐');
    console.log('│  RESET PASSWORD (DEMO — SMTP non configurato)│');
    console.log('├──────────────────────────────────────────────┤');
    console.log(`│  To:    ${to}`);
    console.log(`│  Link:  ${resetUrl}`);
    console.log('└──────────────────────────────────────────────┘\n');
    return { demo: true, resetUrl };
  }

  // Invio reale
  const from = process.env.SMTP_FROM || 'Music Method Store <no-reply@example.com>';
  await tx.sendMail({ from, to, subject, text, html });
  console.log(`✉️  Email recupero password inviata a ${to}`);
  return { demo: false };
}

module.exports = { sendTwoFaEmail, sendPasswordResetEmail, getTransporter };