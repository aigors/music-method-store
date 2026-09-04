# Music Method Store — versione Docker

Questa è una **versione alternativa a container** dell'app, che coesiste con la
deploy nativa (PM2/systemd + nginx). I file di deploy nativo (`deploy.sh`,
`setup-vps.sh`, `ecosystem.config.js`, `musicstore.service`, `nginx.conf`)
restano intatti e continuano a funzionare.

- **Nativa**: Node.js avviato con PM2, porta 3000, dati in `/var/lib/musicstore/`.
- **Docker**: immagine `music-method-store:latest`, porta 3000, dati in un volume Docker `musicstore_data`.

Entrambe usano lo **stesso file `.env`** per i segreti (SESSION_SECRET, SMTP, PayPal).

---

## Requisiti

- Docker Engine 23+ / Docker Desktop con plugin Compose v2.
  ```sh
  docker --version
  docker compose version
  ```

## Avvio rapido

Il database, i PDF e la cache vengono creati automaticamente alla prima partenza
(volume `musicstore_data`), quindi al primo `up` hai un catalogo vuoto: carica i
tuoi metodi dal pannello admin.

```sh
# 1. configura il .env (come per la versione nativa)
cp .env.example .env        # poi compila i valori

# 2. build + avvio
docker compose up -d

# 3. verifica
curl http://localhost:3000/api/config   # → JSON { "paypalClientId": ..., ... }
curl -I http://localhost:3000/catalogo  # → 200
```

Il container espone la **porta 3000** per default — se la porta è occupata
(es. la versione nativa è già in esecuzione sulla VPS), cambiala nel `.env`:

```
PORT=3001
```

e l'nginx esistente (`proxy_pass http://127.0.0.1:3001`) andrà aggiornato di
conseguenza.

### Test locale in HTTP semplice

Per provare il sito in locale su `http://localhost:3000` (senza HTTPS) imposta
`NODE_ENV=development` nel `.env`: i cookie di sessione non sono `secure` e il
login funziona. Con `NODE_ENV=production` l'app richiede HTTPS (cookie secure).

## aggiornare dopo una modifica al codice

```sh
docker compose build && docker compose up -d
```

L'immagine non monta il codice dal disco: ogni `build` ricopia i sorgenti.
Confronta la build `docker build .` per vedere le modifiche applicate.

## Comandi utili

| Comando | Effetto |
|---|---|
| `docker compose up -d` | avvia in background |
| `docker compose logs -f` | log in tempo reale |
| `docker compose ps` | stato |
| `docker compose down` | ferma (i dati **restano** nel volume) |
| `docker compose down -v` | ferma **e cancella** i dati (attenzione!) |
| `docker build -t music-method-store .` | build manuale dell'immagine |

## Variabili d'ambiente

Arrivano tutte dal file `.env` (stesso della versione nativa). I tre percorsi dati
vengono però **sovrascritti dal compose** con i path interni al container:

| Var | Dentro il container | Note |
|---|---|---|
| `DB_PATH` | `/app/data/db.sqlite` | obbligatoria per persistere |
| `PDF_DIR` | `/app/data/pdfs` | PDF caricati dall'admin |
| `CACHE_DIR` | `/app/data/cache` | cache rasterizzazione |
| `SESSION_SECRET` | dal `.env` | generare con `openssl rand -hex 32` |
| `SMTP_*` | dal `.env` | per il codice 2FA via email |
| `PAYPAL_ENV/CLIENT_ID/SECRET/WEBHOOK_ID` | dal `.env` | `sandbox` o `live` |
| `BASE_URL` | dal `.env` | usato per return-url PayPal e link reset |

Non modificare i path dati nel `.env` per la versione Docker: sono gestiti qui.

## Dati persistenti

Il volume Docker `musicstore_data` è montato su `/app/data` e contiene:

```
/app/data/
├── db.sqlite        # database (WAL)
├── pdfs/            # i PDF caricati
├── cache/           # cache rasterizzazione
└── covers/          # cover generate
```

### Migrare i dati della versione nativa nel volume

Se hai già un'installazione nativa con dati in `/var/lib/musicstore/`, copiali
una volta nel volume (il container deve essere fermo):

```sh
docker compose down
docker run --rm \
  -v musicstore_data:/app/data \
  -v /var/lib/musicstore:/old:ro \
  alpine sh -c 'cp -a /old/. /app/data/'
docker compose up -d
```

### Backup del volume

Il `backup-cron.sh` esistente lavora su path host e non serve per Docker.
Equivalente Docker (da aggiungere a un cron):

```sh
docker run --rm -v musicstore_data:/app/data -v /var/backups/musicstore:/backup \
  alpine tar czf /backup/musicstore-$(date +%Y%m%d-%H%M%S).tar.gz -C /app/data .
```

## Produzione sulla VPS (affiancata all'nginx esistente)

La versione nativa resta attiva su PM2. Per usare Docker **in alternativa**:

```sh
# su una porta diversa dalla nativa (es. 3001) finché non la spegni,
# oppure ferma la nativa prima:
#   systemctl stop musicstore && systemctl disable musicstore
docker compose up -d
```

Con il container sulla porta 3000 e `NODE_ENV=production`, l'nginx esistente
(`proxy_pass http://127.0.0.1:3000`) inoltra le richieste HTTPS senza modifiche.
Il webhook PayPal deve puntare all'URL pubblico raggiunto da nginx
(`https://TUODOMINIO/api/pay/webhook`), uguale per entrambe le versioni.

## Limitazioni note

- **Singola istanza**: l'app usa `express-session` con MemoryStore (come la
  versione nativa, `instances: 1`): le sessioni si azzerano a ogni restart del
  container. Non avviare due repliche dello stesso container sulla stessa porta.
- **Niente TLS nel container**: il TLS è gestito da nginx (come in nativo).
- **Immagine minimale**: i moduli nativi (`better-sqlite3`, `@napi-rs/canvas`)
  usano i prebuild per `node:20` su Debian glibc; non usare basi Alpine.