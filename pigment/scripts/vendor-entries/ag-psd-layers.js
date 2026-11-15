// psd-layers' fixes to ag-psd's layer handlers (ARCHITECTURE.md "0.5 features", S4.5), imported by ag-psd-fixes.js
// before anything reads or writes a PSD, so the browser bundle (scripts/build-vendor.mjs) and Node (package.json's
// "#ag-psd") always run with them. Each fix wraps a handler of ag-psd's `infoHandlersMap` the way ag-psd-grdm.js does
// (or adds one ag-psd lacks), is idempotent, and keeps everything else of the block ag-psd's.
//
// What ag-psd 31 gets wrong or leaves out, and what each fix does:
//
// - 'knko' (Blending Options > Knockout) is a byte 0 / 1 / 2 (None, Shallow, Deep); ag-psd reads it as a boolean.
//   The raw mode is kept as `knockoutMode` ('none' | 'shallow' | 'deep') next to ag-psd's `knockout`, and written back
//   when present.
// - 'brst' (channel blending restrictions: the channels the layer does not blend into) reads nothing for one or two
//   restricted channels: its loop wants more than 4 bytes left for each 4-byte entry. The read is redone.
// - 'vmgm' (Vector Mask Hides Effects) has no handler: one is added, the same layout as 'lmgm'
//   (`vectorMaskAsGlobalMask`).
// - 'lfx2' / 'lmfx' (layer effects): ag-psd parses the descriptor into its own effect objects and drops what it has no
//   field for (the Bevel's Contour and Texture depth and invert, contour corner points, the Pattern Overlay's angle,
//   the Stroke's Shape Burst style). The raw descriptor is kept as `effectsDescriptor` (read), and `effectsExtra`
//   (write) is merged into the descriptor ag-psd serialises: `{ [agPsdEffectName]: patch[] }`, one patch per
//   instance, each a set of raw descriptor keys (undefined removes a key). lib/psd/effects.js builds both sides.
//   ag-psd's descriptor writer types every value by its key from a private table, so a key it does not know (the
//   Bevel's 'textureDepth', 'InvT') would be written as an integer and throw: such a value is given as
//   `{ $type: 'UntF', units, value }` or `{ $type: 'bool', value }`, written under a placeholder key ag-psd types that
//   way, and the placeholder's bytes are renamed afterwards (descriptors hold no byte lengths, so the rename is safe).
// - The gradient style enum (GrdT) throws on Photoshop's Shape Burst ('GrdT.shapeburst', a Stroke effect's
//   gradient), which loses every effect of the layer: it reads as Linear here and lib/psd/effects.js takes the style
//   from the raw descriptor.
// - 'PtFl' and 'vscg' (pattern fill layers and shape fills): ag-psd drops the pattern's Scale and Angle, and its
//   writer throws on its own Link with Layer flag ('Lnkd', which its descriptor table types as an integer). Read keeps
//   Scale and Angle as `scale` (a fraction) and `angle` (degrees) on the vector content; write puts them back and
//   writes 'Lnkd' as the boolean Photoshop reads. (A stroke's pattern content and the Stroke effect's pattern have
//   the same 'Lnkd' problem: lib/psd/vector.js leaves the flag out of a shape stroke's content, and lib/psd/effects.js
//   gives the Stroke effect's flag as a typed extra.)
// - 'GdFl' and 'vscg' (gradient fill layers and shape fills): ag-psd rounds the gradient's Scale and Offset to whole
//   percents; they are written as the floats Photoshop keeps.
import { infoHandlers, infoHandlersMap } from 'ag-psd/dist/additionalInfo.js';
import { readVersionAndDescriptor, writeVersionAndDescriptor, serializeEffects, serializeVectorContent, GrdT } from 'ag-psd/dist/descriptor.js';
import { readUint8, readUint32, readInt32, skipBytes } from 'ag-psd/dist/psdReader.js';
import { writeUint8, writeUint32, writeZeros, writeSignature, createWriter, getWriterBuffer, writeBytes } from 'ag-psd/dist/psdWriter.js';

