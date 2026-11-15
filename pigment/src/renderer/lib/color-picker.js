// The colour picker (ARCHITECTURE.md "0.5 features", S7; color-picker-swatches' MODULES entry, package 11). Every colour
// the user chooses goes through app.colorPicker:
//   app.colorPicker.pick({ initial: ColorValue | '#rrggbb', title?, live?(c), doc?, target?, allowBooks? }) -> Promise<ColorValue | null>
//   app.colorPicker.hud({ at, tool, initial }) -> HudSession { move(p), up(p), cancel(), done: Promise<ColorValue | null> }
//   app.pickColor(initial, { title, live, target = 'field' }) -> Promise<'#rrggbb' | null>   (0.4's API, kept: pick()
//     returning hex; a call without a target is a field's)
//   swatchColors(app) -> '#rrggbb'[]                                       (the shape paint popover's swatch row)
// ColorValue: { hex, rgb: [r, g, b], lab?, cmyk?, book: { book, name } | null, space: 'rgb' | 'hsb' | 'lab' | 'cmyk' | 'book' }.
//
// The picker is Photoshop's: a field and a strip for any of nine axes (the radio buttons beside H S B, R G B, L a b),
// HSB / RGB / Lab / CMYK / hex fields, new and current colours, Only Web Colors, the out-of-gamut (printing) and
// not-web-safe warnings (a click takes the nearest colour that is), Add to Swatches, Color Libraries, sampling the
// image under the dialog (the Eyedropper's Sample Size and Sample) or anywhere on the screen (window.EyeDropper,
// converted from sRGB into the document's profile). Lab goes through the colour pipeline (lib/color/pipeline.js), so
// it is icc-engine's D50 Lab of the document's profile once that engine is ready. S7.4's DOM is kept (class
// color-picker-dialog, [data-f="h|s|v|r|g|b|hex"], [data-m="L|a|b|c|m|y|k"], OK as .dialog-buttons .btn.primary; a field
// commits on blur and change).
//
// This module also registers the real `color` field widget (S7.3), the kinds `swatches` (with groups, S7.2) and
// `color-books`, the .acb format (lib/color-libraries.js), the Preferences section `color-picker` (order 25), and
// migrates 0.4's edited palette (settings.swatches) into `swatches` once (settings.colorUI.swatchesMigrated).
import { icon, registerIcons } from './icons.js';
import { normHex } from './panels/color.js';
import { parseColor, rgbaToHex, rgbToCmyk, cmykToRgb, labToRgb, isOutOfCmykGamut } from '../../shared/pixels/color.js';
import { DEFAULT_SWATCHES, DEFAULT_SETTINGS } from '../../shared/defaults.js';
import { registerPresetKind } from './presets.js';
import { registerWidget } from './fields.js';
import { SRGB, toLab, fromLab, convertColor } from './color/pipeline.js';
import * as M from './color-picker-model.js';
import { createAxisPicker } from './panels/color-views.js';
import { createHudSession } from './hud-picker.js';
import { colorLibrariesDialog, registerColorBooks, bookEntryValue } from './color-libraries.js';

registerIcons({
  'web-cube': '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  'color-book': '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M9 8h6"/>',
});

/** A ColorValue (S7.1) for an RGB hex. */
export function colorValue(hex) {
  const h = normHex(hex);
  const [r, g, b] = parseColor(h);
  return { hex: h, rgb: [r, g, b], book: null, space: 'rgb' };
}

const hexOf = (initial, fallback) => normHex(typeof initial === 'string' ? initial : initial?.hex ?? fallback);

/** The Lab conversions of a document's profile (the pipeline's: icc-engine's numbers once it is ready). */
export function convFor(doc) {
  const profile = doc?.profile ?? null;
  return {
    toLab: (rgb) => toLab(rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), profile),
    fromLab: (lab) => fromLab(lab, profile),
  };
}

/**
 * '#rrggbb' of a `swatches` preset's colour (S7.2: rgb 0..255, lab L 0..100 a b -128..127, cmyk and gray 0..100).
 * Lab goes through fromLab(lab, profile) (S6.5); without a profile argument the 0.4 sRGB maths as the stub did.
 */
