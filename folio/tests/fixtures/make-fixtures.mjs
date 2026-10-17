// Generates fixture PDFs used by the unit and e2e tests into tests/fixtures/out/.
// Run: node tests/fixtures/make-fixtures.mjs
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(here, 'out');

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];

/** 5-page Letter document with distinct text per page, a title and an outline. */
export async function makeTextPdf(pages = 5) {
  const doc = await PDFDocument.create();
  doc.setTitle('Folio sample document');
  doc.setAuthor('Folio tests');
  doc.setSubject('Fixture');
  doc.setKeywords(['folio', 'fixture']);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageRefs = [];
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([612, 792]);
    pageRefs.push(page.ref);
    page.drawText(`Folio sample document`, { x: 72, y: 720, size: 22, font: bold, color: rgb(0.1, 0.1, 0.3) });
    page.drawText(`Page ${i + 1} of ${pages}`, { x: 72, y: 690, size: 12, font });
    const word = WORDS[i % WORDS.length];
    const lines = [
      `This page is about ${word}. The keyword ${word} appears several times so that search`,
      `tests can count matches: ${word}, ${word.toUpperCase()}, and ${word} again.`,
      'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
      'Sphinx of black quartz, judge my vow. How vexingly quick daft zebras jump!',
    ];
    lines.forEach((line, j) => page.drawText(line, { x: 72, y: 640 - j * 18, size: 11, font }));
    page.drawRectangle({ x: 72, y: 400, width: 200, height: 120, borderColor: rgb(0.2, 0.5, 0.9), borderWidth: 2 });
    page.drawText('Unique marker: ZEBRA-' + (i + 1), { x: 72, y: 380, size: 11, font });
    page.drawText(`${i + 1}`, { x: 300, y: 40, size: 10, font });
  }
  // Outline (bookmarks): one top-level entry per page.
  const ctx = doc.context;
  const outlineRef = ctx.nextRef();
  const itemRefs = pageRefs.map(() => ctx.nextRef());
  itemRefs.forEach((ref, i) => {
    const dict = ctx.obj({
      Title: PDFHexString.fromText(`Section ${i + 1}: ${WORDS[i % WORDS.length]}`),
      Parent: outlineRef,
      Dest: [pageRefs[i], PDFName.of('XYZ'), null, 792, null],
    });
    if (i > 0) dict.set(PDFName.of('Prev'), itemRefs[i - 1]);
    if (i < itemRefs.length - 1) dict.set(PDFName.of('Next'), itemRefs[i + 1]);
    ctx.assign(ref, dict);
  });
  ctx.assign(outlineRef, ctx.obj({ Type: 'Outlines', First: itemRefs[0], Last: itemRefs[itemRefs.length - 1], Count: itemRefs.length }));
  doc.catalog.set(PDFName.of('Outlines'), outlineRef);
  return doc.save({ useObjectStreams: false });
}

/** AcroForm with text, checkbox, radio, dropdown and multiline fields. */
export async function makeFormPdf() {
  const doc = await PDFDocument.create();
  doc.setTitle('Folio form fixture');
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  page.drawText('Registration form', { x: 72, y: 720, size: 20, font });
  page.drawText('Name', { x: 72, y: 672, size: 11, font });
  const name = form.createTextField('name');
  name.addToPage(page, { x: 160, y: 660, width: 260, height: 24 });
  page.drawText('Email', { x: 72, y: 632, size: 11, font });
  const email = form.createTextField('email');
  email.addToPage(page, { x: 160, y: 620, width: 260, height: 24 });
  page.drawText('I agree to the terms', { x: 190, y: 585, size: 11, font });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 160, y: 578, width: 18, height: 18 });
  page.drawText('Favourite colour', { x: 72, y: 540, size: 11, font });
  const colour = form.createRadioGroup('colour');
  colour.addOptionToPage('red', page, { x: 160, y: 532, width: 18, height: 18 });
  colour.addOptionToPage('green', page, { x: 240, y: 532, width: 18, height: 18 });
  page.drawText('red', { x: 184, y: 537, size: 10, font });
  page.drawText('green', { x: 264, y: 537, size: 10, font });
  page.drawText('Country', { x: 72, y: 495, size: 11, font });
  const country = form.createDropdown('country');
  country.addOptions(['Canada', 'France', 'Japan', 'United States']);
  country.addToPage(page, { x: 160, y: 483, width: 200, height: 24 });
  page.drawText('Comments', { x: 72, y: 445, size: 11, font });
  const comments = form.createTextField('comments');
  comments.enableMultiline();
  comments.addToPage(page, { x: 160, y: 360, width: 300, height: 100 });
  return doc.save({ useObjectStreams: false });
}

