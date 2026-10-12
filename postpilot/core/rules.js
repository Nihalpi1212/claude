// Automation rule engine (pure, environment-neutral).
//
// Event (built by the worker from comments, DMs, story replies and mentions):
//   { source: 'comment'|'dm'|'story_reply'|'mention', id, text, mediaId, userId, username, name?,
//     isOwn, timestamp }
//
// Keywords (rule.trigger.keywords, blocked words):
//   - plain words or phrases, matched as whole words after normalize() ("price" matches "Price?" and
//     "what's the price" but not "priceless");
//   - a trailing * matches word prefixes ("discount*" matches "discounts");
//   - "re:<pattern>" is a case-insensitive JavaScript regular expression tested against the raw and
//     the normalized text. Patterns are limited to 200 characters, at most 2 unbounded repeats, no
//     nested repeats like (a+)+ and no back-references, so they cannot stall the worker.
//   - In scripts written without spaces (Chinese, Japanese, Thai...) keywords match anywhere.
//
// processed (automations.processed) gains one key owned by this module:
//   processed.users = { [ruleId]: { [userId]: ISO time the rule last fired for that user } }
// Use recordFired() after the worker performs a rule's actions; evaluate() reads it for oncePerUser.

const MAX_REGEX_CHARS = 200;
const MAX_UNBOUNDED_REPEATS = 2;
const MAX_TEXT_CHARS = 5000;

// Apostrophes are removed (don't -> dont) so "dont" and "don't" match the same text.
const APOSTROPHES = /['‘’ʼ`´]/g;
// Emoji are kept but split from adjacent words; presentation selectors and skin tones are dropped
// so a keyword "👍" matches "👍🏽" and "❤" matches "❤️".
const EMOJI_NOISE = /[︎️\u{1F3FB}-\u{1F3FF}]/gu;
const EMOJI_SEQ = /\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic})*/gu;
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

/**
 * Normalize text for matching: lowercase, compatibility-decomposed with Latin diacritics removed
 * (café -> cafe, 𝐛𝐨𝐥𝐝 -> bold), punctuation collapsed to single spaces, emoji kept as separate tokens.
 * Marks of other scripts (Devanagari vowel signs etc.) are preserved.
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  if (text == null) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .replace(APOSTROPHES, '')
    .replace(/\p{P}/gu, ' ')
    .replace(EMOJI_NOISE, '')
    .replace(EMOJI_SEQ, ' $& ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Regular expression keywords

function quantifierAt(src, j) {
  const c = src[j];
  if (c === '*' || c === '+') return 'unbounded';
  if (c === '?') return 'optional';
  if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(j));
    if (!m) return null;
    if (m[2] && (m[3] === '' || Number(m[3]) > 20)) return 'unbounded';
    return Number(m[3] ?? m[1]) > 1 ? 'bounded' : 'optional';
  }
  return null;
}

/** Static check that a pattern cannot backtrack catastrophically (conservative). */
function regexSafetyError(src) {
  if (/\\[1-9]|\\k</.test(src)) return 'Back-references are not supported in keyword patterns.';
  const stack = [];
  let unbounded = 0;
  const markRepeat = () => {
    if (stack.length) stack[stack.length - 1].repeat = true;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    let atomEnd = -1;
    let group = null;
    if (c === '\\') {
      i++;
      atomEnd = i;
    } else if (c === '[') {
      i++;
      if (src[i] === '^') i++;
      if (src[i] === ']') i++;
      while (i < src.length && src[i] !== ']') {
        if (src[i] === '\\') i++;
        i++;
      }
      atomEnd = i;
    } else if (c === '(') {
      stack.push({ repeat: false, alt: false });
      continue;
    } else if (c === ')') {
      group = stack.pop() || { repeat: false, alt: false };
      atomEnd = i;
    } else if (c === '|') {
      if (stack.length) stack[stack.length - 1].alt = true;
      continue;
    } else if ('*+?{'.includes(c)) {
      continue; // quantifiers are read together with the atom before them
    } else {
      atomEnd = i;
    }
    const q = quantifierAt(src, atomEnd + 1);
    if (q === 'unbounded') unbounded++;
    if (group) {
      if ((q === 'unbounded' || q === 'bounded') && (group.repeat || group.alt)) {
        return 'Avoid repeating a group that already repeats or has alternatives, like (a+)+ or (a|b)*.';
      }
      if (group.repeat || q === 'unbounded' || q === 'bounded') markRepeat();
    } else if (q === 'unbounded' || q === 'bounded') {
      markRepeat();
    }
  }
  if (unbounded > MAX_UNBOUNDED_REPEATS) return `Use at most ${MAX_UNBOUNDED_REPEATS} open-ended repeats (*, + or {n,}) in a pattern.`;
  return null;
}

