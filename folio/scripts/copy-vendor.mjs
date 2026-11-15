// Copies the browser builds of pdf.js and pdf-lib from node_modules into src/renderer/vendor so the
// renderer (a plain file:// page with an import map) can load them without a bundler.
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, 'src', 'renderer', 'vendor');
const nm = join(root, 'node_modules');

const copies = [
  ['pdfjs-dist/build/pdf.mjs', 'pdfjs/pdf.mjs'],
  ['pdfjs-dist/build/pdf.mjs.map', 'pdfjs/pdf.mjs.map'],
  ['pdfjs-dist/build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs'],
  ['pdfjs-dist/build/pdf.worker.mjs.map', 'pdfjs/pdf.worker.mjs.map'],
  ['pdfjs-dist/build/pdf.sandbox.mjs', 'pdfjs/pdf.sandbox.mjs'],
  ['pdfjs-dist/build/pdf.sandbox.mjs.map', 'pdfjs/pdf.sandbox.mjs.map'],
  ['pdfjs-dist/web/pdf_viewer.mjs', 'pdfjs/pdf_viewer.mjs'],
  ['pdfjs-dist/web/pdf_viewer.mjs.map', 'pdfjs/pdf_viewer.mjs.map'],
  ['pdfjs-dist/web/pdf_viewer.css', 'pdfjs/pdf_viewer.css'],
  ['pdfjs-dist/web/images', 'pdfjs/images'],
  ['pdfjs-dist/cmaps', 'pdfjs/cmaps'],
  ['pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts'],
  ['pdfjs-dist/wasm', 'pdfjs/wasm'],
  ['pdfjs-dist/iccs', 'pdfjs/iccs'],
  ['pdf-lib/dist/pdf-lib.esm.js', 'pdf-lib/pdf-lib.esm.js'],
  ['pdf-lib/dist/pdf-lib.esm.js.map', 'pdf-lib/pdf-lib.esm.js.map'],
  ['@pdf-lib/fontkit/dist/fontkit.es.js', 'pdf-lib/fontkit.es.js'],
];

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
let copied = 0;
for (const [from, to] of copies) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.warn(`copy-vendor: skipping missing ${from}`);
    continue;
  }
  const dest = join(vendor, to);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  copied++;
}
console.log(`copy-vendor: copied ${copied}/${copies.length} entries into src/renderer/vendor`);
