// The PSD reader (ARCHITECTURE.md "0.5 features", S4.1, S4.2, S4.4), skeleton file: 0.4's readPsdDocument as a loop
// over the registered mappers (registry.js). Each layer record goes to the first kind (by order) whose test passes,
// which builds the layer; a group's children are read into it, then every aspect runs on the layer in order (a
// group's after its children). Resources with order < 500 read before the layers, the others after (the built-in
// composite fallback for a file without layers). Open notices of the report become `doc.openNotices` (not saved),
// which documents.js shows after the document opened.
import { readPsd } from '#ag-psd';
import { Document } from '../document.js';
import { psdLayerKinds, psdAspects, psdResources, psdOptions } from './registry.js';
import { createReport } from './report.js';

/** Reads PSD/PSB bytes into a Document (layers, groups, masks, opacity, blend modes, clipping, text). */
export function readPsdDocument(bytes, { report = createReport() } = {}) {
  const opts = psdOptions('read', { skipThumbnail: true, skipLinkedFilesData: true });
  const psd = readPsd(bytes, opts);
  const doc = new Document({ width: psd.width, height: psd.height });
  const claims = new WeakMap();
  const ctx = {
    doc,
    psd,
    opts,
    report,
    parent: doc.root,
    claim(layer, part) {
      if (!claims.has(layer)) claims.set(layer, new Set());
      claims.get(layer).add(part);
    },
    claimed: (layer, part) => !!claims.get(layer)?.has(part),
    patterns: new Map((psd.patterns ?? []).map((p) => [p.id, p])), // PSD pattern id -> ag-psd PatternInfo
  };
  const kinds = psdLayerKinds().filter((k) => typeof k.read === 'function');
  const aspects = psdAspects().filter((a) => typeof a.read === 'function');
  const readLayer = (pl, parent) => {
    const at = { ...ctx, parent };
    const kind = kinds.find((k) => !k.test || k.test(pl, at));
    const layer = kind?.read(pl, at);
    if (!layer) return null;
    parent.children.push(layer);
    layer.parent = parent;
    if (layer.isGroup && Array.isArray(pl.children)) for (const child of pl.children) readLayer(child, layer);
    for (const aspect of aspects) aspect.read(pl, layer, at);
    return layer;
  };
  const resources = psdResources().filter((r) => typeof r.read === 'function');
  for (const r of resources) if (r.order < 500) r.read(psd, doc, ctx);
  for (const pl of psd.children ?? []) readLayer(pl, doc.root);
  for (const r of resources) if (r.order >= 500) r.read(psd, doc, ctx);
  doc.active = doc.root.children[doc.root.children.length - 1] ?? null;
  if (doc.active) doc.selected.add(doc.active);
  const notices = report.lines('open');
  if (notices.length) doc.openNotices = notices;
  return doc;
}
