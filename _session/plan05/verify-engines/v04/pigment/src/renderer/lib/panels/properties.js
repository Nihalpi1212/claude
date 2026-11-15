// Properties panel (middle group): context-sensitive settings of the active layer, built from sections
// (ARCHITECTURE.md "0.4 features", L.1; E18). The panel is a host: it renders, for the active layer (or the document
// when none), every registered section whose `test` passes and that no other passing section `hides`, in `order`,
// in two regions ('main', then 'mask'). The 0.3 sections live in lib/properties/*.js:
//   document, transform (lib/properties/transform.js)   fill (fill.js)        shape (shape.js)
//   text (text.js)   paragraph (paragraph.js, empty)   adjustment (adjustment.js)   mask (mask.js, region 'mask')
//
//   app.properties.registerSection({ id, order, region: 'main' | 'mask', test(layer | null, doc), hides?: string[],
//     render(layer, doc, { app, schedule(), keep(key) -> boolean }) -> HTMLElement | null, dispose?(element),
//     keepWhileTyping?: boolean })   // the later registration of an id wins; the built-ins never replace an earlier one
//   (app.properties exists from the App constructor on, so a package may register from install())
//
// Host rules: a section the user is typing in (an <input> inside it has focus, same layer) is not rebuilt, as in 0.3
// (`keepWhileTyping: false` opts out); `keep(key)` is true when the section rendered with the same key last time
// and its element is still shown, and `render` may then return that same element, which stays mounted (a drag in
// progress survives the re-render that setLayerProps causes); `dispose(element)` runs whenever the host removes or
// replaces an element, and on 'doc:closed'. Type sections re-render on 'type:selection', at most once per frame.
import { icon } from '../icons.js';
import { ADJUSTMENT_ICONS } from '../adjust-ui.js';
import { ADJUSTMENTS } from '../../../shared/pixels/adjust.js';
import { BLEND_LABELS } from '../document.js';
import { h, layerContentBounds, offsetLayer } from '../properties/ui.js';
// Namespace imports: each section file belongs to a package (L.1), which may drop the export and register its
// section from its own module instead; a missing export is then skipped rather than failing this whole panel.
import * as transformFile from '../properties/transform.js';
import * as fillFile from '../properties/fill.js';
import * as shapeFile from '../properties/shape.js';
import * as textFile from '../properties/text.js';
import * as paragraphFile from '../properties/paragraph.js';
import * as adjustmentFile from '../properties/adjustment.js';
import * as maskFile from '../properties/mask.js';

const BUILTIN_SECTIONS = () => [
  transformFile.documentSection,
  transformFile.transformSection,
  fillFile.fillSection,
  adjustmentFile.adjustmentSection,
  shapeFile.shapeSection,
  textFile.textSection,
  paragraphFile.paragraphSection,
  maskFile.maskSection,
].filter(Boolean);

// 0.3 exports, kept for other modules (panels/info.js) and tests
export { layerContentBounds, offsetLayer };

const TYPE_LABEL = { raster: 'Pixel layer', group: 'Group', text: 'Type layer', shape: 'Shape layer', fill: 'Fill layer', adjustment: 'Adjustment layer', smart: 'Smart object' };
const TYPE_ICON = { raster: 'image', group: 'folder', text: 'text', shape: 'shape', fill: 'fill', adjustment: 'adjust', smart: 'smart' };
const REGIONS = ['main', 'mask'];

