import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as impose from '../../src/shared/impose.js';
import * as engine from '../../src/shared/engine.js';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { fixture, pageTexts, withPdfjs, pdflibLoad } from './helpers.mjs';

const near = (a, b, tol = 0.6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const pageNumbers = (texts) => texts.map((t) => Number(/Page (\d+) of/.exec(t)?.[1] ?? NaN));

/** Per page: size and the positioned text items (str, x, y in PDF user space of the unrotated page). */
async function textItems(bytes) {
  return withPdfjs(bytes, async (doc) => {
    const out = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const content = await page.getTextContent();
      out.push({
        width: vp.width,
        height: vp.height,
        items: content.items.filter((it) => it.str.trim()).map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width })),
      });
    }
    return out;
  });
}

/** The big page numbers of the sample document on a sheet, left to right (then top to bottom). */
const bigNumbers = (sheet) =>
  sheet.items
    .filter((it) => /^\d+$/.test(it.str))
    .sort((a, b) => (Math.abs(a.y - b.y) > 20 ? b.y - a.y : a.x - b.x))
    .map((it) => Number(it.str));

async function sizes(bytes) {
  return (await impose.pageInfo(bytes)).map((p) => [Math.round(p.width * 100) / 100, Math.round(p.height * 100) / 100]);
}

test('createSampleDocument numbers its pages and uses the requested sheet size', async () => {
  const bytes = await impose.createSampleDocument({ pages: 3, size: 'A5', label: 'Sheet {page}/{pages}' });
  const texts = await pageTexts(bytes);
  assert.equal(texts.length, 3);
  assert.match(texts[2], /Sheet 3\/3/);
  assert.match(texts[2], /\b3\b/);
  assert.deepEqual(await sizes(bytes), [[419.53, 595.28], [419.53, 595.28], [419.53, 595.28]]);
  const letter = await impose.createSampleDocument({ pages: 1, size: 'Letter-landscape', colored: false });
  assert.deepEqual(await sizes(letter), [[792, 612]]);
});

test('createBooklet pairs pages for saddle stitching (left and right binding, creep, signatures)', async () => {
  const sample = await impose.createSampleDocument({ pages: 8, size: 'A5' });
  const { bytes, sheets } = await impose.createBooklet(sample);
  assert.equal(sheets, 4);
  const pages = await textItems(bytes);
  assert.equal(pages.length, 4);
  near(pages[0].width, 419.53 * 2, 0.1);
  near(pages[0].height, 595.28, 0.1);
  assert.deepEqual(pages.map(bigNumbers), [[8, 1], [2, 7], [6, 3], [4, 5]]);

  const right = await impose.createBooklet(sample, { binding: 'right' });
  assert.deepEqual((await textItems(right.bytes)).map(bigNumbers), [[1, 8], [7, 2], [3, 6], [5, 4]]);

  // five pages are padded with blanks to a multiple of four
  const five = await impose.createBooklet(await impose.createSampleDocument({ pages: 5, size: 'A5' }));
  assert.equal(five.sheets, 4);
  assert.deepEqual((await textItems(five.bytes)).map(bigNumbers), [[1], [2], [3], [4, 5]]);

  // two signatures of four pages
  const sig = await impose.createBooklet(sample, { signatureSize: 4 });
  assert.deepEqual((await textItems(sig.bytes)).map(bigNumbers), [[4, 1], [2, 3], [8, 5], [6, 7]]);

  // explicit sheet with margin + creep still produces the same pairing, and pages land inside the sheet
  const a4 = await impose.createBooklet(sample, { sheet: 'A4-landscape', margin: 20, creep: 2, gap: 10 });
  const a4pages = await textItems(a4.bytes);
  near(a4pages[0].width, 841.89, 0.1);
  assert.deepEqual(a4pages.map(bigNumbers), [[8, 1], [2, 7], [6, 3], [4, 5]]);
  for (const it of a4pages[0].items) assert.ok(it.x >= 20 && it.x <= 841.89 - 20 && it.y >= 20 && it.y <= 595.28 - 20);

  // creep: the outermost sheet is not shifted, inner sheets move toward the spine
  const crept = await textItems((await impose.createBooklet(sample, { creep: 10 })).bytes);
  const plain = await textItems(bytes);
  const labelX = (sheet, n) => sheet.items.find((it) => it.str === `Page ${n} of 8` && it.y > 300).x;
  near(labelX(crept[0], 8), labelX(plain[0], 8)); // outer sheet front, left page: unchanged
  near(labelX(crept[2], 6), labelX(plain[2], 6) + 10); // inner sheet front, left page: toward the spine (right)
  near(labelX(crept[2], 3), labelX(plain[2], 3) - 10); // inner sheet front, right page: toward the spine (left)

  // pages without a content stream (allowed for blank pages) can be imposed
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]).drawText('hello', { x: 10, y: 10, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) });
  doc.addPage([300, 400]).node.delete(PDFName.of('Contents'));
  const noContents = await impose.createBooklet(await doc.save());
  assert.equal(noContents.sheets, 2);
});

