// Vendor step (ARCHITECTURE.md "0.4 features", L.8 / E23; "0.5 features", rule 15, package icc-engine): copies
// LittleCMS 2 compiled to WebAssembly (the npm package lcms-wasm, MIT, by Matt DesLauriers; LittleCMS itself is MIT,
// by Marti Maria Saguer) into src/renderer/vendor/lcms2/. The renderer has no bundler and loads ES modules from disk,
// so the package's ES module (its Emscripten loader with the LittleCMS bindings) and the wasm are copied as they are;
// lib/color/lcms.js imports lcms.js and hands it the wasm bytes it fetched itself (served as application/wasm by
// pigment:// and the test server; the CSP allows 'wasm-unsafe-eval'). The minified copy and its source map are left
// out. Both licences are written next to them, and electron-builder packages the folder with the rest of src/.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['lcms.js', 'lcms.wasm'];

// LittleCMS's own licence (the COPYING file of mm2/Little-CMS): the wasm is LittleCMS's code, compiled
const LITTLECMS_LICENSE = `Little CMS
MIT License

Copyright (c) 2023 Marti Maria Saguer

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject
to the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;

export async function build({ root, out }) {
  const pkg = join(root, 'node_modules', 'lcms-wasm');
  const dist = join(pkg, 'dist');
  if (!existsSync(join(dist, 'lcms.wasm'))) throw new Error('node_modules/lcms-wasm is missing: run npm install');
  const dest = join(out, 'lcms2');
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) copyFileSync(join(dist, f), join(dest, f));
  if (existsSync(join(pkg, 'LICENSE.md'))) copyFileSync(join(pkg, 'LICENSE.md'), join(dest, 'LICENSE-lcms-wasm.md'));
  writeFileSync(join(dest, 'LICENSE-littlecms.txt'), LITTLECMS_LICENSE);
  // which package the copy came from (About and the release notes' notices read docs/0.5/icc-engine.md; this is the
  // record next to the files themselves)
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  writeFileSync(join(dest, 'VERSION'), `lcms-wasm ${version} (LittleCMS 2.16)\n`);
}
