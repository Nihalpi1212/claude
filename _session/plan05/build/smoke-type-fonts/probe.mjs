import { readFileSync } from 'node:fs';
import * as hb from '/home/user/claude/pigment/src/renderer/vendor/harfbuzz/index.mjs';
const files = process.argv.slice(2);
for (const f of files) {
  const b = readFileSync(f);
  const blob = new hb.Blob(new Uint8Array(b));
  const face = new hb.Face(blob, 0);
  const os2 = face.referenceTable('OS/2');
  const fc = os2 ? (os2[30] << 8 | os2[31]) : null;
  const pan = os2 ? [...os2.slice(32, 42)] : null;
  const post = face.referenceTable('post');
  const fixed = post ? (post[12] << 24 | post[13] << 16 | post[14] << 8 | post[15]) : null;
  console.log(f.split('/').pop(), face.getName(1,'en'), '|', face.getName(2,'en'), '|', face.getName(6,'en'), '| class', fc >> 8, fc & 255, 'panose', pan.join(','), 'fixed', fixed, 'axes', JSON.stringify(face.getAxisInfos()), 'n', face.collectUnicodes().length, 'name25', face.getName(25,'en'));
}