test('nUp lays pages out in a grid (across or down) and stepAndRepeat repeats them', async () => {
  const sample = await impose.createSampleDocument({ pages: 5, size: 'A6' });
  const across = await impose.nUp(sample, { sheet: 'A4', rows: 2, cols: 2 });
  assert.equal(across.sheets, 2);
  const pages = await textItems(across.bytes);
  assert.deepEqual(pages.map(bigNumbers), [[1, 2, 3, 4], [5]]);
  near(pages[0].width, 595.28, 0.1);

  const down = await impose.nUp(sample, { sheet: 'A4', rows: 2, cols: 2, order: 'down' });
  assert.deepEqual((await textItems(down.bytes)).map(bigNumbers), [[1, 3, 2, 4], [5]]);

  // gap/margin too large for the cells
  await assert.rejects(impose.nUp(sample, { sheet: 'A6', rows: 1, cols: 2, margin: 200 }), (e) => e.code === 'range');

  // rotate is counter-clockwise (text then runs upwards: positive b in the text matrix)
  const rotated = await impose.nUp(await fixture('text'), { sheet: 'Letter-landscape', rows: 1, cols: 1, rotate: 90, pageIndices: [0] });
  const rotatedItems = await withPdfjs(rotated.bytes, async (doc) => (await (await doc.getPage(1)).getTextContent()).items.filter((it) => it.str.trim()));
  assert.ok(rotatedItems[0].transform[1] > 0 && rotatedItems[0].transform[2] < 0, 'rotated counter-clockwise');

  const one = await impose.stepAndRepeat(sample, { sheet: 'A4', rows: 2, cols: 2, each: false });
  assert.equal(one.sheets, 1);
  assert.deepEqual((await textItems(one.bytes)).map(bigNumbers), [[1, 1, 1, 1]]);
  const each = await impose.stepAndRepeat(sample, { sheet: 'A4', rows: 2, cols: 2, each: true, pageIndices: [0, 2] });
  assert.equal(each.sheets, 2);
  assert.deepEqual((await textItems(each.bytes)).map(bigNumbers), [[1, 1, 1, 1], [3, 3, 3, 3]]);
});

test('manualImpose places pages at explicit positions, scales and rotations', async () => {
  const sample = await impose.createSampleDocument({ pages: 3, size: 'A6', colored: false });
  const { bytes, sheets } = await impose.manualImpose(sample, {
    sheets: [
      { size: 'A4-landscape', placements: [{ page: 0, x: 20, y: 20, scale: 1 }, { page: 2, x: 400, y: 20, scale: 0.5, rotation: 90 }] },
      { size: [300, 300], placements: [{ page: 1, x: 0, y: 0, scale: 0.7 }] },
    ],
  });
  assert.equal(sheets, 2);
  const pages = await textItems(bytes);
  assert.deepEqual(await sizes(bytes), [[841.89, 595.28], [300, 300]]);
  assert.deepEqual(bigNumbers(pages[0]), [1, 3]);
  assert.deepEqual(bigNumbers(pages[1]), [2]);
  // the un-rotated page keeps its label where it was drawn (28 pt from the left edge, offset by x)
  const label = pages[0].items.find((it) => it.str === 'Page 1 of 3' && it.y > 300);
  near(label.x, 20 + 28, 0.5);
  await assert.rejects(impose.manualImpose(sample, { sheets: [{ size: 'A4', placements: [{ page: 7 }] }] }), (e) => e.code === 'range');
  await assert.rejects(impose.manualImpose(sample, { sheets: [] }), (e) => e.code === 'range');
});

