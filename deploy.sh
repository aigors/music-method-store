#!/usr/bin/env bash
# deploy.sh — Deploy Music Method Store su VPS
# Uso: bash deploy.sh [utente@]host[:porta]
#
# Esempio:
#   bash deploy.sh deploy@192.168.1.100
#   bash deploy.sh deploy@192.168.1.100:2222
#
# Premesse:
#   - Il server deve già aver eseguito setup-vps.sh (Nginx, Node, PM2)
#   - SSH key-based auth configurata
#   - Path dati: /var/lib/musicstore/ (DB + PDFs + cache)
#   - Path app: /var/www/musicstore/

set -euo pipefail

# ──────────────────────────────────────────────────────────────
# CONFIGURAZIONE
# ──────────────────────────────────────────────────────────────
REMOTE="${1:-deploy@192.168.1.100}"
SSH_PORT="${REMOTE##*:}"
SSH_PORT="${SSH_PORT%%@*}"
if [[ "$SSH_PORT" == "$REMOTE" || -z "$SSH_PORT" || ! "$SSH_PORT" =~ ^[0-9]+$ ]]; then
  SSH_PORT=22
fi

REMOTE_USER="${REMOTE%%:*}"
REMOTE_USER="${REMOTE_USER##*@}"
REMOTE_HOST="${REMOTE%%:*}"
REMOTE_HOST="${REMOTE_HOST##*@}"

APP_DIR="/var/www/musicstore"
DATA_DIR="/var/lib/musicstore"
REMOTE_SSH="ssh -p $SSH_PORT $REMOTE_USER@$REMOTE_HOST"

# Path dati corretti (devono corrispondere a ecosystem.config.js)
DB_PATH="$DATA_DIR/db.sqlite"
PDF_DIR="$DATA_DIR/pdfs"
CACHE_DIR="$DATA_DIR/cache"
BACKUP_DIR="$DATA_DIR"
PREV_DB="$BACKUP_DIR/backup_prev.db"

echo "🚀 Deploy Music Method Store su $REMOTE_HOST:$SSH_PORT"

# ──────────────────────────────────────────────────────────────
# 0. Build locale (opzionale)
# ──────────────────────────────────────────────────────────────
if [ -f package.json ]; then
  echo "📦 Build dipendenze..."
  npm ci --omit=dev
fi

# ──────────────────────────────────────────────────────────────
# 1. Sync del progetto
# ──────────────────────────────────────────────────────────────
echo "📤 Sincronizzazione file su server..."
rsync -avz --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'data/db.sqlite*' \
  --exclude 'data/pdfs/*' \
  --exclude '*.log' \
  --exclude '.env' \
  -e "ssh -p $SSH_PORT" \
  ./ $REMOTE_USER@$REMOTE_HOST:$APP_DIR/

# ──────────────────────────────────────────────────────────────
# 2. Pre-deploy: backup DB + PDFs (solo se db esiste)
# ──────────────────────────────────────────────────────────────
echo "💾 Backup precedente..."
$REMOTE_SSH "mkdir -p $BACKUP_DIR"

# Backup DB
if $REMOTE_SSH "[ -f $DB_PATH ]"; then
  $REMOTE_SSH "cp '$DB_PATH' '$PREV_DB'" 2>/dev/null || true
fi

# Backup PDFs (l'intera cartella, essenziale per la replica)
$REMOTE_SSH "mkdir -p $PDF_DIR" 2>/dev/null || true
$REMOTE_SSH "rsync -a --delete '$PDF_DIR/' '$BACKUP_DIR/pdfs_backup/'" 2>/dev/null || true

# ──────────────────────────────────────────────────────────────
# 3. Installa dipendenze production
# ──────────────────────────────────────────────────────────────
echo "📥 Installazione dipendenze..."
$REMOTE_SSH "cd $APP_DIR && npm ci --omit=dev"

# ──────────────────────────────────────────────────────────────
# 4. Verifica .env (non sovrascrivere!)
# ──────────────────────────────────────────────────────────────
if ! $REMOTE_SSH "[ -f $APP_DIR/.env ]"; then
  echo "⚠️  Nessun file .env trovato! Copia .env.example.production → .env e compila i valori."
  echo "   Comando: $REMOTE_SSH 'cp $APP_DIR/.env.example.production $APP_DIR/.env && nano $APP_DIR/.env'"
  exit 1
fi

# ──────────────────────────────────────────────────────────────
# 5. Migrazione DB (backup WAL + checkpoint)
# ──────────────────────────────────────────────────────────────
echo "🗄️ Migrazione database..."
$REMOTE_SSH "[ -f $DB_PATH-wal ] && cp '$DB_PATH-wal' '$BACKUP_DIR/backup_prev.db-wal'" 2>/dev/null || true
$REMOTE_SSH "sqlite3 '$DB_PATH' 'PRAGMA wal_checkpoint(TRUNCATE);'" 2>/dev/null || true