const KNOCKOUT = ['none', 'shallow', 'deep'];

/** ag-psd's effect names -> the descriptor keys of one instance and of several (lib/psd/effects.js has the same table). */
export const EFFECT_DESCRIPTOR_KEYS = Object.freeze({
  dropShadow: ['DrSh', 'dropShadowMulti'],
  innerShadow: ['IrSh', 'innerShadowMulti'],
  outerGlow: ['OrGl', null],
  innerGlow: ['IrGl', null],
  bevel: ['ebbl', null],
  solidFill: ['SoFi', 'solidFillMulti'],
  patternOverlay: ['patternFill', null],
  gradientOverlay: ['GrFl', 'gradientFillMulti'],
  satin: ['ChFX', null],
  stroke: ['FrFX', 'frameFXMulti'],
});

function patchKnockout(h) {
  if (!h || h.pigmentKnockout) return !!h;
  const { read, write } = h;
  h.read = (reader, target, left, ...rest) => {
    const v = reader.offset < reader.view.byteLength ? reader.view.getUint8(reader.offset) : 0;
    read(reader, target, left, ...rest);
    target.knockoutMode = KNOCKOUT[v] ?? (v ? 'shallow' : 'none');
  };
  h.write = (writer, target, ...rest) => {
    const at = KNOCKOUT.indexOf(target.knockoutMode);
    if (at < 0) return write(writer, target, ...rest);
    writeUint8(writer, at);
    writeZeros(writer, 3);
  };
  h.pigmentKnockout = true;
  return true;
}

function patchRestrictions(h) {
  if (!h || h.pigmentRestrictions) return !!h;
  h.read = (reader, target, left) => {
    target.channelBlendingRestrictions = [];
    while (left() >= 4) target.channelBlendingRestrictions.push(readInt32(reader));
    if (left() > 0) skipBytes(reader, left());
  };
  h.pigmentRestrictions = true;
  return true;
}

function addVectorMaskHidesEffects() {
  if (infoHandlersMap.vmgm) return true;
  const handler = {
    key: 'vmgm',
    has: (target) => target.vectorMaskAsGlobalMask !== undefined,
    read: (reader, target, left) => {
      target.vectorMaskAsGlobalMask = !!readUint8(reader);
      skipBytes(reader, left());
    },
    write: (writer, target) => {
      writeUint8(writer, target.vectorMaskAsGlobalMask ? 1 : 0);
      writeZeros(writer, 3);
    },
  };
  // the writer walks this list in order: right after 'lmgm', as Photoshop writes them
  const at = infoHandlers.findIndex((x) => x.key === 'lmgm');
  infoHandlers.splice(at >= 0 ? at + 1 : infoHandlers.length, 0, handler);
  infoHandlersMap.vmgm = handler;
  return true;
}

/** Merges `extra` ({ name: patch[] }) into a serialised effects descriptor. */
function mergeEffectsExtra(desc, effects, extra) {
  for (const [name, patches] of Object.entries(extra ?? {})) {
    const keys = EFFECT_DESCRIPTOR_KEYS[name];
    if (!keys || !Array.isArray(patches)) continue;
    const many = Array.isArray(effects?.[name]) && effects[name].length > 1 && keys[1];
    const objs = many ? desc[keys[1]] : desc[keys[0]] ? [desc[keys[0]]] : [];
    patches.forEach((patch, i) => {
      const obj = objs?.[i];
      if (!obj || !patch) return;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete obj[k];
        else obj[k] = v;
      }
    });
  }
  return desc;
}

// keys ag-psd's writer already types as UntF / bool and that never occur in an effects descriptor
const PLACEHOLDERS = { UntF: ['Rslt', 'Shrp', 'ClNs'], bool: ['Mnch', 'GpuY', 'LIWy', 'ExtF', 'ExtM'] };

