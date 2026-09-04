#!/usr/bin/env bash
# Setup iniziale VPS per Music Method Store
# Esegui come root: bash setup-vps.sh

set -euo pipefail

DOMAIN="tuodominio.it"
APP_USER="www-data"
APP_DIR="/var/www/musicstore"
DATA_DIR="/var/lib/musicstore"
LOG_DIR="/var/log/musicstore"
BACKUP_DIR="/var/backups/musicstore"

echo "🔧 Setup VPS Music Method Store"

# ──────────────────────────────────────────────────────────────
# 1. Aggiorna sistema
# ──────────────────────────────────────────────────────────────
apt update && apt upgrade -y

# ──────────────────────────────────────────────────────────────
# 2. Installa dipendenze base
# ──────────────────────────────────────────────────────────────
apt install -y nodejs npm nginx certbot python3-certbot-nginx sqlite3 git rsync ufw

# ──────────────────────────────────────────────────────────────
# 3. Verifica Node.js >= 18
# ──────────────────────────────────────────────────────────────
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "⚠️ Node.js $NODE_VERSION < 18, installo Node 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

# ──────────────────────────────────────────────────────────────
# 4. Installa PM2 globalmente
# ──────────────────────────────────────────────────────────────
npm install -g pm2@latest

# ──────────────────────────────────────────────────────────────
# 5. Crea directory persistenti
# ──────────────────────────────────────────────────────────────
mkdir -p "$DATA_DIR"/{pdfs,cache}
mkdir -p "$LOG_DIR"
mkdir -p "$BACKUP_DIR"
mkdir -p "$APP_DIR"

# ──────────────────────────────────────────────────────────────
# 6. Permessi
# ──────────────────────────────────────────────────────────────
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR" "$APP_DIR"
chmod 750 "$DATA_DIR" "$DATA_DIR"/pdfs "$DATA_DIR"/cache
chmod 755 "$LOG_DIR" "$BACKUP_DIR"

# ──────────────────────────────────────────────────────────────
# 7. Firewall
# ──────────────────────────────────────────────────────────────
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# ──────────────────────────────────────────────────────────────
# 8. IPv6: rileva disponibilità
# ──────────────────────────────────────────────────────────────
HAS_IPV6=0
if ip -6 addr show scope global 2>/dev/null | grep -q 'inet6'; then
    HAS_IPV6=1
    echo "✅ IPv6 rilevato — Nginx ascolterà su IPv4 + IPv6"
else
    echo "⚠️  IPv6 non disponibile — Nginx ascolterà solo su IPv4"
fi

# ──────────────────────────────────────────────────────────────
# 9. Certificato SSL (dopo aver puntato DNS)
# ──────────────────────────────────────────────────────────────
echo ""
echo "📜 Certificato SSL per $DOMAIN"
echo "   Assicurati che DNS A/AAAA punti a questo server PRIMA di continuare."
read -p "   DNS configurato? (s/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Ss]$ ]]; then
    certbot --nginx -d "shop.$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect
else
    echo "   ⏭️ Salto certificato. Esegui dopo: certbot --nginx -d shop.$DOMAIN"
fi

# ──────────────────────────────────────────────────────────────
# 10. Nginx config (generata con IPv6 condizionale)
# ──────────────────────────────────────────────────────────────
echo "📝 Configurazione Nginx..."

# Genera listen directives in base a IPv6
LISTEN_80="listen 80;"
LISTEN_443="listen 443 ssl http2;"
if [ "$HAS_IPV6" -eq 1 ]; then
    LISTEN_80="listen 80;\n    listen [::]:80;"
    LISTEN_443="listen 443 ssl http2;\n    listen [::]:443 ssl http2;"
fi

# Genera nginx.conf dinamicamente
cat > /etc/nginx/sites-available/musicstore <<NGINXEOF
# ──────────────────────────────────────────────────────────────
# Music Method Store — Nginx reverse proxy
# Generato da setup-vps.sh il $(date -Iseconds)
# IPv6: $([ "$HAS_IPV6" -eq 1 ] && echo "abilitato" || echo "disabilitato")
# ──────────────────────────────────────────────────────────────

