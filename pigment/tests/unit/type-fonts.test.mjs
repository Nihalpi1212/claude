// type-fonts (ARCHITECTURE.md "0.5 features", package 12): the font tables (names, OS/2, PANOSE, fvar), the
// classification, the bundled fonts' manifest, the style-key helpers, variable instances drawn by the real HarfBuzz,
// and missing glyph protection (per-cluster fallback). Fixtures: tests/fixtures/fonts (Carlito, Liberation Sans,
// Serif and Mono, SIL OFL 1.1) and the bundled Source Sans 3 VF (src/renderer/fonts, SIL OFL 1.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as hb from 'harfbuzzjs';
import * as T from '../../src/renderer/lib/type/font-tables.js';
import { setHarfBuzz, shapePiece } from '../../src/renderer/lib/type/shaper.js';
import { addFaces, faceFor, fallbackFaceFor, setFallbackFamilies, synthesis, axisValuesFor, unitOutline, harfBuzzFontProvider, facesOf } from '../../src/renderer/lib/type/fonts.js';
import { splitByFace } from '../../src/renderer/lib/type/layout.js';

const FIX = new URL('../fixtures/fonts/', import.meta.url);
const BUNDLED = new URL('../../src/renderer/fonts/', import.meta.url);
const read = (base, name) => new Uint8Array(readFileSync(new URL(name, base)));

test('fontInfo reads names, weight, slant and the classification fields of the fixture fonts', () => {
  const sans = T.fontInfo(read(FIX, 'LiberationSans-Regular.ttf'));
  assert.equal(sans.family, 'Liberation Sans');
  assert.equal(sans.postScriptName, 'LiberationSans');
  assert.equal(sans.weight, 400);
  assert.equal(sans.italic, false);
  assert.equal(sans.classification, 'sans-serif');
  assert.ok(Math.abs(sans.metrics.xHeight - 0.528) < 0.001 && Math.abs(sans.metrics.capHeight - 0.688) < 0.001);
  const bold = T.fontInfo(read(FIX, 'LiberationSans-Bold.ttf'));
  assert.deepEqual([bold.postScriptName, bold.subfamily, bold.weight], ['LiberationSans-Bold', 'Bold', 700]);
  assert.equal(T.fontInfo(read(FIX, 'LiberationSerif-Regular.ttf')).classification, 'serif');
  // Liberation Mono's IBM class says sans (8): post's fixed pitch and PANOSE proportion 9 make it monospace
  const mono = T.fontInfo(read(FIX, 'LiberationMono-Regular.ttf'));
  assert.equal(mono.classification, 'monospace');
  // Carlito has no IBM class (0): PANOSE family 2, serif style 15 (rounded) and the name decide
  assert.equal(T.fontInfo(read(FIX, 'Carlito-Regular.ttf')).classification, 'sans-serif');
  assert.equal(T.fontInfo(new Uint8Array([1, 2, 3])), null);
  assert.equal(T.isFontFile(read(FIX, 'Carlito-Regular.ttf')), true);
  assert.equal(T.isFontFile(new TextEncoder().encode('not a font file')), false);
});

test('classify maps IBM classes, PANOSE and fixed pitch to the menu classes', () => {
  assert.equal(T.classify({ panose: [2, 11, 6, 4, 2, 2, 2, 2, 2, 4] }), 'sans-serif');
  assert.equal(T.classify({ panose: [2, 2, 6, 3, 5, 4, 5, 2, 3, 4] }), 'serif');
  assert.equal(T.classify({ panose: [2, 6, 6, 3, 5, 4, 5, 2, 3, 4] }), 'slab-serif'); // square serifs
  assert.equal(T.classify({ familyClass: 5, familySubclass: 1 }), 'slab-serif');
  assert.equal(T.classify({ familyClass: 4 }), 'slab-serif'); // Clarendon
  assert.equal(T.classify({ familyClass: 10, familySubclass: 3 }), 'script'); // formal joined
  assert.equal(T.classify({ familyClass: 10, familySubclass: 2 }), 'handwritten'); // brush joined
  assert.equal(T.classify({ panose: [3, 2, 6, 0, 0, 0, 0, 0, 0, 0] }), 'handwritten'); // Latin hand written
  assert.equal(T.classify({ panose: [4, 2, 6, 0, 0, 0, 0, 0, 0, 0] }), 'decorative');
  assert.equal(T.classify({ familyClass: 9 }), 'decorative');
  assert.equal(T.classify({ familyClass: 8, isFixedPitch: true }), 'monospace');
  assert.equal(T.classify({ panose: [2, 11, 6, 9, 2, 2, 2, 2, 2, 4] }), 'monospace');
  assert.equal(T.classify({ familyClass: 1 }), 'serif');
  assert.equal(T.classify({ family: 'UnifrakturMaguntia Fraktur' }), 'blackletter');
  assert.equal(T.classify({}), null);
  assert.equal(T.classifyName('Courier New'), 'monospace');
  assert.equal(T.classifyName('Georgia'), 'serif');
  assert.equal(T.classifyName('Helvetica Neue'), 'sans-serif');
  assert.equal(T.classifyName('Brush Script MT'), 'handwritten');
  assert.equal(T.classifyName('Zzyzx'), null);
  assert.deepEqual(T.FONT_CLASSES, ['serif', 'sans-serif', 'slab-serif', 'script', 'handwritten', 'monospace', 'decorative', 'blackletter']);
});