export function swatchHex(data, profile) {
  const c = data?.color;
  const v = Array.isArray(c?.values) ? c.values.map(Number) : null;
  if (!v || v.some((x) => !Number.isFinite(x))) return null;
  const hex = (rgb) => rgbaToHex(rgb.map((x) => Math.max(0, Math.min(255, Math.round(x)))));
  if (c.space === 'rgb') return hex(v.slice(0, 3));
  if (c.space === 'lab') return hex(profile === undefined ? labToRgb(v[0], v[1], v[2]) : fromLab(v.slice(0, 3), profile));
  if (c.space === 'cmyk') return hex(cmykToRgb(v[0], v[1], v[2], v[3]));
  if (c.space === 'gray') return hex([0, 0, 0].map(() => 255 * (1 - v[0] / 100))); // gray is ink: 0 % white
  return null;
}

/**
 * The swatches as hex (the shape paint popover's row): the `swatches` kind once 0.4's palette is migrated into it
 * (settings.colorUI.swatchesMigrated), else 0.4's settings.swatches (when edited or non-empty) or DEFAULT_SWATCHES.
 */
export function swatchColors(app) {
  if (app?.settings?.colorUI?.swatchesMigrated && app.presets) {
    try {
      return app.presets.list('swatches').map((p) => swatchHex(p.data, app.doc?.profile ?? null)).filter(Boolean);
    } catch (err) {
      console.warn('swatches kind not readable', err);
    }
  }
  const s = app?.settings?.swatches;
  const list = Array.isArray(s) && (app.settings.swatchesEdited || s.length) ? s : DEFAULT_SWATCHES;
  return list.map((c) => normHex(typeof c === 'string' ? c : c?.color ?? '#000000'));
}

/** Adds a colour (hex or ColorValue) to the `swatches` kind; resolves the new preset. */
export async function addSwatch(app, value, { name = null, group = null } = {}) {
  await app.presets.ready('swatches');
  const c = typeof value === 'string' ? colorValue(value) : value;
  const data = M.swatchFromColorValue(c) ?? M.swatchFromHex(c.hex);
  return app.presets.add('swatches', { name: name ?? c.book?.name ?? c.hex, data, group });
}

/** settings.colorUI with its defaults. */
export const colorUI = (app) => ({ ...DEFAULT_SETTINGS.colorUI, ...(app.settings.colorUI ?? {}) });
export function saveColorUI(app, patch) {
  app.saveSettingsSoon({ colorUI: { ...colorUI(app), ...patch } });
}

// ---- the picker dialog ---------------------------------------------------------------------------------------------

const FIELD_ROWS = [
  ['h', 'H', 'Hue (degrees)', 0, 360, '°'],
  ['s', 'S', 'Saturation (%)', 0, 100, '%'],
  ['v', 'B', 'Brightness (%)', 0, 100, '%'],
  ['r', 'R', 'Red (0–255)', 0, 255, ''],
  ['g', 'G', 'Green (0–255)', 0, 255, ''],
  ['b', 'B', 'Blue (0–255)', 0, 255, ''],
];
const MODE_ROWS = [
  ['L', 'L', 'Lightness (0–100)', 0, 100, '', 'L'],
  ['a', 'a', 'a (green–red)', -128, 127, '', 'A'],
  ['b', 'b', 'b (blue–yellow)', -128, 127, '', 'B'],
  ['c', 'C', 'Cyan (%)', 0, 100, '%'],
  ['m', 'M', 'Magenta (%)', 0, 100, '%'],
  ['y', 'Y', 'Yellow (%)', 0, 100, '%'],
  ['k', 'K', 'Black (%)', 0, 100, '%'],
];

/** The Eyedropper's sampler (lib/tools/nav.js), when the tool is registered. */
function sampleImage(app, p) {
  const tool = app.tools?.get?.('eyedropper');
  return tool?.sampleColor?.(p) ?? null;
}

