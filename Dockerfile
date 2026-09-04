# ============================================================
# Music Method Store — Dockerfile (multi-stage)
#
# Immagine final: node 20 LTS, immagini Debian (glibc) per i
# moduli nativi con prebuild (better-sqlite3, @napi-rs/canvas).
# Non usare Alpine: i prebuild dei moduli nativi sono per glibc.
# ============================================================

# ------------------------------------------------------------
# STAGE 1 — build: installa le dipendenze
# ------------------------------------------------------------
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Strumenti di compilazione solo FALLBACK: better-sqlite3 e
# @napi-rs/canvas hanno prebuild per linux-x64; se il download
# fallisce npm compila da sorgente.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# --omit=dev: esclude puppeteer (scaricherebbe Chromium inutilmente)
RUN npm ci --omit=dev

# Verifica che i moduli nativi si carichino prima di procedere
RUN node -e "require('better-sqlite3'); require('@napi-rs/canvas'); console.log('native modules OK')"

# ------------------------------------------------------------
# STAGE 2 — runtime: solo i file necessari
# ------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# Utente non-root
RUN groupadd --gid 1000 nodejs \
    && useradd --uid 1000 --gid nodejs --create-home --shell /bin/false appuser

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/db.sqlite \
    PDF_DIR=/app/data/pdfs \
    CACHE_DIR=/app/data/cache

# Copia le dipendenze già installate (senza dev)
COPY --from=build --chown=appuser:nodejs /app/node_modules ./node_modules

# Codice applicativo + asset statici
COPY --chown=appuser:nodejs server.js package.json ./
COPY --chown=appuser:nodejs src ./src
COPY --chown=appuser:nodejs public ./public
COPY --chown=appuser:nodejs scripts ./scripts

# Directory dati persistenti (montata come volume in compose)
RUN mkdir -p /app/data \
    && chown -R appuser:nodejs /app/data

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]