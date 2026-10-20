// AI assistant (see ARCHITECTURE.md "0.2 features: AI — Assistant"): the chat behind the Assistant
// panel (lib/panels/assistant.js). A turn sends the conversation of the active document (optionally with
// a downscaled composite of the image) to the chosen chat model through providers.chat with a tool set;
// every tool runs through the command registry or the layer-ops helpers so each action is one undoable
// history step, and returns a short textual result for the model. Arguments are validated here (layer
// ids, kinds, numeric ranges) so a confused model cannot put the document into a bad state.
import { ADJUSTMENTS, ADJUSTMENT_KINDS } from '../../../shared/pixels/adjust.js';
import { FILTERS, FILTER_KINDS } from '../../../shared/pixels/filters.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';
import { RasterLayer, TextLayer, BLEND_LABELS } from '../document.js';
import { structural, setLayerProps, nextLayerName } from '../layer-ops.js';
import { flattenDocument } from '../compositor.js';
import { Selection } from '../selection.js';
import { hasOpaqueBackground } from '../image-ops.js';
import { PROVIDERS, downscale, canvasToDataUrl } from './providers.js';

const MAX_TURNS = 40; // messages kept per document
const IMAGE_EDGE = 1024; // long edge of the attached composite
const MAX_ROUNDS = 12; // tool rounds per turn

/** Parameter ranges used to clamp what the model sends (unknown keys pass through untouched). */
const ADJUST_RANGES = {
  brightness: [-150, 150], contrast: [-100, 100], exposure: [-20, 20], offset: [-0.5, 0.5], gamma: [0.01, 9.99],
  vibrance: [-100, 100], saturation: [-100, 100], hue: [-180, 180], lightness: [-100, 100], colorizeHue: [0, 360], colorizeSat: [0, 100], colorizeLight: [-100, 100],
  reds: [-200, 300], yellows: [-200, 300], greens: [-200, 300], cyans: [-200, 300], blues: [-200, 300], magentas: [-200, 300],
  density: [0, 100], levels: [2, 255], level: [1, 255], shadows: [-100, 100], highlights: [-100, 100], radius: [0, 250],
  inBlack: [0, 255], inWhite: [0, 255], outBlack: [0, 255], outWhite: [0, 255],
};
/** Fallback ranges for filter params; the dialog's own field ranges (app.filterEditor.ranges) win per kind. */
const FILTER_RANGES = {
  radius: [0.1, 500], amount: [-999, 999], angle: [-999, 999], distance: [1, 2000], threshold: [0, 255], strength: [0, 10],
  amplitude: [1, 999], wavelength: [2, 999], ridges: [1, 20], dx: [-4000, 4000], dy: [-4000, 4000], height: [1, 100], width: [1, 14], brightness: [0, 300], scale: [1, 9999], levels: [2, 256],
};

/** Commands the assistant may not run: they close things, quit, open native dialogs or talk to the providers themselves. */
const BLOCKED_COMMANDS = /^(file:(quit|close|close-all|revert|open|open-paths|open-recent|clear-recent|save|save-as|save-copy|export|export-quick|export-layers|place|import-image|print|reveal|new)|help:|ai:|window:|tool:|edit:preferences|app:)/;

const clampNum = (v, [lo, hi]) => Math.max(lo, Math.min(hi, v));

