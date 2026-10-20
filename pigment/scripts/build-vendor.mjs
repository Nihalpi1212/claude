// Bundles the few third-party libraries the renderer uses into src/renderer/vendor (git-ignored).
// The renderer has no bundler of its own: it loads ES modules straight from disk, so dependencies
// that are not shipped as self-contained ES modules are bundled here once, at install time.
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
