// Renderer side of Filters, part A (builder "filters-a"): the Lens Blur dialog. Every other kind in
// src/shared/pixels/filters-more-a.js is driven by its `fields` metadata through lib/filter-ui.js;
// Lens Blur also needs the document, because its depth map comes from the active layer's
// transparency, its layer mask or a saved alpha channel, so it registers a custom opener with
// app.filterEditor.register('lens-blur', { fields, open }). The opener runs the usual pixel edit
// dialog (live preview inside the selection, one history entry) and hands the depth map to the pure
// filter as params.depthMap; what it resolves with (remembered for Last Filter and recorded for
// actions) carries only the source name, never the map, so settings and action files stay small.
import { FILTERS, applyFilter } from '../../shared/pixels/filters.js';
import { buildForm } from './form.js';
import { pixelEditDialog, getPath, setPath } from './adjust-ui.js';

const KIND = 'lens-blur';
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Depth map for the pixel edit session (one byte per pixel of session.local, the region the filter
 * sees), read from the chosen source; null means a uniform blur. Pixels outside the document (a layer
 * that overhangs the canvas) read 0 for mask and channel sources.
 */
function depthMapFor(app, session, source) {
  const { target, local, rect } = session;
  const w = local.width, h = local.height;
  if (source === 'transparency') {
    const px = target.canvas.getContext('2d', { willReadFrequently: true }).getImageData(local.x, local.y, w, h).data;
    const map = new Uint8ClampedArray(w * h);
    for (let p = 0, i = 3; p < map.length; p++, i += 4) map[p] = px[i];
    return map;
  }
  const doc = app.doc;
  const fromDocument = (read) => {
    const map = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const dy = rect.y + y;
      if (dy < 0 || dy >= doc.height) continue;
      for (let x = 0; x < w; x++) {
        const dx = rect.x + x;
        if (dx >= 0 && dx < doc.width) map[y * w + x] = read(dx, dy);
      }
    }
    return map;
  };
  if (source === 'mask') {
    const mask = target.layer?.mask;
    if (!mask?.canvas) return null;
    // mask canvases keep the mask value in alpha (see beginPixelEdit in lib/adjust-ui.js)
    const mw = mask.canvas.width, mh = mask.canvas.height;
    const px = mask.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, mw, mh).data;
    return fromDocument((x, y) => (x < mw && y < mh ? px[(y * mw + x) * 4 + 3] : 0));
  }
  if (typeof source === 'string' && source.startsWith('channel:')) {
    const ch = (doc.channels ?? []).find((c) => String(c.id) === source.slice('channel:'.length));
    if (!ch?.mask) return null;
    return fromDocument((x, y) => ch.mask[y * doc.width + x]);
  }
  return null;
}

/** Dialog opener: open(kind, { params, def, ctx }) -> params | null (the contract of app.filterEditor.register). */
async function openLensBlur(app, { params, def }) {
  const doc = app.doc;
  if (!doc) return null;
  const layer = doc.active;
  const sources = [['none', 'None'], ['transparency', 'Transparency']];
  if (layer?.mask) sources.push(['mask', 'Layer Mask']);
  for (const ch of doc.channels ?? []) sources.push([`channel:${ch.id}`, ch.name]);
  const fields = def.fields.map((f) => (f.key === 'source' ? { ...f, options: sources } : f));
  // the remembered params name the source as the contract spells it ('alpha' + channel name); map it onto the select
  const start = { ...clone({ ...params, depthMap: undefined }), depthMap: null };
  if (start.source === 'alpha') {
    const ch = (doc.channels ?? []).find((c) => c.name === start.channel) ?? doc.channels?.[0];
    start.source = ch ? `channel:${ch.id}` : 'none';
  }
  if (!sources.some(([v]) => v === start.source)) start.source = 'none';
  delete start.channel;
  const used = await pixelEditDialog(app, {
    title: def.name,
    params: start,
    // the radius slider goes to 100 while the dialog is open, so the session reads that much around the selection
    margin: 102,
    width: 460,
    editor: (onChange, session) => {
      let last = { source: null, map: null };
      const withMap = (p) => {
        if (p.source !== last.source) last = { source: p.source, map: depthMapFor(app, session, p.source) };
        return { ...p, depthMap: last.map };
      };
      const values = {};
      for (const f of fields) if (f.key) values[f.key] = getPath(start, f.key) ?? (f.type === 'checkbox' ? false : 0);
      const current = clone(start);
      const form = buildForm(fields, {
        values,
        onChange: (v) => {
          for (const f of fields) if (f.key) setPath(current, f.key, v[f.key]);
          onChange(withMap(clone(current)));
        },
      });
      // a remembered depth-map source previews with its map from the first frame
      if (start.source !== 'none') onChange(withMap(clone(start)));
      return { element: form.element };
    },
    run: (img, p) => applyFilter(img, KIND, p),
    // listeners of 'pixels:committed' (16/32-bit re-runs) get the map; it is dropped from what is remembered below
    meta: (p) => ({ filter: { kind: KIND, params: { ...p } } }),
  });
  if (!used) return null;
  const { depthMap, ...rest } = used;
  void depthMap;
  if (typeof rest.source === 'string' && rest.source.startsWith('channel:')) {
    const ch = (doc.channels ?? []).find((c) => String(c.id) === rest.source.slice('channel:'.length));
    rest.source = 'alpha';
    rest.channel = ch?.name ?? '';
  }
  return rest;
}

export function install(app) {
  if (!app.filterEditor?.register || !FILTERS[KIND]) return;
  app.filterEditor.register(KIND, {
    fields: FILTERS[KIND].fields,
    margin: FILTERS[KIND].margin,
    open: (kind, opts) => openLensBlur(app, opts),
  });
}
