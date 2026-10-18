import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../../src/shared/engine.js';
import { fixture, pageTexts, annotationsOfPage, pdflibLoad, withPdfjs, makePng, widgetOf } from './helpers.mjs';

const pageNumbers = (texts) => texts.map((t) => Number(/Page (\d+) of/.exec(t)?.[1] ?? /Mixed page (\d+)/.exec(t)?.[1]));

test('getPageInfo reports sizes and rotations', async () => {
  const info = await engine.getPageInfo(await fixture('mixed'));
  assert.equal(info.count, 4);
  assert.deepEqual(info.pages.map((p) => [p.width, p.height, p.rotation]), [
    [595, 842, 0],
    [842, 595, 0],
    [300, 300, 0],
    [612, 792, 90],
  ]);
});

test('rotatePages rotates only the selected pages, cumulatively', async () => {
  let bytes = await fixture('text');
  bytes = await engine.rotatePages(bytes, [0, 2], 90);
  bytes = await engine.rotatePages(bytes, [2], -90);
  const info = await engine.getPageInfo(bytes);
  assert.deepEqual(info.pages.map((p) => p.rotation), [90, 0, 0, 0, 0]);
  await assert.rejects(engine.rotatePages(bytes, [9], 90), (e) => e.code === 'range');
});

test('deletePages removes pages and refuses to delete all of them', async () => {
  const bytes = await engine.deletePages(await fixture('text'), [1, 3]);
  assert.deepEqual(pageNumbers(await pageTexts(bytes)), [1, 3, 5]);
  await assert.rejects(engine.deletePages(bytes, [0, 1, 2]), (e) => e.code === 'range');
});

test('reorderPages reorders within the same document and keeps the outline', async () => {
  const bytes = await engine.reorderPages(await fixture('text'), [4, 0, 3, 1, 2]);
  assert.deepEqual(pageNumbers(await pageTexts(bytes)), [5, 1, 4, 2, 3]);
  await withPdfjs(bytes, async (doc) => {
    const outline = await doc.getOutline();
    assert.equal(outline.length, 5);
    assert.equal(doc.numPages, 5);
  });
  await assert.rejects(engine.reorderPages(bytes, [0, 0, 1, 2, 3]), (e) => e.code === 'range');
  const same = await engine.reorderPages(bytes, [0, 1, 2, 3, 4]);
  assert.deepEqual(pageNumbers(await pageTexts(same)), [5, 1, 4, 2, 3]);
});

test('insertPages, extractPages, splitByRanges and mergeDocuments', async () => {
  const text = await fixture('text');
  const mixed = await fixture('mixed');
  const inserted = await engine.insertPages(text, mixed, 1, [0, 1]);
  assert.equal((await engine.getPageInfo(inserted)).count, 7);
  assert.deepEqual(pageNumbers(await pageTexts(inserted)).slice(0, 4), [1, 1, 2, 2]);

  const extracted = await engine.extractPages(text, [4, 1]);
  assert.deepEqual(pageNumbers(await pageTexts(extracted)), [2, 5]);
  assert.equal((await engine.getMetadata(extracted)).title, 'Folio sample document');

  const parts = await engine.splitByRanges(text, [[0, 1], [2, 3, 4]]);
  assert.equal(parts.length, 2);
  assert.deepEqual(pageNumbers(await pageTexts(parts[1])), [3, 4, 5]);

  const merged = await engine.mergeDocuments([parts[1], parts[0], mixed]);
  assert.equal((await engine.getPageInfo(merged)).count, 9);
  assert.deepEqual(pageNumbers(await pageTexts(merged)).slice(0, 5), [3, 4, 5, 1, 2]);
});

test('cropPages sets the crop box', async () => {
  const bytes = await engine.cropPages(await fixture('text'), [0], { x: 50, y: 50, width: 300, height: 400 });
  await withPdfjs(bytes, async (doc) => {
    const page = await doc.getPage(1);
    assert.deepEqual(page.view, [50, 50, 350, 450]);
    const page2 = await doc.getPage(2);
    assert.deepEqual(page2.view, [0, 0, 612, 792]);
  });
});

