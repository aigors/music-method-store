#!/usr/bin/env node
/**
 * Scarica PDF.js e worker in public/lib
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const LIB_DIR = path.resolve(__dirname, '..', 'public', 'lib');
if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });

const files = [
  {
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.min.js',
    dest: path.join(LIB_DIR, 'pdf.min.js')
  },
  {
    url: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.6.82/build/pdf.worker.min.js',
    dest: path.join(LIB_DIR, 'pdf.worker.min.js')
  }
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} per ${url}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`✅  Scaricato: ${path.basename(dest)} (${(fs.statSync(dest).size / 1024).toFixed(1)} KB)`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log('📥  Download PDF.js...\n');
  for (const f of files) {
    try {
      await download(f.url, f.dest);
    } catch (err) {
      console.error(`❌  Errore ${f.url}:`, err.message);
    }
  }
  console.log('\n✨  Fatto.');
}

main();