// The document profile (icc-engine, ARCHITECTURE.md "0.5 features", package 4; S6.2, S6.3, S6.6, S6.7): which
// embedded profile a document adopts on open, what the 'icc' chunk provider embeds on save, Edit > Assign Profile…,
// and the description the status bar and the Info panel show.
//
// Adoption (S6.3): decodeConversion answers 'none' exactly when the embedded profile is adopted, so the browser hands
// over the numbers as stored and nothing is converted twice. Untagged files, files whose profile does not parse and
// sRGB-tagged files decode as 0.4 decoded them ('default'); an sRGB-tagged file is recorded as sRGB (the built-in, no
// bytes), so it saves byte-identical to 0.4. A CMYK or Lab profile is not adopted (0.3's conversion stands, S6.7) and
// an open notice says so.
import { SRGB, assignProfile, profileOf } from './pipeline.js';
import { profileRecord, parseIcc, writeIcc, BUILTIN_DEFS } from './profiles.js';
import { registerChunkProvider } from '../io-chunks.js';

// ---- adoption ----------------------------------------------------------------------------------------------------------

/** What an embedded profile means for the file it is in: { action: 'adopt' | 'srgb' | 'ignore' | 'notice', profile }. */
export function embeddedPolicy(icc, { resolve } = {}) {
  if (!icc?.length) return { action: 'ignore', profile: null };
  const rec = profileRecord(icc, 'embedded');
  if (!rec) return { action: 'ignore', profile: null };
  // the same bytes as a built-in are that built-in (Pigment's own files reopen as 'display-p3', not as a SHA-1)
  const profile = resolve?.(rec) ?? rec;
  if (profile.colorSpace === 'cmyk' || profile.colorSpace === 'lab') return { action: 'notice', profile };
  if (profile.colorSpace !== 'rgb' && profile.colorSpace !== 'gray') return { action: 'ignore', profile };
  if (profile.wellKnown === 'srgb' && profile.colorSpace === 'rgb') return { action: 'srgb', profile };
  return { action: 'adopt', profile };
}

/** engine.decodeConversion (S6.3): 'none' exactly when adoptOnOpen adopts the embedded profile. */
export function decodeConversion(chunks) {
  return embeddedPolicy(chunks?.icc).action === 'adopt' ? 'none' : 'default';
}

/** engine.adoptOnOpen (S6.3): the embedded profile becomes `doc.profile` when the numbers were kept as stored. */
export function adoptOnOpen(doc, { chunks, conv }, { resolve } = {}) {
  if (!doc) return;
  const { action, profile } = embeddedPolicy(chunks?.icc, { resolve });
  if (doc.mode === 'bitmap') return; // S6.7: no profile
  if (action === 'notice') {
    const kind = profile.colorSpace === 'cmyk' ? 'CMYK' : 'Lab';
    doc.openNotices = [...(doc.openNotices ?? []), `The embedded ${kind} profile “${profile.name}” was not used: Pigment converted the colours as it always has.`];
    return;
  }
  if (action === 'srgb') {
    doc.profile = SRGB;
    return;
  }
  // the numbers are the file's own only when the decoder was asked not to convert (or the reader never converts:
  // TIFF, PSD, 16-bit PNG and GIF readers decode themselves; they were handed 'none' as well)
  if (action === 'adopt' && conv === 'none') doc.profile = profile;
}

// ---- saving: the 'icc' provider (S5, S6.3) -------------------------------------------------------------------------------

const rgbOfGray = new Map(); // gray profile id -> its RGB equivalent's bytes

/**
 * Every file Pigment writes holds RGB numbers, and an RGB file cannot carry a Gray profile (PNG, JPEG, WebP, TIFF and
 * PSD readers ignore or reject it). A Gray-tagged document is saved with the RGB equivalent: sRGB's primaries and
 * the Gray profile's tone curve on every channel, which shows the document's tones exactly as the Gray profile does.
 */
export function rgbEquivalentOfGray(profile) {
  if (rgbOfGray.has(profile.id)) return rgbOfGray.get(profile.id);
  const parsed = parseIcc(profile.bytes);
  const trc = parsed?.curves?.[0];
  let bytes = null;
  if (trc && trc.kind !== 'identity') {
    const srgb = BUILTIN_DEFS[0];
    bytes = writeIcc({ name: `${profile.name} (RGB)`, space: 'rgb', primaries: srgb.primaries, white: srgb.white, trc });
  }
  rgbOfGray.set(profile.id, bytes);
  return bytes;
}