const regexCache = new Map();

function compileRegex(src, exact) {
  const key = `${exact ? 'x' : 'p'}:${src}`;
  if (regexCache.has(key)) return regexCache.get(key);
  let re = null;
  if (src && src.length <= MAX_REGEX_CHARS && !regexSafetyError(src)) {
    const body = exact ? `^(?:${src})$` : src;
    for (const flags of ['iu', 'i']) {
      try {
        re = new RegExp(body, flags);
        break;
      } catch {
        re = null;
      }
    }
  }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(key, re);
  return re;
}

/**
 * Why a keyword cannot be used, or null when it is fine. For the rule editor.
 * @param {string} keyword
 * @returns {string|null}
 */
export function keywordError(keyword) {
  if (typeof keyword !== 'string' || !keyword.trim()) return 'Enter a keyword.';
  if (!keyword.startsWith('re:')) {
    return normalize(keyword.replace(/\*$/, '')) ? null : 'Use letters, numbers or emoji in keywords.';
  }
  const src = keyword.slice(3);
  if (!src) return 'Enter a pattern after "re:".';
  if (src.length > MAX_REGEX_CHARS) return `Patterns can be at most ${MAX_REGEX_CHARS} characters.`;
  const unsafe = regexSafetyError(src);
  if (unsafe) return unsafe;
  return compileRegex(src, false) ? null : 'This pattern is not a valid regular expression.';
}

// ---------------------------------------------------------------------------
// Keyword matching

function prepare(raw) {
  const text = String(raw ?? '').slice(0, MAX_TEXT_CHARS);
  return { raw: text, norm: normalize(text) };
}

function keywordMatches(prepared, keyword, exact = false) {
  if (typeof keyword !== 'string') return false;
  const kwRaw = keyword.trim();
  if (!kwRaw) return false;
  if (kwRaw.startsWith('re:')) {
    const re = compileRegex(kwRaw.slice(3), exact);
    if (!re) return false;
    return re.test(prepared.raw) || re.test(prepared.norm);
  }
  const prefix = !exact && kwRaw.endsWith('*');
  const kw = normalize(prefix ? kwRaw.slice(0, -1) : kwRaw);
  if (!kw) return false;
  if (exact) return prepared.norm === kw;
  if (NO_SPACE_SCRIPT.test(kw)) return prepared.norm.includes(kw);
  return ` ${prepared.norm} `.includes(prefix ? ` ${kw}` : ` ${kw} `);
}

/** The first blocked word found in text, or null. */
export function findBlockedWord(text, words) {
  const list = Array.isArray(words) ? words : [];
  if (!list.length || !text) return null;
  const prepared = prepare(text);
  return list.find((w) => keywordMatches(prepared, w)) ?? null;
}

/** True when text contains any of the blocked words (same matching as rule keywords). */
export function containsBlockedWord(text, words) {
  return findBlockedWord(text, words) != null;
}