test('order helpers: shuffle rules, booklet, cut and stack, even/odd', () => {
  assert.deepEqual(impose.shuffleOrder(8, [4, 1, 2, 3], 4), [3, 0, 1, 2, 7, 4, 5, 6]);
  assert.deepEqual(impose.shuffleOrder(5, [2, 1]), [1, 0, 3, 2, 4]);
  assert.deepEqual(impose.shuffleOrder(6, [1], 2), [0, 2, 4]); // a short rule selects pages
  assert.throws(() => impose.shuffleOrder(8, [5, 1], 4), (e) => e.code === 'range');
  assert.throws(() => impose.shuffleOrder(8, []), (e) => e.code === 'range');
  assert.deepEqual(impose.bookletOrder(8), [7, 0, 1, 6, 5, 2, 3, 4]);
  assert.deepEqual(impose.bookletOrder(5), [null, 0, 1, null, null, 2, 3, 4]);
  assert.deepEqual(impose.cutAndStackOrder(8, 2), [0, 4, 1, 5, 2, 6, 3, 7]);
  assert.deepEqual(impose.cutAndStackOrder(5, 2), [0, 3, 1, 4, 2, null]);
  assert.deepEqual(impose.evenOddOrder(5, 'separate'), [0, 2, 4, 1, 3]);
  assert.deepEqual(impose.evenOddOrder(5, 'separate-reverse-evens'), [0, 2, 4, 3, 1]);
  assert.deepEqual(impose.evenOddOrder(5, 'interleave'), [0, 3, 1, 4, 2]);
});

test('shufflePages, shufflePreset, reversePages and applyOrder rebuild the page order', async () => {
  const text = await fixture('text');
  assert.deepEqual(pageNumbers(await pageTexts(await impose.reversePages(text))), [5, 4, 3, 2, 1]);
  assert.deepEqual(pageNumbers(await pageTexts(await impose.shufflePages(text, { rule: [2, 1] }))), [2, 1, 4, 3, 5]);
  const cut = await impose.shufflePreset(text, 'cut-and-stack', { stacks: 2 });
  const cutTexts = await pageTexts(cut);
  assert.equal(cutTexts.length, 6);
  assert.deepEqual(pageNumbers(cutTexts.slice(0, 5)), [1, 4, 2, 5, 3]);
  assert.equal(cutTexts[5], ''); // the padding page is blank
  assert.deepEqual(pageNumbers(await pageTexts(await impose.shufflePreset(text, 'even-odd-interleave'))), [1, 4, 2, 5, 3]);
  await assert.rejects(impose.shufflePreset(text, 'nope'), (e) => e.code === 'unsupported');
  await assert.rejects(impose.applyOrder(text, [0, 9]), (e) => e.code === 'range');
  const blanks = await impose.applyOrder(text, [null, 0], { blankSize: [100, 200] });
  assert.deepEqual(await sizes(blanks), [[100, 200], [612, 792]]);
  // blanks follow the *displayed* size of the first page
  const landscapeDoc = await PDFDocument.create();
  landscapeDoc.addPage([612, 792]).setRotation(degrees(90));
  const withBlank = await impose.insertBlankPages(await landscapeDoc.save(), { at: 'end' });
  assert.deepEqual(await sizes(withBlank), [[792, 612], [792, 612]]);
});

test('insertBlankPages, fillToMultiple and duplicatePages', async () => {
  const text = await fixture('text');
  let out = await impose.insertBlankPages(text, { at: 'start', count: 2 });
  let texts = await pageTexts(out);
  assert.equal(texts.length, 7);
  assert.deepEqual(texts.slice(0, 2), ['', '']);
  assert.deepEqual(pageNumbers(texts.slice(2)), [1, 2, 3, 4, 5]);

  out = await impose.insertBlankPages(text, { at: 'after', pageIndex: 0, size: 'A5' });
  texts = await pageTexts(out);
  assert.equal(texts[1], '');
  assert.deepEqual((await sizes(out))[1], [419.53, 595.28]);

  out = await impose.insertBlankPages(text, { at: 'before', pageIndex: 4 });
  assert.equal((await pageTexts(out))[4], '');
  out = await impose.insertBlankPages(text, { afterEvery: 2 });
  texts = await pageTexts(out);
  assert.deepEqual(texts.map((t) => t === ''), [false, false, true, false, false, true, false]);

  const filled = await impose.fillToMultiple(text, 4);
  assert.equal((await pageTexts(filled)).length, 8);
  assert.equal(await impose.fillToMultiple(filled, 4), filled); // already a multiple: unchanged

  const dup = await impose.duplicatePages(text, { pageIndices: [0], copies: 2 });
  assert.deepEqual(pageNumbers(await pageTexts(dup)), [1, 1, 1, 2, 3, 4, 5]);
  const atEnd = await impose.duplicatePages(text, { pageIndices: [0, 1], copies: 1, together: false });
  assert.deepEqual(pageNumbers(await pageTexts(atEnd)), [1, 2, 3, 4, 5, 1, 2]);
});