function pickerDialog(app, { initial, title = 'Color Picker', live = null, doc = app.doc, target = 'field', allowBooks = true } = {}) {
  const conv = convFor(doc);
  const ui = colorUI(app);
  const startHex = hexOf(initial, app.settings.foreground);
  const startValue = typeof initial === 'object' && initial ? initial : null;
  let st = startValue?.space === 'lab' && Array.isArray(startValue.lab) ? M.stateFromLab(startValue.lab, conv) : M.stateFromRgb(M.rgbOfHex(startHex), conv);
  let space = startValue?.space && startValue.space !== 'book' ? startValue.space : 'rgb';
  let book = startValue?.space === 'book' && startValue.book ? { ...startValue.book, lab: startValue.lab, cmyk: startValue.cmyk } : null;
  if (book) space = 'book';
  let cmykTyped = startValue?.space === 'cmyk' && Array.isArray(startValue.cmyk) ? startValue.cmyk.slice(0, 4) : null;
  let webOnly = !!ui.webOnly;

  const content = document.createElement('div');
  content.className = 'cpx-dialog';
  const picker = createAxisPicker({ axis: M.axisOf(ui.pickerAxis).id, value: st, conv, web: webOnly, onChange: (next) => setState(next, { space: M.axisOf(picker.axis).model, from: 'picker' }) });
  const side = document.createElement('div');
  side.className = 'cpx-side';
  const radio = (axis, label) => `<input type="radio" name="cpx-axis" value="${axis}" data-axis="${axis}" aria-label="Show ${label} on the slider">`;
  side.innerHTML = `
    <div class="cpx-top">
      <div class="cp-compare" aria-label="New and current colour">
        <span class="muted">new</span>
        <div class="cp-swatches"><span class="cp-new"></span><button type="button" class="cp-old" title="Click to go back to the current colour"></button></div>
        <span class="muted">current</span>
      </div>
      <div class="cpx-warnings">
        <button type="button" class="cpx-warn cp-gamut" hidden title="Warning: out of gamut for printing. Click to take the closest printable colour">${icon('warning')}<span class="cpx-warn-swatch"></span></button>
        <button type="button" class="cpx-warn cp-web" hidden title="Warning: not a web-safe colour. Click to take the closest web colour">${icon('web-cube')}<span class="cpx-warn-swatch"></span></button>
      </div>
      <div class="cpx-actions">
        <button type="button" class="btn small cp-add">${icon('plus')} Add to Swatches</button>
        <button type="button" class="btn small cp-libraries" ${allowBooks ? '' : 'hidden'}>${icon('color-book')} Color Libraries</button>
        <button type="button" class="btn small cp-screen" hidden title="Pick a colour anywhere on the screen">${icon('eyedropper')} Sample Screen</button>
      </div>
    </div>
    <div class="cp-book muted" hidden></div>
    <div class="cpx-fields">
      <div class="cpx-col">
        ${FIELD_ROWS.map(([k, l, t, lo, hi, u]) => `<label class="cpx-row" title="${t}">${radio(k, l)}<span class="cpx-label">${l}</span><input class="input" data-f="${k}" type="number" min="${lo}" max="${hi}" step="1"><span class="cpx-unit muted">${u}</span></label>`).join('')}
        <label class="cpx-row cpx-hex" title="Hexadecimal colour"><span class="cpx-label">#</span><input class="input" data-f="hex" type="text" maxlength="7" spellcheck="false" aria-label="Hex colour"></label>
      </div>
      <div class="cpx-col color-fields cp-modes" aria-label="Lab and CMYK">
        ${MODE_ROWS.map(([k, l, t, lo, hi, u, axis]) => `<label class="cpx-row" title="${t}">${axis ? radio(axis, l) : '<span class="cpx-radio-gap"></span>'}<span class="cpx-label">${l}</span><input class="input" data-m="${k}" type="number" min="${lo}" max="${hi}" step="1"><span class="cpx-unit muted">${u}</span></label>`).join('')}
      </div>
    </div>
    <div class="cp-note muted" hidden></div>
    <label class="cpx-web-only"><input type="checkbox" data-k="webOnly"> Only Web Colors</label>
    <div class="cp-sample-hint muted" hidden>Click in the image to sample a colour</div>
    <div class="cp-quick-title muted">Recent and swatches</div>
    <div class="cp-quick"></div>`;
  content.append(picker.element, side);

  const $ = (s) => side.querySelector(s);
  const fields = Object.fromEntries([...side.querySelectorAll('[data-f]')].map((i) => [i.dataset.f, i]));
  const modes = Object.fromEntries([...side.querySelectorAll('[data-m]')].map((i) => [i.dataset.m, i]));
  const newSw = $('.cp-new'), oldSw = $('.cp-old');
  const gamutBtn = $('.cp-gamut'), webBtn = $('.cp-web');
  const bookLabel = $('.cp-book'), note = $('.cp-note');
  oldSw.style.background = startHex;
  for (const r of side.querySelectorAll('[data-axis]')) r.checked = r.value === picker.axis;
  $('[data-k="webOnly"]').checked = webOnly;

  // what painting would get: the document's mode constrains the foreground and background (app.setColors)
  const shown = (hex) => {
    if ((target === 'foreground' || target === 'background') && app.colorConstraint && doc) {
      try {
        return app.colorConstraint(hex, doc) ?? hex;
      } catch {
        return hex;
      }
    }
    return hex;
  };
  const value = () => {
    const hex = M.stateHex(st);
    const v = { hex, rgb: st.rgb.map((x) => Math.round(x)), book: book ? { book: book.book, name: book.name } : null, space };
    if (space === 'lab' || (space === 'book' && book?.lab)) v.lab = space === 'book' ? book.lab.slice() : st.lab.map((x) => Math.round(x * 100) / 100);
    if (space === 'cmyk' || (space === 'book' && book?.cmyk)) v.cmyk = space === 'book' ? book.cmyk.slice() : (cmykTyped ?? rgbToCmyk(...st.rgb)).map((x) => Math.round(x * 100) / 100);
    return v;
  };

  let liveRaf = 0;
  const pushLive = () => {
    if (typeof live !== 'function' || liveRaf) return;
    liveRaf = requestAnimationFrame(() => {
      liveRaf = 0;
      try {
        live(value());
      } catch (err) {
        console.error(err);
      }
    });
  };

  function showFields() {
    const [r, g, b] = st.rgb.map((x) => Math.round(x));
    const { h, s, v } = st.hsv;
    const vals = { h: Math.round(h) % 360, s: Math.round(s * 100), v: Math.round(v * 100), r, g, b, hex: M.stateHex(st).slice(1) };
    for (const [k, input] of Object.entries(fields)) if (document.activeElement !== input) input.value = String(vals[k]);
    const cmyk = space === 'cmyk' && cmykTyped ? cmykTyped : rgbToCmyk(r, g, b);
    const mv = { L: st.lab[0], a: st.lab[1], b: st.lab[2], c: cmyk[0], m: cmyk[1], y: cmyk[2], k: cmyk[3] };
    for (const [k, input] of Object.entries(modes)) if (document.activeElement !== input) input.value = String(Math.round(mv[k]));
  }

  function showState() {
    const hex = M.stateHex(st);
    const paint = shown(hex);
    newSw.style.background = paint;
    newSw.title = paint === hex ? hex : `${hex}: this document's mode paints ${paint}`;
    // out of gamut for printing: the proof of View > Gamut Warning, on the colour as sRGB shows it
    const srgb = convertColor(st.rgb, doc?.profile ?? null, SRGB);
    const outOfGamut = isOutOfCmykGamut(srgb);
    gamutBtn.hidden = !outOfGamut;
    if (outOfGamut) gamutBtn.querySelector('.cpx-warn-swatch').style.background = M.hexOfRgb(M.printableRgb(srgb));
    const notWeb = !M.isWebSafe(st.rgb.map((x) => Math.round(x)));
    webBtn.hidden = !notWeb;
    if (notWeb) webBtn.querySelector('.cpx-warn-swatch').style.background = M.hexOfRgb(M.webSafe(st.rgb));
    bookLabel.hidden = !book;
    bookLabel.textContent = book ? `${book.book}: ${book.name}` : '';
    const clipped = space === 'lab' && M.labClipped(st.lab, conv);
    note.hidden = !clipped;
    note.textContent = clipped ? `This Lab colour is outside ${doc?.profile?.name ?? 'the document\'s colour space'}: the nearest colour it holds is used` : '';
    showFields();
  }

  /** The one way the colour changes. */
  function setState(next, { space: sp = 'rgb', from = null, keepBook = false, cmyk = null } = {}) {
    if (webOnly && sp !== 'book' && sp !== 'lab') next = M.stateFromRgb(M.webSafe(next.rgb), conv, next);
    st = next;
    space = sp;
    cmykTyped = sp === 'cmyk' ? cmyk : null;
    if (!keepBook) book = null;
    if (from !== 'picker') picker.set(st);
    showState();
    pushLive();
  }
  const setHex = (hex, sp = 'rgb') => setState(M.stateFromRgb(M.rgbOfHex(hex), conv, st), { space: sp });

  // fields: HSB and RGB commit as they are typed, Lab and CMYK on change (blur) and Enter, hex once it is valid
  const commitField = (input, final) => {
    const k = input.dataset.f;
    if (k === 'hex') {
      const raw = input.value.trim().replace(/^#/, '');
      if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(raw)) {
        if (final) showFields();
        return;
      }
      setHex(`#${raw}`);
      return;
    }
    const n = Number(input.value);
    if (input.value === '' || !Number.isFinite(n)) {
      if (final) showFields();
      return;
    }
    if (k === 'h' || k === 's' || k === 'v') {
      const hsv = { ...st.hsv, [k]: k === 'h' ? Math.min(359.999, Math.max(0, n) % 360) : Math.max(0, Math.min(100, n)) / 100 };
      setState(M.stateFromHsv(hsv, conv), { space: 'hsb' });
    } else {
      const rgb = st.rgb.map((x) => Math.round(x));
      rgb['rgb'.indexOf(k)] = Math.max(0, Math.min(255, Math.round(n)));
      setState(M.stateFromRgb(rgb, conv, st), { space: 'rgb' });
    }
  };
  for (const input of Object.values(fields)) {
    input.addEventListener('input', () => commitField(input, false));
    input.addEventListener('change', () => {
      commitField(input, true);
      showFields();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitField(input, true);
    });
    input.addEventListener('blur', () => showFields());
  }
  const commitMode = (key) => {
    const n = (k) => Number(modes[k].value);
    if (Object.values(modes).some((i) => i.value === '' || !Number.isFinite(Number(i.value)))) return;
    if ('Lab'.includes(key)) setState(M.stateFromLab([n('L'), n('a'), n('b')], conv, st), { space: 'lab' });
    else {
      const cmyk = ['c', 'm', 'y', 'k'].map((k) => Math.max(0, Math.min(100, n(k))));
      setState(M.stateFromRgb(cmykToRgb(...cmyk), conv, st), { space: 'cmyk', cmyk });
    }
  };
  for (const [k, input] of Object.entries(modes)) {
    input.addEventListener('change', () => commitMode(k));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitMode(k);
    });
    input.addEventListener('blur', () => showFields());
  }
  for (const r of side.querySelectorAll('[data-axis]')) {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      picker.setAxis(r.value);
      saveColorUI(app, { pickerAxis: r.value });
    });
  }
  $('[data-k="webOnly"]').addEventListener('change', (e) => {
    webOnly = e.currentTarget.checked;
    picker.setWeb(webOnly);
    saveColorUI(app, { webOnly });
    if (webOnly) setState(st, { space: space === 'book' ? 'rgb' : space });
  });
  oldSw.addEventListener('click', () => {
    if (startValue?.space === 'book' && startValue.book) {
      setState(M.stateFromRgb(M.rgbOfHex(startHex), conv), { space: 'book', keepBook: true });
    } else setHex(startHex, startValue?.space ?? 'rgb');
  });
  gamutBtn.addEventListener('click', () => {
    const srgb = M.printableRgb(convertColor(st.rgb, doc?.profile ?? null, SRGB));
    setState(M.stateFromRgb(convertColor(srgb, SRGB, doc?.profile ?? null), conv, st), { space: 'rgb' });
  });
  webBtn.addEventListener('click', () => setState(M.stateFromRgb(M.webSafe(st.rgb), conv, st), { space: 'rgb' }));

  // Add to Swatches: the colour as it was chosen (Lab, CMYK and book colours keep their numbers)
  $('.cp-add').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await addSwatch(app, value());
      b.innerHTML = `${icon('check')} Added`;
    } catch (err) {
      console.warn('Add to Swatches failed', err);
      b.disabled = false;
    }
  });
  // Color Libraries: a book colour, or back to the picker
  $('.cp-libraries').addEventListener('click', async () => {
    const res = await colorLibrariesDialog(app, { initial: M.stateHex(st), doc, book: book?.book ?? null, name: book?.name ?? null });
    if (!res) return;
    const v = bookEntryValue(res.book, res.entry, doc);
    book = { book: v.book.book, name: v.book.name, lab: v.lab, cmyk: v.cmyk };
    setState(M.stateFromRgb(v.rgb, conv), { space: 'book', keepBook: true });
  });
  // sampling the screen (Chromium and Electron): the colour arrives as sRGB
  const screenBtn = $('.cp-screen');
  if (typeof window.EyeDropper === 'function') {
    screenBtn.hidden = false;
    screenBtn.addEventListener('click', async () => {
      try {
        const res = await new window.EyeDropper().open();
        if (!res?.sRGBHex) return;
        setState(M.stateFromRgb(convertColor(M.rgbOfHex(res.sRGBHex), SRGB, doc?.profile ?? null), conv, st), { space: 'rgb' });
      } catch {
        // Escape closes the screen eyedropper: nothing to do
      }
    });
  }

  // recent colours and swatches
  const quick = $('.cp-quick');
  const recent = (app.settings.recentColors ?? []).map(normHex);
  const seen = new Set();
  for (const c of [...recent, ...swatchColors(app)]) {
    if (seen.has(c) || seen.size >= 30) continue;
    seen.add(c);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.title = c;
    b.dataset.color = c;
    b.addEventListener('click', () => setHex(c));
    quick.appendChild(b);
  }
  showState();

  let releaseSample = null;
  return app.dialogs
    .open({
      title,
      content,
      width: 640,
      className: 'color-picker-dialog',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
      onOpen: (dialogEl) => {
        // the image under the dialog samples like the Eyedropper while the picker is the only dialog (a nested
        // picker would let clicks through to the dialog below it)
        if (!doc || !app.canvasCapture || !app.dialogs.setCanvasThrough || app.dialogs.stack.length !== 1 || app.doc !== doc) return;
        app.dialogs.setCanvasThrough(dialogEl, true);
        const sample = (p) => {
          const rgba = sampleImage(app, p);
          if (rgba) setState(M.stateFromRgb(rgba.slice(0, 3), conv, st), { space: 'rgb' });
        };
        releaseSample = app.canvasCapture.push({ id: 'color-picker', cursor: 'crosshair', down: (p) => sample(p), move: (p, _v, dragging) => dragging && sample(p) });
        $('.cp-sample-hint').hidden = false;
      },
    })
    .then((ok) => {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
      releaseSample?.();
      picker.destroy();
      return ok ? value() : null;
    });
}

