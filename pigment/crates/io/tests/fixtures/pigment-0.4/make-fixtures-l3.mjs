// The documents with text layers and smart objects (with their smart filters). make-fixtures.mjs
// calls this file; README.md says how to run it.
//
// Smart-object documents are written twice, as in make-fixtures-layers.mjs: `<name>.pigment` by the
// app's writer and `<name>.png`, the picture the app's own compositor made of it, which the
// importer's tests compare with the picture of the opened document. Text documents are written
// without a picture: the app drew type with the fonts of the machine it ran on, so pictures would
// compare fonts, not the importer; the tests check the type layers' text, runs and geometry.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function l3Fixtures({ set, lib, out, io, D, add, canvasFrom, background, save }) {
  const { Document, RasterLayer, TextLayer } = D;
  const { flattenDocument } = await lib('renderer/lib/compositor.js');
  const v3 = set === 'v3';
  // The type facade sets the text backend (0.4) and text on a path and stacked vertical type are a
  // text extension the app installs at start. Their install also registers menu commands, which
  // are not needed here.
  if (v3) {
    await lib('renderer/lib/type/api.js');
    try {
      (await lib('renderer/lib/text-path.js')).install({ commands: { registerAll() {} }, dialogs: {} });
    } catch {
      // the extension is registered before the commands
    }
  }
  // The smart-object module's imports read `window` when loaded; nothing of it is used here.
  globalThis.window ??= globalThis;
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, addListener() {} });
  globalThis.addEventListener ??= () => {};
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  const smart = await lib('renderer/lib/smart-object.js');
  const { SmartLayer, makeSource } = smart;

  async function saveBoth(name, doc) {
    await save(`${set}-${name}`, doc);
    writeFileSync(join(out, `${set}-${name}.png`), await io.canvasToPng(flattenDocument(doc)));
  }

  // ---- text ------------------------------------------------------------------------------------

  /** A document for type: white, 96 x 48 at 144 ppi (sizes are pixels in the app, points here). */
  function typeDoc(name) {
    const doc = new Document({ width: 96, height: 48, dpi: 144, name });
    background(doc);
    return doc;
  }

  // Point text with every 0.3 font field set (0.3's flat `font`, which 0.4 reads through fromLegacy).
  {
    const doc = typeDoc('Point text');
    add(doc.root, new TextLayer({
      name: 'Point',
      text: 'Hello',
      x: 4,
      y: 6,
      font: { family: 'Arial', size: 16, weight: 700, italic: true, underline: true, color: '#c03020', align: 'left', lineHeight: 1.5, letterSpacing: 2, stroke: { color: '#0000ff', width: 1 } },
    }));
    await save(`${set}-text-point`, doc);
  }
  // Paragraph text: a box, two paragraphs, centred, and a turned point text.
  {
    const doc = typeDoc('Paragraph text');
    const props = { name: 'Box', text: 'One two three four\nFive', x: 10, y: 4, width: 60, font: { family: 'Arial', size: 10, align: 'center', lineHeight: 1.2, color: '#203040' } };
    if (v3) props.height = 36;
    add(doc.root, new TextLayer(props));
    const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    add(doc.root, new TextLayer({ name: 'Turned', text: 'Turn', x: 0, y: 0, font: { family: 'Arial', size: 12, align: 'right', color: '#008000' }, transform: [c * 1.5, s * 1.5, -s, c, 60, 20] }));
    await save(`${set}-text-box`, doc);
  }
  if (v3) {
    const model = await lib('renderer/lib/type/model.js');
    // Mixed runs with 0.4's character and paragraph attributes.
    {
      const doc = typeDoc('Mixed runs');
      let content = model.fromPlain('Mixed runs here\nSecond line', {}, {});
      content = model.applyChar(content, 0, 5, { size: 20, tracking: 50, fontFamily: 'Georgia', postScriptName: 'Georgia-Bold', fontWeight: 700 });
      content = model.applyChar(content, 6, 10, { baselineShift: 3, fauxBold: true, color: '#0000ff', kern: -20, autoKern: 'optical', scaleX: 120, scaleY: 90 });
      content = model.applyChar(content, 11, 15, { fontItalic: true, underline: true, strike: true, caps: 'all', position: 'super', language: 'de-DE', features: { liga: 0, ss01: 1 }, leading: 30 });
      content = model.applyChar(content, 16, 22, { caps: 'small', fauxItalic: true, noBreak: true, stroke: { color: '#ff0000', width: 2 } });
      content = model.applyPara(content, 0, 1, { align: 'justify-left', indentLeft: 4, indentRight: 2, indentFirst: 6, spaceBefore: 3, spaceAfter: 5, hyphenate: true });
      content = model.applyPara(content, 16, 17, { align: 'right', list: { type: 'bullet' }, hangingPunctuation: true, justification: { word: [70, 90, 120], letter: [0, 0, 0], glyph: [100, 100, 100], autoLeading: 140, singleWord: 'justify-all' } });
      add(doc.root, new TextLayer({ name: 'Runs', content, typeOptions: { antiAlias: 'crisp' }, x: 2, y: 2, width: 90, height: 44 }));
      await save(`${set}-text-runs`, doc);
    }
    // Vertical type: 'vertical-stacked' (upright characters in columns) and 'vertical' (horizontal
    // type turned a quarter, as setOrientation in lib/text-path.js makes it).
    {
      const doc = typeDoc('Vertical text');
      add(doc.root, new TextLayer({ name: 'Stacked', content: model.fromPlain('ABC\nDE', { size: 10 }, {}), typeOptions: { orientation: 'vertical-stacked' }, x: 70, y: 4 }));
      const x = 20, y = 4;
      add(doc.root, new TextLayer({ name: 'Turned vertical', content: model.fromPlain('Side', { size: 10 }, {}), typeOptions: { orientation: 'vertical' }, x, y, transform: [0, 1, -1, 0, x + y, y - x] }));
      await save(`${set}-text-vertical`, doc);
    }
    // Text on a path: an open curve, started a fifth of the way along.
    {
      const doc = typeDoc('Text on a path');
      const path = { subpaths: [{ closed: false, points: [{ x: 6, y: 40, inX: 6, inY: 40, outX: 30, outY: 0 }, { x: 90, y: 40, inX: 66, inY: 0, outX: 90, outY: 40 }] }] };
      add(doc.root, new TextLayer({ name: 'On path', content: model.fromPlain('Along the curve', { size: 8, color: '#800080' }, { align: 'left' }), x: 0, y: 0, pathText: { path, startOffset: 0.2, flip: false, align: 'left' } }));
      add(doc.root, new TextLayer({ name: 'On path flipped', content: model.fromPlain('Under', { size: 8 }, { align: 'center' }), x: 0, y: 0, pathText: { path, startOffset: 0.5, flip: true, align: 'center' } }));
      await save(`${set}-text-path`, doc);
    }
  }

  // ---- smart objects ---------------------------------------------------------------------------

  /** A 16 x 12 document with two layers: what the smart objects hold. */
  function contents(name = 'Contents') {
    const doc = new Document({ width: 16, height: 12, name });
    add(doc.root, new RasterLayer({ name: 'Red', canvas: canvasFrom(16, 12, (x, y) => [200, 40 + x * 8, 30 + y * 10, 255]), x: 0, y: 0 }));
    add(doc.root, new RasterLayer({ name: 'Square', canvas: canvasFrom(6, 6, () => [20, 60, 220, 255]), x: 5, y: 3, opacity: 0.75 }));
    return doc;
  }
  function host(name) {
    const doc = new Document({ width: 40, height: 32, name });
    background(doc);
    return doc;
  }
  const smartLayer = (doc, props) => {
    const l = add(doc.root, new SmartLayer(props));
    smart.attachHost?.(l, doc);
    return l;
  };

  // A document source placed twice: the second instance shares the first one's source (Duplicate
  // Layer keeps the source object), turned and scaled.
  {
    const doc = host('Smart instances');
    const src = makeSource({ kind: 'document', doc: contents(), name: 'Contents' });
    smartLayer(doc, { name: 'First', source: src, transform: [1, 0, 0, 1, 2, 3] });
    const c = Math.cos(0.4), s = Math.sin(0.4);
    smartLayer(doc, { name: 'Second', source: src, transform: [c * 1.25, s * 1.25, -s * 1.25, c * 1.25, 22, 10], opacity: 0.8 });
    await saveBoth('smart-instances', doc);
  }
  // An image source, scaled up, without a transform at its own size, and at the origin.
  {
    const doc = host('Smart image');
    const pattern = canvasFrom(8, 6, (x, y) => [(x * 37) & 255, (y * 53) & 255, 120, 255]);
    smartLayer(doc, { name: 'Image', source: makeSource({ kind: 'image', canvas: pattern, name: 'pattern.png' }), transform: [2, 0, 0, 2, 4, 4] });
    smartLayer(doc, { name: 'Image at origin', source: makeSource({ kind: 'image', canvas: canvasFrom(4, 4, () => [0, 0, 0, 255]), name: 'black.png' }), transform: null });
    await saveBoth('smart-image', doc);
  }
  // Smart filters PhotoCraft has: Gaussian Blur, Unsharp Mask, Levels; one off.
  {
    const doc = host('Smart filters');
    const filters = [
      { kind: 'gaussian-blur', params: { radius: 1.5 }, enabled: true },
      { kind: 'unsharp-mask', params: { amount: 80, radius: 1, threshold: 2 }, enabled: true },
      { kind: 'adjust:levels', params: { rgb: { inBlack: 20, inWhite: 220, gamma: 1.4, outBlack: 0, outWhite: 255 }, r: null, g: null, b: null }, enabled: true },
      { kind: 'adjust:invert', params: {}, enabled: false },
    ];
    smartLayer(doc, { name: 'Filtered', source: makeSource({ kind: 'document', doc: contents(), name: 'Contents' }), transform: [1.5, 0, 0, 1.5, 8, 6], filters });
    await saveBoth('smart-filters', doc);
  }
  // A filter Pigment on PhotoCraft has no counterpart for, between two it has, and the whole stack off.
  {
    const doc = host('Smart filters unmapped');
    const filters = [
      { kind: 'box-blur', params: { radius: 2 }, enabled: true },
      { kind: 'glowing-edges', params: { width: 2, brightness: 6 }, enabled: true },
      { kind: 'mosaic', params: { size: 4 }, enabled: true },
    ];
    smartLayer(doc, { name: 'Unmapped', source: makeSource({ kind: 'document', doc: contents(), name: 'Contents' }), transform: [1, 0, 0, 1, 4, 4], filters, filtersEnabled: false });
    await saveBoth('smart-filters-unmapped', doc);
  }
  // Smart objects nested ten deep: each holds the next.
  {
    let inner = contents('Level 10');
    for (let level = 9; level >= 0; level--) {
      const doc = new Document({ width: 16, height: 12, name: `Level ${level}` });
      const l = add(doc.root, new SmartLayer({ name: `Holds level ${level + 1}`, source: makeSource({ kind: 'document', doc: inner, name: `Level ${level + 1}` }), transform: [1, 0, 0, 1, 0, 0] }));
      smart.attachHost?.(l, doc);
      inner = doc;
    }
    await save(`${set}-smart-deep`, inner);
  }
}