test('trimAndShift trims margins or just moves the content', async () => {
  const text = await fixture('text');
  const before = (await textItems(text))[0];
  const trimmed = await impose.trimAndShift(text, { pageIndices: [0], trim: { top: 10, bottom: 20, left: 30, right: 40 } });
  const s = await sizes(trimmed);
  assert.deepEqual(s[0], [542, 762]);
  assert.deepEqual(s[1], [612, 792]); // untouched
  const after = (await textItems(trimmed))[0];
  const title = (p) => p.items.find((it) => it.str.startsWith('Page 1 of'));
  near(title(after).x, title(before).x - 30);
  near(title(after).y, title(before).y - 20);

  const shifted = await impose.trimAndShift(text, { pageIndices: [1], shift: { x: 50, y: -15 }, resize: false });
  assert.deepEqual((await sizes(shifted))[1], [612, 792]);
  const p2 = (await textItems(shifted))[1];
  const p2before = (await textItems(text))[1];
  near(p2.items[0].x, p2before.items[0].x + 50);
  near(p2.items[0].y, p2before.items[0].y - 15);

  const oddEven = await impose.trimAndShift(text, { oddShift: { x: 10 }, evenShift: { x: -10 }, resize: false });
  const oe = await textItems(oddEven);
  const orig = await textItems(text);
  near(oe[0].items[0].x, orig[0].items[0].x + 10);
  near(oe[1].items[0].x, orig[1].items[0].x - 10);
});

test('adjustPageSizes fits, fills, centres or stretches pages onto a new size', async () => {
  const mixed = await fixture('mixed'); // 595x842, 842x595, 300x300, 612x792 rotated 90
  const fit = await impose.adjustPageSizes(mixed, { size: 'A4', mode: 'fit' });
  assert.deepEqual(await sizes(fit), [[595.28, 841.89], [841.89, 595.28], [595.28, 841.89], [841.89, 595.28]]);
  const forced = await impose.adjustPageSizes(mixed, { pageIndices: [1], size: 'A4', orientation: 'portrait' });
  assert.deepEqual((await sizes(forced))[1], [595.28, 841.89]);
  const letter = await impose.adjustPageSizes(await fixture('text'), { size: 'Letter', mode: 'center', align: 'left' });
  assert.deepEqual((await sizes(letter))[0], [612, 792]);
  // content is not scaled in 'center' mode: text keeps its x when aligned left
  const before = (await textItems(await fixture('text')))[0].items[0];
  const after = (await textItems(letter))[0].items[0];
  near(after.x, before.x);
  const stretched = await impose.adjustPageSizes(await fixture('text'), { pageIndices: [0], size: [300, 792], mode: 'stretch' });
  const st = (await textItems(stretched))[0];
  near(st.items[0].x, before.x * (300 / 612), 1);
  near(st.items[0].y, before.y, 1);
});