# ──────────────────────────────────────────────────────────────
# 6. Ripristino backup (solo DB; PDFs si ripristinano dal backup
#    solo se assenti, per non sovrascrivere versioni nuove)
# ──────────────────────────────────────────────────────────────
echo "🔄 Verifica integrità dati..."
if ! $REMOTE_SSH "[ -f $DB_PATH ]"; then
  echo "⚠️  DB non trovato — ripristino dal backup..."
  $REMOTE_SSH "cp '$PREV_DB' '$DB_PATH'" 2>/dev/null || true
  $REMOTE_SSH "cp '$PREV_DB-wal' '$DB_PATH-wal'" 2>/dev/null || true
  $REMOTE_SSH "cp '$PREV_DB-shm' '$DB_PATH-shm'" 2>/dev/null || true
fi
# PDFs: ripristina solo se cartella vuota (primo deploy o cancellazione accidentale)
if $REMOTE_SSH "[ ! -f $PDF_DIR/*.pdf ] 2>/dev/null"; then
  echo "⚠️  PDFs assenti — ripristino dal backup..."
  $REMOTE_SSH "rsync -a '$BACKUP_DIR/pdfs_backup/' '$PDF_DIR/'" 2>/dev/null || true
fi

# ──────────────────────────────────────────────────────────────
# 7. Permessi
# ──────────────────────────────────────────────────────────────
$REMOTE_SSH "chown -R www-data:www-data '$DATA_DIR' '$APP_DIR'"
$REMOTE_SSH "chmod 750 '$DATA_DIR' '$PDF_DIR' '$CACHE_DIR'" 2>/dev/null || true

# ──────────────────────────────────────────────────────────────
# 8. IPv6: rileva disponibilità e aggiorna Nginx
# ──────────────────────────────────────────────────────────────
echo "🌐 Verifica IPv6..."
HAS_IPV6=$($REMOTE_SSH "ip -6 addr show scope global 2>/dev/null | grep -q 'inet6' && echo 1 || echo 0")

LISTEN_80="listen 80;"
LISTEN_443="listen 443 ssl http2;"
if [ "$HAS_IPV6" -eq 1 ]; then
  LISTEN_80="listen 80;\n    listen [::]:80;"
  LISTEN_443="listen 443 ssl http2;\n    listen [::]:443 ssl http2;"
  echo "✅ IPv6 attivo"
else
  echo "⚠️  IPv6 non disponibile — Nginx ascolta solo su IPv4"
fi

# Trova il dominio dalla nginx config esistente
DOMAIN=$($REMOTE_SSH "grep server_name /etc/nginx/sites-available/musicstore 2>/dev/null | head -1 | awk '{print \$2}' | tr -d ';' | head -1" || echo "")
if [ -z "$DOMAIN" ]; then
  echo "⚠️  Impossibile leggere il dominio da Nginx. Salto aggiornamento config."
  DOMAIN=""
fi

if [ -n "$DOMAIN" ]; then
  echo "📝 Aggiornamento Nginx per $DOMAIN (IPv6: $([ "$HAS_IPV6" -eq 1 ] && echo "sì" || echo "no"))..."
  $REMOTE_SSH "cat > /etc/nginx/sites-available/musicstore" <<NGINXEOF
# ──────────────────────────────────────────────────────────────
# Music Method Store — Nginx reverse proxy
# Aggiornato da deploy.sh il $(date -Iseconds)
# IPv6: $([ "$HAS_IPV6" -eq 1 ] && echo "abilitato" || echo "disabilitato")
# ──────────────────────────────────────────────────────────────

# Redirect HTTP → HTTPS
server {
    $(echo -e "$LISTEN_80")
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

# HTTPS + reverse proxy verso Node.js
server {
    $(echo -e "$LISTEN_443")
    server_name $DOMAIN;

    # SSL (gestito da Certbot)
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

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

  # Test e reload Nginx
  if $REMOTE_SSH "nginx -t" 2>&1; then
    $REMOTE_SSH "systemctl reload nginx"
    echo "✅ Nginx ricaricato"
  else
    echo "❌ Errore configurazione Nginx! Ripristino..."
    $REMOTE_SSH "nginx -t" 2>&1
    exit 1
  fi
fi

# ──────────────────────────────────────────────────────────────
# 9. Restart servizio (systemd gestisce PM2)
# ──────────────────────────────────────────────────────────────
echo "🔄 Riavvio applicazione..."
$REMOTE_SSH "systemctl restart musicstore"
sleep 2

# ──────────────────────────────────────────────────────────────
# 10. Health check
# ──────────────────────────────────────────────────────────────
echo "🔍 Health check..."
if $REMOTE_SSH "systemctl is-active musicstore" | grep -q "active"; then
  echo "✅ Deploy completato con successo! Servizio attivo."
else
  echo "⚠️  Servizio non attivo. Controlla i log:"
  echo "   $REMOTE_SSH 'journalctl -u musicstore -n 30 --no-pager'"
  exit 1
fi