test('fvar: the axes and named instances of the bundled variable font, PostScript names per TN #5902', () => {
  const up = T.fontInfo(read(BUNDLED, 'SourceSans3VF-Upright.ttf'));
  assert.equal(up.variable, true);
  assert.deepEqual(up.axes, [{ tag: 'wght', name: 'Weight', min: 200, default: 200, max: 900, hidden: false }]);
  assert.deepEqual(up.instances.map((i) => [i.name, i.postScriptName, i.weight, i.italic]), [
    ['ExtraLight', 'SourceSans3VF-ExtraLight', 200, false], ['Light', 'SourceSans3VF-Light', 300, false], ['Regular', 'SourceSans3VF-Regular', 400, false],
    ['Medium', 'SourceSans3VF-Medium', 500, false], ['Semibold', 'SourceSans3VF-Semibold', 600, false], ['Bold', 'SourceSans3VF-Bold', 700, false], ['Black', 'SourceSans3VF-Black', 900, false],
  ]);
  assert.deepEqual(up.instances[5].coords, { wght: 700 });
  const it = T.fontInfo(read(BUNDLED, 'SourceSans3VF-Italic.ttf'));
  assert.equal(it.italic, true);
  assert.ok(it.instances.every((i) => i.italic && i.postScriptName.endsWith('Italic')));
  // a static font has none
  assert.equal(T.fontInfo(read(FIX, 'Carlito-Regular.ttf')).variable, false);
  assert.equal(T.instancePostScriptName('Source Sans 3', 'Semibold Italic'), 'SourceSans3-SemiboldItalic');
  // the catalog reads installed fonts in slices: the spans name the tables fontInfo reads
  const bytes = read(FIX, 'LiberationSans-Regular.ttf');
  const spans = T.infoTableSpans(bytes.subarray(0, 4096));
  assert.deepEqual(spans.map((s) => s.tag).sort(), ['OS/2', 'head', 'name', 'post']);
  const sliced = T.infoFromTables((tag) => {
    const s = spans.find((x) => x.tag === tag);
    return s ? bytes.slice(s.offset, s.offset + s.length) : null;
  });
  assert.deepEqual(sliced, T.fontInfo(bytes));
});

test('the bundled fonts: index.json matches the font files, and each has its licence beside it', () => {
  const manifest = JSON.parse(readFileSync(new URL('index.json', BUNDLED), 'utf8'));
  assert.equal(manifest.format, 'pigment-fonts');
  assert.equal(manifest.default, 'SourceSans3VF');
  for (const fam of manifest.families) {
    assert.ok(readFileSync(new URL(fam.license, BUNDLED), 'utf8').includes('SIL Open Font License'), fam.license);
    for (const face of fam.faces) {
      const info = T.fontInfo(read(BUNDLED, face.file));
      assert.equal(info.family, fam.name);
      assert.deepEqual({ ps: face.postScriptName, w: face.weight, i: face.italic, axes: face.axes, inst: face.instances, m: face.metrics }, { ps: info.postScriptName, w: info.weight, i: info.italic, axes: info.axes, inst: info.instances, m: info.metrics });
    }
  }
  assert.ok(readFileSync(new URL('Liberation-LICENSE.txt', FIX), 'utf8').includes('SIL-OFL-1.1'));
});