function findMatch(rule, event) {
  const none = { matched: false, keyword: null };
  if (!rule || !event || event.isOwn) return none;
  const trigger = rule.trigger || {};
  if ((trigger.source || 'comment') !== event.source) return none;
  const ids = Array.isArray(trigger.mediaIds) && trigger.mediaIds.length ? trigger.mediaIds.map(String) : null;
  if (ids && (event.mediaId == null || !ids.includes(String(event.mediaId)))) return none;
  const mode = trigger.match || 'any';
  if (mode === 'always') return { matched: true, keyword: null };
  const keywords = (trigger.keywords || []).filter((k) => typeof k === 'string' && k.trim());
  if (!keywords.length) return none;
  const prepared = prepare(event.text);
  if (mode === 'all') {
    return keywords.every((k) => keywordMatches(prepared, k)) ? { matched: true, keyword: keywords[0] } : none;
  }
  const exact = mode === 'exact';
  const hit = keywords.find((k) => keywordMatches(prepared, k, exact));
  return hit ? { matched: true, keyword: hit } : none;
}

/**
 * Does the rule's trigger match the event? Ignores rule.enabled (evaluate() checks it) and never
 * matches the account's own comments/messages.
 * @param {object} rule Rule (model.js)
 * @param {object} event see top of file
 * @returns {boolean}
 */
export function matchRule(rule, event) {
  return findMatch(rule, event).matched;
}

/** The keyword that made the rule match (null for 'always' or no match). */
export function matchedKeyword(rule, event) {
  return findMatch(rule, event).keyword;
}

// ---------------------------------------------------------------------------
// Templates

/**
 * Replace {name} placeholders. {name|fallback} uses the fallback when the value is missing or empty.
 * Placeholders without a value or fallback are left as they are.
 * @param {string} text
 * @param {object} vars
 * @returns {string}
 */
