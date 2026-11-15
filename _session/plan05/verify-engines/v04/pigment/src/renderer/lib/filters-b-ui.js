// Renderer side of filters-b (src/shared/pixels/filters-more-b.js): the custom openers of the two
// kinds whose parameters are not plain dialog fields. Displace needs a displacement map (another
// open document, a layer of this document or a file) and Flame needs a path (the work path or the
// active shape's path). Both openers build on the standard field editor (app.filterEditor.editor)
// inside a pixelEditDialog session, so previews, the selection limit, history and the actions
// recorder behave exactly like the other filter dialogs. Registered through
// app.filterEditor.register(kind, { open }); the kinds carry `ui: 'custom'` in the registry.
//
// Lighting Effects keeps the registry's field dialog (first light + surface properties); an
// on-canvas multi-light editor is not part of this module.
import { applyFilter } from '../../shared/pixels/filters.js';
import { bridge } from './bridge.js';
import { pixelEditDialog } from './adjust-ui.js';
import { flattenDocument } from './compositor.js';
import { openDocument } from './io.js';
import { renderLayersFlat } from './layer-ops.js';
import { currentPathTarget } from './tools/vector.js';

/**
 * A displacement map for the filter: { width, height, data } plus a label for the chooser. The
 * typed array stays as it is (a 2000 x 1500 map is 12 MB), but JSON serialisation drops the map,
 * so settings, Last Filter, actions and .pigment smart filters never store the pixels. Saved
 * smart filters therefore lose their map (the filter is then a no-op until it is re-chosen).
 */
function makeMap(width, height, data, label) {
  const map = { width, height, data, label };
  Object.defineProperty(map, 'toJSON', { value: () => null, enumerable: false });
  return map;
}

function mapFromCanvas(canvas, label) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return makeMap(id.width, id.height, id.data, label);
}

/** Converts a path in document space to the coordinates of a pixel edit session's region. */
function localPath(path, rect) {
  const shift = (p) => {
    const o = { ...p, x: p.x - rect.x, y: p.y - rect.y };
    if (p.inX !== undefined) o.inX = p.inX - rect.x;
    if (p.inY !== undefined) o.inY = p.inY - rect.y;
    if (p.outX !== undefined) o.outX = p.outX - rect.x;
    if (p.outY !== undefined) o.outY = p.outY - rect.y;
    return o;
  };
  return { subpaths: (path.subpaths ?? []).map((sp) => ({ closed: !!sp.closed, points: (sp.points ?? []).map(shift) })) };
}