/** Replaces typed values by placeholder keys (in place); returns the real key of each placeholder, in write order. */
function typedKeys(value, renames = []) {
  if (Array.isArray(value)) {
    for (const v of value) typedKeys(v, renames);
    return renames;
  }
  if (!value || typeof value !== 'object') return renames;
  const used = { UntF: 0, bool: 0 };
  for (const key of Object.keys(value)) {
    const v = value[key];
    if (v && typeof v === 'object' && typeof v.$type === 'string' && PLACEHOLDERS[v.$type]) {
      const ph = PLACEHOLDERS[v.$type][used[v.$type]++];
      delete value[key];
      if (!ph) continue; // more typed keys in one object than placeholders: dropped
      value[ph] = v.$type === 'bool' ? !!v.value : { units: v.units ?? 'Percent', value: Number(v.value) || 0 };
      renames.push([ph, key]);
    }
  }
  // the writer walks keys in order: placeholders were appended last, children before them in key order
  for (const key of Object.keys(value)) {
    if (renames.some(([ph]) => ph === key)) continue;
    typedKeys(value[key], renames);
  }
  return renames;
}

const keyBytes = (key) => {
  const out = [];
  const push32 = (n) => out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  push32(key.length === 4 ? 0 : key.length);
  for (let i = 0; i < key.length; i++) out.push(key.charCodeAt(i) & 255);
  return out;
};

/** Writes a version-16 descriptor whose typed values were placed under placeholders, with the real keys put back. */
function writeTypedDescriptor(writer, desc) {
  const renames = typedKeys(desc);
  if (!renames.length) return writeVersionAndDescriptor(writer, '', 'null', desc);
  const tmp = createWriter(1024);
  writeVersionAndDescriptor(tmp, '', 'null', desc);
  let bytes = Array.from(new Uint8Array(getWriterBuffer(tmp)));
  let from = 0;
  for (const [ph, key] of renames) {
    const pat = keyBytes(ph);
    let at = -1;
    for (let i = from; i <= bytes.length - pat.length; i++) {
      let ok = true;
      for (let j = 0; j < pat.length && ok; j++) ok = bytes[i + j] === pat[j];
      if (ok) {
        at = i;
        break;
      }
    }
    if (at < 0) continue;
    const real = keyBytes(key);
    bytes = bytes.slice(0, at).concat(real, bytes.slice(at + pat.length));
    from = at + real.length;
  }
  writeBytes(writer, new Uint8Array(bytes));
}

function patchEffects(h) {
  if (!h || h.pigmentEffects) return !!h;
  const { read, write } = h;
  h.read = (reader, target, left, ...rest) => {
    const start = reader.offset;
    read(reader, target, left, ...rest);
    const end = reader.offset;
    try {
      reader.offset = start;
      readUint32(reader); // version
      target.effectsDescriptor = readVersionAndDescriptor(reader);
    } catch {
      target.effectsDescriptor = undefined;
    }
    reader.offset = end;
  };
  h.write = (writer, target, psd, options, ...rest) => {
    if (!target.effectsExtra) return write(writer, target, psd, options, ...rest);
    const desc = serializeEffects(target.effects, !!options?.logMissingFeatures, true);
    mergeEffectsExtra(desc, target.effects, target.effectsExtra);
    writeUint32(writer, 0); // version
    writeTypedDescriptor(writer, desc);
  };
  h.pigmentEffects = true;
  return true;
}

// pattern Scale and Angle of a vector content descriptor
const readPatternExtras = (desc, content) => {
  if (!content || content.type !== 'pattern' || !desc) return;
  const scale = desc['Scl '];
  if (scale && typeof scale.value === 'number') content.scale = scale.value / 100;
  const angle = desc.Angl;
  if (angle && typeof angle.value === 'number') content.angle = angle.value;
};
const writePatternExtras = (descriptor, content) => {
  if (content?.type !== 'pattern') return descriptor;
  if (Number.isFinite(content.scale)) descriptor['Scl '] = { units: 'Percent', value: content.scale * 100 };
  if (Number.isFinite(content.angle)) descriptor.Angl = { units: 'Angle', value: content.angle };
  return descriptor;
};