/** Preferences > Color Picker: System. A dialog around the operating system's colour chooser. */
function systemPicker(app, { initial, title = 'Color Picker', live = null } = {}) {
  const start = hexOf(initial, app.settings.foreground);
  let current = start;
  const content = document.createElement('div');
  content.className = 'cpx-system';
  content.innerHTML = `<input type="color" class="cpx-system-input" aria-label="Colour"><p class="muted">The colour picker of your system. Choose Pigment's own in Preferences &gt; Color Picker.</p>`;
  const input = content.querySelector('input');
  input.value = start;
  input.addEventListener('input', () => {
    current = normHex(input.value);
    try {
      live?.(colorValue(current));
    } catch (err) {
      console.error(err);
    }
  });
  return app.dialogs
    .open({
      title,
      content,
      width: 360,
      className: 'color-picker-dialog system-picker',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
      onOpen: () => {
        try {
          input.showPicker?.();
        } catch {
          // no user activation: the swatch opens it with a click
        }
      },
    })
    .then((ok) => (ok ? colorValue(current) : null));
}

// ---- the `color` field widget (S7.3) ---------------------------------------------------------------------------------

const hex6 = (v) => {
  const s = String(v ?? '').trim();
  if (/^#[0-9a-f]{6}/i.test(s)) return s.slice(0, 7).toLowerCase();
  if (/^#?[0-9a-f]{3}$/i.test(s)) {
    const h = s.replace('#', '');
    return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(s)) return `#${s.toLowerCase()}`;
  return '#000000';
};

/**
 * Every colour field: a swatch button that opens the picker (target 'field'), keeping a visually hidden
 * input[type=color] with the field's data-key (its `input` event sets the value, as specs and scripts do), and in
 * forms the hex box beside it. While the picker is open the field follows it live (onInput); OK commits (onChange),
 * Cancel puts the colour back.
 */
export function createColorField(spec, { value, onInput, onChange, app }) {
  const root = document.createElement(spec.text ? 'div' : 'span');
  root.className = spec.text ? 'slider-field color-field' : 'color-field';
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `color-chip${spec.className ? ` ${spec.className}` : ''}`;
  if (spec.id) chip.id = spec.id;
  if (spec.style) chip.style.cssText = spec.style;
  const label = spec.ariaLabel ?? spec.title ?? 'Colour';
  chip.setAttribute('aria-label', `${label}: click to choose a colour`);
  chip.title = spec.title ? `${spec.title}: click to choose a colour` : 'Click to choose a colour';
  const fill = document.createElement('span');
  fill.className = 'color-chip-fill';
  chip.appendChild(fill);
  const input = document.createElement('input');
  input.type = 'color';
  input.className = 'color-native';
  input.tabIndex = -1;
  if (spec.key) input.dataset.key = spec.key;
  if (spec.dataK) input.dataset.k = spec.dataK;
  if (spec.title) input.title = spec.title;
  if (spec.ariaLabel) input.setAttribute('aria-label', spec.ariaLabel);
  let current = hex6(value ?? spec.value ?? spec.default ?? '#000000');
  let text = null;
  root.append(chip, input);
  if (spec.text) {
    text = document.createElement('input');
    text.className = 'input';
    text.spellcheck = false;
    root.appendChild(text);
  }
  const show = () => {
    input.value = current;
    fill.style.background = current;
    chip.dataset.color = current;
    if (text && document.activeElement !== text) text.value = current;
  };
  show();
  input.addEventListener('input', () => {
    current = hex6(input.value);
    show();
    onInput(current);
  });
  input.addEventListener('change', () => onChange(hex6(input.value)));
  text?.addEventListener('change', () => {
    const v = text.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(v) || /^#?[0-9a-f]{3}$/i.test(v)) {
      current = hex6(v.startsWith('#') ? v : '#' + v);
      show();
      text.value = current;
      onInput(current);
      onChange(current);
    } else text.value = current;
  });
  let open = false;
  chip.addEventListener('click', async () => {
    const a = app ?? globalThis.pigmentApp;
    if (open || !a?.colorPicker) return;
    open = true;
    const start = current;
    let moved = false;
    try {
      const c = await a.colorPicker.pick({
        initial: current,
        title: spec.pickerTitle ?? (spec.title ? `Color Picker (${spec.title})` : 'Color Picker'),
        target: 'field',
        live: (v) => {
          if (v.hex === current) return;
          moved = true;
          current = v.hex;
          show();
          onInput(current);
        },
      });
      if (c) {
        current = c.hex;
        show();
        onInput(current);
        onChange(current);
      } else if (moved && current !== start) {
        current = start;
        show();
        onInput(current);
      }
    } finally {
      open = false;
    }
  });
  return {
    element: root,
    input,
    chip,
    get: () => current,
    set(v, { silent = true } = {}) {
      current = hex6(v);
      show();
      if (!silent) {
        onInput(current);
        onChange(current);
      }
    },
    setDisabled(b) {
      chip.disabled = !!b;
      input.disabled = !!b;
      if (text) text.disabled = !!b;
    },
    destroy: () => root.remove(),
  };
}