test('mirrorPages, rotatePagesContent, splitPages and tilePages', async () => {
  const text = await fixture('text');
  const before = (await textItems(text))[0];
  const mirrored = await impose.mirrorPages(text, { pageIndices: [0], axis: 'horizontal' });
  const m = (await textItems(mirrored))[0];
  near(m.width, 612);
  // the text origin moves to the mirrored position (x -> width - x)
  near(m.items[0].x, 612 - before.items[0].x, 1.5);
  near(m.items[0].y, before.items[0].y, 1);
  const vertical = (await textItems(await impose.mirrorPages(text, { pageIndices: [0], axis: 'vertical' })))[0];
  near(vertical.items[0].y, 792 - before.items[0].y, 1.5);

  const rotated = await impose.rotatePagesContent(text, { pageIndices: [0], angle: 90 });
  assert.deepEqual((await sizes(rotated))[0], [792, 612]);
  assert.equal((await impose.pageInfo(rotated))[0].rotation, 0); // baked into the content, not /Rotate
  const r180 = await impose.rotatePagesContent(text, { pageIndices: [0], angle: 180 });
  assert.deepEqual((await sizes(r180))[0], [612, 792]);
  assert.match((await pageTexts(r180))[0], /Page 1 of 5/);

  const split = await impose.splitPages(text, { pageIndices: [0], mode: 'vertical' });
  const ss = await sizes(split);
  assert.equal(ss.length, 6);
  assert.deepEqual(ss.slice(0, 2), [[306, 792], [306, 792]]);
  const quad = await impose.splitPages(text, { pageIndices: [0, 1], mode: 'quad', gutter: 10 });
  const qs = await sizes(quad);
  assert.equal(qs.length, 11);
  assert.deepEqual(qs[0], [301, 391]);
  const horiz = await impose.splitPages(text, { pageIndices: [4], mode: 'horizontal' });
  assert.deepEqual((await sizes(horiz)).slice(4), [[612, 396], [612, 396]]);

  const poster = await impose.createSampleDocument({ pages: 1, size: 'A3' });
  const tiles = await impose.tilePages(poster, { tile: 'A4', overlap: 0 });
  assert.deepEqual(await sizes(tiles), [[595.28, 841.89], [595.28, 841.89], [595.28, 841.89], [595.28, 841.89]]);
  const scaled = await impose.tilePages(poster, { tile: 'A4', overlap: 20, scale: 2 });
  assert.equal((await sizes(scaled)).length, 9); // 1683x2381 at A4 tiles with 20pt overlap -> 3x3
});

test('setPageBoxes sets, insets and removes page boxes; pageInfo reports them', async () => {
  const text = await fixture('text');
  let out = await impose.setPageBoxes(text, { pageIndices: [0], box: 'crop', insets: { top: 10, right: 20, bottom: 30, left: 40 } });
  let info = await impose.pageInfo(out);
  assert.deepEqual(info[0].cropBox, [40, 30, 552, 752]);
  assert.deepEqual([info[0].width, info[0].height], [552, 752]);
  assert.deepEqual(info[1].cropBox, [0, 0, 612, 792]);
  out = await impose.setPageBoxes(out, { pageIndices: [0], box: 'trim', values: [10, 10, 100, 200] });
  info = await impose.pageInfo(out);
  assert.deepEqual(info[0].trimBox, [10, 10, 100, 200]);
  assert.equal(info[0].bleedBox, null);
  out = await impose.setPageBoxes(out, { pageIndices: [0], box: 'trim', remove: true });
  assert.equal((await impose.pageInfo(out))[0].trimBox, null);
  await assert.rejects(impose.setPageBoxes(text, { box: 'crop', values: [0, 0, 0, 10] }), (e) => e.code === 'range');
  // insets are visual: on a /Rotate 90 page the displayed top edge is the user-space left edge
  const rotDoc = await PDFDocument.create();
  rotDoc.addPage([612, 792]).setRotation(degrees(90));
  const rotCrop = await impose.setPageBoxes(await rotDoc.save(), { box: 'crop', insets: { top: 100, left: 20 } });
  const rc = (await impose.pageInfo(rotCrop))[0];
  assert.deepEqual(rc.cropBox, [100, 20, 512, 772]);
  assert.deepEqual([rc.width, rc.height], [772, 512]);
  await assert.rejects(impose.setPageBoxes(text, { box: 'nope' }), (e) => e.code === 'range');
  const mixed = await impose.pageInfo(await fixture('mixed'));
  assert.deepEqual(mixed.map((p) => p.orientation), ['portrait', 'landscape', 'square', 'landscape']);
  assert.equal(mixed[3].rotation, 90);
});

