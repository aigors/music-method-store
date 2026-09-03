# Music Method Store

**Catalogo di metodi musicali in PDF protetti** — visualizzazione online con watermark personale, pagamenti PayPal, autenticazione a 2 fattori via email. Servizio separato per integrazione con Google Sites.

## 🚀 Caratteristiche principali

| Feature | Descrizione |
|---------|-------------|
| 🔒 **PDF protetti** | Streaming via token a breve scadenza, niente URL diretto al file. Download e stampa disabilitati nel viewer. |
| 🎨 **Watermark dinamico** | Applicato server-side su ogni pagina: email utente + timestamp. Visibile anche in screenshot. |
| 📱 **Responsive** | Funziona su desktop, tablet, mobile. Zoom, navigazione touch, fullscreen. |
| 🛡️ **2FA via email** | Login userid+password + codice 6 cifre inviato per email (SMTP o modalità demo). |
| 💳 **PayPal Sandbox** | Integrazione completa: creazione ordine, approvazione, cattura, registrazione acquisto. |
| 🗃️ **SQLite locale** | Zero dipendenze esterne. Database, PDF sorgenti e cache in `./data/`. |

## 📦 Struttura del progetto

```
music-method-store/
├── public/                 # Frontend statico (servito da Express)
│   ├── index.html          # Home
│   ├── catalog.html        # Catalogo pubblico
│   ├── login.html          # Login
│   ├── register.html       # Registrazione
│   ├── 2fa.html            # Verifica 2FA
│   ├── viewer.html         # Viewer PDF.js
│   ├── account.html        # Area utente / acquisti
│   ├── styles.css          # Stili responsive
│   ├── js/                 # Moduli ES6
│   │   ├── main.js         # Utilità comuni (fetch, auth nav, alert)
│   │   ├── catalog.js      # Logica catalogo + PayPal Buttons
│   │   ├── auth.js         # Login, register, 2FA
│   │   ├── account.js      # Area utente
│   │   └── viewer.js       # PDF.js viewer con anti-download
│   └── lib/                # PDF.js locale (no CDN)
│       ├── pdf.min.js
│       └── pdf.worker.min.js
├── src/
│   ├── app.js              # Express app (middleware, rotte, sicurezza)
│   ├── db.js               # SQLite + helper (users, books, purchases, tokens)
│   ├── auth.js             # API auth + middleware requireAuth/requireTwoFaVerified
│   ├── mail.js             # Invio codice 2FA via SMTP (fallback demo)
│   ├── catalog.js          # API catalogo (pubblico)
│   ├── payment.js          # API pagamenti PayPal
│   └── pdf.js              # API streaming PDF + watermark (pdf-lib)
├── scripts/
│   ├── seed.js             # Popola DB con utente demo + 5 metodi + PDF placeholder
│   ├── cleanup.js          # Pulisce token scaduti + cache PDF >24h
│   └── fetch-pdfjs.js      # Scarica PDF.js locale
├── data/                   # Creato automaticamente (git-ignored)
│   ├── db.sqlite           # Database SQLite
│   ├── pdfs/               # PDF sorgenti (non serviti pubblicamente)
│   └── cache/              # PDF watermarkati temporanei
├── server.js               # Entry point
├── package.json
├── .env.example            # Copia in .env e configura
└── .gitignore
```

## ⚙️ Installazione rapida

```bash
# 1. Entra nella cartella
cd music-method-store

# 2. Installa dipendenze
npm install

# 3. Configura ambiente
cp .env.example .env
# Modifica .env con i tuoi valori (vedi sotto)

# 4. Popola database con dati demo
npm run seed

# 5. Avvia server
npm start
# → http://localhost:3000
```

## 🔧 Configurazione (`.env`)

