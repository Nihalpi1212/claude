// Hyphenation for type-paragraph-panel (ARCHITECTURE.md "0.4 features", package 4; B.2 registerHyphenator): Liang's
// algorithm on the TeX patterns of hyph-utf8 (lib/type/patterns/, licences in LICENSES.md there), standing in for
// Adobe's dictionaries. Pure: no DOM, so Node tests import it.
//
// Pattern files are loaded on demand (the German one is 270 KB): `ensureLanguage(tag)` imports and parses them; until
// then `hyphenateWord` answers null for that language and asks for the load, and `onLanguageLoaded` tells the caller
// when it arrives (the Paragraph panel then relays out the text, B.4's route). American English starts loading at
// install, so the default language is ready by the time anyone types.

/** Bundled languages: BCP 47 tag -> pattern module. These are the tags the hyphenator registers (B.2 `languages`). */
export const HYPHENATION_LANGUAGES = Object.freeze({
  'en-US': './patterns/en-us.js',
  'en-GB': './patterns/en-gb.js',
  de: './patterns/de.js',
  fr: './patterns/fr.js',
  es: './patterns/es.js',
  it: './patterns/it.js',
  nl: './patterns/nl.js',
  pt: './patterns/pt.js',
});

// regional tags that use one of the bundled pattern sets (B.2's lookup is by exact tag: these go through the fallback
// hyphenator, which matches any tag)
const BASE = { en: 'en-US', 'en-us': 'en-US', 'en-gb': 'en-GB', 'en-au': 'en-GB', 'en-nz': 'en-GB', 'en-ie': 'en-GB', 'en-za': 'en-GB', 'en-in': 'en-GB', 'en-ca': 'en-US' };

/** The bundled tag that hyphenates `lang` ('de-AT' -> 'de', 'en-AU' -> 'en-GB'), or null. */
export function patternLanguage(lang) {
  if (!lang) return null;
  if (HYPHENATION_LANGUAGES[lang]) return lang;
  const low = String(lang).toLowerCase();
  if (BASE[low]) return BASE[low];
  const primary = low.split(/[-_]/)[0];
  if (BASE[primary]) return BASE[primary];
  return HYPHENATION_LANGUAGES[primary] ? primary : null;
}

// ---- Liang's algorithm ------------------------------------------------------------------------------------------------

/**
 * A pattern trie from TeX patterns ("1ba .ach4 4b1h ..."): nested Maps keyed by character; a node's `v` holds the
 * digits as an array (v[k] = the value before the node path's k-th character, v[length] after the last).
 */
export function parsePatterns(text) {
  const root = new Map();
  for (const pat of String(text).split(/\s+/)) {
    if (!pat) continue;
    const chars = [];
    const digits = [0];
    for (const ch of pat) {
      if (ch >= '0' && ch <= '9') digits[digits.length - 1] = Number(ch);
      else {
        chars.push(ch);
        digits.push(0);
      }
    }
    let node = root;
    for (const ch of chars) {
      let next = node.get(ch);
      if (!next) node.set(ch, (next = new Map()));
      node = next;
    }
    node.v = digits;
  }
  return root;
}

/** Exceptions ("as-so-ciate ...") -> Map(lower-case word -> positions). */
export function parseExceptions(text) {
  const out = new Map();
  for (const ex of String(text ?? '').split(/\s+/)) {
    if (!ex) continue;
    const pos = [];
    let word = '';
    for (const ch of ex) {
      if (ch === '-') pos.push([...word].length);
      else word += ch;
    }
    out.set(word.toLowerCase(), pos);
  }
  return out;
}

/**
 * Raw hyphenation points of a word by Liang's algorithm: positions p (1 .. length − 1, in UTF-16 units of `word`)
 * where a hyphen may stand before word[p]. No minimum lengths are applied (the facade applies Photoshop's After First
 * and Before Last, B.3). `dict` = { trie, exceptions }.
 */
