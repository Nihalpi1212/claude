// Recomputes the CSP hash of the inline import map in src/renderer/index.html and updates the meta tag.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = new URL('../src/renderer/index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1];
if (!map) throw new Error('import map not found');
const hash = createHash('sha256').update(map).digest('base64');
html = html.replace(/'sha256-[^']+'/, `'sha256-${hash}'`);
writeFileSync(file, html);
console.log(`CSP hash updated: sha256-${hash}`);
