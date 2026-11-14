// Type target (ARCHITECTURE.md "0.4 features", B.7): what the Character and Paragraph panels, the Properties type
// sections, the options bar and the type commands act on. While text is being edited it is the editing session's
// selection (or its caret's insertion style); otherwise every selected, unlocked text layer as a whole.
// Skeleton version; owned by type-editing afterwards (which installs its editor as the selection provider).
import * as M from './model.js';
import { setLayerProps } from '../layer-ops.js';

/** @type {{ active(app): null | object } | null} */
let provider = null;

/** Installed by the Type tool's editor; `active(app)` returns the TypeSession being edited or null. */
export function setSelectionProvider(p) {
  provider = p ?? null;
}

const session = (app) => provider?.active(app) ?? null;

/** The provider calls it whenever the selection or the insertion style changes: emits 'type:selection'. */
export function selectionChanged(app) {
  const s = session(app);
  app.emit('type:selection', { layer: s?.layer ?? null, from: s ? s.from : null, to: s ? s.to : null });
}

/** Text layers a change applies to when nothing is being edited: the selected unlocked ones, else the active one. */
function targetLayers(doc) {
  if (!doc) return [];
  const sel = doc.selectedLayers().filter((l) => l.type === 'text' && !l.locked.all);
  if (sel.length) return sel;
  return doc.active?.type === 'text' && !doc.active.locked.all ? [doc.active] : [];
}

export function typeTargets(app) {
  const s = session(app);
  if (s) return { editing: true, layers: [s.layer], layer: s.layer, from: s.from, to: s.to };
  const layers = targetLayers(app.doc);
  return { editing: false, layers, layer: layers[0] ?? null, from: null, to: null };
}