test('metadata round trip', async () => {
  let bytes = await fixture('text');
  bytes = await engine.setMetadata(bytes, { title: 'New title', author: 'Someone', keywords: 'a, b', subject: 'S' });
  const meta = await engine.getMetadata(bytes);
  assert.equal(meta.title, 'New title');
  assert.equal(meta.author, 'Someone');
  assert.equal(meta.keywords, 'a, b');
  assert.equal(meta.subject, 'S');
  assert.ok(meta.modificationDate instanceof Date);
  await withPdfjs(bytes, async (doc) => {
    const { info } = await doc.getMetadata();
    assert.equal(info.Title, 'New title');
  });
});

test('form data, reset and flatten', async () => {
  const form = await fixture('form');
  const data = await engine.getFormData(form);
  assert.deepEqual(data.map((f) => [f.name, f.type]), [
    ['name', 'TextField'],
    ['email', 'TextField'],
    ['agree', 'CheckBox'],
    ['colour', 'RadioGroup'],
    ['country', 'Dropdown'],
    ['comments', 'TextField'],
  ]);
  // fill through pdf.js (as the viewer does), save, then read back and reset/flatten
  const filled = await withPdfjs(form, async (doc) => {
    const fields = await doc.getFieldObjects();
    doc.annotationStorage.setValue(widgetOf(fields, 'name').id, { value: 'Ada Lovelace' });
    doc.annotationStorage.setValue(widgetOf(fields, 'agree').id, { value: true });
    return doc.saveDocument();
  });
  const filledData = await engine.getFormData(filled);
  assert.equal(filledData.find((f) => f.name === 'name').value, 'Ada Lovelace');
  assert.equal(filledData.find((f) => f.name === 'agree').value, true);

  const reset = await engine.resetForm(filled);
  assert.equal((await engine.getFormData(reset)).find((f) => f.name === 'name').value, '');

  const flat = await engine.flattenForms(filled);
  assert.deepEqual(await engine.getFormData(flat), []);
  await withPdfjs(flat, async (doc) => {
    const page = await doc.getPage(1);
    const widgets = (await page.getAnnotations()).filter((a) => a.subtype === 'Widget');
    assert.equal(widgets.length, 0);
    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
    assert.match(text, /Ada Lovelace/);
  });
});

test('imagesToPdf and rasterizedCopy', async () => {
  const png = makePng(80, 40);
  const fit = await engine.imagesToPdf([{ bytes: png, type: 'png' }], { pageSize: 'fit' });
  const info = await engine.getPageInfo(fit);
  assert.deepEqual([info.pages[0].width, info.pages[0].height], [80, 40]);
  const a4 = await engine.imagesToPdf([{ bytes: png, type: 'png' }, { bytes: png, type: 'png' }], { pageSize: 'A4', margin: 36 });
  assert.equal((await engine.getPageInfo(a4)).count, 2);
  const raster = await engine.rasterizedCopy([{ png, widthPt: 200, heightPt: 100 }]);
  assert.deepEqual((await engine.getPageInfo(raster)).pages[0], { width: 200, height: 100, rotation: 0 });
});

