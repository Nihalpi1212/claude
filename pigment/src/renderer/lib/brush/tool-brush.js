// The tool's brush (ARCHITECTURE.md "0.5 features", S1.2, S1.3). Skeleton file: no package edits it.
//
// Each painting tool has its own current brush, as in Photoshop. settings.tools[toolId] keeps 0.4's flat keys (size,
// hardness, angle, roundness, opacity, flow, smoothing, pressureSize, pressureOpacity, blend, lockAlpha), gains a flat
// `spacing`, and `brush` (a full BrushPreset), `brushPresetId` and `smoothingOptions`. The flat keys win for size,
// hardness, angle, roundness and spacing: 0.4 code, the [ ] keys, the resize HUD, arrow rotation and the specs set
// them with setOpt. setToolBrush writes all of them together, so they never disagree after a pick.
//
// Sampled tips are decoded here (prepareBrush) into a cache the engine reads synchronously (sampleCanvas). The sample
// blobs live in the `brushes` preset kind, content-addressed, and are never removed.
//
// Node-safe at import time (lib/brush/engine.js imports sampleCanvas): the DOM is used only when a tip is decoded.
import { normalizeBrush, legacyTip, withSections, withoutSampleData, brushFromLegacy } from './preset.js';

const DEFAULT_SMOOTHING_OPTIONS = Object.freeze({ mode: 'average', catchUp: false, catchUpOnEnd: false, adjustForZoom: true });
const TIP_FLAT = ['size', 'hardness', 'angle', 'roundness', 'spacing'];
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const hasOption = (tool, key) => !!tool?.options?.some((o) => o.key === key);

/**
 * 'full': StrokeTool subclasses with a size option (every section applies); 'tip': the DabTool family (size and
 * hardness only in 0.5); false: other tools. Read from the tool's shape, so this file imports no tool module.
 */
export function supportsBrush(tool) {
  if (!tool || typeof tool.baseSettings !== 'function' || !hasOption(tool, 'size')) return false;
  return typeof tool.dabAt === 'function' ? 'tip' : 'full';
}

/** The tool's brush: the stored preset with the flat tip keys applied, and the tool's paint settings (ToolPaint). */
export function toolBrush(app, toolId) {
  const stored = app.settings?.tools?.[toolId] ?? {};
  const opt = (k) => (app.tools?.opt ? app.tools.opt(toolId, k) : stored[k]);
  const preset = normalizeBrush(isObject(stored.brush) ? stored.brush : {});
  for (const k of ['size', 'hardness', 'angle', 'roundness']) {
    const v = opt(k);
    if (finite(v)) preset.tip[k] = v;
  }
  const spacing = finite(stored.spacing) ? stored.spacing : isObject(stored.brush) ? preset.tip.spacing : app.settings?.brush?.spacing ?? 0.12;
  preset.tip.spacing = spacing;
  const paint = {
    opacity: opt('opacity') ?? 1,
    flow: opt('flow') ?? 1,
    blend: opt('blend') ?? 'normal',
    smoothing: opt('smoothing') ?? 0.2,
    smoothingOptions: { ...DEFAULT_SMOOTHING_OPTIONS, ...(isObject(stored.smoothingOptions) ? stored.smoothingOptions : {}) },
    pressureSize: opt('pressureSize') ?? true,
    pressureOpacity: opt('pressureOpacity') ?? false,
    lockAlpha: opt('lockAlpha') ?? false,
  };
  // clamp what the flat keys brought in to the schema's ranges
  return { preset: normalizeBrush(preset), paint };
}

/** The flat value to store for `key`, clamped to the tool's own option (DabTools stop at 1000 px, S2.7). */
function flatValue(tool, key, v) {
  const spec = tool?.options?.find((o) => o.key === key);
  if (spec?.min !== undefined) v = Math.max(spec.min, v);
  if (spec?.max !== undefined) v = Math.min(spec.max, v);
  return v;
}

/** Whether setToolBrush writes the flat tip key for this tool (the keys 0.4's Brushes panel set for it). */
function writesFlat(tool, key) {
  if (!tool) return true;
  if (hasOption(tool, key)) return true;
  return (key === 'angle' || key === 'roundness' || key === 'spacing') && supportsBrush(tool) === 'full';
}

/**
 * Makes `preset` the tool's brush: `brush`, the flat keys and `brushPresetId` in one saveSettingsSoon, the options
 * bar and the cursor updated, 'tool:options' { tool, key: 'brush', value, presetId } emitted, the tip decoded.
 * respectLocks: the sections in settings.brushes.locks keep the current values; includeTool: preset.tool's values go
 * to the flat opacity / flow / blend / smoothing and tool.color to the foreground. brushPresetId changes only when a
 * presetId is given (an edit never clears it).
 */
