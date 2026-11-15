const C = await import('/home/user/claude/pigment/src/renderer/lib/io-chunks.js');
const png = await import('/home/user/claude/pigment/src/shared/pixels/png.js');
console.log(Object.keys(png).join(' '));
const w = 4, h = 3, data = new Uint8ClampedArray(w * h * 4).fill(200);
const bytes = await (png.encodeRgba8 ?? png.encodePng)({ width: w, height: h, data });
const icc = new Uint8Array(70000).map((_, i) => (i * 7) & 255);
const same = await C.writeChunks(bytes, 'png', {});
console.log('empty patch same object:', same === bytes);
const withIcc = await C.writeChunks(bytes, 'png', { icc, xmp: '<x:xmpmeta/>', resolution: { x: 300, y: 300, unit: 'in' } });
const back = await C.readChunks(withIcc, 'png');
console.log('png icc roundtrip', back.icc?.length, Buffer.compare(Buffer.from(back.icc), Buffer.from(icc)) === 0, 'xmp', back.xmp, 'res', JSON.stringify(back.resolution));
const removed = await C.writeChunks(withIcc, 'png', { icc: null });
console.log('png icc removed', (await C.readChunks(removed, 'png')).icc ?? 'none', 'decodes:', !!(await png.decodePng(removed)));
console.log('damaged', JSON.stringify(await C.readChunks(withIcc.slice(0, 60), 'png')), JSON.stringify(await C.readChunks(new Uint8Array([1,2,3]), 'png')));
// a minimal baseline JPEG: SOI, APP0 JFIF, ... take a tiny real JPEG from fixtures if present
import { readdirSync, readFileSync } from 'node:fs';
const fx = '/home/user/claude/pigment/tests/fixtures';
const find = (dir, re) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = `${dir}/${f.name}`; if (f.isDirectory()) { const r = find(p, re); if (r) return r; } else if (re.test(f.name)) return p; } return null; };
const jpgPath = find(fx, /\.jpe?g$/i);
console.log('jpeg fixture', jpgPath);
if (jpgPath) {
  const jb = new Uint8Array(readFileSync(jpgPath));
  const j2 = await C.writeChunks(jb, 'jpeg', { icc });
  const jr = await C.readChunks(j2, 'jpeg');
  let segs = 0; for (let i = 0; i < j2.length - 14; i++) if (j2[i] === 0xff && j2[i + 1] === 0xe2 && String.fromCharCode(...j2.subarray(i + 4, i + 15)) === 'ICC_PROFILE') segs++;
  console.log('jpeg icc', jr.icc?.length, Buffer.compare(Buffer.from(jr.icc), Buffer.from(icc)) === 0, 'APP2 segments', segs);
}
console.log('formatFor', ['a.JPG','x.psb','png16','tif','gif','webp'].map(C.chunkFormatFor).join(','));
console.log('support', JSON.stringify(['jpeg','png','webp','tiff','psd'].map((f) => [f, C.chunkSupport(f)])));