test('style keys: nearest style (CSS matching), axis suffixes, PostScript and style names', () => {
  const styles = [400, 700].flatMap((w) => [false, true].map((i) => ({ name: `${w}${i ? 'i' : ''}`, postScriptName: `X-${w}${i ? 'i' : ''}`, weight: w, italic: i })));
  assert.equal(T.nearestStyle(styles, 400, false).postScriptName, 'X-400');
  assert.equal(T.nearestStyle(styles, 600, false).postScriptName, 'X-700'); // above 500: heavier first
  assert.equal(T.nearestStyle(styles, 300, true).postScriptName, 'X-400i'); // below 400: lighter first, then heavier
  assert.equal(T.nearestStyle(styles.filter((s) => !s.italic), 700, true).postScriptName, 'X-700'); // no italic: upright
  assert.equal(T.axesSuffix({ wght: 650, wdth: 90 }, { wght: 600 }), 'wdth=90,wght=650');
  assert.equal(T.axesSuffix({ wght: 600 }, { wght: 600 }), '');
  assert.equal(T.axesSuffix({ wght: 600, bad: 3, opsz: NaN }, {}), 'wght=600');
  assert.deepEqual(T.parseStyleKey('SourceSans3VF-Bold|wght=650,wdth=90'), { key: 'SourceSans3VF-Bold', axes: { wght: 650, wdth: 90 } });
  assert.deepEqual(T.parseStyleKey('700i'), { key: '700i', axes: {} });
  assert.deepEqual(T.parsePostScriptStyle('Arial-BoldItalicMT'), { weight: 700, italic: true });
  assert.deepEqual(T.parsePostScriptStyle('MyriadPro-Semibold'), { weight: 600, italic: false });
  assert.deepEqual(T.parseStyleName('Semibold Italic'), { weight: 600, italic: true });
  assert.deepEqual(T.parseStyleName('Book'), { weight: 400, italic: false });
});

test('similarity ranks faces of the same class and proportions first', () => {
  const sans = T.fontInfo(read(FIX, 'LiberationSans-Regular.ttf'));
  const carlito = T.fontInfo(read(FIX, 'Carlito-Regular.ttf'));
  const serif = T.fontInfo(read(FIX, 'LiberationSerif-Regular.ttf'));
  const mono = T.fontInfo(read(FIX, 'LiberationMono-Regular.ttf'));
  assert.ok(T.similarity(sans, carlito) > T.similarity(sans, serif));
  assert.ok(T.similarity(sans, carlito) > T.similarity(sans, mono));
  assert.equal(T.similarity(sans, sans), 1);
  assert.equal(T.similarity(null, sans), 0);
});

// ---- the engine with the real HarfBuzz ------------------------------------------------------------------------------

setHarfBuzz(hb);
const style = (o = {}) => ({ fontFamily: 'SourceSans3VF', size: 100, scaleX: 100, scaleY: 100, tracking: 0, kern: 0, autoKern: 'metrics', caps: 'normal', position: 'normal', baselineShift: 0, features: {}, language: 'en-US', fontWeight: 400, fontItalic: false, postScriptName: null, axes: {}, ...o });
const env = { faceFor, fallbackFace: fallbackFaceFor, measure: (s, st, size) => s.length * size * 0.5 };
addFaces(read(BUNDLED, 'SourceSans3VF-Upright.ttf'), { family: 'SourceSans3VF' });
addFaces(read(BUNDLED, 'SourceSans3VF-Italic.ttf'), { family: 'SourceSans3VF' });
addFaces(read(FIX, 'Carlito-Regular.ttf'), { family: 'Unit Carlito' });
const width = (st, s = 'HHHH') => shapePiece(s, 0, s.length, st, env).units.reduce((w, u) => w + u.advance, 0);