test('listAnnotations reads existing annotations with ids pdf.js agrees on', async () => {
  const bytes = await fixture('annotated');
  const list = await engine.listAnnotations(bytes);
  assert.deepEqual(list.map((a) => a.subtype), ['Text', 'Square', 'Highlight']);
  assert.equal(list[0].contents, 'Existing sticky note');
  assert.equal(list[0].author, 'Fixture Author');
  assert.equal(list[0].created.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(list[1].color, '#e63333');
  const pdfjsIds = (await annotationsOfPage(bytes)).map((a) => a.id);
  for (const a of list) assert.ok(pdfjsIds.includes(a.id), `pdf.js knows id ${a.id}`);
});

test('addAnnotation creates every supported type with appearance streams', async () => {
  let bytes = await fixture('text');
  const author = 'Tester';
  const specs = [
    { type: 'note', rect: [500, 700, 520, 720], contents: 'Hello note', author, color: '#ffd54f', open: true },
    { type: 'highlight', quads: [[72, 652, 300, 652, 72, 640, 300, 640]], color: '#ffff00', author, contents: 'hl' },
    { type: 'underline', quads: [[72, 634, 300, 634, 72, 622, 300, 622]], color: '#0000ff', author },
    { type: 'strikeout', quads: [[72, 616, 300, 616, 72, 604, 300, 604]], color: '#ff0000', author },
    { type: 'squiggly', quads: [[72, 598, 300, 598, 72, 586, 300, 586]], color: '#00aa00', author },
    { type: 'square', rect: [100, 100, 300, 200], color: '#ff0000', fill: '#ffeeee', width: 3, author, contents: 'box' },
    { type: 'circle', rect: [320, 100, 420, 200], color: '#0000ff', width: 2, opacity: 0.5, author },
    { type: 'line', start: [100, 250], end: [300, 300], color: '#000000', width: 2, author },
    { type: 'arrow', start: [100, 320], end: [300, 370], color: '#aa00aa', width: 3, author },
    { type: 'ink', paths: [[100, 400, 150, 450, 200, 400], [220, 420, 260, 460]], color: '#008800', width: 2, author },
    { type: 'freetext', rect: [320, 400, 520, 460], text: 'Free text with wrapping that is long enough to wrap onto a second line', fontSize: 11, color: '#1e1e1e', author },
    { type: 'stamp-image', rect: [320, 480, 420, 530], image: makePng(100, 50), imageType: 'png', author },
    { type: 'stamp-text', rect: [320, 540, 520, 600], text: 'APPROVED', color: '#c62828', author },
  ];
  const ids = [];
  for (const spec of specs) {
    const result = await engine.addAnnotation(bytes, 0, spec);
    bytes = result.bytes;
    ids.push(result.id);
  }
  const list = await engine.listAnnotations(bytes);
  assert.deepEqual(list.map((a) => a.subtype), ['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Line', 'Line', 'Ink', 'FreeText', 'Stamp', 'Stamp']);
  assert.deepEqual(list.map((a) => a.id), ids);
  assert.ok(list.every((a) => a.author === author && a.created && a.modified && a.name?.startsWith('folio-')));
  assert.equal(list[6].opacity, 0.5);

  const annots = await annotationsOfPage(bytes, 0);
  const byId = Object.fromEntries(annots.map((a) => [a.id, a]));
  const note = byId[ids[0]];
  assert.equal(note.subtype, 'Text');
  assert.equal(note.contentsObj.str, 'Hello note');
  assert.equal(note.titleObj.str, author);
  assert.ok(note.popupRef, 'note has a popup');
  assert.ok(annots.some((a) => a.subtype === 'Popup' && a.parentRef === ids[0] || a.id === note.popupRef), 'popup annotation exists');
  const hl = byId[ids[1]];
  assert.equal(hl.subtype, 'Highlight');
  assert.deepEqual([...hl.color], [255, 255, 0]);
  assert.equal(hl.quadPoints.length, 8, 'one quad = 8 numbers');
  assert.ok(hl.hasAppearance, 'highlight has an appearance stream');
  assert.ok(byId[ids[5]].hasAppearance && byId[ids[6]].hasAppearance && byId[ids[7]].hasAppearance && byId[ids[9]].hasAppearance, 'shapes have appearances');
  assert.deepEqual(byId[ids[7]].lineCoordinates, [100, 250, 300, 300]);
  assert.equal(byId[ids[9]].inkLists.length, 2);
  const ft = byId[ids[10]];
  assert.equal(ft.subtype, 'FreeText');
  assert.match(ft.contentsObj.str, /Free text/);
  assert.ok(ft.hasAppearance);
  assert.ok(byId[ids[11]].hasAppearance && byId[ids[12]].hasAppearance, 'stamps have appearances');
  // pdf.js can render the page with these annotations without throwing (operator list build)
  await withPdfjs(bytes, async (doc) => {
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList({ annotationMode: 1 });
    assert.ok(ops.fnArray.length > 0);
  });
});

test('updateAnnotation changes contents, colour, opacity and hidden flag; deleteAnnotation removes replies and popup', async () => {
  let bytes = await fixture('text');
  const { bytes: b1, id } = await engine.addAnnotation(bytes, 1, { type: 'square', rect: [50, 50, 150, 150], color: '#ff0000', width: 2, author: 'A', contents: 'before' });
  bytes = b1;
  bytes = await engine.updateAnnotation(bytes, id, { contents: 'after', color: '#00ff00', opacity: 0.4, hidden: true });
  let [a] = await engine.listAnnotations(bytes);
  assert.equal(a.contents, 'after');
  assert.equal(a.color, '#00ff00');
  assert.equal(a.opacity, 0.4);
  assert.equal(a.hidden, true);
  const pdfjsA = (await annotationsOfPage(bytes, 1)).find((x) => x.id === id);
  assert.deepEqual([...pdfjsA.color], [0, 255, 0]);
  assert.ok(pdfjsA.hasAppearance, 'appearance regenerated');
  bytes = await engine.updateAnnotation(bytes, id, { hidden: false });
  [a] = await engine.listAnnotations(bytes);
  assert.equal(a.hidden, false);

  const { bytes: b2, id: replyId } = await engine.addReply(bytes, id, { contents: 'reply 1', author: 'B' });
  const { bytes: b3, id: reply2 } = await engine.addReply(b2, replyId, { contents: 'reply 2', author: 'C' });
  bytes = b3;
  const withReplies = await engine.listAnnotations(bytes);
  assert.equal(withReplies.length, 3);
  assert.equal(withReplies.find((x) => x.id === replyId).inReplyTo, id);
  assert.equal(withReplies.find((x) => x.id === reply2).inReplyTo, replyId);

  const { bytes: b4, id: noteId } = await engine.addAnnotation(bytes, 1, { type: 'note', rect: [10, 10, 30, 30], contents: 'n', author: 'A', color: '#ffff00' });
  bytes = await engine.deleteAnnotation(b4, id);
  const remaining = await engine.listAnnotations(bytes);
  assert.deepEqual(remaining.map((x) => x.id), [noteId]);
  const annots = await annotationsOfPage(bytes, 1);
  assert.equal(annots.filter((x) => x.subtype === 'Popup').length, 1, 'only the note popup remains');
  bytes = await engine.deleteAnnotation(bytes, noteId);
  assert.deepEqual(await engine.listAnnotations(bytes), []);
  assert.equal((await annotationsOfPage(bytes, 1)).length, 0);
  await assert.rejects(engine.deleteAnnotation(bytes, noteId), (e) => e.code === 'range');
});

test('engine errors on invalid input', async () => {
  await assert.rejects(engine.getPageInfo(new Uint8Array([1, 2, 3])), (e) => e.code === 'invalid');
  await assert.rejects(engine.rotatePages('nope', [0], 90), (e) => e.code === 'invalid');
  assert.equal(engine.looksLikePdf(await fixture('text')), true);
  assert.equal(engine.looksLikePdf(new Uint8Array([1, 2, 3, 4, 5, 6])), false);
});

test('pdf-lib can load a document saved by pdf.js (incremental update) and vice versa', async () => {
  const form = await fixture('form');
  const saved = await withPdfjs(form, async (doc) => {
    const fields = await doc.getFieldObjects();
    doc.annotationStorage.setValue(widgetOf(fields, 'email').id, { value: 'a@b.c' });
    return doc.saveDocument();
  });
  const doc = await pdflibLoad(saved);
  assert.equal(doc.getForm().getTextField('email').getText(), 'a@b.c');
  const rotated = await engine.rotatePages(saved, [0], 90);
  await withPdfjs(rotated, async (d) => {
    const page = await d.getPage(1);
    assert.equal(page.rotate, 90);
    const fields = await d.getFieldObjects();
    assert.equal(widgetOf(fields, 'email').value, 'a@b.c');
  });
});

test('flattenAnnotations bakes appearances into the page and removes the annotations', async () => {
  let bytes = await fixture('annotated');
  ({ bytes } = await engine.addAnnotation(bytes, 0, { type: 'square', rect: [100, 100, 300, 200], color: '#ff0000', width: 3, author: 'A', opacity: 0.5 }));
  ({ bytes } = await engine.addAnnotation(bytes, 0, { type: 'stamp-text', rect: [320, 540, 520, 600], text: 'FINAL', color: '#c62828', author: 'A' }));
  const before = await withPdfjs(bytes, async (doc) => (await (await doc.getPage(1)).getOperatorList({ annotationMode: 0 })).fnArray.length);
  const flat = await engine.flattenAnnotations(bytes);
  assert.deepEqual(await engine.listAnnotations(flat), []);
  await withPdfjs(flat, async (doc) => {
    const page = await doc.getPage(1);
    assert.equal((await page.getAnnotations()).length, 0);
    const ops = await page.getOperatorList({ annotationMode: 0 });
    assert.ok(ops.fnArray.length > before, 'page content grew with the baked appearances');
    const text = (await page.getTextContent()).items.map((i) => i.str).join(' ');
    assert.match(text, /FINAL/, 'the stamp text is now page content');
  });
});
