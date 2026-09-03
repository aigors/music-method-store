#!/usr/bin/env bash
# Deploy script per Music Method Store
# Uso: ./deploy.sh [versione|latest]

set -euo pipefail

PROJECT_DIR="/var/www/musicstore"
SERVICE_NAME="musicstore"
BACKUP_DIR="/var/backups/musicstore"
DATE=$(date +%Y%m%d-%H%M%S)

echo "🚀 Deploy Music Method Store - $DATE"

# 1. Backup database
echo "📦 Backup database..."
mkdir -p "$BACKUP_DIR"
cp /var/lib/musicstore/db.sqlite "$BACKUP_DIR/db-$DATE.sqlite"
sqlite3 /var/lib/musicstore/db.sqlite ".backup $BACKUP_DIR/db-$DATE.sqlite"
echo "   ✓ Backup salvato in $BACKUP_DIR/db-$DATE.sqlite"

# 2. Pull latest (se repo git) o copia file
if [ -d "$PROJECT_DIR/.git" ]; then
    echo "📥 Git pull..."
    cd "$PROJECT_DIR"
    git pull origin main
else
    echo "📁 Sincronizzazione file (rsync/scp manuale richiesto prima)..."
fi

# 3. Installa dipendenze production
echo "📦 npm ci --omit=dev..."
cd "$PROJECT_DIR"
npm ci --omit=dev 2>&1 | tail -5

# 4. Esegui seed se DB vuoto (prima volta)
if [ ! -f /var/lib/musicstore/db.sqlite ] || [ $(sqlite3 /var/lib/musicstore/db.sqlite "SELECT COUNT(*) FROM users;") -eq 0 ]; then
    echo "🌱 Database vuoto - eseguo seed..."
    npm run seed
else
    echo "ℹ️ Database esistente - seed saltato"
fi

# 5. Permessi directory persistenti
echo "🔐 Fix permessi..."
chown -R www-data:www-data /var/lib/musicstore
chmod 750 /var/lib/musicstore /var/lib/musicstore/pdfs /var/lib/musicstore/cache

# 6. Riavvia via PM2
echo "🔄 Riavvio PM2..."
pm2 reload ecosystem.config.js --env production || pm2 start ecosystem.config.js --env production
pm2 save

# 7. Health check
echo "🩺 Health check..."
sleep 3
if curl -sf http://localhost:3000/api/catalog >/dev/null; then
    echo "   ✓ API risponde"
else
    echo "   ✗ API non risponde - controlla pm2 logs"
    pm2 logs "$SERVICE_NAME" --lines 30
    exit 1
fi

# 8. Pulizia backup vecchi (mantieni ultimi 14)
echo "🧹 Pulizia backup vecchi..."
find "$BACKUP_DIR" -name 'db-*.sqlite' -mtime +14 -delete

echo ""
echo "✅ Deploy completato!"
echo "   Logs: pm2 logs $SERVICE_NAME"
echo "   Status: pm2 status"
echo "   Backup: $BACKUP_DIR/db-$DATE.sqlite"