export function setToolBrush(app, toolId, preset, { respectLocks = true, includeTool = true, presetId = null } = {}) {
  const tool = app.tools?.get?.(toolId) ?? null;
  const current = toolBrush(app, toolId).preset;
  let next = normalizeBrush(preset);
  if (respectLocks) {
    const locks = app.settings?.brushes?.locks;
    const ids = isObject(locks) ? Object.keys(locks).filter((k) => locks[k]) : [];
    if (ids.length) next = withSections(next, current, ids);
  }
  // Protect Texture: the current pattern and scale stay on every brush with a texture
  if (current.protectTexture && next.texture.enabled) {
    next.texture.pattern = current.texture.pattern ? { ...current.texture.pattern } : null;
    next.texture.scale = current.texture.scale;
  }
  const stored = { ...(app.settings?.tools?.[toolId] ?? {}) };
  const written = [];
  const tip = legacyTip(next);
  for (const k of TIP_FLAT) {
    if (!writesFlat(tool, k)) continue;
    stored[k] = flatValue(tool, k, tip[k]);
    written.push(k);
  }
  if (includeTool && next.tool) {
    for (const k of ['opacity', 'flow', 'blend', 'smoothing']) {
      // only the options the tool has (0.4's Brushes panel set flow only where the tool has a Flow option)
      if (next.tool[k] === undefined || (tool && !hasOption(tool, k))) continue;
      stored[k] = typeof next.tool[k] === 'number' ? flatValue(tool, k, next.tool[k]) : next.tool[k];
      written.push(k);
    }
  }
  stored.brush = withoutSampleData(next);
  if (presetId !== null && presetId !== undefined) stored.brushPresetId = presetId;
  const tools = { ...(app.settings?.tools ?? {}), [toolId]: stored };
  app.settings.tools = tools;
  app.saveSettingsSoon({ tools });
  if (includeTool && next.tool?.color) app.setColors?.({ foreground: next.tool.color });
  if (app.tools?.active?.id === toolId) {
    for (const k of written) app.tools.updateControl(k, stored[k]);
    if (!written.length) app.tools.updateControl('preset');
    app.tools.updateCursor();
  }
  app.view?.invalidate();
  app.emit?.('tool:options', { tool: toolId, key: 'brush', value: stored.brush, presetId: stored.brushPresetId ?? null });
  // the decode starts from the incoming preset, which may carry its tip as a data URL only
  prepareBrush(app, next).catch((err) => console.warn('Brush tip could not be prepared', err));
  return stored.brush;
}

// ---- sampled tips -------------------------------------------------------------------------------------------------

const decoded = new Map(); // sample key (hash, else blob name) -> canvas with the coverage in alpha
const sampleBytes = new Map(); // sample key -> the PNG bytes (withSampleData)
const pending = new Map(); // sample key -> Promise

const keyOf = (ref) => ref?.hash || ref?.blob || '';

/** The decoded sample of a sampled tip (coverage in alpha), or null until prepareBrush finished. Sync, for the engine. */
export function sampleCanvas(hash) {
  return decoded.get(hash) ?? null;
}

/** Every sampled tip of the preset is decoded (computed tips always are). */
export function brushReady(preset) {
  const p = normalizeBrush(preset);
  return sampledRefs(p).every((ref) => decoded.has(keyOf(ref)));
}

function sampledRefs(p) {
  const out = [];
  if (p.tip.kind === 'sampled' && p.tip.sample) out.push(p.tip.sample);
  if (p.dualBrush.enabled && p.dualBrush.tip.kind === 'sampled' && p.dualBrush.tip.sample) out.push(p.dualBrush.tip.sample);
  return out;
}

