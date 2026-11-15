import { readFileSync } from 'node:fs';
import * as hb from '/home/user/claude/pigment/src/renderer/vendor/harfbuzz/index.mjs';
const cov = (f) => new Set(new hb.Face(new hb.Blob(new Uint8Array(readFileSync(f))), 0).collectUnicodes());
const ss = cov('src/renderer/fonts/SourceSans3VF-Upright.ttf');
const ca = cov('tests/fixtures/fonts/Carlito-Regular.ttf');
const li = cov('tests/fixtures/fonts/LiberationSans-Regular.ttf');
const only = [...ss].filter((c) => !ca.has(c) && !li.has(c) && c > 0x20).slice(0, 40);
console.log(only.map((c) => c.toString(16) + ':' + String.fromCodePoint(c)).join(' '));
