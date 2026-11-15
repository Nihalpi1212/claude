// icc-engine's MODULES entry (ARCHITECTURE.md "0.5 features", package 4; S6): the colour engine of S6.1 registered
// with setColorEngine, LittleCMS 2 (lcms-wasm, vendored into src/renderer/vendor/lcms2/) behind it, and everything
// that makes documents carry a colour profile: adoption on open, the 'icc' chunk provider on save, the display stage
// over takeDamage and the view canvas's colour space, Edit > Assign Profile…, the conversions of S6.5 and the
// Preferences section `color-management`.
//
// Sync and async (S6.1): parse, transform().apply, decodeConversion, adoptOnOpen and displaySpace are synchronous and
// work before the wasm is there (matrix/TRC and Gray profiles convert in JavaScript, profiles.js reads the bytes);
// ready() resolves once LittleCMS is instantiated (or could not be), so LUT-based profiles convert from then on.
// Untagged and sRGB documents never reach a conversion: the display stage is inactive for them, the provider embeds
// nothing, and decodeConversion answers 'default' as 0.4 decoded.
import { setColorEngine, colorEngine, SRGB, profileOf, profilesList } from './pipeline.js';
import { builtinIcc, BUILTIN_DEFS, profileRecord, sha1Hex } from './profiles.js';
import { loadLcms } from './lcms.js';
import { makeTransform, sameSpace, convertRgb, rgbToLab, labToRgb, inGamut } from './transforms.js';
import { installDisplayStage } from './display.js';
import { ProfileLibrary } from './library.js';
import { decodeConversion, adoptOnOpen, installChunkProvider, describeProfile, assignProfileCommand } from './doc-profile.js';
import { rgbToLab as srgbToLab } from '../../../shared/pixels/color.js';

/** The built-in profiles (S6.1): sRGB (the pipeline's own record, no bytes) and the four generated ones. */
const BUILTINS = [
  SRGB,
  ...BUILTIN_DEFS.filter((d) => d.id !== 'srgb').map((d) => Object.freeze({ id: d.id, name: d.name, bytes: builtinIcc(d.id), colorSpace: d.space, wellKnown: d.wellKnown, source: 'builtin' })),
];
const P3 = BUILTINS.find((p) => p.id === 'display-p3');
const BY_SHA1 = new Map(BUILTINS.filter((p) => p.bytes).map((p) => [sha1Hex(p.bytes), p])); // a built-in's own bytes

const DISPLAY_SPACES = ['auto', 'srgb', 'display-p3'];

/** Whether the screen shows more than sRGB (Chromium answers from the display's own profile). */
const screenIsP3 = () => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(color-gamut: p3)').matches;
  } catch {
    return false;
  }
};

const isCanvas = (x) => x && typeof x.getContext === 'function';