| Variabile | Obbligatoria | Descrizione |
|-----------|--------------|-------------|
| `PORT` | No | Porta server (default 3000) |
| `BASE_URL` | Sì | URL pubblico del servizio (es. `https://metodi.tuodominio.com`) |
| `NODE_ENV` | No | `development` o `production` |
| `SESSION_SECRET` | **Sì (prod)** | Stringa casuale lunga (genera: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`) |
| `SMTP_HOST` | No | Host SMTP per email 2FA. Se vuoto → **modalità demo** (codice nei log server) |
| `SMTP_PORT` | No | Porta SMTP (default 587) |
| `SMTP_SECURE` | No | `true` per porta 465, `false` per 587 |
| `SMTP_USER` | Se SMTP_HOST | Utente SMTP |
| `SMTP_PASS` | Se SMTP_HOST | Password / App password SMTP |
| `SMTP_FROM` | No | Mittente email (default: `Music Method Store <no-reply@example.com>`) |
| `PAYPAL_ENV` | Sì | `sandbox` (test) o `live` |
| `PAYPAL_CLIENT_ID` | Sì | Client ID da PayPal Developer Dashboard |
| `PAYPAL_CLIENT_SECRET` | Sì | Secret da PayPal Developer Dashboard |
| `PAYPAL_WEBHOOK_ID` | No | Webhook ID per notifiche asincrone (opzionale) |

### PayPal Sandbox — Setup rapido
1. Vai su https://developer.paypal.com → **Dashboard** → **Apps & Credentials**
2. Crea una **App** in ambiente **Sandbox**
3. Copia **Client ID** e **Secret** nel `.env`
4. In **Sandbox → Accounts** crea un account **Buyer** (personale) per i test
5. Usa le credenziali buyer per pagare in sandbox

## 🏗️ Integrazione con Google Sites

Poiché Google Sites non supporta codice server-side, il servizio gira **separatamente** (VPS, Vercel, Heroku, Fly.io, Railway, ecc.) e viene linkato dal sito Google Sites.

### Opzione A — Link diretto (consigliata)
Nel tuo Google Sites, aggiungi un pulsante/link che punta a:
```
https://metodi.tuodominio.com/catalogo
```
L'utente esce da Google Sites, usa il negozio, e può tornare indietro.

### Opzione B — Embed iframe (limitato)
In Google Sites → **Incorpora** → **Incorpora URL**:
```
https://metodi.tuodominio.com/catalogo
```
⚠️ **Attenzione**: l'iframe potrebbe bloccare cookie di sessione (SameSite=Lax) e il login 2FA. Funziona meglio con Opzione A.

### Opzione C — Sottodominio dedicato
Configura DNS:
```
metodi.tuodominio.com  →  IP del tuo server / target Vercel / ecc.
```
Così il servizio appare come parte del tuo brand.

## 🧪 Test locale

```bash
# 1. Avvia server
npm start

# 2. Apri browser
#    http://localhost:3000

# 3. Registrati con email qualsiasi
#    (in modalità demo il codice 2FA appare nei log del server)

# 4. Acquista un metodo (usa account buyer PayPal sandbox)

# 5. Vai in /account → "Leggi" → viewer PDF protetto
```

## 🔐 Sicurezza — Cosa NON è (e cosa SÌ)

| Protezione | Livello | Note |
|------------|---------|------|
| **Nessun URL diretto al PDF** | ✅ Forte | Il PDF viene streammato via token a 10 min, max 3 usi (per Range requests). |
| **Watermark per utente** | ✅ Forte | Applicato server-side con `pdf-lib` su ogni pagina. Traccia chi ha fatto screenshot. |
| **Download disabilitato UI** | ⚠️ Best-effort | PDF.js toolbar nascosta, contextmenu bloccato, Ctrl+P/S bloccati. |
| **Stampa disabilitata** | ⚠️ Best-effort | Stesso metodo. Un utente determinato può sempre fare screenshot o usare DevTools. |
| **Token monouso/breve** | ✅ Forte | Scade a 10 min, consumato a ogni richiesta Range. |
| **2FA obbligatorio per PDF** | ✅ Forte | Anche se rubi la sessione, serve codice email. |
| **HTTPS in produzione** | ✅ Obbligatorio | Cookie `secure`, HSTS, CSP rigidi. |

> **Onestà intellettuale**: *impedire tecnicamente al 100% il download di un PDF visualizzato in browser è impossibile*. Un attaccante con accesso al disco/rete può intercettare il blob. Questo sistema alza drasticamente la barriera: niente link diretto, watermark tracciabile, token effimeri, 2FA. Per uso didattico/professionale è sufficiente.

## 🛠️ Script utili

```bash
npm run seed      # Popola DB demo
npm run cleanup   # Rimuove token scaduti + cache PDF >24h (da mettere in cron)
npm start         # Avvia server produzione
```

## 📝 Licenza

UNLICENSED — Uso privato / progetto didattico. Non ridistribuire senza autorizzazione.

---

**Sviluppato per integrazione con Google Sites come servizio separato.**