function bytesFromDataUrl(url) {
  const comma = url.indexOf(',');
  if (comma < 0) return null;
  const head = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (!/;base64$/i.test(head)) return new TextEncoder().encode(decodeURIComponent(body));
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** A grey PNG (white = full coverage) to a canvas whose alpha is the coverage. */
async function decodeCoverage(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i + 3] = Math.round((grey * d[i + 3]) / 255);
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function prepareSample(app, ref) {
  const key = keyOf(ref);
  if (!key || decoded.has(key)) return;
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    let bytes = null;
    try {
      bytes = await app.presets?.readBlob?.('brushes', ref.blob);
    } catch {
      bytes = null;
    }
    if (bytes && !(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (!bytes?.length && ref.dataUrl) {
      bytes = bytesFromDataUrl(ref.dataUrl);
      // the tip arrived as data (a replay, an imported tool preset): it becomes a blob of the `brushes` kind
      if (bytes?.length) await Promise.resolve(app.presets?.writeBlob?.('brushes', ref.blob, bytes)).catch(() => {});
    }
    if (!bytes?.length) return;
    const canvas = await decodeCoverage(bytes);
    decoded.set(key, canvas);
    sampleBytes.set(key, bytes);
    app.view?.invalidate?.();
  })().finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

/** Decodes the preset's sampled tips (blob, else dataUrl, which it also writes into `brushes`) and awaits its pattern. */
export async function prepareBrush(app, preset) {
  const p = normalizeBrush(preset);
  const jobs = sampledRefs(p).map((ref) => prepareSample(app, ref).catch((err) => console.warn('Brush tip could not be decoded', err)));
  if (p.texture.enabled && p.texture.pattern?.presetId) jobs.push(Promise.resolve(app.patterns?.get?.(p.texture.pattern.presetId)).catch(() => null));
  await Promise.all(jobs);
}

/** A copy whose SampleRefs carry their PNG as dataUrl (replay arguments, exports). */
export async function withSampleData(app, preset) {
  const p = normalizeBrush(preset);
  for (const t of [p.tip, p.dualBrush.tip]) {
    const ref = t.sample;
    if (!ref || ref.dataUrl) continue;
    let bytes = sampleBytes.get(keyOf(ref)) ?? null;
    if (!bytes) {
      try {
        bytes = await app.presets?.readBlob?.('brushes', ref.blob);
      } catch {
        bytes = null;
      }
    }
    if (bytes?.length) ref.dataUrl = `data:image/png;base64,${base64(new Uint8Array(bytes))}`;
  }
  return p;
}

// ---- install --------------------------------------------------------------------------------------------------

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) freezeDeep(v);
  }
  return o;
}

/**
 * S1.2 migration: 0.4's settings.brushPresets join the `brushes` kind once, under their own ids. The store's add()
 * makes new ids, so the entries go into its order the way its loader puts them (presets.js is not edited in 0.5).
 */
async function migrateBrushPresets(app) {
  if (app.settings?.brushes?.migrated === true) return;
  const old = Array.isArray(app.settings?.brushPresets) ? app.settings.brushPresets.filter((p) => isObject(p) && Number.isFinite(Number(p.size))) : [];
  if (!old.length || !app.presets) return;
  await app.presets.ready('brushes');
  const s = app.presets.state('brushes');
  const have = new Set(app.presets.list('brushes').map((p) => p.id));
  const ids = [];
  for (const p of old) {
    const id = typeof p.id === 'string' && p.id && !have.has(p.id) ? p.id : `u-${Math.random().toString(36).slice(2, 10)}`;
    have.add(id);
    s.order.push({ preset: freezeDeep({ id, name: String(p.name ?? 'Brush'), group: null, data: withoutSampleData(brushFromLegacy(p)), builtin: false }) });
    ids.push(id);
  }
  app.presets.changedState(s, 'add', ids);
  app.saveSettingsSoon({ brushes: { ...(app.settings.brushes ?? {}), migrated: true } });
}

/** start(): the migration, tool:brush-preset, and the active tool's tip decoded on 'tool:changed'. */
export function installToolBrush(app) {
  let lastPaintTool = 'brush';
  app.on('tool:changed', ({ tool }) => {
    if (!supportsBrush(tool)) return;
    lastPaintTool = tool.id;
    prepareBrush(app, toolBrush(app, tool.id).preset).catch(() => {});
  });
  migrateBrushPresets(app).catch((err) => console.warn('Brush presets could not be migrated', err));

  app.commands.register('tool:brush-preset', {
    label: 'Brush Preset',
    // arg: a `brushes` preset id, or { id?, preset?, tool? }
    run: async (arg, ctx) => {
      const a = typeof arg === 'string' ? { id: arg } : isObject(arg) ? arg : {};
      const id = typeof a.id === 'string' ? a.id : null;
      let preset = a.preset ? normalizeBrush(a.preset) : null;
      if (!preset && id && app.presets) {
        await app.presets.ready('brushes');
        preset = app.presets.get('brushes', id)?.data ?? null;
      }
      if (!preset) {
        app.dialogs?.toast?.('That brush preset no longer exists', { kind: 'error', timeout: 2000 });
        ctx?.cancel?.();
        return false;
      }
      const toolId = typeof a.tool === 'string' && app.tools.get(a.tool) ? a.tool : supportsBrush(app.tools.active) ? app.tools.active.id : lastPaintTool;
      // the replay carries the preset and its tip, so it works where the preset or its blob does not exist
      ctx?.setReplayArg?.({ id, preset: await withSampleData(app, preset), ...(typeof a.tool === 'string' ? { tool: a.tool } : {}) });
      setToolBrush(app, toolId, preset, { presetId: id });
      return true;
    },
  });
}