/** Pages of different sizes and rotations. */
export async function makeMixedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sizes = [
    [595, 842],
    [842, 595],
    [300, 300],
    [612, 792],
  ];
  sizes.forEach(([w, h], i) => {
    const page = doc.addPage([w, h]);
    page.drawText(`Mixed page ${i + 1} (${w}x${h})`, { x: 30, y: h - 50, size: 16, font });
    if (i === 3) page.setRotation(degrees(90));
  });
  return doc.save({ useObjectStreams: false });
}

/** A document with a few existing annotations (sticky note, square, highlight) written by hand. */
export async function makeAnnotatedPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText('Annotated fixture: this line is highlighted', { x: 72, y: 700, size: 14, font });
  page.drawText('A square annotation sits below', { x: 72, y: 600, size: 12, font });
  const ctx = doc.context;
  const annots = [];
  const note = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [500, 700, 520, 720],
      Contents: PDFHexString.fromText('Existing sticky note'),
      T: PDFHexString.fromText('Fixture Author'),
      M: PDFString.fromDate(new Date('2026-01-02T03:04:05Z')),
      CreationDate: PDFString.fromDate(new Date('2026-01-01T00:00:00Z')),
      C: [1, 0.85, 0.3],
      Name: 'Comment',
      F: 4,
      NM: PDFString.of('note-1'),
    })
  );
  annots.push(note);
  annots.push(
    ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Square',
        Rect: [72, 480, 300, 580],
        C: [0.9, 0.2, 0.2],
        CA: 1,
        BS: { W: 2 },
        T: PDFHexString.fromText('Fixture Author'),
        Contents: PDFHexString.fromText('A red square'),
        M: PDFString.fromDate(new Date('2026-01-02T03:04:05Z')),
        F: 4,
        NM: PDFString.of('square-1'),
      })
    )
  );
  const width = font.widthOfTextAtSize('Annotated fixture: this line is highlighted', 14);
  annots.push(
    ctx.register(
      ctx.obj({
        Type: 'Annot',
        Subtype: 'Highlight',
        Rect: [72, 696, 72 + width, 716],
        QuadPoints: [72, 716, 72 + width, 716, 72, 696, 72 + width, 696],
        C: [1, 1, 0],
        CA: 1,
        T: PDFHexString.fromText('Fixture Author'),
        Contents: PDFHexString.fromText('Important'),
        M: PDFString.fromDate(new Date('2026-01-02T03:04:05Z')),
        F: 4,
        NM: PDFString.of('highlight-1'),
      })
    )
  );
  page.node.set(PDFName.of('Annots'), ctx.obj(annots));
  return doc.save({ useObjectStreams: false });
}

export async function makeAll() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = {
    'text.pdf': await makeTextPdf(5),
    'long.pdf': await makeTextPdf(40),
    'form.pdf': await makeFormPdf(),
    'mixed.pdf': await makeMixedPdf(),
    'annotated.pdf': await makeAnnotatedPdf(),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(OUT_DIR, name), bytes);
  return Object.keys(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  makeAll().then((names) => console.log(`fixtures written to ${OUT_DIR}: ${names.join(', ')}`));
}