/** Models that can only send strings (Gemini schemas) send objects as JSON text: parse it when it looks like one. */
export function parseMaybeJson(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!/^[[{]/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}

const stoppedError = () => Object.assign(new Error('Stopped by the user'), { code: 'stopped' });

/** A params object from the model (an object, or an object as JSON text); unreadable text is an error the model sees. */
export function objectArg(v, name) {
  const p = parseMaybeJson(v);
  if (p === undefined || p === null || (typeof p === 'string' && !p.trim())) return {};
  if (typeof p === 'string') throw new Error(`${name} must be a JSON object such as {"radius": 4}; could not read: ${p.slice(0, 80)}`);
  if (typeof p !== 'object' || Array.isArray(p)) throw new Error(`${name} must be an object`);
  return p;
}

/** run_command's argument: JSON text (an object, a quoted string, a number, true/false) is decoded; plain text stays text. */
export function valueArg(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!/^([[{"]|-?\d|true$|false$|null$)/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    if (/^[[{"]/.test(s)) throw new Error(`arg looks like JSON but could not be read: ${s.slice(0, 80)}`);
    return v;
  }
}

/** Sanitises a params object: finite numbers (clamped by the range table), booleans, short strings, arrays and plain objects. */
export function sanitizeParams(params, ranges, depth = 0) {
  if (!params || typeof params !== 'object' || depth > 4) return {};
  const out = Array.isArray(params) ? [] : {};
  for (const [k, raw] of Object.entries(params)) {
    let v = raw;
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && ranges[k]) v = Number(v);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) continue;
      out[k] = ranges[k] ? clampNum(v, ranges[k]) : v;
    } else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (v && typeof v === 'object') out[k] = sanitizeParams(v, ranges, depth + 1);
  }
  return out;
}

/** Deep merge of defaults and the model's params (objects merged, everything else replaced). */
function withDefaults(defaults, params) {
  const out = JSON.parse(JSON.stringify(defaults ?? {}));
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = withDefaults(out[k], v);
    else out[k] = v;
  }
  return out;
}

const paramNames = (defaults) => Object.keys(defaults ?? {});

/** One line per adjustment / filter kind with its parameter names and defaults, for the instructions. */
function kindList(table, kinds) {
  return kinds.map((k) => {
    const d = table[k].defaults ?? {};
    const names = paramNames(d);
    return names.length ? `${k} (${names.map((n) => `${n}=${JSON.stringify(d[n])}`).join(', ')})` : k;
  }).join('; ');
}

// ---- tools ---------------------------------------------------------------------------------------------------------------

const rectSchema = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] };

export const TOOLS = [
  { name: 'get_document', description: 'Current document: size, layers (id, name, type, visible, opacity, blend, active) and the selection bounds. Call it before acting when unsure of ids.', parameters: { type: 'object', properties: {} } },
  { name: 'set_active_layer', description: 'Makes a layer active (the target of adjustments, filters and fills).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'apply_adjustment', description: 'Applies an image adjustment to the active layer pixels (destructive, undoable). kind is one of the adjustment kinds; params uses the listed parameter names.', parameters: { type: 'object', properties: { kind: { type: 'string' }, params: { type: 'object', properties: {} } }, required: ['kind'] } },
  { name: 'apply_filter', description: 'Applies a filter to the active layer pixels. kind is one of the filter kinds; params uses the listed parameter names.', parameters: { type: 'object', properties: { kind: { type: 'string' }, params: { type: 'object', properties: {} } }, required: ['kind'] } },
  { name: 'run_command', description: 'Runs a registered Pigment command by id with an optional argument (see the command list).', parameters: { type: 'object', properties: { id: { type: 'string' }, arg: { description: 'Argument for the command when it takes one: a string, a number, or an object (may be given as a JSON string)' } }, required: ['id'] } },
  { name: 'new_layer', description: 'Adds an empty raster layer above the active one and makes it active. Returns its id.', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'set_layer_props', description: 'Changes layer properties: opacity (0-100), blend mode, visible, name.', parameters: { type: 'object', properties: { id: { type: 'string' }, opacity: { type: 'number' }, blend: { type: 'string' }, visible: { type: 'boolean' }, name: { type: 'string' } }, required: ['id'] } },
  { name: 'select', description: "Changes the selection: kind 'all', 'none', 'inverse' or 'rect' (with rect in pixels).", parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['all', 'none', 'inverse', 'rect'] }, rect: rectSchema }, required: ['kind'] } },
  { name: 'crop', description: 'Crops the document to a rectangle (pixels).', parameters: { type: 'object', properties: { rect: rectSchema }, required: ['rect'] } },
  { name: 'resize_image', description: 'Resamples the whole image to width × height pixels.', parameters: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] } },
  { name: 'canvas_size', description: "Changes the canvas size without scaling; anchor is one of nw, n, ne, w, c, e, sw, s, se (where the existing image stays).", parameters: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, anchor: { type: 'string' } }, required: ['width', 'height'] } },
  { name: 'fill_selection', description: 'Fills the selection (or the whole active layer when nothing is selected) with a colour (hex such as #ff8800 or a CSS colour name).', parameters: { type: 'object', properties: { color: { type: 'string' } }, required: ['color'] } },
  { name: 'add_text', description: 'Adds a text layer at (x, y) in pixels with a font size and colour.', parameters: { type: 'object', properties: { text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, size: { type: 'number' }, color: { type: 'string' } }, required: ['text'] } },
  { name: 'generative_fill', description: 'Fills the current selection with generated content from a prompt (needs a selection and an image model).', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
];

