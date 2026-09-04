# Deploy su VPS — Music Method Store

> Guida rapida per mettere in produzione su un VPS Linux (Ubuntu/Debian) con dominio e certificato SSL già pronti.

---

## 📋 Prerequisiti VPS

- **OS**: Ubuntu 22.04/24.04 LTS o Debian 12
- **RAM**: ≥ 1 GB (2 GB consigliati)
- **Disk**: ≥ 5 GB liberi
- **Accesso**: root via SSH
- **DNS**: Record A/AAAA `shop.tuodominio.it` → IP del VPS

---

## ⚡ Setup Automatico (Consigliato)

```bash
# 1. Come root, scarica ed esegui
curl -fsSL https://raw.githubusercontent.com/TUO-REPO/main/setup-vps.sh | bash
# OPPURE copia setup-vps.sh sul server e:
chmod +x setup-vps.sh && ./setup-vps.sh
```

Lo script fa tutto:
- Installa Node.js 20, PM2, Nginx, Certbot, SQLite
- Crea directory `/var/lib/musicstore`, `/var/log/musicstore`, `/var/backups/musicstore`
- Configura firewall (ufw), Nginx, systemd, logrotate, cron backup
- Richiede certificato SSL Let's Encrypt

---

## 📦 Deploy dell'Applicazione

```bash
# 1. Vai nella directory app
cd /var/www/musicstore

# 2. Clona il repo (o rsync/scp i file)
git clone https://github.com/TUO-REPO/music-method-store.git .

# 3. Configura variabili d'ambiente
cp .env.example.production .env
# MODIFICA .env con i TUOI valori reali (vedi sotto)

# 4. Installa dipendenze production
npm ci --omit=dev

# 5. Seed database (SOLO prima volta)
npm run seed

# 6. Avvia
systemctl start musicstore
# oppure: pm2 start ecosystem.config.js --env production

# 7. Verifica
pm2 logs musicstore
curl -s https://shop.tuodominio.it/api/catalog | head -c 200
```

---

## 🔐 Variabili `.env` — **Obbligatorie in Produzione**

| Variabile | Esempio | Note |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -hex 32` | **Genera una nuova!** 64 char hex |
| `DB_PATH` | `/var/lib/musicstore/db.sqlite` | Già corretto |
| `PDF_DIR` | `/var/lib/musicstore/pdfs` | Già corretto |
| `CACHE_DIR` | `/var/lib/musicstore/cache` | Già corretto |
| `SMTP_HOST` | `smtp.sendgrid.net` | **Obbligatorio per 2FA** |
| `SMTP_PORT` | `587` | 587 (STARTTLS) o 465 (SSL) |
| `SMTP_USER` | `apikey` | Per SendGrid: `apikey` |
| `SMTP_PASS` | `SG.xxx...` | API key o password SMTP |
| `SMTP_FROM` | `Music Store <noreply@tuodominio.it>` | Mittente email |
| `PAYPAL_CLIENT_ID` | `AbC123...` | **Live**, non sandbox |
| `PAYPAL_CLIENT_SECRET` | `XyZ789...` | **Live** |
| `PAYPAL_MODE` | `live` | Fisso |
| `PAYPAL_WEBHOOK_ID` | `WH-123...` | Da PayPal Developer → Webhooks |

> ⚠️ **Non committare `.env`** — è in `.gitignore`

---

## 🔧 File di Configurazione Inclusi

| File | Destinazione | Descrizione |
|---|---|---|
| `ecosystem.config.js` | `/var/www/musicstore/` | PM2 config (env, log, restart) |
| `nginx.conf` | `/etc/nginx/sites-available/musicstore` | Reverse proxy + SSL + rate limit |
| `musicstore.service` | `/etc/systemd/system/musicstore.service` | Systemd unit per PM2 |
| `deploy.sh` | `/var/www/musicstore/` | Script deploy aggiornamenti |
| `backup-cron.sh` | `/usr/local/bin/musicstore-backup` | Backup DB giornaliero (cron 03:00) |
| `setup-vps.sh` | (root home) | Setup iniziale VPS completo |

---

## 📂 Struttura Directory su VPS

```
/var/www/musicstore/          # Codice applicazione (git)
├── .env                      # Segreti (NON in git)
├── ecosystem.config.js       # PM2
├── deploy.sh                 # Deploy updates
├── server.js                 # Entry point
├── src/                      # Backend
├── public/                   # Frontend statico
└── ...