/** What the 'icc' provider embeds for a document: its profile's bytes, or nothing (untagged, sRGB, converted to sRGB). */
export function embeddedBytes(doc, opts = {}) {
  const p = doc?.profile;
  if (!p?.bytes?.length || opts?.embedProfile === false || opts?.convertTo === 'srgb') return null;
  if (p.colorSpace === 'gray') return rgbEquivalentOfGray(p);
  if (p.colorSpace !== 'rgb') return null;
  return p.bytes;
}

export function installChunkProvider() {
  return registerChunkProvider({
    id: 'icc',
    order: 100,
    kinds: ['icc'],
    provide(doc, { opts }) {
      const icc = embeddedBytes(doc, opts);
      return icc ? { icc } : null;
    },
  });
}

// ---- the description (S6.5, S6.6) ----------------------------------------------------------------------------------------

/** "Untagged RGB", or the profile's name with the depth when it is not 8 bits: "Display P3 (16bpc)". */
export function describeProfile(doc) {
  if (!doc) return '';
  const depth = doc.depth && doc.depth !== 8 ? ` (${doc.depth}bpc)` : '';
  if (doc.mode === 'bitmap') return '';
  if (!doc.profile) return `Untagged RGB${depth}`;
  return `${doc.profile.name}${depth}`;
}

// ---- Edit > Assign Profile… (S13.3: `{ profile: id | null }`) ----------------------------------------------------------------

/** The profiles Assign Profile offers for a document: RGB profiles, and Gray ones for Grayscale and Duotone documents. */
export function assignable(list, doc) {
  const grey = doc?.mode === 'grayscale' || doc?.mode === 'duotone';
  return list.filter((p) => p.colorSpace === 'rgb' || (p.colorSpace === 'gray' && grey));
}

/**
 * Runs Assign Profile: `arg.profile` is a profile id, or null for "Don't Color Manage This Document"; without an
 * argument the dialog asks. One history entry, "Assign Profile"; the numbers stay as they are.
 */
export async function assignProfileCommand(app, arg, ctx, { profiles, byId }) {
  const doc = app.doc;
  if (!doc) return false;
  let id;
  if (arg && typeof arg === 'object' && 'profile' in arg) id = arg.profile ?? null;
  else {
    const list = assignable(await profiles(), doc);
    const current = doc.profile;
    const working = SRGB;
    const choice = current ? (current.id === working.id ? 'working' : 'profile') : 'none';
    const options = list.filter((p) => p.id !== working.id).map((p) => [p.id, p.name]);
    // a document's own embedded profile is offered even when the library does not hold it
    if (current && current.id !== working.id && !options.some(([pid]) => pid === current.id)) options.unshift([current.id, current.name]);
    const { formDialog } = await import('../form.js'); // the dialog's code (this file stays Node-safe)
    const values = await formDialog(app, {
      title: 'Assign Profile',
      intro: 'Assigning a profile changes how the numbers are shown and printed; it does not change them.',
      fields: [
        { key: 'choice', type: 'select', label: 'Assign', options: [['none', "Don't Color Manage This Document"], ['working', `Working RGB: ${working.name}`], ['profile', 'Profile']], value: choice },
        { key: 'profile', type: 'select', label: 'Profile', options, value: current && current.id !== working.id ? current.id : options[0]?.[0], when: (v) => v.choice === 'profile' },
      ],
    });
    if (!values) {
      ctx?.cancel?.();
      return false;
    }
    id = values.choice === 'none' ? null : values.choice === 'working' ? working.id : values.profile ?? null;
    ctx?.setReplayArg?.({ profile: id });
  }
  const profile = id == null ? null : id === SRGB.id ? SRGB : byId(id);
  if (id != null && !profile) throw new Error('That colour profile is not installed.');
  if (profile && !assignable([profile], doc).length) throw new Error(`“${profile.name}” cannot be assigned to this document: it is not an RGB profile.`);
  return assignProfile(app, doc, profile, 'Assign Profile');
}

export { profileOf };