export function renderTemplate(text, vars = {}) {
  const v = vars || {};
  return String(text ?? '').replace(/\{([A-Za-z_][\w]*)(?:\|([^{}]*))?\}/g, (whole, key, fallback) => {
    const has = Object.prototype.hasOwnProperty.call(v, key);
    const value = has && v[key] != null ? String(v[key]) : '';
    if (value) return value;
    if (fallback !== undefined) return fallback;
    return has ? '' : whole;
  });
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Final avalanche so ids that differ only in their last character spread across variants.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Deterministic choice among non-empty texts. The same seed (the event id) always gives the same
 * text, so retries are stable, while different comments get different variants.
 * @param {string[]} texts
 * @param {string|number} seed
 * @returns {string} '' when there is no usable text
 */
export function pickVariant(texts, seed) {
  const list = (Array.isArray(texts) ? texts : [texts]).filter((t) => typeof t === 'string' && t.trim());
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  return list[hash32(String(seed ?? '')) % list.length];
}

/** Template variables for an event: username, mention (@username), name, first_name. */
export function eventVars(event = {}) {
  const username = event.username ? String(event.username).replace(/^@/, '') : '';
  const name = event.name ? String(event.name).trim() : '';
  return {
    username,
    mention: username ? `@${username}` : '',
    name: name || username,
    first_name: name ? name.split(/\s+/)[0] : username,
  };
}

// ---------------------------------------------------------------------------
// Evaluation

// Which action types make sense for each event source; others are mapped or dropped.
const ACTION_MAP = {
  comment: { reply_comment: 'reply_comment', private_reply: 'private_reply', send_dm: 'private_reply', hide_comment: 'hide_comment', ai_reply: 'ai_reply' },
  mention: { reply_comment: 'reply_comment', ai_reply: 'ai_reply' },
  dm: { send_dm: 'send_dm', reply_comment: 'send_dm', ai_reply: 'ai_reply' },
  story_reply: { send_dm: 'send_dm', reply_comment: 'send_dm', ai_reply: 'ai_reply' },
};

function ruleActions(rule, event, vars, seed) {
  const out = [];
  const map = ACTION_MAP[event.source] || {};
  for (const action of rule.actions || []) {
    const type = map[action?.type];
    if (!type) continue;
    const text = renderTemplate(pickVariant(action.texts || [], seed), vars).trim();
    const base = { ruleId: rule.id, ruleName: rule.name || '', type };
    if (type === 'hide_comment') out.push(base);
    else if (type === 'ai_reply') {
      const channel = action.channel || (event.source === 'comment' || event.source === 'mention' ? 'comment' : 'dm');
      out.push({ ...base, channel, guidance: action.guidance || '', ...(text ? { text } : {}) });
    } else if (text) out.push({ ...base, text });
  }
  return out;
}

/** Has the rule already fired for this user (see processed.users)? */
export function hasFired(processed, ruleId, userId) {
  return Boolean(userId != null && processed?.users?.[ruleId]?.[userId]);
}

/**
 * Record that a rule fired for a user (for oncePerUser). Mutates and returns `processed`.
 * @param {object} processed automations.processed
 * @param {string} ruleId
 * @param {string} userId
 * @param {string} [at] ISO time
 */
export function recordFired(processed, ruleId, userId, at = new Date().toISOString()) {
  const p = processed && typeof processed === 'object' ? processed : {};
  if (ruleId == null || userId == null) return p;
  p.users ||= {};
  p.users[ruleId] ||= {};
  p.users[ruleId][userId] = at;
  return p;
}

/**
 * Decide what to do with an incoming event. Returns actions in order, [] for nothing.
 *  1. Blocked words: a comment containing one is hidden ('hide_comment', or 'delete_comment' when
 *     blockedWords.action === 'delete') and nothing else happens; a DM/story reply/mention containing
 *     one gets no automated response at all.
 *  2. The first enabled rule (in order) whose trigger matches and that produces at least one action.
 *     Rules with oncePerUser are skipped for users they already fired for (processed.users), so a later
 *     rule can still match.
 *  3. DMs and story replies with no matching rule get the welcome message when isFirstContact.
 * Text actions are rendered with renderTemplate using eventVars(event), {keyword} and `vars`
 * (e.g. { link }); the variant is chosen with pickVariant seeded by the event id.
 * @param {{rules?: object[], event: object, processed?: object, blockedWords?: object|string[],
 *   welcome?: {enabled: boolean, text?: string, texts?: string[]}, isFirstContact?: boolean, vars?: object}} args
 * @returns {Array<{ruleId: string|null, ruleName?: string, type: 'reply_comment'|'private_reply'|'send_dm'|
 *   'hide_comment'|'delete_comment'|'ai_reply', text?: string, guidance?: string, channel?: 'comment'|'dm', reason?: string}>}
 */
export function evaluate({ rules = [], event, processed, blockedWords, welcome, isFirstContact = false, vars = {} } = {}) {
  if (!event || event.isOwn) return [];
  const words = Array.isArray(blockedWords) ? blockedWords : blockedWords?.enabled ? blockedWords.words || [] : [];
  if (words.length && containsBlockedWord(event.text, words)) {
    if (event.source !== 'comment') return [];
    const type = !Array.isArray(blockedWords) && blockedWords.action === 'delete' ? 'delete_comment' : 'hide_comment';
    return [{ ruleId: null, type, reason: 'blocked_word' }];
  }
  const seed = event.id ?? `${event.userId}:${event.timestamp}`;
  const base = { ...eventVars(event), ...(vars || {}) };
  for (const rule of rules || []) {
    if (!rule || rule.enabled === false) continue;
    const { matched, keyword } = findMatch(rule, event);
    if (!matched) continue;
    if (rule.oncePerUser && hasFired(processed, rule.id, event.userId)) continue;
    const actions = ruleActions(rule, event, { ...base, keyword: keyword && !keyword.startsWith('re:') ? keyword : '' }, seed);
    if (actions.length) return actions;
  }
  if ((event.source === 'dm' || event.source === 'story_reply') && isFirstContact && welcome?.enabled) {
    const text = renderTemplate(pickVariant(welcome.texts?.length ? welcome.texts : [welcome.text], seed), base).trim();
    if (text) return [{ ruleId: null, type: 'send_dm', text, reason: 'welcome' }];
  }
  return [];
}
