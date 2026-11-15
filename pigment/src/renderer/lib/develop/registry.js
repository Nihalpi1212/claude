// Camera Raw registry (ARCHITECTURE.md "0.5 features", S8.2): the tabs, sections, tools and workspace slots the Camera
// Raw dialog (lib/develop-ui.js, then camera-raw-workspace's full-window workspace) is built from, the packages'
// capability flags (S15) and createFakeWorkspace, the DevelopWorkspace stand-in tools are tested on before the
// workspace lands. The develop stages themselves register in src/shared/pixels/develop-stages.js.
//
// Same id: the later registration wins, but a builtin never replaces an earlier registration (the skeleton's 0.4
// tabs in lib/develop/tabs-04.js are builtins, so a package that registers first keeps its replacement). A section's
// id is unique within its tab. Skeleton file; no package edits it (camera-raw-panels and camera-raw-workspace
// register from their own files). Node-safe: no DOM at import.
import { develop, normalizeDevelopParams } from '../../../shared/pixels/develop.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
let seq = 0;

function registry(name, keyOf) {
  const map = new Map();
  return {
    register(def, { builtin = false } = {}) {
      if (!def || typeof def.id !== 'string' || !def.id) throw new Error(`${name}: an id is required`);
      const key = keyOf(def);
      if (builtin && map.has(key)) return () => {};
      const entry = { def, builtin, seq: ++seq };
      map.set(key, entry);
      return () => {
        if (map.get(key) === entry) map.delete(key);
      };
    },
    list: () => [...map.values()].sort((a, b) => (Number(a.def.order) || 0) - (Number(b.def.order) || 0) || a.seq - b.seq).map((e) => e.def),
    builtin: (key) => map.get(key)?.builtin === true,
  };
}

const TABS = registry('registerDevelopTab', (d) => d.id);
const SECTIONS = registry('registerDevelopSection', (d) => `${d.tab}\u0000${d.id}`);
const TOOLS = registry('registerDevelopTool', (d) => d.id);
const SLOTS = registry('registerWorkspaceSlot', (d) => d.id);
const SLOT_PLACES = new Set(['toolbar-start', 'toolbar-end', 'panel-top', 'footer-start', 'footer-end', 'filmstrip']);

/** A tab of the Camera Raw dialog: { id, label, order, modes?: string[] } (modes: a segment control, HSL's three). */
export const registerDevelopTab = (def, opts) => TABS.register(def, opts);

/**
 * A section of a tab: { tab, id, label, order, fields?: FieldSpec[] | ((mode) => FieldSpec[]), render?(ctx), test?(ctx) }.
 * ctx: { params, get(path), set(path, value), app, session, workspace | null }. Field keys are param paths.
 */
export function registerDevelopSection(def, opts) {
  if (typeof def?.tab !== 'string') throw new Error('registerDevelopSection: a section names its tab');
  return SECTIONS.register(def, opts);
}

/**
 * A tool of the workspace's tool strip: { id, label, icon, key?, order, cursor, activate?(ws), deactivate?(ws),
 * down(p, ws), move?(p, ws, dragging), up?(p, ws), overlay?(ctx, ws) }; p in output image px plus the PointerSample
 * modifiers, overlay in screen CSS px.
 */
export function registerDevelopTool(def, opts) {
  if (typeof def?.down !== 'function') throw new Error('registerDevelopTool: down(p, ws) is required');
  return TOOLS.register(def, opts);
}

/** A slot of the workspace: { id, place, order, render(ws): HTMLElement }. */
export function registerWorkspaceSlot(def, opts) {
  if (!SLOT_PLACES.has(def?.place)) throw new Error(`registerWorkspaceSlot: place must be one of ${[...SLOT_PLACES].join(', ')}`);
  return SLOTS.register(def, opts);
}

/** The tabs in order, each with its sections in order (sections of an unregistered tab are left out). */
export function developTabs() {
  const sections = SECTIONS.list();
  return TABS.list().map((t) => ({ ...t, sections: sections.filter((s) => s.tab === t.id) }));
}

export const developTools = () => TOOLS.list();
export const workspaceSlots = (place = null) => SLOTS.list().filter((s) => !place || s.place === place);

