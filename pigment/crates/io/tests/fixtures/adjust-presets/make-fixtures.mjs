// Writes the adjustment preset files of this folder with the JavaScript Pigment's own writers
// (`writeAcv`, `writeAlv` in src/renderer/lib/adjust/tonal-formats.js; `writeAhu`, `writeCha`,
// `writeAsv`, `writeBlw` in src/renderer/lib/adjust/color-formats.js). README.md names the commit.
//
//   node make-fixtures.mjs <path to a checkout's pigment/ folder> <output folder>
//
// The writers are pure (no DOM), so nothing else is needed. The settings are the params the
// app's editors hold; `settings.json` beside the files records them for the tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appArg, outArg] = process.argv.slice(2);
if (!appArg || !outArg) {
  console.error('usage: node make-fixtures.mjs <checkout>/pigment <output folder>');
  process.exit(2);
}
const app = resolve(appArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const load = (rel) => import(pathToFileURL(join(app, 'src', rel)).href);
const tonal = await load('renderer/lib/adjust/tonal-formats.js');
const color = await load('renderer/lib/adjust/color-formats.js');

const L = (o) => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255, ...o });
const settings = {
  'curves.acv': {
    write: tonal.writeAcv,
    params: { space: 'rgb', rgb: [[0, 0], [64, 40], [192, 220], [255, 255]], r: [[0, 0], [128, 150], [255, 255]], g: null, b: [[0, 20], [255, 235]] },
  },
  'levels.alv': {
    write: tonal.writeAlv,
    params: { space: 'rgb', perChannel: true, rgb: L({ inBlack: 12, inWhite: 240, gamma: 1.2, outBlack: 5, outWhite: 250 }), r: L({ inBlack: 20, gamma: 0.8 }), g: null, b: L({ outWhite: 230 }) },
  },
  'hue-saturation.ahu': {
    write: color.writeAhu,
    params: {
      hue: 15, saturation: -20, lightness: 5, colorize: false, colorizeHue: 0, colorizeSat: 25, colorizeLight: 0, range: 'master',
      ranges: [{ base: 'reds', bounds: [310, 340, 20, 50], hue: 10, saturation: 30, lightness: -5 }, { base: 'blues', bounds: [195, 225, 255, 285], hue: 0, saturation: -40, lightness: 0 }],
    },
  },
  'sepia.ahu': {
    write: color.writeAhu,
    params: { hue: 0, saturation: 0, lightness: 0, colorize: true, colorizeHue: 205, colorizeSat: 30, colorizeLight: -10, range: 'master', ranges: [] },
  },
  'channel-mixer.cha': {
    write: color.writeCha,
    params: { monochrome: true, r: { r: 100, g: 0, b: 0, constant: 0 }, g: { r: 0, g: 100, b: 0, constant: 0 }, b: { r: 0, g: 0, b: 100, constant: 0 }, gray: { r: 50, g: 30, b: 20, constant: 5 } },
  },
  'selective-color.asv': {
    write: color.writeAsv,
    params: { relative: false, reds: { c: -20, m: 10, y: 30, k: 0 }, neutrals: { c: 0, m: 0, y: 0, k: 15 }, blacks: { c: 5, m: 5, y: 5, k: -10 } },
  },
  'black-white.blw': {
    write: color.writeBlw,
    params: { reds: 55, yellows: 70, greens: 30, cyans: 60, blues: -10, magentas: 90, tint: { hue: 35, sat: 25 } },
  },
};

const record = {};
for (const [name, { write, params }] of Object.entries(settings)) {
  const bytes = write(params);
  writeFileSync(join(out, name), bytes);
  record[name] = params;
  console.log(`${name}: ${bytes.length} bytes`);
}
writeFileSync(join(out, 'settings.json'), JSON.stringify(record, null, 2) + '\n');
