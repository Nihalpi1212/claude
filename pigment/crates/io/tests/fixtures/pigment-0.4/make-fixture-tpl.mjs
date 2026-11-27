// Writes `wip05-tool-presets.tpl` with the JavaScript Pigment 0.5's own writer (`writeTplFile` in
// src/renderer/lib/preset-files/tpl.js), run under Node. No canvas is needed: the tip is a PNG
// encoded by the app's own encoder (src/shared/pixels/png.js).
//
//   node make-fixture-tpl.mjs <wip05 checkout>/pigment <output folder>
//
// The checkout needs `npm install --ignore-scripts` (ag-psd 31.0.3, which `#ag-psd` resolves to).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, outArg] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error('usage: node make-fixture-tpl.mjs <checkout>/pigment <output folder>');
  process.exit(2);
}
const app = resolve(appArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const lib = (p) => import(pathToFileURL(join(app, 'src', p)).href);
const { writeTplFile } = await lib('renderer/lib/preset-files/tpl.js');
const { encodePng } = await lib('shared/pixels/png.js');

// A 6 x 4 grey tip the tests know: coverage (x * 40 + y * 10), the PNG is grey (luma = coverage).
const tw = 6;
const th = 4;
const grey = new Uint8Array(tw * th);
for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) grey[y * tw + x] = x * 40 + y * 10;
const tipPng = await encodePng({ width: tw, height: th, channels: 1, depth: 8, data: grey });

const presets = [
  {
    name: 'Soft Round 30',
    data: {
      tool: 'brush',
      options: { size: 30, hardness: 0.25, opacity: 0.6, flow: 0.4, blend: 'multiply', smoothing: 0.5, pressureSize: false, lockAlpha: true },
      brush: { tip: { kind: 'computed', size: 30, hardness: 0.25, angle: 30, roundness: 0.5, spacing: 0.2 } },
    },
  },
  {
    name: 'Sampled Pencil',
    data: {
      tool: 'pencil',
      options: { opacity: 0.8, blend: 'screen', autoErase: true },
      brush: { tip: { kind: 'sampled', size: 6, sample: { blob: 'tip1.png', hash: '0123456789abcdef0123456789abcdef', width: tw, height: th } } },
    },
  },
  { name: 'Block Eraser', data: { tool: 'eraser', options: { size: 16, mode: 'pencil', eraseToHistory: true } } },
  { name: 'Red Gradient', data: { tool: 'gradient', options: { opacity: 0.5, blend: 'overlay', type: 'radial' }, color: '#ff0000' } },
  { name: 'Headline', data: { tool: 'type', options: {}, type: { char: { fontFamily: 'Inter', size: 36, postScriptName: 'Inter-Bold' }, para: {} } } },
  { name: 'Spot Heal 20', data: { tool: 'spot-heal', options: { size: 20 } } },
  { name: 'Dodge Highlights', data: { tool: 'dodge', options: { size: 40, range: 'highlights', exposure: 0.3 } } },
  { name: 'Adjust Brush', data: { tool: 'adjustment-brush', options: { size: 50 } } },
];

const readBlob = async (kind, name) => (kind === 'brushes' && name === 'tip1.png' ? tipPng : null);
const { bytes, report } = await writeTplFile(presets, { readBlob });
writeFileSync(join(out, 'wip05-tool-presets.tpl'), bytes);
console.log(`wip05-tool-presets.tpl  ${bytes.length} bytes`);
for (const line of report) console.log(`report: ${line}`);