/** Creates the engine of S6.1 for `app` (settings, presets) over `library`. */
export function createEngine({ app, library }) {
  let ready = false;
  let readyPromise = null;
  const pref = () => {
    const d = app?.settings?.colorManagement?.display;
    return DISPLAY_SPACES.includes(d) ? d : 'auto';
  };
  const p3Display = () => pref() === 'display-p3' || (pref() === 'auto' && screenIsP3());
  const byId = (id) => BUILTINS.find((p) => p.id === id) ?? library.get(id) ?? null;
  // a parsed record as the engine knows it: a built-in for a built-in's bytes, else the library's record
  const resolve = (rec) => BY_SHA1.get(rec.id) ?? library.remember(rec);

  const engine = {
    id: 'lcms2',
    available: true,
    get isReady() {
      return ready;
    },
    ready() {
      if (!readyPromise) {
        readyPromise = loadLcms()
          .catch(() => null)
          .then(() => {
            ready = true;
          });
      }
      return readyPromise;
    },
    parse(bytes) {
      const rec = profileRecord(bytes, 'embedded');
      return rec ? resolve(rec) : null;
    },
    builtins: () => BUILTINS.slice(),
    profiles: () => library.load(),
    profileById: byId,
    transform: (from, to, opts = {}) => makeTransform(from, to, opts),
    decodeConversion: (chunks) => decodeConversion(chunks),
    adoptOnOpen: (doc, info) => adoptOnOpen(doc, info ?? {}, { resolve }),
    /**
     * The view canvas's space (S6.4): sRGB for untagged, sRGB and Gray documents (the browser shows an sRGB canvas
     * correctly on any screen, at no cost); Display P3 for another RGB profile when the screen is P3 (or the
     * Preferences say so), so a wide-gamut document is not clipped to sRGB.
     */
    displaySpace(view) {
      if (pref() === 'srgb') return 'srgb';
      const p = view?.doc?.profile;
      if (!p || p.colorSpace !== 'rgb' || p.wellKnown === 'srgb') return 'srgb';
      return p3Display() ? 'display-p3' : 'srgb';
    },
    toLab(rgb, profile) {
      return rgbToLab(rgb, profile) ?? srgbToLab(rgb[0], rgb[1], rgb[2]);
    },
    fromLab(lab, profile) {
      return labToRgb(lab, profile) ?? convertRgb(labToRgb(lab, SRGB), SRGB, profile);
    },
    /** '#rrggbb' of the colour in sRGB; `color(display-p3 …)` for a colour sRGB cannot show on a P3 screen. */
    cssColor(rgb, profile) {
      const hex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
      if (sameSpace(profile, SRGB)) return hex(rgb);
      if (inGamut(rgb, profile, SRGB) === false && p3Display()) {
        const p = convertRgb(rgb, profile, P3);
        return `color(display-p3 ${p.map((v) => (v / 255).toFixed(4)).join(' ')})`;
      }
      return hex(convertRgb(rgb, profile, SRGB));
    },
    describe: (doc) => describeProfile(doc),
    /** A canvas or ImageData-like converted between profiles (Convert to sRGB, S6.5); a copy, the input untouched. */
    async convertCanvas(input, from, to, { intent = 'perceptual', bpc = true } = {}) {
      const t = makeTransform(from, to, { intent, bpc });
      if (t.identity || !input) return input;
      if (isCanvas(input)) {
        const out = document.createElement('canvas');
        out.width = input.width;
        out.height = input.height;
        const g = out.getContext('2d', { willReadFrequently: true });
        g.drawImage(input, 0, 0);
        const img = g.getImageData(0, 0, out.width, out.height);
        t.apply(img.data, img.data, out.width * out.height);
        g.putImageData(img, 0, 0);
        return out;
      }
      const data = new Uint8ClampedArray(input.data);
      t.apply(data, data, input.width * input.height);
      if (typeof ImageData === 'function' && input instanceof ImageData) return new ImageData(data, input.width, input.height);
      return { ...input, width: input.width, height: input.height, data };
    },
  };
  return engine;
}

// ---- Preferences: Color Management (E20, section `color-management`, order 46) -------------------------------------