// ---- panel ------------------------------------------------------------------------------------------------------
export function install(app) {
  const el = h('div', 'props-panel');
  const header = h('div', 'props-header');
  const main = h('div', 'props-main');
  const maskBox = h('div', 'props-mask');
  el.append(header, main, maskBox);
  const boxes = { main, mask: maskBox };

  const sections = new Map(); // id -> spec
  const records = new Map(); // id -> { region, element, key, docId, layerId }
  let pending = 0;

  const visible = () => app.panels.isVisible('properties');
  const schedule = () => {
    if (pending || !visible()) return;
    pending = requestAnimationFrame(render);
  };

  // app.properties is created in the App constructor (before MODULES), so packages may have registered sections
  // already: take them over, then add the built-ins, which never replace a section registered first
  for (const spec of app.properties.sections()) sections.set(spec.id, spec);
  app.properties.attachHost({
    changed(id) {
      if (sections.has(id)) dropRecord(id);
      sections.set(id, app.properties.sections().find((s) => s.id === id));
      schedule();
    },
    render: () => render(),
  });
  for (const s of BUILTIN_SECTIONS()) app.properties.registerSection(s, { builtin: true });

  function dispose(spec, element) {
    if (!element) return;
    try {
      spec?.dispose?.(element);
    } catch (err) {
      console.warn(`properties section ${spec?.id} dispose failed`, err);
    }
  }
  function dropRecord(id) {
    const rec = records.get(id);
    if (!rec) return;
    records.delete(id);
    dispose(sections.get(id), rec.element);
    rec.element?.remove();
  }
  function dropAll() {
    for (const id of [...records.keys()]) dropRecord(id);
  }

  function passes(spec, layer, doc) {
    try {
      return !!spec.test(layer, doc);
    } catch (err) {
      console.warn(`properties section ${spec.id} test failed`, err);
      return false;
    }
  }

  function render() {
    pending = 0;
    const doc = app.doc;
    if (!doc) {
      dropAll();
      header.replaceChildren();
      maskBox.replaceChildren();
      main.replaceChildren(h('div', 'panel-empty', 'No document open'));
      return;
    }
    const layer = doc.active ?? null;
    renderHeader(layer, doc);
    const passing = [...sections.values()].filter((s) => passes(s, layer, doc));
    const hidden = new Set(passing.flatMap((s) => (Array.isArray(s.hides) ? s.hides : [])));
    const shown = passing.filter((s) => !hidden.has(s.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const region of REGIONS) renderRegion(region, shown.filter((s) => s.region === region), layer, doc);
    for (const id of [...records.keys()]) if (!shown.some((s) => s.id === id)) dropRecord(id);
    main.dataset.layer = layer?.id ?? '';
  }

  function renderRegion(region, list, layer, doc) {
    const box = boxes[region];
    const layerId = layer?.id ?? null;
    const elements = [];
    for (const spec of list) {
      const rec = records.get(spec.id);
      const sameLayer = !!rec && rec.docId === doc.id && rec.layerId === layerId;
      const active = document.activeElement;
      // 0.3's rule: do not rebuild a form the user is typing in
      const typing = sameLayer && spec.keepWhileTyping !== false && !!rec.element?.isConnected && rec.element.contains(active) && active?.tagName === 'INPUT';
      let element;
      let key;
      if (typing) {
        element = rec.element;
        key = rec.key;
      } else {
        const ctx = {
          app,
          schedule,
          keep: (k) => {
            key = k;
            return !!rec && rec.key === k && !!rec.element?.isConnected && box.contains(rec.element);
          },
        };
        try {
          element = spec.render(layer, doc, ctx) ?? null;
        } catch (err) {
          console.error(`properties section ${spec.id} failed`, err);
          element = null;
        }
        if (rec?.element && rec.element !== element) dispose(spec, rec.element);
      }
      records.set(spec.id, { region, element, key, docId: doc.id, layerId });
      if (element) elements.push(element);
    }
    const same = elements.length === box.children.length && elements.every((n, i) => box.children[i] === n);
    if (!same) box.replaceChildren(...elements);
  }

  function renderHeader(layer, doc) {
    header.replaceChildren();
    const ic = h('span', 'props-icon');
    ic.innerHTML = icon(layer ? (layer.type === 'adjustment' ? ADJUSTMENT_ICONS[layer.kind] ?? 'adjust' : TYPE_ICON[layer.type] ?? 'layers') : 'image');
    const text = h('div', 'props-title');
    text.appendChild(h('strong', '', layer ? layer.name : doc.name));
    const sub = layer ? (layer.type === 'adjustment' ? `${ADJUSTMENTS[layer.kind]?.name ?? layer.kind} adjustment` : TYPE_LABEL[layer.type] ?? layer.type) : 'Document';
    text.appendChild(h('span', 'muted', sub + (layer && layer.blend !== 'normal' && layer.blend !== 'pass-through' ? ` · ${BLEND_LABELS[layer.blend] ?? layer.blend}` : '') + (layer && layer.opacity < 1 ? ` · ${Math.round(layer.opacity * 100)}%` : '')));
    header.append(ic, text);
  }

  // ---- events -------------------------------------------------------------------------------------------------
  app.on('doc:activated', schedule);
  app.on('layer:activated', schedule);
  app.on('history:changed', schedule);
  app.on('mask:editing', schedule);
  // the caret or the selection of the text being edited moved: the type sections show its formatting (B.7)
  app.on('type:selection', schedule);
  app.on('doc:closed', () => {
    dropAll();
    schedule();
  });
  app.on('doc:change', (e) => {
    if (['props', 'tree', 'active', 'canvas', 'mask-edit', 'history'].includes(e.kind)) schedule();
    else if (e.kind === 'pixels' || e.kind === 'mask') {
      clearTimeout(schedule.timer);
      schedule.timer = setTimeout(schedule, 300); // content bounds and mask thumbnail after painting
    }
  });

  app.panels.register({
    id: 'properties',
    title: 'Properties',
    icon: 'properties',
    element: el,
    group: 'middle',
    onShow: () => {
      cancelAnimationFrame(pending);
      render();
    },
  });
  render();
  // helpers for other modules and tests
  app.offsetLayer = (layer, dx, dy, label) => offsetLayer(app, layer, dx, dy, label);
  app.layerContentBounds = layerContentBounds;
  return { render };
}