// ---- kinds, migration, preferences ---------------------------------------------------------------------------------

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function registerSwatchKinds() {
  // the same built-ins as the skeleton's (0.4's DEFAULT_SWATCHES, ids default-<i>), so a stored order stays valid
  registerPresetKind('swatches', {
    title: 'Swatches',
    version: 1,
    builtins: () => ({
      presets: DEFAULT_SWATCHES.map((hex, i) => ({ id: `default-${i}`, name: hex, data: M.swatchFromHex(hex) })),
    }),
    normalize: (data) => M.normalizeSwatchData(data),
  });
  registerColorBooks();
}

/** 0.4's edited palette into the `swatches` kind, once (S7.2). Built-ins it did not keep are hidden. */
export async function migrateSwatches(app) {
  if (colorUI(app).swatchesMigrated) return false;
  await app.presets.ready('swatches');
  if (colorUI(app).swatchesMigrated) return false;
  const s = app.settings;
  let moved = false;
  if (s.swatchesEdited && Array.isArray(s.swatches)) {
    const items = M.migrateSwatchList(s.swatches);
    app.presets.remove('swatches', app.presets.list('swatches').map((p) => p.id));
    for (const it of items) app.presets.add('swatches', it);
    moved = true;
  }
  saveColorUI(app, { swatchesMigrated: true });
  app.emit('swatches:changed', null);
  return moved;
}