/** True while the tab, section (`tab/section`), tool or slot registered under this id is a builtin. */
export function isBuiltinDevelop(kind, id) {
  if (kind === 'tab') return TABS.builtin(id);
  if (kind === 'section') return SECTIONS.builtin(id.replace('/', '\u0000'));
  if (kind === 'tool') return TOOLS.builtin(id);
  if (kind === 'slot') return SLOTS.builtin(id);
  return false;
}

// ---- capability flags (S15) ---------------------------------------------------------------------------------
const FEATURES = { workspace: false, panels: false };
/** { workspace, panels }: true once camera-raw-workspace / camera-raw-panels have landed. */
export const developFeatures = () => ({ ...FEATURES });
/** camera-raw-workspace calls setDevelopFeature('workspace'), camera-raw-panels setDevelopFeature('panels'). */
export function setDevelopFeature(name, on = true) {
  if (!(name in FEATURES)) throw new Error(`setDevelopFeature: unknown feature ${name}`);
  FEATURES[name] = !!on;
}

// ---- DevelopWorkspace stand-in ------------------------------------------------------------------------------
const getPath = (obj, path) => String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  o[keys[keys.length - 1]] = value;
}

/**
 * A DevelopWorkspace (S8.2) over an image, without a window: tools and sections are tested on it before
 * camera-raw-workspace lands, and the skeleton's dialog gives its tools one. Screen and image px are the same at
 * zoom 1 (toScreen / toImage scale by `zoom`). Beyond the interface it records what a tool did: `sets` (every set()
 * call), `invalidations` and `cursor`.
 * @param {object} params develop params (normalized)
 * @param {{ width, height, data }} image the pre-develop pixels (ws.source)
 * @param {{ origin?: { x, y }, onSet?(path, value, opts), onInvalidate?() }} [opts]
 */
export function createFakeWorkspace(params, image, { origin = { x: 0, y: 0 }, onSet = null, onInvalidate = null } = {}) {
  const ws = {
    params: normalizeDevelopParams(clone(params ?? {})),
    get: (path) => getPath(ws.params, path),
    set(path, value, { final = false } = {}) {
      setPath(ws.params, path, value);
      ws.sets.push({ path, value, final });
      onSet?.(path, value, { final });
    },
    source: Object.assign({ width: image?.width ?? 0, height: image?.height ?? 0, data: image?.data ?? new Uint8ClampedArray(0) }, { origin: { ...origin } }),
    /** [r, g, b] averaged over a (2·radius−1)² box: 'before' reads the source, anything else the developed image. */
    sample(pt, { radius = 1, stage = 'after' } = {}) {
      const src = ws.source;
      if (!src.width || !src.height) return [0, 0, 0];
      const r = Math.max(0, Math.round(radius) - 1);
      const cx = Math.round(pt.x), cy = Math.round(pt.y);
      const box = { x: Math.max(0, cx - r), y: Math.max(0, cy - r) };
      box.width = Math.min(src.width, cx + r + 1) - box.x;
      box.height = Math.min(src.height, cy + r + 1) - box.y;
      if (box.width <= 0 || box.height <= 0) return [0, 0, 0];
      let img = src;
      if (stage !== 'before') {
        img = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
        develop(img, ws.params, null);
      }
      const sum = [0, 0, 0];
      for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
        const o = (y * img.width + x) * 4;
        sum[0] += img.data[o];
        sum[1] += img.data[o + 1];
        sum[2] += img.data[o + 2];
      }
      const n = box.width * box.height;
      return sum.map((v) => Math.round(v / n));
    },
    toImage: (screenPt) => ({ x: screenPt.x / ws.zoom, y: screenPt.y / ws.zoom }),
    toScreen: (imagePt) => ({ x: imagePt.x * ws.zoom, y: imagePt.y * ws.zoom }),
    zoom: 1,
    activeTool: null,
    invalidate() {
      ws.invalidations++;
      onInvalidate?.();
    },
    setCursor(css) {
      ws.cursor = css;
    },
    sets: [],
    invalidations: 0,
    cursor: null,
  };
  return ws;
}
