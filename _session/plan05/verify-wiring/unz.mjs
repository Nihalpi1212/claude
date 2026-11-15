import { readZip } from '/home/user/claude/pigment/src/shared/zip.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
const opts = { inflate: async (d) => new Uint8Array(zlib.inflateRawSync(d)) };
const r = JSON.parse(fs.readFileSync('rewrites.json'));
for (const k of Object.keys(r.in05)) {
  if (!r.in05[k]) continue;
  const a = await readZip(new Uint8Array(r.in05[k]), opts), b = await readZip(new Uint8Array(r.in04[k]), opts), o = await readZip(new Uint8Array(r.orig[k]), opts);
  const names = (z) => z.map((e) => e.name);
  const get = (z, n) => z.find((e) => e.name === n)?.data;
  const na = names(a), nb = names(b);
  const diffs = [];
  for (const n of new Set([...na, ...nb])) {
    const x = get(a, n), y = get(b, n);
    const bx = x ? Buffer.from(x) : null, by = y ? Buffer.from(y) : null;
    if (!bx || !by || !bx.equals(by)) diffs.push(n + (n.endsWith('.json') && bx && by ? `\n  05: ${bx.toString().slice(0, 1500)}\n  04: ${by.toString().slice(0, 1500)}` : ` (${bx?.length} vs ${by?.length})`));
  }
  console.log(k, 'entries', na.length, nb.length, 'diff:', diffs.length ? diffs.join('\n') : 'none');
}
