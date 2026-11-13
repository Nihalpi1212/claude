// Bundles the few third-party libraries the renderer uses into src/renderer/vendor (git-ignored).
// The renderer has no bundler of its own: it loads ES modules straight from disk, so dependencies
// that are not shipped as self-contained ES modules are bundled here once, at install time.
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const { build } = esbuild;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'renderer', 'vendor');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'scripts', 'vendor-entries', 'ag-psd.js')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  outfile: join(out, 'ag-psd.js'),
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('vendor: ag-psd bundled ->', existsSync(join(out, 'ag-psd.js')) ? 'ok' : 'missing');

// 0.4 (ARCHITECTURE.md "0.4 features", L.8): every scripts/vendor/*.mjs is a vendor step exporting
// build({ root, out, esbuild }) (HarfBuzz is type-engine-core's). Steps run in name order; a step that fails prints
// a warning and the others still run, so one missing tool never breaks npm install. No directory: no steps.
const stepsDir = join(root, 'scripts', 'vendor');
const steps = existsSync(stepsDir) ? readdirSync(stepsDir).filter((f) => f.endsWith('.mjs')).sort() : [];
for (const file of steps) {
  try {
    const step = await import(pathToFileURL(join(stepsDir, file)).href);
    if (typeof step.build !== 'function') throw new Error('it exports no build() function');
    await step.build({ root, out, esbuild });
    console.log(`vendor: ${file} ok`);
  } catch (err) {
    console.warn(`vendor: ${file} failed: ${err?.message ?? err}`);
  }
}
