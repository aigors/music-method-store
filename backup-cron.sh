#!/usr/bin/env bash
# Backup automatico database SQLite
# Aggiungi a crontab: 0 3 * * * /var/www/musicstore/backup-cron.sh >> /var/log/musicstore/backup.log 2>&1

set -euo pipefail

DB_PATH="/var/lib/musicstore/db.sqlite"
BACKUP_DIR="/var/backups/musicstore"
DATE=$(date +%Y%m%d-%H%M%S)
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

# Backup con sqlite3 (consistente anche se DB in uso)
sqlite3 "$DB_PATH" ".backup $BACKUP_DIR/db-$DATE.sqlite"

# Comprimi
gzip "$BACKUP_DIR/db-$DATE.sqlite"

# Pulizia vecchi
find "$BACKUP_DIR" -name 'db-*.sqlite.gz' -mtime +$RETENTION_DAYS -delete

echo "[$(date)] Backup completato: db-$DATE.sqlite.gz"