export function liang(word, dict, lower = word.toLowerCase()) {
  const ex = dict.exceptions?.get(lower);
  if (ex) return toUnits(word, ex);
  const chars = ['.', ...lower, '.'];
  const n = chars.length;
  const levels = new Uint8Array(n + 1);
  for (let i = 0; i < n; i++) {
    let node = dict.trie;
    for (let j = i; j < n; j++) {
      node = node.get(chars[j]);
      if (!node) break;
      const v = node.v;
      if (v) for (let k = 0; k < v.length; k++) if (v[k] > levels[i + k]) levels[i + k] = v[k];
    }
  }
  // levels[i] is the value before chars[i]; chars[0] is the boundary, so a break before letter m is levels[m + 1]
  const letters = n - 2;
  const pos = [];
  for (let m = 1; m < letters; m++) if (levels[m + 1] & 1) pos.push(m);
  return toUnits(word, pos);
}

/** Code-point positions -> UTF-16 positions in `word` (they differ only around astral characters). */
function toUnits(word, cps) {
  if (word.length === [...word].length) return cps.slice();
  const map = [];
  let u = 0;
  for (const ch of word) {
    map.push(u);
    u += ch.length;
  }
  map.push(u);
  return cps.map((p) => map[p]);
}

// ---- languages ---------------------------------------------------------------------------------------------------------

const dicts = new Map(); // tag -> { trie, exceptions }
const loading = new Map(); // tag -> Promise
const listeners = new Set();
const cache = new Map(); // `${tag}\u0000${word}` -> positions

/** Installs a parsed pattern set (tests; also the loader). `data` = { patterns, exceptions } as the pattern modules export. */
export function setLanguageData(tag, data) {
  dicts.set(tag, { trie: parsePatterns(data.patterns), exceptions: parseExceptions(data.exceptions) });
  for (const k of [...cache.keys()]) if (k.startsWith(`${tag}\u0000`)) cache.delete(k);
}

/** True when the patterns of `lang` (or the bundled language it maps to) are loaded. */
export function languageReady(lang) {
  const tag = patternLanguage(lang);
  return !!tag && dicts.has(tag);
}

/** Loads the patterns of `lang` (resolves to true, or false for a language with no bundled patterns). */
export function ensureLanguage(lang) {
  const tag = patternLanguage(lang);
  if (!tag) return Promise.resolve(false);
  if (dicts.has(tag)) return Promise.resolve(true);
  if (!loading.has(tag)) {
    loading.set(tag, import(HYPHENATION_LANGUAGES[tag]).then((m) => {
      setLanguageData(tag, m.default);
      for (const fn of listeners) {
        try {
          fn(tag);
        } catch (err) {
          console.warn('hyphenation listener failed', err);
        }
      }
      return true;
    }).catch((err) => {
      console.warn(`hyphenation patterns for ${tag} failed to load`, err);
      loading.delete(tag);
      return false;
    }));
  }
  return loading.get(tag);
}

/** fn(tag) after a language's patterns arrive; returns an unsubscribe function. */
export function onLanguageLoaded(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const LETTERS = /^[\p{L}\p{M}'’]+$/u;

/**
 * The hyphenator registered with the facade (B.2): raw positions inside `word` for `lang`, or null when the language
 * has no patterns (or they are still loading: the load starts and the text is laid out again when they arrive). Words
 * with characters other than letters, marks and apostrophes are not hyphenated.
 */
export function hyphenateWord(word, lang) {
  const tag = patternLanguage(lang);
  if (!tag || !word || word.length < 2) return null;
  const dict = dicts.get(tag);
  if (!dict) {
    ensureLanguage(tag);
    return null;
  }
  if (!LETTERS.test(word)) return [];
  const key = `${tag}\u0000${word}`;
  const hit = cache.get(key);
  if (hit) return hit.slice();
  const lower = word.toLocaleLowerCase(tag);
  // a case mapping that changes the length (Turkish dotted I and the like) would shift the positions: no hyphens
  const pos = lower.length === word.length ? liang(word, dict, lower.replace(/’/g, "'")) : [];
  if (cache.size > 20000) cache.clear();
  cache.set(key, pos);
  return pos.slice();
}