/** A short, human label for a tool call shown in the panel ("Applied Levels", "Ran filter:gaussian-blur"). */
export function describeCall(call) {
  const a = call.args ?? {};
  const failed = call.result && typeof call.result === 'object' && call.result.error;
  const prefix = failed ? 'Failed: ' : '';
  switch (call.name) {
    case 'get_document': return `${prefix}Read the document`;
    case 'set_active_layer': return `${prefix}Selected layer ${a.id ?? ''}`;
    case 'apply_adjustment': return `${prefix}Applied ${ADJUSTMENTS[a.kind]?.name ?? a.kind ?? 'adjustment'}`;
    case 'apply_filter': return `${prefix}Applied ${FILTERS[a.kind]?.name ?? a.kind ?? 'filter'}`;
    case 'run_command': return `${prefix}Ran ${a.id ?? 'command'}`;
    case 'new_layer': return `${prefix}New layer${a.name ? ` "${a.name}"` : ''}`;
    case 'set_layer_props': return `${prefix}Changed layer properties`;
    case 'select': return `${prefix}Selection: ${a.kind ?? ''}`;
    case 'crop': return `${prefix}Cropped`;
    case 'resize_image': return `${prefix}Resized to ${a.width} × ${a.height}`;
    case 'canvas_size': return `${prefix}Canvas size ${a.width} × ${a.height}`;
    case 'fill_selection': return `${prefix}Filled with ${a.color ?? ''}`;
    case 'add_text': return `${prefix}Added text "${String(a.text ?? '').slice(0, 30)}"`;
    case 'generative_fill': return `${prefix}Generative fill`;
    default: return `${prefix}${call.name}`;
  }
}