test('number formats and templates', () => {
  assert.equal(impose.toRoman(1994), 'mcmxciv');
  assert.equal(impose.toRoman(0), '0');
  assert.equal(impose.toAlpha(1), 'a');
  assert.equal(impose.toAlpha(27), 'aa');
  assert.equal(impose.formatNumber(7, 'ROMAN'), 'VII');
  assert.equal(impose.formatNumber(3, 'ALPHA'), 'C');
  assert.equal(impose.formatNumber(42, 'arabic', 5), '00042');
  const ctx = { page: 4, pages: 12, n: 2, bates: 7, batesPrefix: 'AB-', batesDigits: 4, date: 'D', time: 'T', file: 'f.pdf', sheet: 3 };
  assert.equal(impose.expandTemplate('Page {page} of {pages} ({page:roman}/{total:ROMAN}) #{n:alpha} {bates} {bates:6} {date} {time} {file} {sheet}', ctx), 'Page 4 of 12 (iv/XII) #b AB-0007 AB-000007 D T f.pdf 3');
  assert.equal(impose.expandTemplate('{page:3}', ctx), '004');
  assert.equal(impose.expandTemplate(undefined, ctx), '');
});

test('stickOnText draws page numbers, Bates numbers and headers at the requested positions', async () => {
  const text = await fixture('text');
  const numbered = await impose.stickOnText(text, { text: '- {page} -', position: 'bottom-center', margin: 18, size: 12 });
  const pages = await textItems(numbered);
  for (let i = 0; i < 5; i++) {
    const item = pages[i].items.find((it) => it.str === `- ${i + 1} -`);
    assert.ok(item, `page ${i + 1} has its number`);
    assert.ok(item.y < 40 && item.y > 10, `near the bottom: ${item.y}`);
    near(item.x + item.w / 2, 612 / 2, 1);
  }
  const bates = await impose.stickOnText(text, { text: '{bates}', batesPrefix: 'ABC', batesStart: 100, batesDigits: 5, position: 'top-right', pageIndices: [1, 3], oddEven: 'all' });
  const b = await textItems(bates);
  assert.ok(b[1].items.some((it) => it.str === 'ABC00100'));
  assert.ok(b[3].items.some((it) => it.str === 'ABC00101'));
  assert.ok(!b[0].items.some((it) => it.str.startsWith('ABC')));
  const top = b[1].items.find((it) => it.str === 'ABC00100');
  assert.ok(top.y > 792 - 40, `near the top: ${top.y}`);
  assert.ok(top.x + top.w <= 612 - 17, `right aligned: ${top.x + top.w}`);

  const odd = await impose.stickOnText(text, { text: 'ODD', oddEven: 'odd', position: 'top-left', startNumber: 10 });
  const o = await textItems(odd);
  assert.deepEqual(o.map((p) => p.items.some((it) => it.str === 'ODD')), [true, false, true, false, true]);
  const seq = await impose.stickOnText(text, { text: 'n={n}', startNumber: 10, pageIndices: [2, 4] });
  const s = await textItems(seq);
  assert.ok(s[2].items.some((it) => it.str === 'n=10'));
  assert.ok(s[4].items.some((it) => it.str === 'n=11'));

  // rotated pages: positions follow the displayed orientation. Page 4 of the mixed fixture is
  // 612x792 with /Rotate 90, so its displayed bottom edge is the user-space right edge (x near 612)
  // and its displayed top-left corner is the user-space bottom-left corner.
  const mixed = await fixture('mixed');
  const rot = await impose.stickOnText(mixed, { text: 'X{page}X', position: 'bottom-center', pageIndices: [3], margin: 18 });
  const bottom = (await textItems(rot))[3].items.find((it) => it.str === 'X4X');
  assert.ok(bottom.x > 585 && bottom.x < 600, `bottom-center lands by the user-space right edge: ${bottom.x}`);
  assert.ok(bottom.y > 300 && bottom.y < 450, `and vertically centred: ${bottom.y}`);
  const topLeft = (await textItems(await impose.stickOnText(mixed, { text: 'TL', position: 'top-left', pageIndices: [3], margin: 18 })))[3].items.find((it) => it.str === 'TL');
  assert.ok(topLeft.x > 18 && topLeft.x < 45 && topLeft.y > 15 && topLeft.y < 22, `top-left lands at the user-space bottom-left: ${topLeft.x},${topLeft.y}`);
});