function colorManagementSection(app, library) {
  const renderLibrary = () => {
    const box = document.createElement('div');
    box.className = 'cm-profiles';
    const draw = () => {
      box.replaceChildren();
      const users = library.userProfiles();
      const list = document.createElement('ul');
      list.className = 'cm-profile-list';
      if (!users.length) {
        const li = document.createElement('li');
        li.className = 'cm-empty';
        li.textContent = 'No profiles added yet.';
        list.appendChild(li);
      }
      for (const p of users) {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'cm-name';
        name.textContent = p.name;
        const space = document.createElement('span');
        space.className = 'cm-space';
        space.textContent = { rgb: 'RGB', gray: 'Gray', cmyk: 'CMYK', lab: 'Lab' }[p.colorSpace] ?? '';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'cm-remove';
        remove.textContent = 'Remove';
        remove.title = `Remove ${p.name} from Pigment's profiles`;
        remove.addEventListener('click', () => {
          library.removeUserProfile(p.id);
          draw();
        });
        li.append(name, space, remove);
        list.appendChild(li);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'cm-add';
      add.textContent = 'Add Profile…';
      add.addEventListener('click', async () => {
        const { bridge } = await import('../bridge.js');
        const paths = await bridge.openFileDialog({ multiple: true, title: 'Add Color Profile', filters: [{ name: 'ICC profiles', extensions: ['icc', 'icm'] }] });
        for (const path of paths ?? []) {
          try {
            const bytes = await bridge.readFile(path);
            await library.addUserProfile(bytes, String(path).split(/[\\/]/).pop());
          } catch (err) {
            app.dialogs?.alert(err?.message ?? String(err), { title: 'Add Color Profile' });
          }
        }
        draw();
      });
      box.append(list, add);
    };
    library.load().then(draw, draw);
    draw();
    return box;
  };
  return {
    id: 'color-management',
    title: 'Color Management',
    order: 46,
    fields: [
      {
        key: 'cmDisplay',
        label: 'Display',
        type: 'select',
        options: [
          ['auto', 'Automatic (as the screen reports)'],
          ['srgb', 'sRGB'],
          ['display-p3', 'Display P3'],
        ],
        help: 'Wide-gamut documents (Display P3, Adobe RGB, ProPhoto) are shown in Display P3 on a screen that has it; sRGB shows every document within sRGB.',
      },
      { label: 'Your profiles', type: 'custom', render: renderLibrary },
    ],
    read: (s) => ({ cmDisplay: DISPLAY_SPACES.includes(s.colorManagement?.display) ? s.colorManagement.display : 'auto' }),
    write(v, s) {
      const cur = s.colorManagement ?? {};
      const display = DISPLAY_SPACES.includes(v.cmDisplay) ? v.cmDisplay : 'auto';
      if (display === (cur.display ?? 'auto')) return {};
      return { colorManagement: { ...cur, display } };
    },
  };
}

// ---- install --------------------------------------------------------------------------------------------------------

export function install(app) {
  const library = new ProfileLibrary(app, BUILTINS);
  const engine = createEngine({ app, library });
  setColorEngine(engine);
  engine.ready();
  const isLive = () => colorEngine() === engine && engine.isReady;
  installChunkProvider();
  installDisplayStage({ p3: P3, isLive });

  app.commands.registerAll({
    'edit:assign-profile': {
      label: 'Assign Profile…',
      dialog: true,
      enabled: () => !!app.doc && app.doc.mode !== 'bitmap',
      run: (arg, ctx) => assignProfileCommand(app, arg, ctx, { profiles: () => library.load(), byId: engine.profileById }),
    },
  });
  app.preferences?.registerSection(colorManagementSection(app, library));

  // a view's canvas space follows its document's profile and the Preferences: tell the views (and the status bar, the
  // Info panel) when either changes
  const seen = new WeakMap(); // doc -> profile id last told
  const changed = () => app.emit?.('color:display-changed');
  app.on?.('doc:change', (e) => {
    const doc = e?.doc ?? app.doc;
    if (!doc || (e?.kind && e.kind !== 'props')) return;
    const id = doc.profile?.id ?? null;
    if (seen.has(doc) && seen.get(doc) === id) return;
    const first = !seen.has(doc);
    seen.set(doc, id);
    if (!first || id) changed();
  });
  app.on?.('doc:opened', (doc) => {
    // New Document and Duplicate set the profile right after the document is added: look once that task is over
    setTimeout(() => {
      if (!doc) return;
      const id = doc.profile?.id ?? null;
      if (seen.get(doc) === id) return;
      seen.set(doc, id);
      if (id) changed();
    }, 0);
  });
  app.on?.('settings:changed', (patch) => {
    if (patch && 'colorManagement' in patch) changed();
  });
  try {
    matchMedia('(color-gamut: p3)').addEventListener('change', changed);
  } catch {}
  // the user's and the system's profiles, once the start-up work is done; asking the pipeline's profilesList() then
  // makes it cache the library's live list, so the New Document list shows them (and profiles added later)
  setTimeout(() => library.load().then(() => profilesList()), 0);
  return { engine, library };
}

export { profileOf };