test('a variable face draws the style\'s weight, a named instance and CharStyle axes', () => {
  const regular = faceFor(style());
  assert.equal(regular.weight, 400);
  assert.equal(regular.postScriptName, 'SourceSans3VF-Regular');
  assert.deepEqual(regular.coords, { wght: 400 });
  const bold = faceFor(style({ fontWeight: 700 }));
  assert.equal(bold.weight, 700);
  assert.notEqual(bold, regular);
  assert.equal(faceFor(style({ fontWeight: 700 })), bold); // cached
  // a heavier instance is wider: the outlines and advances change with the axis
  assert.ok(width(style({ fontWeight: 900 })) > width(style({ fontWeight: 400 })) + 10, `${width(style({ fontWeight: 900 }))} > ${width(style())}`);
  // no synthetic bold: the instance is bold
  assert.deepEqual(synthesis(bold, style({ fontWeight: 700 })), { bold: false, italic: false });
  // a named instance by PostScript name, whatever the weight says; CharStyle axes win over both
  assert.equal(faceFor(style({ postScriptName: 'SourceSans3VF-Semibold' })).weight, 600);
  assert.equal(faceFor(style({ postScriptName: 'SourceSans3VF-Semibold', axes: { wght: 650 } })).weight, 650);
  assert.deepEqual(axisValuesFor(regular, style({ axes: { wght: 2000 } })), { wght: 900 }); // clamped
  // the default instance's own name (the face's name 6) is the ExtraLight instance
  assert.equal(faceFor(style({ postScriptName: 'SourceSans3VF-ExtraLight', fontWeight: 400 })).weight, 200);
  // the italic file: italic instances
  const it = faceFor(style({ fontItalic: true, fontWeight: 700 }));
  assert.equal(it.italic, true);
  assert.equal(it.postScriptName, 'SourceSans3VF-BoldItalic');
  assert.equal(facesOf('SourceSans3VF').length, 2);
  // outlines follow the instance (Create Work Path, optical kerning)
  const thin = harfBuzzFontProvider.outline(style({ fontWeight: 200 }), 'I');
  const black = harfBuzzFontProvider.outline(style({ fontWeight: 900 }), 'I');
  const span = (p) => {
    const xs = p.subpaths.flatMap((s) => s.points.map((q) => q.x));
    return Math.max(...xs) - Math.min(...xs);
  };
  assert.ok(span(black) > span(thin) * 2, `${span(black)} vs ${span(thin)}`);
});

test('missing glyph protection: a cluster the face lacks is drawn by the fallback family and gets a run of its own', () => {
  setFallbackFamilies(['SourceSans3VF']);
  const st = style({ fontFamily: 'Unit Carlito' });
  // U+2318 (⌘) is in Source Sans 3, not in Carlito
  const piece = shapePiece('A⌘B', 0, 3, st, env);
  assert.deepEqual(piece.units.map((u) => [u.index, u.end, u.kind, u.face?.family ?? null]), [[0, 1, 'glyphs', null], [1, 2, 'glyphs', 'SourceSans3VF'], [2, 3, 'glyphs', null]]);
  assert.ok(piece.units[1].advance > 10);
  assert.ok(unitOutline(piece.face, piece.units[1]).subpaths.length > 0);
  // emoji keep the Canvas fallback (the system's colour emoji)
  assert.equal(shapePiece('A\u{1F600}', 0, 3, st, env).units[1].kind, 'fallback');
  // a character no loaded face has stays a fallback unit
  assert.equal(shapePiece('A\u{10900}', 0, 3, st, env).units[1].kind, 'fallback');
  // switched off: Canvas fallback
  setFallbackFamilies(['SourceSans3VF'], { enabled: false });
  assert.equal(shapePiece('A⌘B', 0, 3, st, env).units[1].kind, 'fallback');
  setFallbackFamilies(['SourceSans3VF']);
  // a bold run falls back to a bold instance
  assert.equal(fallbackFaceFor('⌘', style({ fontFamily: 'Unit Carlito', fontWeight: 700 })).weight, 700);
  // splitByFace: one run per face, clusters and positions kept, the fallback named
  const face = piece.face;
  const units = piece.units.map((u, i) => ({ ...u, x: i * 50 }));
  const run = { from: 0, to: 3, x: 0, advance: 150, face, units, clusters: units.map((u) => ({ index: u.index, x: u.x, advance: 50 })), style: st };
  const parts = splitByFace(run);
  assert.deepEqual(parts.map((r) => [r.from, r.to, r.x, r.advance, r.face.family, r.fallback?.family ?? null, r.clusters.map((c) => c.index)]), [
    [0, 1, 0, units[0].advance, 'Unit Carlito', null, [0]], [1, 2, 50, units[1].advance, 'SourceSans3VF', 'SourceSans3VF', [1]], [2, 3, 100, units[2].advance, 'Unit Carlito', null, [2]],
  ]);
  assert.deepEqual(splitByFace({ ...run, units: [units[0]] }), [{ ...run, units: [units[0]] }]);
});