/** Merges per-layer attribute reports: a value every layer agrees on, else MIXED (deep: per sub-key). */
function mergeReports(reports, deep) {
  if (!reports.length) return {};
  if (reports.length === 1) return reports[0];
  const out = {};
  const keys = new Set(reports.flatMap((r) => Object.keys(r)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const merge = (vals) => {
    if (vals.some((v) => v === M.MIXED)) return M.MIXED;
    if (vals.every((v) => same(v, vals[0]))) return vals[0];
    if (deep && vals.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const o = {};
      for (const k of new Set(vals.flatMap((v) => Object.keys(v)))) o[k] = merge(vals.map((v) => v[k]));
      return o;
    }
    if (deep && vals.every((v) => Array.isArray(v) && v.length === vals[0].length)) return vals[0].map((_, i) => merge(vals.map((v) => v[i])));
    return M.MIXED;
  };
  for (const k of keys) out[k] = merge(reports.map((r) => r[k]));
  return out;
}

/** Resolved character attributes of the selection, the caret's insertion style or the targeted layers (MIXED where they differ). */
export function readChar(app, { deep = false } = {}) {
  const s = session(app);
  if (s) {
    if (s.from === s.to) return M.resolveChar(s.insertionStyle ?? M.charAttrs(s.layer.content, s.from, s.to));
    return M.charAttrs(s.layer.content, s.from, s.to, { deep });
  }
  const layers = targetLayers(app.doc);
  if (!layers.length) return M.resolveChar(typeDefaults(app).char);
  return mergeReports(layers.map((l) => M.charAttrs(l.content, 0, Math.max(1, M.contentLength(l.content)), { deep })), deep);
}

export function readPara(app, { deep = false } = {}) {
  const s = session(app);
  if (s) return M.paraAttrs(s.layer.content, s.from, s.to, { deep });
  const layers = targetLayers(app.doc);
  if (!layers.length) return M.resolvePara(typeDefaults(app).para);
  return mergeReports(layers.map((l) => M.paraAttrs(l.content, 0, M.contentLength(l.content), { deep })), deep);
}

/**
 * Applies fn(layer) -> { content?, typeOptions?, width?, height? } to several text layers as one history entry. Its
 * mergeKey is 0.3's `text:${ids}:${keys}`, so consecutive changes of the same attributes (a colour-picker drag)
 * merge within 1.5 s when `merge` is set. One layer goes through setLayerProps (its own merge rule).
 */
export function editTypeLayers(app, layers, fn, { label, merge = false, keys = [] } = {}) {
  const doc = app.doc;
  if (!doc || !layers.length) return;
  if (layers.length === 1) {
    const l = layers[0];
    const patch = fn(l);
    if (!patch || !Object.keys(patch).length) return;
    // setLayerProps keys its merge on the patched fields, and every type change patches `content`: merge only a repeat
    // of the same change (label and attributes), as a session merges only a repeated command, so Font Size then Faux
    // Bold stay two steps
    const key = `text:${l.id}:${keys.join(',')}`;
    const h = doc.history, top = h.entries[h.index];
    setLayerProps(app, l, patch, label, { merge: merge && top?.typeKey === key && top.label === label });
    const pushed = h.entries[h.index];
    if (pushed && pushed !== top) pushed.typeKey = key;
    return;
  }
  const FIELDS = ['content', 'typeOptions', 'width', 'height'];
  const snap = (l) => Object.fromEntries(FIELDS.map((k) => [k, l[k]]));
  const before = layers.map(snap);
  const after = layers.map((l, i) => ({ ...before[i], ...(fn(l) ?? {}) }));
  const apply = (states) => {
    layers.forEach((l, i) => {
      Object.assign(l, states[i]);
      l.touch();
      doc.changed('props', { layer: l });
    });
  };
  const key = `text:${layers.map((l) => l.id).join('+')}:${keys.join(',')}`;
  const h = doc.history;
  const last = h.entries[h.index];
  apply(after);
  if (merge && last?.mergeKey === key && Date.now() - last.at < 1500) {
    h.merge(() => apply(after));
    return;
  }
  h.push({ label, undo: () => apply(before), redo: () => apply(after), bytes: 0, at: Date.now(), mergeKey: key });
  doc.changed('history');
}

/** Character attributes: a caret sets the insertion style, a range is one session edit, layers get it whole. */
export function applyChar(app, patch, { label = 'Character', merge = false } = {}) {
  const s = session(app);
  if (s) {
    if (s.from === s.to) s.setInsertionStyle(patch);
    else s.edit((content, from, to) => ({ content: M.applyChar(content, from, to, patch), from, to }), { label, merge });
    return;
  }
  editTypeLayers(app, targetLayers(app.doc), (l) => ({ content: wholeChar(l.content, patch) }), { label, merge, keys: Object.keys(patch) });
}

/** applyChar over the whole text, the insertion style of an empty text included. */
function wholeChar(content, patch) {
  const n = M.contentLength(content);
  if (n) return M.applyChar(content, 0, n, patch);
  return M.mapChar(content, (style) => {
    const out = { ...style };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  });
}

/** Paragraph attributes of every paragraph the selection touches (the caret's own), or of the targeted layers. */
export function applyPara(app, patch, { label = 'Paragraph', merge = false } = {}) {
  const s = session(app);
  if (s) {
    s.edit((content, from, to) => ({ content: M.applyPara(content, from, to, patch), from, to }), { label, merge });
    return;
  }
  editTypeLayers(app, targetLayers(app.doc), (l) => ({ content: M.applyPara(l.content, 0, M.contentLength(l.content), patch) }), { label, merge, keys: Object.keys(patch) });
}

/** Orientation, anti-aliasing, system layout of the edited layer or the targeted layers. */
export function applyTypeOptions(app, patch, { label = 'Type Options' } = {}) {
  const s = session(app);
  const next = (l) => M.normalizeTypeOptions({ ...l.typeOptions, ...patch });
  if (s) {
    s.edit((content, from, to) => ({ content, from, to, typeOptions: next(s.layer) }), { label });
    return;
  }
  editTypeLayers(app, targetLayers(app.doc), (l) => ({ typeOptions: next(l) }), { label, keys: Object.keys(patch) });
}

/** Point <-> paragraph text and the box size: width null = point text, height null = the box grows with the text. */
export function applyBox(app, box, { label = 'Text Box' } = {}) {
  const patch = {};
  if ('width' in box) patch.width = box.width === null ? null : Math.max(1, Number(box.width) || 1);
  if ('height' in box) patch.height = box.height === null ? null : Math.max(1, Number(box.height) || 1);
  const s = session(app);
  if (s) {
    s.edit((content, from, to) => ({ content, from, to, ...patch }), { label });
    return;
  }
  editTypeLayers(app, targetLayers(app.doc), () => ({ ...patch }), { label, keys: Object.keys(patch) });
}

// ---- defaults for new text ---------------------------------------------------------------------------------------

const TOOL_IDS = ['type-horizontal', 'type-vertical'];

/** What new text starts with: model defaults <- settings.type <- the type tools' options (family, style, size, align, colour). */
export function typeDefaults(app) {
  const st = app.settings?.type ?? {};
  const tool = app.tools?.get?.('type-horizontal');
  const opt = (k, d) => tool?.opt?.(k) ?? d;
  const style = String(opt('style', '400'));
  const char = { ...(st.char ?? {}) };
  char.fontFamily = opt('family', char.fontFamily ?? M.CHAR_DEFAULTS.fontFamily);
  char.fontWeight = parseInt(style, 10) || 400;
  char.fontItalic = style.endsWith('i');
  char.size = Math.max(0.1, Number(opt('size', char.size ?? M.CHAR_DEFAULTS.size)) || M.CHAR_DEFAULTS.size);
  char.color = app.settings?.foreground ?? char.color ?? M.CHAR_DEFAULTS.color;
  const para = { ...(st.para ?? {}), align: opt('align', st.para?.align ?? M.PARA_DEFAULTS.align) };
  return { char: M.resolveChar(char), para: M.resolvePara(para) };
}

/** Writes the options-bar attributes through the type tools' options, the rest into settings.type. */
export function setTypeDefaults(app, { char = null, para = null } = {}) {
  const tm = app.tools;
  const set = (k, v) => {
    for (const id of TOOL_IDS) if (tm?.get?.(id)) tm.setOpt(id, k, v, { silent: true });
    if (TOOL_IDS.includes(tm?.active?.id)) tm.updateControl?.(k, v);
  };
  const restChar = { ...(app.settings?.type?.char ?? {}) };
  const restPara = { ...(app.settings?.type?.para ?? {}) };
  if (char) {
    for (const [k, v] of Object.entries(char)) {
      if (k === 'fontFamily') set('family', v);
      else if (k === 'size') set('size', v);
      else if (k === 'color') app.setColors?.({ foreground: v });
      else if (k === 'fontWeight' || k === 'fontItalic') continue;
      else if (v === undefined) delete restChar[k];
      else restChar[k] = v;
    }
    if ('fontWeight' in char || 'fontItalic' in char) {
      const cur = typeDefaults(app).char;
      set('style', `${char.fontWeight ?? cur.fontWeight}${(char.fontItalic ?? cur.fontItalic) ? 'i' : ''}`);
    }
  }
  if (para) {
    for (const [k, v] of Object.entries(para)) {
      if (k === 'align') set('align', v);
      else if (v === undefined) delete restPara[k];
      else restPara[k] = v;
    }
  }
  if (app.saveSettingsSoon) app.saveSettingsSoon({ type: { ...(app.settings?.type ?? {}), char: restChar, para: restPara } });
  else if (app.settings) app.settings.type = { ...(app.settings.type ?? {}), char: restChar, para: restPara };
}