export function install(app) {
  const conversations = new Map(); // doc.id -> { messages: [...] }
  let running = null; // { doc, stop, stopped }

  const convo = (d) => {
    if (!d) return null;
    let c = conversations.get(d.id);
    if (!c) {
      c = { messages: [] };
      conversations.set(d.id, c);
    }
    return c;
  };
  app.on('doc:closed', (id) => conversations.delete(id));

  // ---- instructions --------------------------------------------------------------------------------------------------------

  function commandList() {
    const ids = [...app.commands.commands.keys()].filter((id) => !BLOCKED_COMMANDS.test(id) && !/^(image:adjust-|filter:)/.test(id)).sort();
    return ids.join(', ');
  }

  function instructions() {
    return [
      'You are the assistant inside Pigment, a layer-based raster image editor (Photoshop-like). The user is editing the active document; a downscaled copy of its composite may be attached to the message.',
      'Help with the image: answer questions about it and perform edits with the tools. Prefer the specific tools (apply_adjustment, apply_filter, select, crop, add_text, ...) over run_command. Every tool changes the document immediately and is undoable; call get_document when you need layer ids or the selection. Act without asking for confirmation unless the request is ambiguous. Keep answers short and say what you changed.',
      'Edits apply to the active layer (image adjustments and filters are destructive on it); add a new layer first when the user wants a separate layer. Coordinates are document pixels with the origin at the top left.',
      `Adjustment kinds (params with defaults): ${kindList(ADJUSTMENTS, ADJUSTMENT_KINDS)}.`,
      `Filter kinds (params with defaults): ${kindList(FILTERS, FILTER_KINDS)}.`,
      `Blend modes: ${Object.keys(BLEND_LABELS).join(', ')}.`,
      `Commands for run_command (ids; most take no argument): ${commandList()}. Also image:adjust-<kind> (params object) and filter:<kind> (params object), which apply_adjustment and apply_filter wrap.`,
    ].join('\n\n');
  }

  // ---- tool implementations -----------------------------------------------------------------------------------------------

  const layerInfo = (d, l) => ({ id: l.id, name: l.name, type: l.type, visible: l.visible, opacity: Math.round(l.opacity * 100), blend: l.blend, active: d.active === l, parent: l.parent && l.parent !== d.root ? l.parent.id : null, ...(l.mask ? { mask: true } : {}), ...(l.type === 'text' ? { text: l.text } : {}) });

  function findLayer(d, id) {
    if (typeof id !== 'string') throw new Error('id must be a layer id string');
    const l = d.find(id);
    if (!l || l === d.root) throw new Error(`No layer with id "${id}" (call get_document for the ids)`);
    return l;
  }

  const num = (v, name, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
    return Math.max(lo, Math.min(hi, n));
  };

  /** A rectangle argument intersected with the canvas; an empty intersection or a non-positive size is an error. */
  function rectArg(d, r) {
    r = parseMaybeJson(r);
    if (!r || typeof r !== 'object') throw new Error('rect must be { x, y, width, height }');
    const BIG = 1e7;
    const x0 = num(r.x, 'rect.x', -BIG, BIG), y0 = num(r.y, 'rect.y', -BIG, BIG);
    const w0 = num(r.width, 'rect.width', -BIG, BIG), h0 = num(r.height, 'rect.height', -BIG, BIG);
    if (w0 <= 0 || h0 <= 0) throw new Error('rect.width and rect.height must be positive');
    const x1 = Math.max(0, Math.round(x0)), y1 = Math.max(0, Math.round(y0));
    const x2 = Math.min(d.width, Math.round(x0 + w0)), y2 = Math.min(d.height, Math.round(y0 + h0));
    if (x2 <= x1 || y2 <= y1) throw new Error(`rect lies outside the canvas (${d.width} × ${d.height})`);
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }

  const needRaster = (d) => {
    const l = d.active;
    if (!l || l.isGroup) throw new Error('No active pixel layer: call set_active_layer or new_layer first');
    if (l.type === 'adjustment') throw new Error('The active layer is an adjustment layer; activate a pixel layer');
    if (l.type !== 'raster' && l.type !== 'smart') throw new Error(`The active layer is a ${l.type} layer; run_command layer:rasterize first or activate a raster layer`);
    if (l.locked.all || l.locked.pixels) throw new Error(`Layer "${l.name}" is locked`);
    return l;
  };

  /** A colour argument from the model: hex, rgb(a), or any CSS colour name, as { hex, alpha 0..1 }; throws on nonsense. */
  function colorArg(value) {
    const s = String(value ?? '').trim();
    let parsed = parseColor(s, null);
    if (!parsed) {
      // CSS names beyond the few parseColor knows: let the canvas parse them (an unknown name leaves fillStyle unchanged)
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = '#010203';
      ctx.fillStyle = s;
      if (ctx.fillStyle === '#010203' && s.toLowerCase() !== '#010203') throw new Error(`Unknown colour "${s}"`);
      parsed = parseColor(ctx.fillStyle, [0, 0, 0, 1]);
    }
    const alpha = Math.max(0, Math.min(1, Number(parsed[3] ?? 1)));
    return { hex: rgbaToHex([parsed[0], parsed[1], parsed[2], 1]), alpha };
  }

  let currentCall = null; // the tool call being executed (for the panel: waiting on a dialog)
  let currentNotify = () => {};

  async function runCommand(id, arg) {
    if (!app.commands.has(id)) throw new Error(`Unknown command "${id}"`);
    if (!app.commands.isEnabled(id)) throw new Error(`Command "${id}" is not available right now`);
    const before = app.dialogs.stack.length;
    const p = app.commands.run(id, arg, 'assistant');
    await new Promise((r) => setTimeout(r, 60));
    let opened = app.dialogs.stack.length > before;
    if (opened && currentCall) {
      // the command opened a dialog: the turn waits for the user to finish it (the modal blocks the app anyway),
      // so later tools act on the document the dialog produced and the model learns the real outcome
      currentCall.waiting = true;
      currentNotify();
    }
    let result;
    try {
      result = await p;
    } finally {
      if (opened && currentCall) {
        currentCall.waiting = false;
        currentNotify();
      }
    }
    if (opened && (result === undefined || result === null || result === false)) return 'The command opened a dialog; the user has closed it (completed or cancelled). Call get_document to see the current state.';
    return result === undefined ? 'ok' : result;
  }

  const TOOL_IMPL = {
    get_document: async (d) => ({
      name: d.name,
      width: d.width,
      height: d.height,
      dpi: d.dpi,
      activeLayer: d.active?.id ?? null,
      layers: d.layers().map((l) => layerInfo(d, l)),
      selection: d.selection && !d.selection.isEmpty ? d.selection.bounds : null,
      description: d.meta?.description ?? undefined,
    }),
    set_active_layer: async (d, { id }) => {
      const l = findLayer(d, id);
      d.setActive(l);
      return `Active layer: ${l.name} (${l.id})`;
    },
    apply_adjustment: async (d, { kind, params }) => {
      if (!ADJUSTMENTS[kind]) throw new Error(`Unknown adjustment "${kind}"`);
      needRaster(d);
      const p = withDefaults(app.adjustments?.[kind]?.defaults ?? ADJUSTMENTS[kind].defaults, sanitizeParams(objectArg(params, 'params'), ADJUST_RANGES));
      await runCommand(`image:adjust-${kind}`, p);
      return `Applied ${ADJUSTMENTS[kind].name} to "${d.active.name}"`;
    },
    apply_filter: async (d, { kind, params }) => {
      if (!FILTERS[kind]) throw new Error(`Unknown filter "${kind}"`);
      needRaster(d);
      // the dialog's field ranges for this kind win over the shared table (vignette's size is 0..1, mosaic's 2..200)
      const ranges = { ...FILTER_RANGES, ...(app.filterEditor?.ranges?.(kind) ?? {}) };
      // the defaults the instructions advertise (not the last dialog run, which can carry dialog-only keys such as Shear's __bend)
      const p = withDefaults(FILTERS[kind].defaults, sanitizeParams(objectArg(params, 'params'), ranges));
      await runCommand(`filter:${kind}`, p);
      return `Applied ${FILTERS[kind].name} to "${d.active.name}"`;
    },
    run_command: async (d, { id, arg }) => {
      if (typeof id !== 'string' || BLOCKED_COMMANDS.test(id)) throw new Error(`Command "${id}" cannot be run by the assistant`);
      arg = valueArg(arg);
      return runCommand(id, arg && typeof arg === 'object' ? sanitizeParams(arg, {}) : arg);
    },
    new_layer: async (d, { name } = {}) => {
      const layer = new RasterLayer({ name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : nextLayerName(d), width: d.width, height: d.height, x: 0, y: 0 });
      structural(app, 'New layer', () => {
        d.add(layer);
        d.setActive(layer);
      });
      return { id: layer.id, name: layer.name };
    },
    set_layer_props: async (d, { id, opacity, blend, visible, name }) => {
      const l = findLayer(d, id);
      const patch = {};
      // null means "leave unchanged" (models fill unused fields with null), never a value
      if (opacity != null) patch.opacity = num(opacity, 'opacity', 0, 100) / 100;
      if (blend != null) {
        if (!BLEND_LABELS[blend] && !(blend === 'pass-through' && l.isGroup)) throw new Error(`Unknown blend mode "${blend}"`);
        patch.blend = blend;
      }
      if (visible != null) patch.visible = typeof visible === 'string' ? !/^(false|0|no|off)$/i.test(visible) : !!visible;
      if (name != null) {
        patch.name = String(name).trim().slice(0, 80);
        if (!patch.name) throw new Error('name is empty');
      }
      if (!Object.keys(patch).length) throw new Error('Nothing to change');
      setLayerProps(app, l, patch, 'Layer properties');
      return `Updated ${l.name}: ${Object.keys(patch).join(', ')}`;
    },
    select: async (d, { kind, rect }) => {
      if (kind === 'all') app.applySelection(Selection.all(d.width, d.height), 'replace', 'Select all');
      else if (kind === 'none') app.applySelection(null, 'replace', 'Deselect');
      else if (kind === 'inverse') app.applySelection(d.selection && !d.selection.isEmpty ? d.selection.invert() : Selection.all(d.width, d.height), 'replace', 'Inverse');
      else if (kind === 'rect') app.applySelection(Selection.fromRect(d.width, d.height, rectArg(d, rect)), 'replace', 'Rectangular selection');
      else throw new Error("kind must be 'all', 'none', 'inverse' or 'rect'");
      return d.selection && !d.selection.isEmpty ? { selection: d.selection.bounds } : 'No selection';
    },
    crop: async (d, { rect }) => {
      const r = rectArg(d, rect);
      await runCommand('image:crop-rect', { rect: r, deletePixels: true, label: 'Crop' });
      return `Cropped to ${d.width} × ${d.height}`;
    },
    resize_image: async (d, { width, height }) => {
      const w = Math.round(num(width, 'width', 1, 30000)), h = Math.round(num(height, 'height', 1, 30000));
      await runCommand('image:size', { width: w, height: h, method: 'bicubic', scaleStyles: true });
      return `Image is now ${d.width} × ${d.height}`;
    },
    canvas_size: async (d, { width, height, anchor }) => {
      const w = Math.round(num(width, 'width', 1, 30000)), h = Math.round(num(height, 'height', 1, 30000));
      const a = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'].includes(anchor) ? anchor : 'c';
      // like the Canvas Size dialog: an opaque Background is extended with the background colour
      const color = hasOpaqueBackground(d) ? app.settings.background : null;
      await runCommand('image:canvas-size', { width: w, height: h, anchor: a, color });
      return `Canvas is now ${d.width} × ${d.height}; the added area is ${color ? `filled with ${color}` : 'transparent'}`;
    },
    fill_selection: async (d, { color }) => {
      const { hex, alpha } = colorArg(color);
      const l = needRaster(d);
      if (l.type !== 'raster') throw new Error('Fill needs a raster layer');
      const hasSel = !!d.selection && !d.selection.isEmpty;
      const where = hasSel ? 'the selection' : 'the layer';
      if (alpha <= 0) {
        // a transparent colour clears: Edit › Clear inside a selection; the whole layer canvas without one
        // (edit:clear without a selection deletes the layer, which is not what "fill with transparent" means)
        if (l.locked.transparency) throw new Error(`Layer "${l.name}" has its transparency locked`);
        if (hasSel) await runCommand('edit:clear');
        else d.history.pixels('Clear', l.canvas, { x: 0, y: 0, width: l.canvas.width, height: l.canvas.height }, (ctx) => ctx.clearRect(0, 0, l.canvas.width, l.canvas.height), { layer: l });
        return `Cleared ${where} to transparent`;
      }
      const opacity = Math.round(alpha * 100);
      await runCommand('edit:fill', { use: 'color', color: hex, opacity, blend: 'normal', preserve: false });
      return `Filled ${where} with ${hex}${opacity < 100 ? ` at ${opacity} % opacity` : ''}`;
    },
    add_text: async (d, { text, x, y, size, color }) => {
      const t = String(text ?? '').slice(0, 2000);
      if (!t.trim()) throw new Error('text is empty');
      // null means "use the default", as for the colour
      const fontSize = size == null ? Math.max(12, Math.round(d.height / 12)) : Math.round(num(size, 'size', 4, 2000));
      const px = x == null ? Math.round(d.width * 0.1) : Math.round(num(x, 'x', -d.width, d.width * 2));
      const py = y == null ? Math.round(d.height * 0.1 + fontSize) : Math.round(num(y, 'y', -d.height, d.height * 2));
      const fontColor = color == null ? app.settings.foreground : colorArg(color).hex;
      const layer = new TextLayer({ text: t, x: px, y: py, font: { size: fontSize, color: fontColor } });
      structural(app, 'Add text', () => {
        d.add(layer);
        d.setActive(layer);
      });
      return { id: layer.id, name: layer.name };
    },
    generative_fill: async (d, { prompt }) => {
      if (!d.selection || d.selection.isEmpty) throw new Error('Generative fill needs a selection: call select first');
      if (!app.aiFeatures?.generativeFill) throw new Error('Generative fill is not available');
      const p = String(prompt ?? '').trim();
      if (!p) throw new Error('prompt is empty');
      const ids = await app.aiFeatures.generativeFill({ prompt: p });
      if (!ids?.length) throw new Error('Generative fill produced no layer (an image model may not be connected)');
      return { layers: ids };
    },
  };

  async function callTool(d, name, args, { call = null, notify = null } = {}) {
    const impl = TOOL_IMPL[name];
    if (!impl) throw new Error(`Unknown tool "${name}"`);
    if (app.doc !== d) throw new Error('The document is no longer active');
    app.tools?.active?.commit?.();
    args = parseMaybeJson(args);
    currentCall = call;
    currentNotify = notify ?? (() => {});
    try {
      return await impl(d, args && typeof args === 'object' ? args : {});
    } finally {
      currentCall = null;
      currentNotify = () => {};
    }
  }

  // ---- turns ------------------------------------------------------------------------------------------------------------

  /** The composite downscaled for the model, as a data URL. */
  function attachedImage(d) {
    const flat = flattenDocument(d, d.view?.compositor);
    return canvasToDataUrl(downscale(flat, IMAGE_EDGE));
  }

  /**
   * Sends a user message for the active document. opts: { provider, model, attach }. Progress reaches the
   * panel through app.emit('assistant:changed', { doc }). Resolves with the assistant message (or null
   * when stopped / failed; the failure is recorded in the conversation).
   */
  async function send(text, { provider, model, attach = true } = {}) {
    const d = app.doc;
    if (!d) throw new Error('Open a document first');
    if (running) throw new Error('The assistant is still working');
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    if (!app.ai) throw new Error('AI is not available in this build');
    if (!provider) provider = await app.ai.ensureConnected('chat');
    if (!provider) return null;
    if (!model) model = await app.ai.model(provider, 'chat');
    if (!model) throw Object.assign(new Error(`No ${PROVIDERS[provider].label} chat model is available`), { code: 'not_connected' });
    const c = convo(d);
    const userMsg = { role: 'user', text: clean, at: Date.now() };
    if (attach) {
      try {
        userMsg.image = attachedImage(d);
      } catch (err) {
        console.warn('assistant: could not attach the image', err);
      }
    }
    c.messages.push(userMsg);
    if (c.messages.length > MAX_TURNS) c.messages.splice(0, c.messages.length - MAX_TURNS);
    const pending = { role: 'assistant', text: '', calls: [], pending: true, at: Date.now() };
    c.messages.push(pending);
    let onStop;
    const stopSignal = new Promise((resolve) => (onStop = resolve));
    const run = {
      doc: d,
      stopped: false,
      stop: () => {
        run.stopped = true;
        onStop();
      },
    };
    running = run;
    app.emit('assistant:changed', { doc: d, running: true });
    const notify = () => app.emit('assistant:changed', { doc: d, running: !!running });
    // only the latest user message carries the image: earlier ones are resent as text to keep requests small
    const history = c.messages.filter((m) => !m.pending && !m.error).map((m, i, all) => ({ role: m.role, text: m.text, images: m.image && i === all.length - 1 ? [m.image] : undefined }));
    try {
      // Stop ends the turn at once: a request still in flight is dropped when it answers (its tools never run)
      const chatPromise = app.ai.providers.chat({
        provider,
        model,
        instructions: instructions(),
        messages: history,
        tools: TOOLS,
        maxRounds: MAX_ROUNDS,
        shouldStop: () => run.stopped,
        onToolCall: async (name, args) => {
          // Stop ends the turn: no more tools, no more provider requests (the providers abort on this error)
          if (run.stopped) throw stoppedError();
          const call = { name, args, result: null, pending: true };
          pending.calls.push(call);
          notify();
          try {
            call.result = await callTool(d, name, args, { call, notify });
          } catch (err) {
            call.result = { error: err?.message ?? String(err) };
          }
          call.pending = false;
          notify();
          if (run.stopped) throw stoppedError();
          return call.result;
        },
      });
      chatPromise.catch(() => {}); // a request answering after Stop is dropped
      const result = await Promise.race([chatPromise, stopSignal.then(() => Promise.reject(stoppedError()))]);
      if (run.stopped) {
        pending.text = pending.text || 'Stopped.';
        pending.stopped = true;
      } else if (result.truncated) {
        pending.text = `${result.text ? `${result.text}\n\n` : ''}Stopped after ${MAX_ROUNDS} tool steps; say "continue" to go on.`;
        pending.truncated = true;
      } else pending.text = result.text || (pending.calls.length ? 'Done.' : '(no answer)');
    } catch (err) {
      if (run.stopped || err?.code === 'stopped') {
        pending.text = pending.text || 'Stopped.';
        pending.stopped = true;
      } else {
        pending.error = err?.message ?? String(err);
        pending.text = pending.error;
        if (err?.code === 'not_connected' || /not connected/i.test(pending.error)) pending.needsAccounts = true;
      }
    } finally {
      pending.pending = false;
      running = null;
      notify();
    }
    return pending;
  }

  function stop() {
    if (!running) return false;
    running.stop();
    app.emit('assistant:changed', { doc: running.doc, running: true, stopping: true });
    return true;
  }

  function clear(d = app.doc) {
    if (!d) return;
    conversations.delete(d.id);
    app.emit('assistant:changed', { doc: d, running: running?.doc === d });
  }

  app.assistant = {
    send,
    stop,
    clear,
    messages: (d = app.doc) => (d ? convo(d).messages : []),
    isRunning: (d = app.doc) => !!running && (!d || running.doc === d),
    tools: TOOLS,
    instructions,
    callTool: (name, args) => callTool(app.doc, name, args),
    parseMaybeJson,
    describeCall,
  };

  app.commands.registerAll({
    'ai:assistant': {
      run: () => {
        app.panels.show('assistant', { reveal: true });
        app.emit('assistant:focus');
      },
      label: 'AI Assistant',
    },
  });
}
