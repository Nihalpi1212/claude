// Layer colour labels, link groups and the global light ↔ PSD (ARCHITECTURE.md "0.5 features", S4.3: aspect `tags`
// 500, resources `global-light` 250 and `link-groups` 510). psd-layers' file.
//
// - Colour labels: `layer.color` (lib/layers-extras/tags.js: Photoshop's eight names) as the record's 'lclr'.
// - Linked layers: `layer.linked` (a link set id) as Photoshop's link groups (image resources 1026 and 1072, which
//   ag-psd reads into each layer's `linkGroup` / `linkGroupEnabled`). A set needs two members, as in the Layers panel.
// - Global light: `doc.globalLight` ({ angle, altitude }; null is Photoshop's 120° / 30°) as image resources 1037 and
//   1049. Written when the document sets it or a layer has effects (which may use it).
//
// install(app) adds the save option and the Preferences section of file-handling.js.
import { registerPsdAspect, registerPsdResource, registerPsdFeatures } from './registry.js';
import { newId } from '../document.js';
import { installFileHandling } from './file-handling.js';

/** What this file has landed (S15); merged into psdFeatures() by the registry. */
export const PSD_FEATURES = Object.freeze({ tags: true, globalLight: true });
registerPsdFeatures(PSD_FEATURES);

const LABELS = new Set(['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray']);
const DEFAULT_LIGHT = Object.freeze({ angle: 120, altitude: 30 });

// per write: link set id -> Photoshop link group number; per read: group number -> the layers in it
const writeGroups = new WeakMap(); // psd -> Map
const readGroups = new WeakMap(); // doc -> Map<number, Layer[]>

function groupsFor(ctx) {
  let m = writeGroups.get(ctx.psd);
  if (!m) {
    // only sets with two or more members are written (a lone member is linked to nothing)
    const count = new Map();
    for (const l of ctx.doc.layers?.() ?? []) if (typeof l.linked === 'string' && l.linked) count.set(l.linked, (count.get(l.linked) ?? 0) + 1);
    m = new Map();
    for (const [id, n] of count) if (n >= 2) m.set(id, m.size + 1);
    writeGroups.set(ctx.psd, m);
  }
  return m;
}

registerPsdAspect({
  id: 'tags',
  order: 500,
  read(pl, layer, ctx) {
    if (LABELS.has(pl.layerColor)) layer.color = pl.layerColor;
    if (Number.isInteger(pl.linkGroup) && pl.linkGroup > 0 && pl.linkGroupEnabled !== false) {
      let m = readGroups.get(ctx.doc);
      if (!m) readGroups.set(ctx.doc, (m = new Map()));
      if (!m.has(pl.linkGroup)) m.set(pl.linkGroup, []);
      m.get(pl.linkGroup).push(layer);
    }
    ctx.claim(layer, 'tags');
  },
  write(layer, rec, ctx) {
    if (LABELS.has(layer.color)) rec.layerColor = layer.color;
    const n = typeof layer.linked === 'string' ? groupsFor(ctx).get(layer.linked) : undefined;
    if (n) {
      rec.linkGroup = n;
      rec.linkGroupEnabled = true;
    }
    if (rec.layerColor || n) ctx.claim(layer, 'tags');
  },
});

// after the layers: the groups read become link sets (two members or more)
registerPsdResource({
  id: 'link-groups',
  order: 510,
  read(psd, doc) {
    const m = readGroups.get(doc);
    if (!m) return;
    readGroups.delete(doc);
    for (const layers of m.values()) {
      if (layers.length < 2) continue;
      const id = newId('K');
      for (const l of layers) l.linked = id;
    }
  },
});

registerPsdResource({
  id: 'global-light',
  order: 250,
  read(psd, doc) {
    const ir = psd.imageResources ?? {};
    const angle = Number.isFinite(ir.globalAngle) ? ir.globalAngle : null;
    const altitude = Number.isFinite(ir.globalAltitude) ? ir.globalAltitude : null;
    if (angle === null && altitude === null) return;
    const light = { angle: angle ?? DEFAULT_LIGHT.angle, altitude: altitude ?? DEFAULT_LIGHT.altitude };
    // Photoshop's default is what an unset global light means in Pigment too
    if (light.angle !== DEFAULT_LIGHT.angle || light.altitude !== DEFAULT_LIGHT.altitude) doc.globalLight = light;
  },
  write(doc, psd) {
    const light = doc.globalLight && Number.isFinite(doc.globalLight.angle) ? doc.globalLight : null;
    const styled = (doc.layers?.() ?? []).some((l) => l.styles && typeof l.styles === 'object' && Object.keys(l.styles).length);
    if (!light && !styled) return;
    psd.imageResources = { ...(psd.imageResources ?? {}), globalAngle: light?.angle ?? DEFAULT_LIGHT.angle, globalAltitude: Number.isFinite(light?.altitude) ? light.altitude : DEFAULT_LIGHT.altitude };
  },
});

/** The renderer half: the PSD save option (Maximize Compatibility) and the File Handling Preferences section. */
export function install(app) {
  installFileHandling(app);
}
