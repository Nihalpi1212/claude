// brush-engine-core's MODULES entry (ARCHITECTURE.md "0.5 features", package 1, S13.3):
//   - Edit > Define Brush Preset… (`edit:define-brush`, arg { name }): what the document shows inside the selection
//     (all of it without one) becomes a sampled tip, as Photoshop does: dark pixels paint, white and transparent ones
//     do not. The coverage is cropped to what paints, kept under 5000 px, stored as a grey PNG blob of the `brushes`
//     kind (white = full coverage, named by its SHA-1) and added as a preset in the group "Defined"; the Brush tool (or
//     the painting tool in use) takes it.
//   - `tool:airbrush-toggle` (Shift+Alt+P while painting, the options bar's airbrush button): toggles the brush's
//     Build-up flag (preset.buildUp) through setToolBrush, the one way it is written (S1.3).
//   - The options bar's airbrush button and smoothing options (Pulled String Mode, Stroke Catch-up, Catch-up on Stroke
//     End, Adjust for Zoom; settings.tools[id].smoothingOptions, S1.3) as options-bar slots (S12.1).
import { flattenDocument } from '../compositor.js';
import { createCanvas } from '../document.js';
import { encodePng } from '../../../shared/pixels/png.js';
import { normalizeBrush } from './preset.js';
import { toolBrush, setToolBrush, supportsBrush, prepareBrush } from './tool-brush.js';
import { registerIcons, icon } from '../icons.js';
import { formDialog } from '../form.js';

/** The largest side of a defined tip (Photoshop's limit). */
export const MAX_TIP = 5000;
const GROUP = 'Defined';

registerIcons({
  airbrush: '<path d="M4 20l5-5"/><path d="M9 15l6-6 3 3-6 6z"/><path d="M15 9l2-2a1.4 1.4 0 0 1 2 2l-2 2"/><circle cx="6" cy="6" r=".6"/><circle cx="9" cy="4.5" r=".6"/><circle cx="4.5" cy="9" r=".6"/>',
  'smoothing-options': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
});

// ---- pure parts (Node-tested) ---------------------------------------------------------------------------------------

/**
 * RGBA (straight alpha) to brush coverage 0..255 per pixel: (1 - luminance) x alpha, so black paints fully and white
 * or transparent pixels do not; `mask` (0..255 per pixel, optional) is the selection's.
 */
export function coverageOf(rgba, width, height, mask = null) {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const a = rgba[i + 3];
    if (!a) continue;
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    let c = ((255 - lum) * a) / 255;
    if (mask) c = (c * mask[p]) / 255;
    out[p] = Math.round(c);
  }
  return out;
}

