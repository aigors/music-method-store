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

# 1. Aggiorna sistema
apt update && apt upgrade -y

# 2. Installa dipendenze base
apt install -y nodejs npm nginx certbot python3-certbot-nginx sqlite3 git rsync ufw

# 3. Verifica Node.js >= 18
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "⚠️ Node.js $NODE_VERSION < 18, installo Node 20 LTS..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

# 4. Installa PM2 globalmente
npm install -g pm2@latest

# 5. Crea directory persistenti
mkdir -p "$DATA_DIR"/{pdfs,cache}
mkdir -p "$LOG_DIR"
mkdir -p "$BACKUP_DIR"
mkdir -p "$APP_DIR"
mkdir -p /var/www/letsencrypt

# 6. Permessi
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR" "$APP_DIR"
chmod 750 "$DATA_DIR" "$DATA_DIR"/pdfs "$DATA_DIR"/cache
chmod 755 "$LOG_DIR" "$BACKUP_DIR"

# 7. Firewall
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 8. Certificato SSL (dopo aver puntato DNS)
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

# 9. Nginx config
echo "📝 Configurazione Nginx..."
cp nginx.conf /etc/nginx/sites-available/musicstore
ln -sf /etc/nginx/sites-available/musicstore /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Crea proxy_params se manca
if [ ! -f /etc/nginx/proxy_params ]; then
cat > /etc/nginx/proxy_params <<'EOF'
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_cache_bypass $http_upgrade;
proxy_read_timeout 60s;
proxy_send_timeout 60s;
proxy_buffering off;
proxy_request_buffering off;
EOF
fi

nginx -t && systemctl reload nginx

# 10. Systemd service per PM2
cp musicstore.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable musicstore

# 11. Cron backup
cp backup-cron.sh /usr/local/bin/musicstore-backup
chmod +x /usr/local/bin/musicstore-backup
(crontab -l 2>/dev/null | grep -v musicstore-backup; echo "0 3 * * * /usr/local/bin/musicstore-backup >> /var/log/musicstore/backup.log 2>&1") | crontab -

# 12. Logrotate
cat > /etc/logrotate.d/musicstore <<'EOF'
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
        pm2 reloadLogs
    endscript
}
EOF

echo ""
echo "✅ Setup VPS completato!"
echo ""
echo "📋 Prossimi passi:"
echo "1. Copia il progetto in $APP_DIR (git clone o rsync)"
echo "2. Crea .env da .env.example.production e compila TUTTI i valori"
echo "3. cd $APP_DIR && npm ci --omit=dev"
echo "4. npm run seed  (prima volta)"
echo "5. systemctl start musicstore  (o pm2 start ecosystem.config.js --env production)"
echo "6. Verifica: pm2 logs musicstore"
echo ""
echo "🔐 File importanti:"
echo "   .env                    → $APP_DIR/.env"
echo "   Nginx config            → /etc/nginx/sites-available/musicstore"
echo   "   PM2 ecosystem           → $APP_DIR/ecosystem.config.js"
echo "   Systemd service         → /etc/systemd/system/musicstore.service"
echo "   Backup script           → /usr/local/bin/musicstore-backup"
echo "   Logs                    → /var/log/musicstore/"
echo "   Database                → /var/lib/musicstore/db.sqlite"
echo "   PDF uploads             → /var/lib/musicstore/pdfs/"