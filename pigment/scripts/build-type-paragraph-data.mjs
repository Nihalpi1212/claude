// Builds the data modules of type-paragraph-panel (ARCHITECTURE.md "0.4 features", package 4) in
// src/renderer/lib/type/patterns/: the TeX hyphenation patterns of eight languages and the Unicode Line_Break classes
// the UAX 14 breaker reads. The generated files are committed; this script is only run again to update the data.
//
//   node scripts/build-type-paragraph-data.mjs --hyphen <dir> --unicode <dir>
//
// <dir> are unpacked npm tarballs (`npm pack hyphen@1.14.1`, `npm pack @unicode/unicode-16.0.0@2.1.0`). Nothing in them
// is executed: the pattern tries and the code-point ranges are read as text and decoded here.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'renderer', 'lib', 'type', 'patterns');
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.hyphen || !args.unicode) {
  console.error('usage: node scripts/build-type-paragraph-data.mjs --hyphen <unpacked hyphen@1.14.1> --unicode <unpacked @unicode/unicode-16.0.0>');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// ---- hyphenation patterns ------------------------------------------------------------------------------------------

// Licences as the hyph-utf8 files state them (checked against the metadata Hyphenopoly 6.1.0 embeds and the licence
// files of the hyphenated-* 1.2.0 packages). Every one allows redistribution in an MIT application.
const LANGS = [
  { tag: 'en-US', file: 'en-us', name: 'American English', source: 'hyph-en-us.tex', copyright: 'Copyright (C) 1990, 2004, 2005 Gerard D.C. Kuiken', licence: 'Copying and distribution of this file, with or without modification, are permitted in any medium without royalty provided the copyright notice and this notice are preserved.', licenceName: 'all-permissive (FSF)' },
  { tag: 'en-GB', file: 'en-gb', name: 'British English', source: 'hyph-en-gb.tex', copyright: 'Copyright (C) 1992, 1996, 2005, 2016 Dominik Wujastyk, Graham Toal', licenceName: 'MIT' },
  { tag: 'de', file: 'de-1996', name: 'German (1996 spelling reform)', source: 'hyph-de-1996.tex', copyright: 'Copyright (C) 2013-2018 Stephan Hennig, Werner Lemberg, Günter Milde, Sander van Geloven, Georg Pfeiffer, Gisbert W. Selke, Tobias Wendorf', licenceName: 'MIT' },
  { tag: 'fr', file: 'fr', name: 'French', source: 'hyph-fr.tex', copyright: 'Copyright (C) 1994-2002 Daniel Flipo, Bernard Gaulle, 2016 Arthur Reutenauer', licenceName: 'MIT' },
  { tag: 'es', file: 'es', name: 'Spanish', source: 'hyph-es.tex', copyright: 'Copyright (C) 1993, 1997 Javier Bezos, 2001-2019 Javier Bezos, CervanTeX', licenceName: 'MIT/X11' },
  { tag: 'it', file: 'it', name: 'Italian', source: 'hyph-it.tex', copyright: 'Copyright (C) 2008-2011 Claudio Beccari', licenceName: 'MIT (the file is dual-licensed LPPL or MIT; Pigment uses it under MIT)' },
  { tag: 'nl', file: 'nl', name: 'Dutch', source: 'hyph-nl.tex', copyright: 'Copyright (C) 1996 Piet Tutelaers', licenceName: 'MIT' },
  { tag: 'pt', file: 'pt', name: 'Portuguese', source: 'hyph-pt.tex', copyright: 'Copyright (C) 1987, 1994, 1996, 2015 Pedro J. de Rezende, 1996, 2015 J. Joao Dias Almeida, 2024 Leonardo Araujo and Aline Benevides', licenceName: 'BSD 3-clause' },
];

const MIT = (c) => `${c}

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const BSD3 = (c) => `${c}
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote
   products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
const licenceText = (l) => (l.licence ? `${l.copyright}\n\n${l.licence}` : l.licenceName.startsWith('BSD') ? BSD3(l.copyright) : MIT(l.copyright));

/** The `hyphen` package's data file as plain data: the UMD wrapper cut off, bare keys quoted, JSON.parse (no eval). */
function readHyphenData(file) {
  const src = readFileSync(file, 'utf8');
  const body = src.slice(src.indexOf('})(this, ') + 9, src.lastIndexOf(');'));
  return JSON.parse(body.replace(/([{,]\s*)([^\s"{}[\]:,]+)\s*:/gu, '$1"$2":'));
}

/**
 * Liang patterns from the package's trie: a path of characters ends in a levels index; levels[k] is the digit before
 * the path's k-th character (the (k + 1)-th when the path starts with the word boundary '.', whose own digit is never
 * stored). Checked: en-us and en-gb decode to exactly the pattern lists of hyphenated-en-us / -en-gb 1.2.0.
 */
function decodePatterns([levels, trie]) {
  const out = [];
  const emit = (path, lv) => {
    const L = levels[lv];
    const chars = [...path];
    const dot = chars[0] === '.';
    const off = dot ? 1 : 0;
    let s = '';
    for (let k = 0; k <= chars.length; k++) {
      const d = k - off >= 0 ? L[k - off] ?? 0 : 0;
      if ((k > 0 || !dot) && d) s += d;
      if (k < chars.length) s += chars[k];
    }
    out.push(s);
  };
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node)) {
      const p = path + k;
      if (typeof v === 'number') emit(p, v);
      else if (Array.isArray(v)) {
        emit(p, v[1]);
        walk(v[0], p);
      } else walk(v, p);
    }
  };
  walk(trie, '');
  return out.sort();
}

/**
 * Exceptions { word: [markers] } as TeX writes them ("as-so-ciates"). The package stores the index of each '-' in the
 * hyphenated spelling (associates: [2, 5]), so the k-th marker stands before letter marker − k.
 */
function decodeExceptions(exc) {
  return Object.entries(exc ?? {}).map(([w, marks]) => {
    const at = marks.map((m, k) => m - k);
    let s = '';
    [...w].forEach((ch, i) => {
      if (at.includes(i)) s += '-';
      s += ch;
    });
    return s;
  }).sort();
}

const comment = (text) => text.split('\n').map((l) => `// ${l}`.trimEnd()).join('\n');
const licences = [];
for (const l of LANGS) {
  const data = readHyphenData(join(args.hyphen, 'patterns', `${l.file}.js`));
  const patterns = decodePatterns(data);
  const exceptions = decodeExceptions(data[2]);
  const name = l.tag.toLowerCase();
  const head = `// Hyphenation patterns for ${l.name} (${l.tag}), read by lib/type/hyphenation.js. Generated by
// scripts/build-type-paragraph-data.mjs from ${l.source} of hyph-utf8 as the npm package hyphen@1.14.1 (ISC) ships it;
// the patterns are unchanged, only written out as text. Licence of the patterns: ${l.licenceName}.
//
${comment(licenceText(l))}
`;
  const body = `export default {\n  tag: ${JSON.stringify(l.tag)},\n  source: ${JSON.stringify(l.source)},\n  patterns: ${JSON.stringify(patterns.join(' '))},\n  exceptions: ${JSON.stringify(exceptions.join(' '))},\n};\n`;
  writeFileSync(join(out, `${name}.js`), `${head}${body}`);
  licences.push({ ...l, file: `${name}.js`, count: patterns.length, exceptions: exceptions.length });
  console.log(`patterns: ${name}.js ${patterns.length} patterns, ${exceptions.length} exceptions`);
}

// ---- Unicode Line_Break classes (UAX 14) ---------------------------------------------------------------------------

const CLASS_DIRS = {
  Unknown: 'XX', Aksara: 'AK', Aksara_Prebase: 'AP', Aksara_Start: 'AS', Alphabetic: 'AL', Ambiguous: 'AI', Break_After: 'BA',
  Break_Before: 'BB', Break_Both: 'B2', Break_Symbols: 'SY', Carriage_Return: 'CR', Close_Parenthesis: 'CP',
  Close_Punctuation: 'CL', Combining_Mark: 'CM', Complex_Context: 'SA', Conditional_Japanese_Starter: 'CJ',
  Contingent_Break: 'CB', E_Base: 'EB', E_Modifier: 'EM', Exclamation: 'EX', Glue: 'GL', H2: 'H2', H3: 'H3',
  Hebrew_Letter: 'HL', Hyphen: 'HY', Ideographic: 'ID', Infix_Numeric: 'IS', Inseparable: 'IN', JL: 'JL', JT: 'JT',
  JV: 'JV', Line_Feed: 'LF', Mandatory_Break: 'BK', Next_Line: 'NL', Nonstarter: 'NS', Numeric: 'NU',
  Open_Punctuation: 'OP', Postfix_Numeric: 'PO', Prefix_Numeric: 'PR', Quotation: 'QU', Regional_Indicator: 'RI',
  Space: 'SP', Surrogate: 'SG', Virama: 'VI', Virama_Final: 'VF', Word_Joiner: 'WJ', ZWJ: 'ZWJ', ZWSpace: 'ZW',
};
const CLASSES = Object.values(CLASS_DIRS);

// decode-ranges.mjs of @unicode/unicode-16.0.0, re-implemented (base64 variable-length deltas, then begin/length pairs)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function decodeRanges(input) {
  const dec = Object.fromEntries([...B64].map((c, i) => [c, i]));
  const deltas = [];
  for (let i = 0; i < input.length;) {
    let x = dec[input[i++]];
    switch (x & 56) {
      case 32: case 40: x = ((x & 15) << 6) | dec[input[i++]]; break;
      case 48: x = ((x & 7) << 12) | (dec[input[i++]] << 6) | dec[input[i++]]; break;
      case 56: x = ((x & 7) << 18) | (dec[input[i++]] << 12) | (dec[input[i++]] << 6) | dec[input[i++]]; break;
      default: break;
    }
    deltas.push(x);
  }
  const ranges = [];
  for (let end = -1, i = 1; i < deltas.length; i += 2) {
    const begin = end + 1 + deltas[i - 1];
    end = begin + 1 + deltas[i];
    ranges.push([begin, end]); // [begin, end)
  }
  return ranges;
}

const lbDir = join(args.unicode, 'Line_Break');
const dirs = readdirSync(lbDir).filter((d) => existsSync(join(lbDir, d, 'ranges.mjs')));
const unknown = dirs.filter((d) => !(d in CLASS_DIRS));
if (unknown.length) throw new Error(`unknown Line_Break classes: ${unknown.join(', ')}`);
const cls = new Uint8Array(0x110000); // 0 = XX
for (const d of dirs) {
  const src = readFileSync(join(lbDir, d, 'ranges.mjs'), 'utf8');
  const m = src.match(/decodeRanges\('([A-Za-z0-9_-]*)'\)/);
  if (!m) throw new Error(`no ranges in ${d}`);
  const c = CLASSES.indexOf(CLASS_DIRS[d]);
  for (const [b, e] of decodeRanges(m[1])) cls.fill(c, b, e);
}
// runs of one class: "start,class;" with start as the base-36 delta from the previous run's start
const runs = [];
for (let cp = 0; cp < 0x110000; cp++) if (cp === 0 || cls[cp] !== cls[cp - 1]) runs.push([cp, cls[cp]]);
let prev = 0;
const encoded = runs.map(([s, c]) => {
  const d = s - prev;
  prev = s;
  return `${d.toString(36)}.${c.toString(36)}`;
}).join(',');
const unicodeLicence = `Unicode Character Database, LineBreak.txt (Unicode 16.0.0), read from the npm package @unicode/unicode-16.0.0@2.1.0 (MIT).
Copyright (C) 1991-2024 Unicode, Inc.

UNICODE LICENSE V3. Permission is hereby granted, free of charge, to any person obtaining a copy of data files and any
associated documentation (the "Data Files") or software and any associated documentation (the "Software") to deal in
the Data Files or Software without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, and/or sell copies of the Data Files or Software, and to permit persons to whom the Data Files or
Software are furnished to do so, provided that either (a) this copyright and permission notice appear with all copies
of the Data Files or Software, or (b) this copyright and permission notice appear in associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD PARTY
RIGHTS. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE BE LIABLE FOR ANY CLAIM, OR ANY
SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THE DATA FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall not be used in advertising or otherwise to
promote the sale, use or other dealings in these Data Files or Software without prior written authorization of the
copyright holder.`;
writeFileSync(join(out, 'line-break.js'), `// Unicode Line_Break classes (UAX 14) for lib/type/line-breaks.js. Generated by scripts/build-type-paragraph-data.mjs.
// RUNS: "delta.class" pairs in base 36, comma-separated: each run starts \`delta\` code points after the previous one
// and holds class CLASSES[class] up to the next run.
//
${comment(unicodeLicence)}
export const CLASSES = ${JSON.stringify(CLASSES)};
export const RUNS = ${JSON.stringify(encoded)};
`);
console.log(`line-break.js: ${runs.length} runs, ${encoded.length} characters`);

// ---- the licence record next to the files --------------------------------------------------------------------------

const md = `# Bundled text data and its licences

Generated by \`scripts/build-type-paragraph-data.mjs\` (type-paragraph-panel, Pigment 0.4). Every file carries its own
copyright and licence notice in its header; this list repeats them. Each licence allows redistribution in Pigment, an
MIT-licensed application.

## Hyphenation patterns (Liang / TeX), read by \`lib/type/hyphenation.js\`

Source: the hyph-utf8 project's pattern files as shipped by the npm package \`hyphen@1.14.1\` (ISC licence; its data is
generated from hyph-utf8). The patterns are unchanged; the script only writes them out as text. The licence of each
pattern file was checked against the hyph-utf8 metadata that Hyphenopoly 6.1.0 embeds and, where available, against the
licence files of the \`hyphenated-*\` 1.2.0 packages.

| File | Language | hyph-utf8 file | Patterns | Exceptions | Licence | Copyright |
|---|---|---|---|---|---|---|
${licences.map((l) => `| \`${l.file}\` | ${l.name} (\`${l.tag}\`) | \`${l.source}\` | ${l.count} | ${l.exceptions} | ${l.licenceName} | ${l.copyright} |`).join('\n')}

Languages left out: none of the eight the 0.4 contract asks for. Other hyph-utf8 languages are not bundled in 0.4
(type-international, 0.9, adds them; check each file's licence: several are LPPL-only or GPL).

## Unicode Line_Break classes, read by \`lib/type/line-breaks.js\`

\`line-break.js\`: the Line_Break property of Unicode 16.0.0 (LineBreak.txt), read from the npm package
\`@unicode/unicode-16.0.0@2.1.0\` (MIT). Unicode License V3; the notice is in the file's header.
`;
writeFileSync(join(out, 'LICENSES.md'), md);
console.log('LICENSES.md written');