test('maskingTape covers a rectangle or an edge and rejects empty tape', async () => {
  const text = await fixture('text');
  const opCount = (bytes) =>
    withPdfjs(bytes, async (doc) => {
      const page = await doc.getPage(1);
      const ops = await page.getOperatorList();
      return ops.fnArray.length;
    });
  const before = await opCount(text);
  const taped = await impose.maskingTape(text, { pageIndices: [0], rect: [10, 10, 100, 50], color: '#ff0000' });
  assert.ok((await opCount(taped)) > before);
  const edge = await impose.maskingTape(text, { fromEdges: { edge: 'top', depth: 40 } });
  assert.equal((await pageTexts(edge)).length, 5);
  await assert.rejects(impose.maskingTape(text, { rect: [0, 0, 0, 0] }), (e) => e.code === 'range');
  const doc = await pdflibLoad(taped);
  const content = doc.getPage(0).node.Contents();
  assert.ok(content, 'page keeps a content stream');
});

test('placeMarks grows the page and draws crop marks, registration, colour bars and a label', async () => {
  const text = await fixture('text');
  const marked = await impose.placeMarks(text, { pageIndices: [0], margin: 36, label: 'Job {file} p{page}/{pages} {date}', file: 'x.pdf', foldMarks: true });
  const s = await sizes(marked);
  assert.deepEqual(s[0], [684, 864]);
  assert.deepEqual(s[1], [612, 792]);
  const pages = await textItems(marked);
  assert.ok(pages[0].items.some((it) => it.str.startsWith('Job x.pdf p1/5')));
  // original content moved inward by the margin
  const before = (await textItems(text))[0].items[0];
  const after = pages[0].items.find((it) => it.str === before.str);
  near(after.x, before.x + 36);
  near(after.y, before.y + 36);
  const same = await impose.placeMarks(text, { grow: false, margin: 36, label: 'INSIDE', pageIndices: [0] });
  assert.deepEqual((await sizes(same))[0], [612, 792]);
  const inside = (await textItems(same))[0].items.find((it) => it.str === 'INSIDE');
  assert.ok(inside && inside.x > 0 && inside.y > 0 && inside.y < 36, 'label drawn inside the page when not growing');
});

test('runSequence replays recorded steps and rejects unknown ones', async () => {
  const text = await fixture('text');
  const out = await impose.runSequence(text, [
    { op: 'fill-multiple', params: { multiple: 4 } },
    { op: 'stick-text', params: { text: '{page}', position: 'bottom-right' } },
    { op: 'booklet', params: { sheet: 'A4-landscape' } },
  ]);
  assert.equal((await pageTexts(out)).length, 4);
  assert.deepEqual((await sizes(out))[0], [841.89, 595.28]);
  await assert.rejects(impose.runSequence(text, [{ op: 'explode' }]), (e) => e.code === 'unsupported');
  assert.deepEqual(Object.keys(impose.OPS).sort(), ['adjust-size', 'booklet', 'duplicate', 'fill-multiple', 'insert-blank', 'manual', 'marks', 'mirror', 'nup', 'page-boxes', 'reverse', 'rotate-content', 'shuffle', 'shuffle-preset', 'split', 'step-repeat', 'stick-text', 'tape', 'tile', 'trim-shift']);
});

test('resolveSheet understands names, orientation suffixes, arrays and objects', () => {
  assert.deepEqual(impose.resolveSheet('A4'), [595.28, 841.89]);
  assert.deepEqual(impose.resolveSheet('A4-landscape'), [841.89, 595.28]);
  assert.deepEqual(impose.resolveSheet('Letter-portrait'), [612, 792]);
  assert.deepEqual(impose.resolveSheet([100, 200]), [100, 200]);
  assert.deepEqual(impose.resolveSheet({ width: 10, height: 20 }), [10, 20]);
  assert.deepEqual(impose.resolveSheet('nope', [1, 2]), [1, 2]);
  assert.deepEqual(impose.resolveSheet([0, 5], [1, 2]), [1, 2]);
});

test('imposition output keeps the title and still passes through the engine', async () => {
  const text = await fixture('text');
  const { bytes } = await impose.nUp(text, { rows: 1, cols: 2 });
  assert.equal((await engine.getMetadata(bytes)).title, 'Folio sample document');
  const info = await engine.getPageInfo(bytes);
  assert.equal(info.count, 3);
  const rotated = await engine.rotatePages(bytes, [0], 90);
  assert.equal((await engine.getPageInfo(rotated)).pages[0].rotation, 90);
});
