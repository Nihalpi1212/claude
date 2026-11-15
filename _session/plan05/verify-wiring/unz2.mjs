import { readZip } from '/home/user/claude/pigment/src/shared/zip.js';
import fs from 'node:fs'; import zlib from 'node:zlib';
const opts = { inflate: async (d) => new Uint8Array(zlib.inflateRawSync(d)) };
const r = JSON.parse(fs.readFileSync('rewrites.json'));
const walk = async (a, b, path) => {
  for (const e of a) {
    const f = b.find((x) => x.name === e.name);
    let x = Buffer.from(e.data).toString('latin1'), y = Buffer.from(f.data).toString('latin1');
    if (e.name.endsWith('.pigment')) { await walk(await readZip(new Uint8Array(e.data), opts), await readZip(new Uint8Array(f.data), opts), path + '/' + e.name); continue; }
    if (e.name.endsWith('.json')) x = x.replaceAll('"profile":null,', '');
    if (x !== y) { let i = 0; while (x[i] === y[i]) i++; console.log(path, e.name, 'DIFF at', i, '\n 05', x.slice(i - 80, i + 200), '\n 04', y.slice(i - 80, i + 200)); }
  }
};
for (const k of Object.keys(r.in05)) if (r.in05[k]) { await walk(await readZip(new Uint8Array(r.in05[k]), opts), await readZip(new Uint8Array(r.in04[k]), opts), k); }
console.log('done');