// a gradient's Scale and Offset as the floats Photoshop keeps (ag-psd rounds them to whole percents)
const writeGradientExtras = (descriptor, content) => {
  if (!content || (content.type !== 'solid' && content.type !== 'noise')) return descriptor;
  if (Number.isFinite(content.scale)) descriptor['Scl '] = { units: 'Percent', value: content.scale * 100 };
  if (content.offset && Number.isFinite(content.offset.x) && Number.isFinite(content.offset.y)) descriptor.Ofst = { Hrzn: { units: 'Percent', value: content.offset.x * 100 }, Vrtc: { units: 'Percent', value: content.offset.y * 100 } };
  return descriptor;
};

function patchGradientFill(h) {
  if (!h || h.pigmentGradient) return !!h;
  const { write } = h;
  h.write = (writer, target, ...rest) => {
    const vf = target.vectorFill;
    if (vf?.type !== 'solid' && vf?.type !== 'noise') return write(writer, target, ...rest);
    const { descriptor } = serializeVectorContent(vf);
    writeVersionAndDescriptor(writer, '', 'null', writeGradientExtras(descriptor, vf));
  };
  h.pigmentGradient = true;
  return true;
}

function patchPatternFill(h, { signature }) {
  if (!h || h.pigmentPattern) return !!h;
  const { read, write } = h;
  h.read = (reader, target, left, ...rest) => {
    const start = reader.offset;
    read(reader, target, left, ...rest);
    const end = reader.offset;
    if (target.vectorFill?.type === 'pattern') {
      try {
        reader.offset = start + (signature ? 4 : 0);
        readPatternExtras(readVersionAndDescriptor(reader), target.vectorFill);
      } catch {
        // ag-psd's own read stands
      }
    }
    reader.offset = end;
  };
  h.write = (writer, target, ...rest) => {
    const vf = target.vectorFill;
    if (signature && (vf?.type === 'solid' || vf?.type === 'noise')) {
      const { descriptor, key } = serializeVectorContent(vf);
      writeSignature(writer, key);
      writeVersionAndDescriptor(writer, '', 'null', writeGradientExtras(descriptor, vf));
      return;
    }
    if (vf?.type !== 'pattern') return write(writer, target, ...rest);
    // ag-psd types 'Lnkd' as an integer and cannot write its own boolean: typed through a placeholder
    const { descriptor, key } = serializeVectorContent({ ...vf, linked: undefined });
    if (vf.linked !== undefined) descriptor.Lnkd = { $type: 'bool', value: !!vf.linked };
    if (signature) writeSignature(writer, key);
    writeTypedDescriptor(writer, writePatternExtras(descriptor, vf));
  };
  h.pigmentPattern = true;
  return true;
}

function patchGradientStyle(e) {
  if (!e || typeof e.decode !== 'function') return false;
  if (e.pigmentShapeBurst) return true;
  const { decode } = e;
  e.decode = (val) => {
    try {
      return decode(val);
    } catch (err) {
      if (/shapeburst|Shpb/i.test(String(val))) return 'linear';
      throw err;
    }
  };
  e.pigmentShapeBurst = true;
  return true;
}

function patchAll() {
  const m = infoHandlersMap;
  const results = [
    patchGradientStyle(GrdT),
    patchKnockout(m.knko),
    patchRestrictions(m.brst),
    addVectorMaskHidesEffects(),
    patchEffects(m.lfx2),
    patchEffects(m.lmfx),
    patchGradientFill(m.GdFl),
    patchPatternFill(m.PtFl, { signature: false }),
    patchPatternFill(m.vscg, { signature: true }),
  ];
  return results.every(Boolean);
}

/** True once every fix above is applied (ag-psd-fixes.js reports it as `fixesPatched.layers`). */
export const patched = patchAll();
