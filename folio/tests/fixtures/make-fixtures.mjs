// Generates fixture PDFs used by the unit and e2e tests into tests/fixtures/out/.
// Run: node tests/fixtures/make-fixtures.mjs
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// ---- password protected (standard security handler, revision 2, RC4 40-bit) ---------------------------
const PAD = Buffer.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}
const padPassword = (pwd) => Buffer.concat([Buffer.from(pwd, 'latin1'), PAD]).subarray(0, 32);

/** A one-page PDF that needs `password` to open (user password = owner password). */
export function makeEncryptedPdf(password = 'secret', text = 'Secret page') {
  const id = md5(Buffer.from('folio-encrypted-fixture'));
  const P = -1;
  const ownerKey = md5(padPassword(password)).subarray(0, 5);
  const O = rc4(ownerKey, padPassword(password));
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  const key = md5(padPassword(password), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objKey = (num, gen) => md5(key, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff])).subarray(0, 10);
  const hex = (b) => Buffer.from(b).toString('hex').toUpperCase();
  const content = Buffer.from(`BT /F1 24 Tf 72 700 Td (${text}) Tj ET`, 'latin1');
  const encContent = rc4(objKey(4, 0), content);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null, // stream
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${P} /O <${hex(O)}> /U <${hex(U)}> >>`,
  ];
  const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((obj, i) => {
    offsets.push(pos);
    let buf;
    if (obj === null) buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${encContent.length} >>\nstream\n`, 'latin1'), encContent, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    else buf = Buffer.from(`${i + 1} 0 obj\n${obj}\nendobj\n`, 'latin1');
    parts.push(buf);
    pos += buf.length;
  });
  const xrefPos = pos;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}

export async function makeAll() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = {
    'text.pdf': await makeTextPdf(5),
    'long.pdf': await makeTextPdf(40),
    'form.pdf': await makeFormPdf(),
    'mixed.pdf': await makeMixedPdf(),
    'annotated.pdf': await makeAnnotatedPdf(),
    'secret.pdf': makeEncryptedPdf('secret'),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(OUT_DIR, name), bytes);
  return Object.keys(files);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  makeAll().then((names) => console.log(`fixtures written to ${OUT_DIR}: ${names.join(', ')}`));
}