/** The bounds of the pixels with coverage, or null when nothing paints. */
export function coverageBounds(cov, width, height) {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!cov[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Hex SHA-1 of bytes (the blob's name: the same tip always gives the same blob). */
async function sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---- Define Brush Preset ------------------------------------------------------------------------------------------

/** The coverage of what the document shows inside the selection (all of it without one), cropped and scaled. */
function sampleCoverage(doc) {
  const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
  const area = sel ? sel.bounds : doc.bounds ?? { x: 0, y: 0, width: doc.width, height: doc.height };
  const x = Math.max(0, Math.floor(area.x)), y = Math.max(0, Math.floor(area.y));
  const w = Math.min(doc.width, Math.ceil(area.x + area.width)) - x, h = Math.min(doc.height, Math.ceil(area.y + area.height)) - y;
  if (w <= 0 || h <= 0) return null;
  const flat = flattenDocument(doc, doc.view?.compositor);
  const rgba = flat.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h).data;
  let mask = null;
  if (sel) {
    const m = sel.toCanvas().getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h).data;
    mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = m[i * 4 + 3];
  }
  const cov = coverageOf(rgba, w, h, mask);
  const b = coverageBounds(cov, w, h);
  if (!b) return null;
  // the cropped coverage as a canvas (grey: white = coverage), scaled down when a side exceeds MAX_TIP
  const k = Math.min(1, MAX_TIP / Math.max(b.width, b.height));
  const crop = createCanvas(b.width, b.height);
  const cctx = crop.getContext('2d');
  const img = cctx.createImageData(b.width, b.height);
  for (let yy = 0; yy < b.height; yy++) {
    for (let xx = 0; xx < b.width; xx++) {
      const v = cov[(b.y + yy) * w + b.x + xx];
      const i = (yy * b.width + xx) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  cctx.putImageData(img, 0, 0);
  if (k >= 1) return crop;
  const out = createCanvas(Math.max(1, Math.round(b.width * k)), Math.max(1, Math.round(b.height * k)));
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(crop, 0, 0, out.width, out.height);
  return out;
}

/** The grey PNG of a coverage canvas (one channel, white = full coverage). */
async function greyPng(canvas) {
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
  const grey = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < grey.length; i++) grey[i] = d[i * 4];
  return encodePng({ width: canvas.width, height: canvas.height, channels: 1, depth: 8, data: grey });
}

/** The painting tool a defined brush goes to: the active one when it takes a full brush, else the Brush. */
function brushTool(app) {
  const t = app.tools?.active;
  return t && supportsBrush(t) === 'full' ? t.id : 'brush';
}

async function definedGroup(app) {
  const g = app.presets.groups('brushes').find((x) => x.name === GROUP && !x.parent);
  return g ? g.id : app.presets.addGroup('brushes', { name: GROUP }).id;
}

function nextName(app) {
  const n = app.presets.list('brushes').filter((p) => /^Sampled Brush \d+$/.test(p.name)).length + 1;
  return `Sampled Brush ${n}`;
}

/**
 * Edit > Define Brush Preset…: from the menu, a key or with { dialog: true } the Brush Name dialog asks first; with a
 * name ({ name } or a string, a recorded step) it does not. Resolves to the new preset.
 */
async function defineBrush(app, arg, ctx = null) {
  const doc = app.doc;
  if (!doc) return null;
  const tip = sampleCoverage(doc);
  if (!tip) {
    app.dialogs.toast(doc.selection && !doc.selection.isEmpty ? 'The selection holds nothing dark enough to paint with' : 'The image holds nothing dark enough to paint with', { kind: 'error', timeout: 2500 });
    ctx?.cancel?.();
    return null;
  }
  await app.presets.ready('brushes');
  let name = typeof arg === 'string' ? arg : typeof arg?.name === 'string' ? arg.name : null;
  const asks = !name && (['menu', 'menu-key', 'key', 'search'].includes(ctx?.source) || arg?.dialog === true);
  if (!name) name = nextName(app);
  if (asks) {
    const v = await formDialog(app, {
      title: 'Brush Name',
      width: 380,
      fields: [
        {
          key: 'preview',
          type: 'custom',
          render: () => {
            const box = document.createElement('div');
            box.className = 'define-pattern-preview';
            const thumb = createCanvas(64, 64);
            const t = thumb.getContext('2d');
            t.fillStyle = '#ffffff';
            t.fillRect(0, 0, 64, 64);
            const k = Math.min(1, 60 / Math.max(tip.width, tip.height));
            const w = tip.width * k, h = tip.height * k;
            // the tip as it paints: dark on white
            const ink = createCanvas(tip.width, tip.height);
            const ictx = ink.getContext('2d');
            ictx.drawImage(tip, 0, 0);
            ictx.globalCompositeOperation = 'difference';
            ictx.fillStyle = '#ffffff';
            ictx.fillRect(0, 0, tip.width, tip.height);
            t.drawImage(ink, (64 - w) / 2, (64 - h) / 2, w, h);
            box.appendChild(thumb);
            const size = document.createElement('span');
            size.className = 'muted';
            size.textContent = `${Math.max(tip.width, tip.height)} px`;
            box.appendChild(size);
            return box;
          },
        },
        { key: 'name', label: 'Name', type: 'text', value: name, autofocus: true },
      ],
    });
    if (!v || !String(v.name ?? '').trim()) {
      ctx?.cancel?.(); // actions (lib/actions.js)
      return null;
    }
    name = String(v.name).trim();
  }
  ctx?.setReplayArg?.({ name }); // a recorded step defines the same brush from the image it runs on, without asking
  const png = await greyPng(tip);
  const hash = await sha1Hex(png);
  const blob = `tip-${hash}.png`;
  await app.presets.writeBlob('brushes', blob, png);
  const size = Math.max(tip.width, tip.height);
  // Photoshop's defaults for a defined tip: hard edges from the image itself, 25 % spacing
  const data = normalizeBrush({ tip: { kind: 'sampled', size, hardness: 1, spacing: 0.25, sample: { blob, hash, width: tip.width, height: tip.height } } });
  const group = await definedGroup(app);
  const preset = app.presets.add('brushes', { name, data, group });
  await prepareBrush(app, data).catch(() => {});
  const toolId = brushTool(app);
  setToolBrush(app, toolId, data, { presetId: preset.id, includeTool: false });
  app.dialogs.toast(`Brush “${name}” defined (${size} px)`, { kind: 'success', timeout: 1800 });
  return preset;
}

// ---- airbrush -----------------------------------------------------------------------------------------------------

/** Tools with Photoshop's airbrush button: those that take a full brush, but not the Pencil (hard, aliased dabs). */
function hasAirbrush(tool) {
  return !!tool && supportsBrush(tool) === 'full' && tool.id !== 'pencil';
}

function toggleAirbrush(app, toolId) {
  const { preset } = toolBrush(app, toolId);
  preset.buildUp = !preset.buildUp;
  // the one way Build-up is written (S1.3): locks and the preset's tool values do not apply to a flag the user flips
  setToolBrush(app, toolId, preset, { respectLocks: false, includeTool: false });
  return preset.buildUp;
}

// ---- options-bar slots --------------------------------------------------------------------------------------------

const SMOOTHING_DEFAULTS = { mode: 'average', catchUp: false, catchUpOnEnd: false, adjustForZoom: true };

function smoothingOptions(app, toolId) {
  return toolBrush(app, toolId).paint.smoothingOptions ?? { ...SMOOTHING_DEFAULTS };
}

function setSmoothingOption(app, toolId, key, value) {
  const next = { ...smoothingOptions(app, toolId), [key]: value };
  if (key === 'pulledString') {
    delete next.pulledString;
    next.mode = value ? 'pulled-string' : 'average';
  }
  app.tools.setOptions(toolId, { smoothingOptions: next });
}

function slotButton({ name, title, pressed = null, onClick }) {
  const wrap = document.createElement('span');
  wrap.className = 'opt opt-button';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'seg-button';
  b.innerHTML = icon(name);
  b.title = title;
  b.setAttribute('aria-label', title);
  if (pressed !== null) b.setAttribute('aria-pressed', String(!!pressed));
  b.addEventListener('click', () => onClick(b));
  wrap.appendChild(b);
  return { wrap, button: b };
}

export function install(app) {
  app.commands.register('edit:define-brush', {
    label: 'Define Brush Preset…',
    dialog: true,
    enabled: () => !!app.doc,
    run: (arg, ctx) => defineBrush(app, arg, ctx),
  });

  app.commands.register('tool:airbrush-toggle', {
    label: 'Airbrush',
    enabled: () => hasAirbrush(app.tools?.active),
    checked: () => hasAirbrush(app.tools?.active) && !!toolBrush(app, app.tools.active.id).preset.buildUp,
    // arg: the tool id (the active tool's when absent); a recorded step names the tool it toggled
    run: (arg, ctx) => {
      const id = typeof arg === 'string' && app.tools.get(arg) ? arg : app.tools.active?.id;
      const tool = app.tools.get(id);
      if (!hasAirbrush(tool)) return false;
      ctx?.setReplayArg?.(id);
      return toggleAirbrush(app, id);
    },
  });

  // the airbrush button follows the flag wherever it is written (the Brush Settings panel's Build-up box, a preset)
  let airButton = null;
  app.on('tool:options', ({ tool, key } = {}) => {
    if (!airButton?.isConnected || tool !== app.tools.active?.id || (key !== 'brush' && key !== '*')) return;
    airButton.setAttribute('aria-pressed', String(!!toolBrush(app, tool).preset.buildUp));
  });
  app.tools.registerOptionsSlot({
    id: 'brush-engine:airbrush',
    place: 'end',
    order: 10,
    render: (tool) => {
      if (!hasAirbrush(tool)) return null;
      const { wrap, button } = slotButton({
        name: 'airbrush',
        title: 'Airbrush: paint builds up while the pointer rests (Shift+Alt+P)',
        pressed: !!toolBrush(app, tool.id).preset.buildUp,
        onClick: () => app.commands.run('tool:airbrush-toggle', tool.id, 'toolbar'),
      });
      wrap.dataset.key = 'airbrush';
      airButton = button;
      return wrap;
    },
  });

  app.tools.registerOptionsSlot({
    id: 'brush-engine:smoothing-options',
    place: 'end',
    order: 11,
    render: (tool) => {
      if (!tool?.options?.some((o) => o.key === 'smoothing') || !supportsBrush(tool)) return null;
      const { wrap } = slotButton({
        name: 'smoothing-options',
        title: 'Smoothing options',
        onClick: (b) => {
          const o = smoothingOptions(app, tool.id);
          const item = (label, key, checked) => ({ label, checked, onSelect: () => setSmoothingOption(app, tool.id, key, !checked) });
          app.dialogs.popover(b, [
            item('Pulled String Mode', 'pulledString', o.mode === 'pulled-string'),
            item('Stroke Catch-up', 'catchUp', !!o.catchUp),
            item('Catch-up on Stroke End', 'catchUpOnEnd', !!o.catchUpOnEnd),
            item('Adjust for Zoom', 'adjustForZoom', o.adjustForZoom !== false),
          ], { closeOnSelect: true });
        },
      });
      wrap.dataset.key = 'smoothingOptions';
      return wrap;
    },
  });
}