/var/lib/musicstore/          # Dati persistenti (backup qui!)
├── db.sqlite                 # Database SQLite
├── db.sqlite-shm/wal         # WAL mode files
├── pdfs/                     # PDF caricati admin
│   ├── metodo-chitarra-base.pdf
│   └── ...
└── cache/                    # Cache watermark PDF

/var/log/musicstore/          # Logs
├── error.log
├── out.log
└── backup.log

/var/backups/musicstore/      # Backup automatici
├── db-20260813-030000.sqlite.gz
└── ...
```

---

## 🚀 Deploy Aggiornamenti (dopo modifiche)

```bash
# Sul server
cd /var/www/musicstore
./deploy.sh
```

`deploy.sh` fa:
1. Backup DB automatico
2. `git pull` (o sincronizza file)
3. `npm ci --omit=dev`
4. `pm2 reload` (zero-downtime)
5. Health check API
6. Pulizia backup > 14 giorni

---

## 🛠️ Comandi Utili

```bash
# Logs applicazione
pm2 logs musicstore           # Live
pm2 logs musicstore --lines 100

# Stato
pm2 status
pm2 monit                     # Dashboard terminale

# Riavvio
pm2 reload musicstore         # Zero-downtime
pm2 restart musicstore        # Hard restart
systemctl restart musicstore  # Via systemd

# Database
sqlite3 /var/lib/musicstore/db.sqlite ".tables"
sqlite3 /var/lib/musicstore/db.sqlite "SELECT * FROM users;"

# Backup manuale
/usr/local/bin/musicstore-backup

# Nginx
nginx -t && systemctl reload nginx
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# Certificato SSL rinnovo (automatico via certbot timer)
certbot renew --dry-run
systemctl status certbot.timer
```

---

## ✅ Checklist Pre-Go-Live

- [ ] DNS `shop.tuodominio.it` → IP VPS propagato
- [ ] Certificato SSL valido (`certbot certificates`)
- [ ] `.env` compilato **tutto** (SMTP, PayPal Live, SESSION_SECRET)
- [ ] `npm run seed` eseguito (admin + catalogo demo)
- [ ] `pm2 logs musicstore` → "Server avviato su porta 3000"
- [ ] Login admin → 2FA email riceve codice
- [ ] Pannello `/admin` accessibile
- [ ] Creazione libro con upload PDF funziona
- [ ] Acquisto PayPal **live** testato (webhook configurato)
- [ ] Backup cron attivo (`crontab -l | grep musicstore`)
- [ ] Logrotate configurato (`/etc/logrotate.d/musicstore`)

---

## 🆘 Troubleshooting Rapido

| Problema | Soluzione |
|---|---|
| `502 Bad Gateway` | `pm2 status` → se stopped: `pm2 logs` per errore; `systemctl start musicstore` |
| 2FA email non arriva | Controlla `SMTP_*` in `.env`; `pm2 logs` per errore nodemailer; test: `telnet smtp.host 587` |
| PayPal webhook fallisce | URL esatto: `https://shop.tuodominio.it/api/paypal/webhook`; verifica `PAYPAL_WEBHOOK_ID`; log: `pm2 logs` |
| Upload PDF fallisce | `client_max_body_size 60M` in nginx; permessi `/var/lib/musicstore/pdfs` (www-data) |
| DB locked / busy | WAL mode attivo; non copiare `db.sqlite` mentre l'app gira — usa `.backup` |

---

## 📞 Supporto

- Logs app: `pm2 logs musicstore`
- Logs nginx: `/var/log/nginx/error.log`
- DB ispezione: `sqlite3 /var/lib/musicstore/db.sqlite`
- Backup recovery: `cp /var/backups/musicstore/db-YYYYMMDD.sqlite.gz /var/lib/musicstore/db.sqlite` (poi `gunzip` e `systemctl restart musicstore`)