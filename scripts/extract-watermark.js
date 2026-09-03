#!/usr/bin/env node
/**
 * Extract forensic watermark from watermarked PDF
 * Uso: node scripts/extract-watermark.js <cached-pdf-path>
 *
 * Estrae il payload forense embeddato come testo invisibile (render mode 3)
 * nel watermark. Il payload ha formato: userId:timestamp:randomSalt
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

async function extractWatermark(pdfPath) {
  if (!fs.existsSync(pdfPath)) {
    console.error(`❌  File non trovato: ${pdfPath}`);
    process.exit(1);
  }

  console.log(`🔍  Analisi: ${pdfPath}\n`);

  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  const results = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const { width, height } = page.getSize();

    // Estrae tutti gli oggetti testo dalla pagina
    // Nota: pdf-lib non ha API diretta per estrarre testo esistente.
    // Dobbiamo parsare il content stream manualmente o usare pdfjs-dist.

    // Per ora, usiamo un approccio alternativo: cerchiamo nel content stream grezzo
    const node = page.node;
    if (node.Contents) {
      const contents = pdfDoc.context.lookup(node.Contents);
      if (contents) {
        // Se è un array di stream
        const streams = Array.isArray(contents) ? contents : [contents];
        for (const streamRef of streams) {
          const stream = pdfDoc.context.lookup(streamRef);
          if (stream && stream.contents) {
            const contentStr = typeof stream.contents === 'string'
              ? stream.contents
              : stream.contents.toString('latin1');

            // Cerca pattern "WM:" che indica watermark invisibile
            const wmMatches = contentStr.match(/WM:([^\s)]+)/g);
            if (wmMatches) {
              for (const match of wmMatches) {
                const payload = match.substring(3); // rimuovi "WM:"
                results.push({
                  page: i + 1,
                  payload,
                  position: 'content-stream'
                });
              }
            }

            // Cerca anche pattern "userId:timestamp:salt" nei text objects
            const forensicMatches = contentStr.match(/(\d+):(\d+):([a-f0-9]{8})/g);
            if (forensicMatches) {
              for (const match of forensicMatches) {
                results.push({
                  page: i + 1,
                  payload: match,
                  position: 'content-stream'
                });
              }
            }
          }
        }
      }
    }
  }

  if (results.length === 0) {
    console.log('⚠️  Nessun watermark forense trovato nel PDF.');
    console.log('   Possibili cause:');
    console.log('   - PDF non watermarkato con questa versione');
    console.log('   - Watermark rimosso/alterato');
    console.log('   - Metodo di estrazione non compatibile con il tipo di watermark');
    return null;
  }

  console.log(`✅  Trovati ${results.length} watermark forensi:\n`);

  for (const r of results) {
    console.log(`  📄 Pagina ${r.page}: ${r.payload}`);
    const parts = r.payload.split(':');
    if (parts.length === 3) {
      const [userId, timestamp, salt] = parts;
      const date = new Date(parseInt(timestamp));
      console.log(`      User ID: ${userId}`);
      console.log(`      Timestamp: ${date.toISOString()} (${date.toLocaleString('it-IT')})`);
      console.log(`      Salt: ${salt}`);
    }
  }

  // Deduplicazione payload univoci
  const uniquePayloads = [...new Set(results.map(r => r.payload))];
  console.log(`\n📋  Payload univoci: ${uniquePayloads.length}`);
  for (const p of uniquePayloads) {
    console.log(`   - ${p}`);
  }

  return results;
}

// CLI
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Uso: node scripts/extract-watermark.js <pdf-path>');
  console.log('Esempio: node scripts/extract-watermark.js data/cache/1_5_a1b2c3d4.pdf');
  process.exit(1);
}

const pdfPath = path.resolve(args[0]);
extractWatermark(pdfPath).catch(err => {
  console.error('❌  Errore:', err.message);
  process.exit(1);
});