export const colorPickerPreferences = {
  id: 'color-picker',
  title: 'Color Picker',
  order: 25,
  fields: [
    { key: 'colorUIPicker', label: 'Color picker', type: 'select', options: [['pigment', 'Pigment'], ['system', 'System']] },
    { key: 'colorUIHud', label: 'HUD color picker', type: 'select', options: M.HUD_STYLES.map(([id, label]) => [id, label]) },
  ],
  read(s) {
    const c = { ...DEFAULT_SETTINGS.colorUI, ...(s.colorUI ?? {}) };
    return { colorUIPicker: c.picker === 'system' ? 'system' : 'pigment', colorUIHud: M.hudStyle(c.hud).id };
  },
  write(v, s) {
    const c = { ...DEFAULT_SETTINGS.colorUI, ...(s.colorUI ?? {}) };
    const picker = v.colorUIPicker === 'system' ? 'system' : 'pigment';
    const hud = M.hudStyle(v.colorUIHud).id;
    return picker !== c.picker || hud !== c.hud ? { colorUI: { ...c, picker, hud } } : {};
  },
};

export function install(app) {
  registerSwatchKinds();
  registerWidget('color', createColorField);
  app.preferences?.registerSection(colorPickerPreferences);

  const picker = {
    real: true,
    /** S7.1: resolves with the ColorValue chosen, or null. */
    pick(opts = {}) {
      if (colorUI(app).picker === 'system') return systemPicker(app, opts);
      return pickerDialog(app, opts);
    },
    hud: (opts = {}) => createHudSession(app, opts),
  };
  app.colorPicker = picker;
  // 0.4's API: pick() returning hex
  app.pickColor = (initial, { title, live, target = 'field' } = {}) => picker.pick({ initial, title, target, live: typeof live === 'function' ? (c) => live(c.hex) : null }).then((c) => (c ? c.hex : null));

  // the swatches move into the preset store once (the browser build: IndexedDB; Electron: the presets folder)
  if (app.presets) migrateSwatches(app).catch((err) => console.warn('The swatches could not be migrated', err));
  // Edit > Preferences > Reset All Settings (extras.js emits 'swatches:changed' with []) promises the default swatches
  app.on('swatches:changed', (arg) => {
    if (!Array.isArray(arg) || !app.presets || colorUI(app).swatchesMigrated) return;
    app.presets.ready('swatches').then(() => {
      app.presets.reset('swatches');
      return migrateSwatches(app);
    }).catch((err) => console.warn('The swatches could not be reset', err));
  });
}
