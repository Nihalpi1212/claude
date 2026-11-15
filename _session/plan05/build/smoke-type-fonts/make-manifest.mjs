// Writes src/renderer/fonts/index.json from the bundled font files (type-fonts). Run from the pigment folder:
// node <this> ; tests/unit/type-fonts.test.mjs checks the manifest still matches the files.
import { readFileSync, writeFileSync } from 'node:fs';
import { fontInfo } from '/home/user/claude/pigment/src/renderer/lib/type/font-tables.js';
const DIR = '/home/user/claude/pigment/src/renderer/fonts/';
const families = [{ files: ['SourceSans3VF-Upright.ttf', 'SourceSans3VF-Italic.ttf'], license: 'SourceSans3-LICENSE.md', origin: 'Source Sans 3 3.52.0 by Adobe (npm package source-sans), SIL Open Font License 1.1' }];
const out = { format: 'pigment-fonts', version: 1, default: null, families: [] };
for (const f of families) {
  const faces = f.files.map((file) => {
    const i = fontInfo(new Uint8Array(readFileSync(DIR + file)));
    return { file, postScriptName: i.postScriptName, style: i.subfamily, weight: i.weight, italic: i.italic, stretch: i.stretch, metrics: i.metrics, axes: i.axes, instances: i.instances };
  });
  const first = fontInfo(new Uint8Array(readFileSync(DIR + f.files[0])));
  out.families.push({ name: first.family, classification: first.classification, variable: first.variable, license: f.license, origin: f.origin, faces });
  out.default ??= first.family;
}
writeFileSync(DIR + 'index.json', JSON.stringify(out, null, 1) + '\n');
console.log('ok', out.families.map((x) => x.name));
