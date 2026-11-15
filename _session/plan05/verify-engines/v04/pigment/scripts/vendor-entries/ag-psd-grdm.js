// The Gradient Map's interpolation method in PSD ('grdm' layer info), fixed in ag-psd's own handler registry.
//
// A grdm block of version 3 holds the method as a 4-character code right after the Reverse and Dither bytes:
// 'Gcls' (Classic), 'Perc' (Perceptual), 'Lnr ' (Linear), 'Smoo' (Smooth); version 1 has no method and is Classic.
// ag-psd 31 gets both ways wrong: its writer passes the method through the descriptor enum, which yields
// 'gradientInterpolationMethodType.Gcls' and throws on the 4-byte field, and its reader feeds the bare code to the
// same enum, which reads every code as Perceptual.
//
// The handler is wrapped, not rewritten, so everything else in the block stays ag-psd's: the reader runs as it is and
// the code is then taken from the bytes themselves (`methodCode`, the raw code, and `method`, its name); the writer
// writes a version 1 block and the code is put in after Dither, which makes it version 3. Pigment's PSD code
// (lib/io.js adjustmentToPsd / adjustmentFromPsd) only uses `methodCode`: an ag-psd without this fix ignores the
// field when writing (version 1, which Photoshop opens as Classic) and never sets it when reading (Classic).
//
// The bundle entry (ag-psd.js next to this file) imports this module, so scripts/build-vendor.mjs bundles the fix
// into src/renderer/vendor/ag-psd.js at every npm install; Node tests import it to fix the node_modules copy.
import { infoHandlersMap } from 'ag-psd/dist/additionalInfo.js';
import { writeZeros } from 'ag-psd/dist/psdWriter.js';

/** Pigment's interpolation names and the codes Photoshop writes for them. */
export const GRDM_METHOD_CODES = Object.freeze({ classic: 'Gcls', perceptual: 'Perc', linear: 'Lnr ', smooth: 'Smoo' });
const NAMES = Object.fromEntries(Object.entries(GRDM_METHOD_CODES).map(([k, v]) => [v, k]));

const code4 = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** Wraps the grdm handler once; true when the registry has the fix (also when it was already applied). */
export function patchGrdm(handlers = infoHandlersMap) {
  const h = handlers?.grdm;
  if (!h || typeof h.read !== 'function' || typeof h.write !== 'function') return false;
  if (h.pigmentMethod) return true;
  const { read, write } = h;
  h.read = (reader, target, left, ...rest) => {
    const at = reader.offset;
    const view = reader.view;
    // version (2 bytes), Reverse, Dither, then the code; the name that follows instead starts with a 0 byte (its
    // length's high byte), which is how ag-psd itself tells the two layouts apart
    let code = null;
    if (at + 8 <= view.byteLength && view.getUint16(at) === 3 && view.getUint8(at + 4) !== 0) code = code4(view, at + 4);
    read(reader, target, left, ...rest);
    const info = target.adjustment;
    if (info?.type === 'gradient map') {
      delete info.method;
      if (code) {
        info.methodCode = code;
        if (NAMES[code]) info.method = NAMES[code];
      }
    }
  };
  h.write = (writer, target, ...rest) => {
    const info = target.adjustment;
    const code = typeof info?.methodCode === 'string' && info.methodCode.length === 4 ? info.methodCode : GRDM_METHOD_CODES[info?.method] ?? null;
    // ag-psd writes version 1 (no method) when `method` is undefined
    const plain = { ...target, adjustment: { ...info, method: undefined } };
    const start = writer.offset;
    write(writer, plain, ...rest);
    if (!code) return;
    const end = writer.offset;
    writeZeros(writer, 4); // room for the code (the buffer may be replaced: read it afterwards)
    const bytes = new Uint8Array(writer.buffer);
    bytes.copyWithin(start + 8, start + 4, end);
    for (let i = 0; i < 4; i++) bytes[start + 4 + i] = code.charCodeAt(i) & 0xff;
    writer.view.setUint16(start, 3);
  };
  h.pigmentMethod = true;
  return true;
}

export const grdmPatched = patchGrdm();
