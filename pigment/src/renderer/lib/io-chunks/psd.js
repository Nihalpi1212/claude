// PSD / PSB image resources (ARCHITECTURE.md "0.5 features", S5), skeleton file. ICC: resource 1039; EXIF: 1058; XMP:
// 1060; IPTC: 1028; resolution: 1005 (ResolutionInfo). Writing rebuilds the image resource section (the other
// resources kept in their order, new ones at the end) and keeps the header, the colour mode data, the layers and the
// image data byte for byte. Read and written at the byte level, not through ag-psd.
import { ascii, concat, be32, u32be, fromUtf8, utf8, copyBytes, touches, parseResources, writeResources, setResource, resolutionFromPsd, resolutionToPsd } from './bytes.js';

export const support = { read: ['icc', 'exif', 'xmp', 'iptc', 'resolution'], write: ['icc', 'exif', 'xmp', 'iptc', 'resolution'] };

const ID = { icc: 1039, exif: 1058, xmp: 1060, iptc: 1028, resolution: 1005 };

/** { start, end } of the resource blocks (after the section's length field). */
function section(b, onDamage = null) {
  if (ascii(b, 0, 4) !== '8BPS') throw new Error('Not a PSD file');
  const modeLen = u32be(b, 26);
  const at = 26 + 4 + modeLen;
  if (at + 4 > b.length) throw new Error('PSD is truncated');
  const len = u32be(b, at);
  if (at + 4 + len > b.length) {
    // a reader keeps the resources that are in the file (S5)
    if (!onDamage) throw new Error('PSD image resources are truncated');
    onDamage();
    return { lenAt: at, start: at + 4, end: b.length };
  }
  return { lenAt: at, start: at + 4, end: at + 4 + len };
}

export function read(b) {
  let damaged = false;
  const onDamage = () => (damaged = true);
  const { start, end } = section(b, onDamage);
  const list = parseResources(b, start, end, onDamage);
  const get = (id) => list.find((r) => r.id === id)?.data;
  const out = {};
  if (get(ID.icc)) out.icc = copyBytes(get(ID.icc));
  if (get(ID.exif)) out.exif = copyBytes(get(ID.exif));
  if (get(ID.xmp)) out.xmp = fromUtf8(get(ID.xmp));
  if (get(ID.iptc)) out.iptc = copyBytes(get(ID.iptc));
  const res = resolutionFromPsd(get(ID.resolution));
  if (res) out.resolution = res;
  return damaged ? { ...out, damaged: true } : out;
}

export function write(b, patch) {
  const { lenAt, start, end } = section(b);
  let list = parseResources(b, start, end);
  if (touches(patch, 'icc')) list = setResource(list, ID.icc, patch.icc?.length ? patch.icc : null);
  if (touches(patch, 'exif')) list = setResource(list, ID.exif, patch.exif?.length ? patch.exif : null);
  if (touches(patch, 'xmp')) list = setResource(list, ID.xmp, patch.xmp ? utf8(patch.xmp) : null);
  if (touches(patch, 'iptc')) list = setResource(list, ID.iptc, patch.iptc?.length ? patch.iptc : null);
  if (touches(patch, 'resolution')) list = setResource(list, ID.resolution, patch.resolution ? resolutionToPsd(patch.resolution) : null);
  const blocks = writeResources(list);
  return concat([b.subarray(0, lenAt), be32(blocks.length), blocks, b.subarray(end)]);
}
