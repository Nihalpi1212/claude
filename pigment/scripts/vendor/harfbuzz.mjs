// Vendor step (ARCHITECTURE.md "0.4 features", L.8 / E23): copies HarfBuzz (harfbuzzjs, MIT; the shaping engine of
// lib/type/shaper.js) into src/renderer/vendor/harfbuzz/. The renderer has no bundler and loads ES modules from disk,
// so the package's ES module, its Emscripten loader and the wasm are copied as they are: index.mjs imports
// ./harfbuzz.js, which fetches ./harfbuzz.wasm next to itself (served as application/wasm by pigment:// and by the
// test server; the CSP allows 'wasm-unsafe-eval'). The subsetter wasm of the package is not needed and is left out.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['index.mjs', 'harfbuzz.js', 'harfbuzz.wasm'];

export async function build({ root, out }) {
  const pkg = join(root, 'node_modules', 'harfbuzzjs');
  const dist = join(pkg, 'dist');
  if (!existsSync(join(dist, 'index.mjs'))) throw new Error('node_modules/harfbuzzjs is missing: run npm install');
  const dest = join(out, 'harfbuzz');
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) copyFileSync(join(dist, f), join(dest, f));
  if (existsSync(join(pkg, 'LICENSE'))) copyFileSync(join(pkg, 'LICENSE'), join(dest, 'LICENSE'));
}