# Redirect HTTP → HTTPS
server {
    $(echo -e "$LISTEN_80")
    server_name shop.$DOMAIN;
    return 301 https://\$host\$request_uri;
}

# HTTPS + reverse proxy verso Node.js
server {
    $(echo -e "$LISTEN_443")
    server_name shop.$DOMAIN;

    # SSL (gestito da Certbot)
    ssl_certificate /etc/letsencrypt/live/shop.$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.$DOMAIN/privkey.pem;

    # Header sicurezza (addizionali rispetto a Helmet)
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;

    # Upload: max 50 MB per copertine PDF
    client_max_body_size 50m;

    # Timeout più lunghi per upload/copertine
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;

    # ── Proxy verso Node.js ──
    location / {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
    }

    # ── File statici (cache aggressive) ──
    location /css/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /js/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /images/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    location /lib/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # ── Copertine (cache 7 giorni, immutable) ──
    location /covers/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # ── API: nessuna cache ──
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }

    # ── Viewer PDF: no cache, no store (protezione watermark) ──
    location /viewer/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }

    location /pdf/ {
        proxy_pass http://127.0.0.1:3000;
        include proxy_params;
        add_header Cache-Control "no-store, no-cache, must-revalidate";
    }
}
NGINXEOF

# proxy_params (necessario per Nginx)
if [ ! -f /etc/nginx/proxy_params ]; then
cat > /etc/nginx/proxy_params <<'PROXYEOF'
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_cache_bypass $http_upgrade;
proxy_read_timeout 60s;
proxy_send_timeout 60s;
proxy_buffering off;
proxy_request_buffering off;
PROXYEOF
fi

# Rimuovi default se presente
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl reload nginx

# ──────────────────────────────────────────────────────────────
# 11. Systemd service per PM2
# ──────────────────────────────────────────────────────────────
cp musicstore.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable musicstore

# ──────────────────────────────────────────────────────────────
# 12. Cron backup
# ──────────────────────────────────────────────────────────────
cp backup-cron.sh /usr/local/bin/musicstore-backup
chmod +x /usr/local/bin/musicstore-backup
(crontab -l 2>/dev/null | grep -v musicstore-backup; echo "0 3 * * * /usr/local/bin/musicstore-backup >> /var/log/musicstore/backup.log 2>&1") | crontab -

# ──────────────────────────────────────────────────────────────
# 13. Logrotate
# ──────────────────────────────────────────────────────────────
cat > /etc/logrotate.d/musicstore <<'LOGEOF'
/var/log/musicstore/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data www-data
    sharedscripts
    postrotate
        systemctl reload musicstore 2>/dev/null || true
    endscript
}
LOGEOF

# ──────────────────────────────────────────────────────────────
# Riepilogo
# ──────────────────────────────────────────────────────────────
echo ""
echo "✅ Setup VPS completato!"
echo ""
echo "📋 Prossimi passi:"
echo "1. Copia il progetto in $APP_DIR (git clone o rsync)"
echo "2. Crea .env da .env.example.production e compila TUTTI i valori"
echo "3. cd $APP_DIR && npm ci"
echo "4. npm run seed  (prima volta)"
echo "5. systemctl start musicstore"
echo "6. Verifica: journalctl -u musicstore -f"
echo ""
echo "🔐 File importanti:"
echo "   .env                    → $APP_DIR/.env"
echo "   Nginx config            → /etc/nginx/sites-available/musicstore"
echo "   PM2 ecosystem           → $APP_DIR/ecosystem.config.js"
echo "   Systemd service         → /etc/systemd/system/musicstore.service"
echo "   Backup script           → /usr/local/bin/musicstore-backup"
echo "   Logs                    → /var/log/musicstore/"
echo "   Database                → /var/lib/musicstore/db.sqlite"
echo "   PDF uploads             → /var/lib/musicstore/pdfs/"
echo ""
if [ "$HAS_IPV6" -eq 0 ]; then
    echo "⚠️  IPv6 non attivo: Nginx ascolta solo su IPv4."
    echo "   Quando IPv6 sarà disponibile, esegui di nuovo questo script."
fi