export function install(app) {
  if (!app.filterEditor?.register) return; // filter-ui.js installs first (app.js MODULES order)

  // ---- Displace ---------------------------------------------------------------------------------------------

  /** Map sources offered by the chooser: other open documents, the layers of this document, a file. */
  function mapSources(doc) {
    const out = [];
    for (const d of app.docs.list()) if (d !== doc) out.push({ id: `doc:${d.id ?? d.name}`, label: `Document: ${d.name}`, load: () => mapFromCanvas(flattenDocument(d, d.view.compositor), `Document: ${d.name}`) });
    for (const l of doc.layers()) if (!l.isGroup) out.push({ id: `layer:${l.id}`, label: `Layer: ${l.name}`, load: () => mapFromCanvas(renderLayersFlat(doc, [l]), `Layer: ${l.name}`) });
    out.push({
      id: 'file',
      label: 'File…',
      load: async () => {
        const paths = await bridge.openFileDialog({ multiple: false, title: 'Choose a displacement map' });
        const path = Array.isArray(paths) ? paths[0] : paths;
        if (!path) return null;
        const name = path.split(/[\\/]/).pop();
        const bytes = await bridge.readFile(path);
        const d = await app.busy(`Opening ${name}…`, () => openDocument(bytes, { name, path }));
        return mapFromCanvas(flattenDocument(d), `File: ${name}`);
      },
    });
    return out;
  }

  async function openDisplace(kind, { params, def }) {
    const doc = app.doc;
    if (!doc) return null;
    const sources = mapSources(doc);
    let map = params.map && params.map.data ? params.map : null; // the previous session's map is still in memory
    let current = { ...params, map };
    // first choice: the previous map's source, else another open document, else a layer other than the active one
    const initial = (map && sources.find((s) => s.label === map.label)) ?? sources.find((s) => s.id.startsWith('doc:')) ?? sources.find((s) => s.id.startsWith('layer:') && s.id !== `layer:${doc.active?.id}`) ?? sources[0];
    const used = await pixelEditDialog(app, {
      title: def.name,
      params: current,
      margin: app.filterEditor.marginFor(kind, current),
      width: 460,
      editor: (onChange) => {
        const wrap = document.createElement('div');
        const row = document.createElement('div');
        row.className = 'dialog-form';
        const field = document.createElement('div');
        field.className = 'field span-all';
        const label = document.createElement('label');
        label.textContent = 'Map source';
        const select = document.createElement('select');
        select.className = 'select';
        select.dataset.key = '__map';
        const option = (value, text) => {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = text;
          select.appendChild(o);
          return o;
        };
        for (const s of sources) option(s.id, s.label);
        field.append(label, select);
        row.appendChild(field);
        const note = document.createElement('div');
        note.className = 'muted';
        note.style.cssText = 'font-size: 11px; margin: 4px 0 8px';
        note.dataset.key = '__map-note';
        const fieldsEd = app.filterEditor.editor(kind, current, (p) => {
          // the field editor hands out JSON clones, which drop the map: put it back
          current = { ...p, map };
          onChange(current);
        });
        wrap.append(row, note, fieldsEd.element);
        const describe = () => {
          note.textContent = map ? `${map.label} (${map.width} × ${map.height}${map.width === doc.width && map.height === doc.height ? '' : `, ${current.mapMode === 'tile' ? 'tiled' : 'stretched to fit'}`})` : 'Choose a map: its red channel displaces horizontally, green vertically.';
        };
        let loading = 0;
        const choose = async (id) => {
          const s = sources.find((x) => x.id === id);
          if (!s) return;
          const n = ++loading;
          try {
            const m = await s.load();
            if (n !== loading) return;
            if (m) {
              map = m;
              if (s.id === 'file') {
                // the chosen file joins the list so the selection shows what is loaded
                const fileId = `file:${m.label}`;
                if (!sources.find((x) => x.id === fileId)) {
                  sources.splice(sources.length - 1, 0, { id: fileId, label: m.label, load: () => m });
                  const o = option(fileId, m.label);
                  select.insertBefore(o, select.lastElementChild);
                }
                select.value = fileId;
              }
            } else if (map) select.value = sources.find((x) => x.label === map.label)?.id ?? select.value;
          } catch (err) {
            app.reportError(err, 'Could not load the displacement map');
          }
          current = { ...current, map };
          describe();
          onChange(current);
        };
        select.addEventListener('change', () => choose(select.value));
        if (initial) {
          select.value = initial.id;
          if (!map || map.label !== initial.label) choose(initial.id);
        }
        describe();
        return { element: wrap };
      },
      run: (img, p) => applyFilter(img, kind, p),
      // meta keeps the live map object (lib/depth.js re-runs the filter on deep pixels from it)
      meta: (p) => ({ filter: { kind, params: p } }),
    });
    return used;
  }

  // ---- Flame ------------------------------------------------------------------------------------------------

  /** The path Flame renders along: the chosen / work path, else the active shape layer's path (document space). */
  function flamePath() {
    const t = currentPathTarget(app);
    const path = t?.get?.();
    if (!path?.subpaths?.some((sp) => (sp.points?.length ?? 0) >= 2)) return null;
    return path;
  }

  async function openFlame(kind, { params, def }) {
    const doc = app.doc;
    if (!doc) return null;
    const path = flamePath();
    if (!path) {
      app.dialogs.toast('Draw a path first', { kind: 'error' });
      return null;
    }
    let current = { ...params, path: null };
    return pixelEditDialog(app, {
      title: def.name,
      params: current,
      margin: 0,
      width: 460,
      editor: (onChange, session) => {
        // the filter works in the session's pixel space: shift the document path into it
        const local = localPath(path, session.rect);
        current.path = local;
        const ed = app.filterEditor.editor(kind, current, (p) => {
          current = { ...p, path: local };
          onChange(current);
        });
        return ed;
      },
      run: (img, p) => applyFilter(img, kind, p),
      meta: (p) => ({ filter: { kind, params: p } }),
    });
  }

  app.filterEditor.register('displace', { open: openDisplace });
  app.filterEditor.register('flame', { open: openFlame });
}
