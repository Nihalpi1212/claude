// Rule editor for Automations: a Modal that edits one keyword rule and tests it against a sample message.
//
//   <RuleEditor open rule=${draft} posts=${postList} gone=${automations.cursors.goneMedia} watch=${{days, posts}}
//     aiReady=${bool} blockedWords=${automations.blockedWords} onClose=${fn} onSave=${(rule) => ...} />
//
// `rule` is a Rule (core/model.js). The editor works on a copy and hands the cleaned rule to onSave.
// `posts` (for "Chosen posts"), newest first: [{id (Instagram media id), caption, timestamp, thumbnailUrl?,
// mediaUrl?, mediaType?, productType?, assetId? (library thumbnail for posts published by Postpilot)}].
// `gone` ({mediaId: ISO}): chosen posts the worker could not find on Instagram; the picker flags them.
// Also exports the starter templates and the plain-language summaries used by the rules list.

import { evaluate, findBlockedWord, keywordError, matchedKeyword, matchRule } from '../../core/rules.js';
import { newRule } from '../../core/model.js';
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { Button, Callout, ChipInput, Field, Frame, IconButton, Menu, Modal, Segmented, Select, TextArea, TextInput, Toggle, cx } from './kit.js';
import { Icon } from './icons.js';
import { MediaThumb } from './media-picker.js';

export const SOURCE_OPTIONS = [
  { value: 'comment', label: 'Comments on my posts' },
  { value: 'dm', label: 'Direct messages' },
  { value: 'story_reply', label: 'Replies to my stories' },
  { value: 'story_mention', label: 'Stories that mention me' },
];

/** One-line explanation under the source picker. */
const SOURCE_HINTS = {
  comment: 'New comments on the posts Postpilot watches (see Watched posts on the Automations screen).',
  dm: 'New direct messages. Also answers replies to your stories when no “Replies to my stories” rule matches. Story mentions have their own trigger.',
  story_reply: 'Messages people send by replying to one of your stories.',
  story_mention: 'Instagram sends you a message when someone mentions you in their story. It usually has no text, so these rules normally answer every mention.',
};

/** Singular noun per source, for summaries and the test panel. */
const SOURCE_NOUN = { comment: 'comment', dm: 'message', story_reply: 'story reply', story_mention: 'story mention', mention: 'mention' };

export const MATCH_OPTIONS = [
  { value: 'any', label: 'Contains any keyword' },
  { value: 'all', label: 'Contains all keywords' },
  { value: 'exact', label: 'Is exactly a keyword' },
  { value: 'always', label: 'Every message' },
];

export const ACTION_LABELS = {
  reply_comment: 'Reply to the comment',
  private_reply: 'Send a private reply by DM',
  send_dm: 'Reply in DM',
  hide_comment: 'Hide the comment',
  ai_reply: 'AI reply',
};

const ACTIONS_FOR = {
  comment: ['reply_comment', 'private_reply', 'hide_comment', 'ai_reply'],
  dm: ['send_dm', 'ai_reply'],
  story_reply: ['send_dm', 'ai_reply'],
  story_mention: ['send_dm', 'ai_reply'],
  mention: ['reply_comment', 'ai_reply'],
};

const TEXT_ACTIONS = new Set(['reply_comment', 'private_reply', 'send_dm']);
const PLACEHOLDER_RE = /\[your [^\]]+\]/i;

/** Starter templates. `build()` returns a fresh rule (not saved). */
export const STARTER_TEMPLATES = [
  {
    id: 'price-dm',
    title: 'Price question → DM details',
    body: 'Someone asks for the price: thank them in the comments and send the details privately.',
    build: () =>
      newRule({
        name: 'Price questions',
        trigger: { source: 'comment', match: 'any', keywords: ['price', 'how much', 'cost*'], mediaIds: null },
        actions: [
          { type: 'reply_comment', texts: ['Thanks {mention}! I sent you the details by DM.', 'Hi {mention}, check your DMs for the prices.'] },
          { type: 'private_reply', texts: ['Hi {first_name}! Thanks for asking. Prices and details are here: [your link]'] },
        ],
        oncePerUser: true,
      }),
  },
  {
    id: 'link-dm',
    title: 'Send the link by DM',
    body: 'People comment "link": send them the link in a private reply, since links in comments are not clickable.',
    build: () =>
      newRule({
        name: 'Send the link',
        trigger: { source: 'comment', match: 'any', keywords: ['link', 'shop', 'where to buy'], mediaIds: null },
        actions: [
          { type: 'private_reply', texts: ['Hi {first_name}! Here is the link: [your link]'] },
          { type: 'reply_comment', texts: ['Sent it to your DMs, {mention}!', 'Check your DMs, {mention}.'] },
        ],
        oncePerUser: true,
      }),
  },
  {
    id: 'thanks',
    title: 'Thank everyone who comments',
    body: 'A short, varied thank-you under each new comment, once per person.',
    build: () =>
      newRule({
        name: 'Thank commenters',
        trigger: { source: 'comment', match: 'always', keywords: [], mediaIds: null },
        actions: [{ type: 'reply_comment', texts: ['Thank you {mention}!', 'Thanks so much, {mention}!', 'Really appreciate it, {mention}.'] }],
        oncePerUser: true,
      }),
  },
  {
    id: 'story-guide',
    title: 'Reply GUIDE to my story → DM the guide',
    body: 'Ask people to reply GUIDE to a story, and send everyone who does the link by DM.',
    build: () =>
      newRule({
        name: 'Story guide',
        trigger: { source: 'story_reply', match: 'any', keywords: ['guide'], mediaIds: null },
        actions: [{ type: 'send_dm', texts: ['Here is the guide, {first_name}: [your link]'] }],
        oncePerUser: true,
      }),
  },
  {
    id: 'story-mention-thanks',
    title: 'Thank people who mention you in their story',
    body: 'A short thank-you DM to everyone who mentions you in their story, once per person.',
    build: () =>
      newRule({
        name: 'Story mention thanks',
        trigger: { source: 'story_mention', match: 'always', keywords: [], mediaIds: null },
        actions: [{ type: 'send_dm', texts: ['Thank you so much for the mention, {first_name}!', 'Thanks for sharing us in your story, {first_name}!'] }],
        oncePerUser: true,
      }),
  },
  {
    id: 'spam',
    title: 'Hide spam words',
    body: 'Hide comments that offer followers, promotions or crypto.',
    build: () =>
      newRule({
        name: 'Hide spam',
        trigger: { source: 'comment', match: 'any', keywords: ['followers fast', 'free followers', 'promote it', 'crypto', 'collab*'], mediaIds: null },
        actions: [{ type: 'hide_comment', texts: [] }],
        oncePerUser: false,
      }),
  },
];

function listWords(words, joiner = 'or') {
  const w = words.map((k) => (k.startsWith('re:') ? 'a pattern' : k.replace(/\*$/, '…')));
  if (w.length <= 1) return w.join('');
  if (w.length > 4) return `${w.slice(0, 3).join(', ')} ${joiner} ${w.length - 3} more`;
  return `${w.slice(0, -1).join(', ')} ${joiner} ${w[w.length - 1]}`;
}

/** "Comment contains price or cost" */
export function triggerSummary(rule) {
  const t = (rule && rule.trigger) || {};
  const n0 = SOURCE_NOUN[t.source || 'comment'] || 'message';
  const noun = n0.charAt(0).toUpperCase() + n0.slice(1);
  const kws = (t.keywords || []).filter((k) => typeof k === 'string' && k.trim());
  let text;
  if (t.match === 'always') text = `Every ${noun.toLowerCase()}`;
  else if (!kws.length) text = `${noun} (no keywords yet)`;
  else if (t.match === 'all') text = `${noun} contains ${listWords(kws, 'and')}`;
  else if (t.match === 'exact') text = `${noun} is exactly ${listWords(kws)}`;
  else text = `${noun} contains ${listWords(kws)}`;
  const n = Array.isArray(t.mediaIds) ? t.mediaIds.length : 0;
  if (n && (t.source || 'comment') === 'comment') text += ` on ${n} chosen post${n === 1 ? '' : 's'}`;
  return text;
}

/** "Reply to the comment (2 versions) · Send a private reply by DM" */
export function actionsSummary(rule) {
  return ((rule && rule.actions) || [])
    .map((a) => {
      const label = ACTION_LABELS[a.type] || a.type;
      const n = (a.texts || []).filter((t) => String(t || '').trim()).length;
      return TEXT_ACTIONS.has(a.type) && n > 1 ? `${label} (${n} versions)` : label;
    })
    .join(' · ');
}

/** Problems that block saving: [{field, message}]. */
export function ruleErrors(rule, { aiReady = true } = {}) {
  const errs = [];
  const t = rule.trigger || {};
  if (!String(rule.name || '').trim()) errs.push({ field: 'name', message: 'Give the rule a name.' });
  const kws = t.keywords || [];
  if (t.match !== 'always') {
    if (!kws.length) errs.push({ field: 'keywords', message: 'Add at least one keyword, or choose "Every message".' });
    for (const k of kws) {
      const e = keywordError(k);
      if (e) errs.push({ field: 'keywords', message: `"${k}": ${e}` });
    }
  }
  if ((t.source || 'comment') === 'comment' && Array.isArray(t.mediaIds) && !t.mediaIds.length) {
    errs.push({ field: 'scope', message: 'Choose at least one post, or apply the rule to all posts.' });
  }
  const actions = rule.actions || [];
  if (!actions.length) errs.push({ field: 'actions', message: 'Add at least one action.' });
  actions.forEach((a, i) => {
    const label = ACTION_LABELS[a.type] || a.type;
    if (TEXT_ACTIONS.has(a.type)) {
      const texts = (a.texts || []).filter((x) => String(x || '').trim());
      if (!texts.length) errs.push({ field: `action-${i}`, message: `${label}: write the message.` });
      if (texts.some((x) => PLACEHOLDER_RE.test(x))) errs.push({ field: `action-${i}`, message: `${label}: replace the text in [brackets] with your own.` });
      if (a.type !== 'reply_comment' && texts.some((x) => x.length > 1000)) errs.push({ field: `action-${i}`, message: `${label}: direct messages are limited to 1,000 characters.` });
    }
    if (a.type === 'ai_reply' && !String(a.guidance || '').trim() && !(a.texts || []).some((x) => String(x || '').trim())) {
      errs.push({ field: `action-${i}`, message: 'AI reply: tell the AI what to say (guidance).' });
    }
    if (a.type === 'ai_reply' && !aiReady && !(a.texts || []).some((x) => String(x || '').trim())) {
      errs.push({ field: `action-${i}`, message: 'AI reply needs AI turned on in Settings → AI (an Anthropic API key and “Use AI features”), or add a fallback message.' });
    }
  });
  return errs;
}

function clean(rule) {
  const r = structuredClone(rule);
  r.name = String(r.name || '').trim();
  r.trigger = { source: 'comment', match: 'any', keywords: [], mediaIds: null, ...r.trigger };
  if (r.trigger.match === 'always') r.trigger.keywords = [];
  if (r.trigger.source !== 'comment') r.trigger.mediaIds = null;
  r.actions = (r.actions || []).map((a) => {
    const out = { type: a.type, texts: TEXT_ACTIONS.has(a.type) || a.type === 'ai_reply' ? (a.texts || []).map((x) => String(x || '').trim()).filter(Boolean) : [] };
    if (a.type === 'ai_reply') {
      out.guidance = String(a.guidance || '').trim();
      if (a.channel) out.channel = a.channel;
    }
    return out;
  });
  return r;
}

function thumbOf(m) {
  return m.thumbnailUrl || (m.mediaType !== 'VIDEO' ? m.mediaUrl : null) || null;
}

function excerpt(text, n = 60) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Label + control group for controls that are not form inputs (Segmented). */
function Group({ label, error, children }) {
  return html`<div class=${cx('field', error && 'has-error')}>
    <div class="field-label-row"><span class="field-label">${label}</span></div>
    <div class="field-control">${children}</div>
    ${error ? html`<p class="field-error" role="alert"><span>${error}</span></p>` : null}
  </div>`;
}

function VariantsEditor({ action, onChange, label, dm }) {
  const texts = action.texts && action.texts.length ? action.texts : [''];
  const set = (i, v) => onChange({ ...action, texts: texts.map((t, j) => (j === i ? v : t)) });
  return html`<div class="rule-variants stack-sm">
    ${texts.map(
      (t, i) => html`<div class="rule-variant" key=${i}>
        <${TextArea} value=${t} rows=${2} maxRows=${8} aria-label=${`${label}, version ${i + 1}`}
          placeholder=${dm ? 'Hi {first_name}! …' : 'Thanks {mention}! …'} onChange=${(v) => set(i, v)} />
        ${texts.length > 1
          ? html`<${IconButton} icon="x" size="sm" label=${`Remove version ${i + 1}`} onClick=${() => onChange({ ...action, texts: texts.filter((_, j) => j !== i) })} />`
          : null}
      </div>`,
    )}
    <div class="row">
      <${Button} size="sm" variant="ghost" icon="plus" disabled=${texts.length >= 5} onClick=${() => onChange({ ...action, texts: [...texts, ''] })}>Add another version<//>
      <span class="faint text-sm">Postpilot picks one at random so replies don't repeat word for word.</span>
    </div>
  </div>`;
}

function ActionEditor({ action, index, count, source, aiReady, onChange, onRemove, onMove, error }) {
  const label = ACTION_LABELS[action.type] || action.type;
  const allowed = ACTIONS_FOR[source] || ACTIONS_FOR.comment;
  const typeOptions = allowed.map((t) => ({ value: t, label: ACTION_LABELS[t] }));
  return html`<li class=${cx('rule-action', error && 'has-error')}>
    <div class="rule-action-head">
      <span class="rule-action-no mono" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
      <${Select} class="grow" options=${typeOptions} value=${action.type} aria-label=${`Action ${index + 1}`}
        onChange=${(type) => onChange({ type, texts: TEXT_ACTIONS.has(type) ? (action.texts && action.texts.length ? action.texts : ['']) : type === 'ai_reply' ? [] : [], ...(type === 'ai_reply' ? { guidance: action.guidance || '' } : {}) })} />
      <${IconButton} icon="arrow-up" size="sm" label="Move action up" disabled=${index === 0} onClick=${() => onMove(-1)} />
      <${IconButton} icon="arrow-down" size="sm" label="Move action down" disabled=${index === count - 1} onClick=${() => onMove(1)} />
      <${IconButton} icon="trash" size="sm" label=${`Remove ${label}`} onClick=${onRemove} />
    </div>
    ${TEXT_ACTIONS.has(action.type) ? html`<${VariantsEditor} action=${action} onChange=${onChange} label=${label} dm=${action.type !== 'reply_comment'} />` : null}
    ${action.type === 'private_reply'
      ? html`<p class="field-hint">One private reply per comment, within 7 days of the comment. It lands in their message requests if they don't follow you.</p>`
      : null}
    ${action.type === 'hide_comment' ? html`<p class="field-hint">Hidden comments stay visible to the person who wrote them and their followers, but not to anyone else.</p>` : null}
    ${action.type === 'ai_reply'
      ? html`<div class="stack-sm">
          ${!aiReady ? html`<${Callout} tone="warning">AI replies need AI turned on: in <a href="#/settings?section=ai">Settings → AI</a> add an Anthropic API key and turn on “Use AI features”, or write a fallback message below.<//>` : null}
          <${Field} label="What should the AI say?" hint="Facts, links and tone it may use. It skips spam and anything that needs a person.">
            <${TextArea} value=${action.guidance || ''} rows=${3} placeholder="Answer questions about shipping (worldwide, every Friday) and custom orders (DM us). Keep it warm."
              onChange=${(v) => onChange({ ...action, guidance: v })} />
          <//>
          ${source === 'comment'
            ? html`<${Group} label="Reply in">
                <${Segmented} size="sm" label="Reply in" value=${action.channel || 'auto'}
                  options=${[{ value: 'auto', label: 'The comments' }, { value: 'dm', label: 'A private reply' }]}
                  onChange=${(v) => onChange({ ...action, channel: v === 'auto' ? undefined : v })} />
              <//>`
            : null}
          <${Field} label="Fallback message (optional)" hint="Sent when the AI is unavailable.">
            <${TextArea} value=${(action.texts || [])[0] || ''} rows=${2} onChange=${(v) => onChange({ ...action, texts: v.trim() ? [v] : [] })} />
          <//>
        </div>`
      : null}
    ${error ? html`<p class="field-error" role="alert"><span>${error}</span></p>` : null}
  </li>`;
}

const SAMPLE = {
  comment: { label: 'Sample comment', placeholder: "What's the price of the blue one?" },
  dm: { label: 'Sample message', placeholder: 'Hi! Is the workshop still open?' },
  story_reply: { label: 'Sample story reply', placeholder: 'GUIDE' },
  story_mention: { label: 'Text with the mention (usually none)', placeholder: 'Leave empty to test a plain mention' },
};

function TestPanel({ rule, blockedWords, posts }) {
  const [text, setText] = useState('');
  const [username, setUsername] = useState('');
  const [seed, setSeed] = useState(1);
  const source = (rule.trigger && rule.trigger.source) || 'comment';
  const scoped = source === 'comment' && Array.isArray(rule.trigger.mediaIds) && rule.trigger.mediaIds.length ? rule.trigger.mediaIds : null;
  // Story mentions usually carry no text, so they are tested even with an empty sample.
  const testable = !!text.trim() || source === 'story_mention';
  const result = useMemo(() => {
    if (!testable) return null;
    const user = username.replace(/^@/, '').trim() || 'maya.studio';
    const event = { source, id: `test-${seed}`, text, mediaId: scoped ? scoped[0] : null, userId: 'test-user', username: user, name: '', isOwn: false, timestamp: new Date().toISOString() };
    const test = { ...clean(rule), id: rule.id || 'draft', enabled: true, oncePerUser: false };
    const matched = matchRule(test, event);
    const keyword = matched ? matchedKeyword(test, event) : null;
    const actions = matched ? evaluate({ rules: [test], event, processed: {} }) : [];
    const words = blockedWords && blockedWords.enabled ? blockedWords.words || [] : [];
    const blocked = findBlockedWord(text, words);
    return { matched, keyword, actions, blocked };
  }, [text, username, seed, rule, blockedWords, testable]);
  const post = scoped && posts.find((p) => p.id === scoped[0]);
  const sample = SAMPLE[source] || SAMPLE.dm;
  const noun = SOURCE_NOUN[source] || 'message';
  const missReason = !text.trim() && source === 'story_mention'
    ? 'This mention has no text. Choose “Every message” to answer every mention.'
    : rule.trigger.match === 'all' ? 'It needs every keyword.' : rule.trigger.match === 'exact' ? 'The whole message must equal a keyword.' : 'None of the keywords appear as whole words.';
  return html`<section class="rule-test" aria-labelledby="rule-test-title">
    <div class="row row-between">
      <h3 class="rule-test-title" id="rule-test-title">Test this rule</h3>
      ${result && result.matched && (rule.actions || []).some((a) => (a.texts || []).filter((t) => String(t || '').trim()).length > 1)
        ? html`<${Button} size="sm" variant="ghost" icon="refresh" onClick=${() => setSeed((s) => s + 1)}>Try another version<//>`
        : null}
    </div>
    <div class="rule-test-inputs">
      <${Field} label=${sample.label} class="grow">
        <${TextArea} value=${text} rows=${2} maxRows=${6} placeholder=${sample.placeholder} onChange=${setText} />
      <//>
      <${Field} label="From" class="rule-test-user">
        <${TextInput} value=${username} placeholder="maya.studio" prefix="@" onChange=${setUsername} />
      <//>
    </div>
    ${scoped && post ? html`<p class="faint text-sm">Tested as a comment on “${excerpt(post.caption, 50) || 'your post'}”.</p>` : null}
    <div class="rule-test-result" aria-live="polite">
      ${!result
        ? html`<p class="faint text-sm">Type a ${noun} to see whether the rule matches and exactly what it would send.</p>`
        : html`<div class="stack-sm">
            <p class=${cx('rule-test-verdict', result.matched ? 'is-match' : 'is-miss')}>
              ${result.matched
                ? html`<strong>Matches</strong>${result.keyword ? html` <span class="muted">on “${result.keyword}”</span>` : rule.trigger.match === 'always' ? html` <span class="muted">every ${noun}</span>` : null}`
                : html`<strong>No match</strong> <span class="muted">${missReason}</span>`}
            </p>
            ${result.blocked && source === 'comment'
              ? html`<p class="text-warn text-sm">This text contains the blocked word “${result.blocked}”, so Postpilot would hide the comment instead of running rules.</p>`
              : result.blocked
                ? html`<p class="text-warn text-sm">This text contains the blocked word “${result.blocked}”, so Postpilot would not answer it.</p>`
                : null}
            ${result.matched
              ? html`<ol class="rule-test-actions">
                  ${result.actions.map(
                    (a, i) => html`<li key=${i}>
                      <span class="label-caps">${ACTION_LABELS[a.type] || a.type}</span>
                      ${a.type === 'hide_comment'
                        ? html`<p class="muted text-sm">The comment would be hidden.</p>`
                        : a.type === 'ai_reply'
                          ? html`<p class="muted text-sm">The AI writes a reply following your guidance${a.text ? html`; fallback: <q class="rule-test-text">${a.text}</q>` : ''}.</p>`
                          : html`<p class="rule-test-text">${a.text}</p>`}
                    </li>`,
                  )}
                </ol>`
              : null}
          </div>`}
    </div>
  </section>`;
}

const PICKER_PAGE = 36;

function kindOf(p) {
  if (p.productType === 'REELS' || p.mediaType === 'VIDEO') return 'reel';
  if (p.mediaType === 'CAROUSEL_ALBUM') return 'carousel';
  return undefined;
}

/** Every post (newest first), searchable by caption; chosen ones are marked. Deleted posts (`gone`) are left out and flagged. */
function PostPicker({ posts: all, gone, value, onChange }) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PICKER_PAGE);
  const set = new Set(value || []);
  const toggle = (id) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };
  const q = query.trim().toLowerCase();
  // Analytics keeps posts that were deleted later; the worker reports the chosen ones it cannot find.
  const posts = useMemo(() => (gone ? all.filter((p) => !gone[String(p.id)]) : all), [all, gone]);
  const shown = useMemo(() => (q ? posts.filter((p) => String(p.caption || '').toLowerCase().includes(q)) : posts), [posts, q]);
  const known = new Set(posts.map((p) => p.id));
  const unknown = [...set].filter((id) => !known.has(id));
  const deleted = unknown.filter((id) => gone && gone[String(id)]).length;
  if (!posts.length && !unknown.length) return html`<p class="muted text-sm">No posts yet. Analytics fills this list after the worker's first run.</p>`;
  const dateOf = (p) => (p.timestamp ? new Date(p.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(p.timestamp).getFullYear() === new Date().getFullYear() ? undefined : '2-digit' }) : '');
  return html`<div class="rule-picker stack stack-sm">
    <div class="rule-picker-bar">
      <${TextInput} class="grow" icon="search" type="search" value=${query} placeholder="Search captions" aria-label="Search posts by caption"
        onChange=${(v) => {
          setQuery(v);
          setLimit(PICKER_PAGE);
        }} />
      <span class="rule-picker-count faint text-sm" aria-live="polite"><span class="num">${set.size}</span> chosen</span>
      ${set.size ? html`<${Button} size="sm" variant="ghost" onClick=${() => onChange([])}>Clear<//>` : null}
    </div>
    ${!shown.length
      ? html`<p class="muted text-sm">No post caption contains “${query.trim()}”.</p>`
      : html`<div class="rule-posts" role="group" aria-label="Choose posts">
          ${shown.slice(0, limit).map((p, i) => {
            const common = {
              key: p.id,
              ratio: '1 / 1',
              number: i + 1,
              kind: kindOf(p),
              label: dateOf(p),
              selected: set.has(p.id),
              onClick: () => toggle(p.id),
              title: excerpt(p.caption, 120) || undefined,
              'aria-label': `${set.has(p.id) ? 'Remove' : 'Choose'} post: ${excerpt(p.caption, 60) || 'untitled'}${p.timestamp ? `, ${dateOf(p)}` : ''}`,
            };
            const src = thumbOf(p);
            return !src && p.assetId
              ? html`<${MediaThumb} assetId=${p.assetId} badge="" ...${common} />`
              : html`<${Frame} src=${src} alt=${excerpt(p.caption, 80)} ...${common} />`;
          })}
        </div>`}
    ${shown.length > limit
      ? html`<div><${Button} size="sm" variant="ghost" icon="chevron-down" onClick=${() => setLimit((n) => n + PICKER_PAGE * 2)}>Show more posts (${shown.length - limit} more)<//></div>`
      : null}
    ${unknown.length
      ? html`<p class="text-warn text-sm rule-picker-missing">
          ${deleted === unknown.length
            ? `${unknown.length === 1 ? 'One chosen post was' : `${unknown.length} chosen posts were`} not found on Instagram (deleted?), so the worker skips ${unknown.length === 1 ? 'it' : 'them'}.`
            : `${unknown.length === 1 ? 'One chosen post is' : `${unknown.length} chosen posts are`} not in your post list (deleted, or not in analytics yet). The worker skips posts Instagram cannot find.`}
          <${Button} size="sm" variant="ghost" onClick=${() => onChange((value || []).filter((id) => known.has(id)))}>Remove ${unknown.length === 1 ? 'it' : 'them'}<//>
        </p>`
      : null}
  </div>`;
}

/** Modal that edits one rule. */
export function RuleEditor({ open, rule, posts = [], gone = null, watch = null, aiReady = false, blockedWords, onClose, onSave, saving = false, title }) {
  const [draft, setDraft] = useState(() => structuredClone(rule || newRule({ name: '' })));
  const [showErrors, setShowErrors] = useState(false);
  // The Match the editor replaced with "Every message" when the source became story mentions.
  const autoMatch = useRef(null);
  useEffect(() => {
    if (open) {
      setDraft(structuredClone(rule || newRule({ name: '' })));
      setShowErrors(false);
      autoMatch.current = null;
    }
  }, [open, rule]);
  if (!open) return null;
  const t = draft.trigger || {};
  const source = t.source || 'comment';
  const errors = ruleErrors(draft, { aiReady });
  const errFor = (field) => (showErrors ? errors.filter((e) => e.field === field).map((e) => e.message).join(' ') : '');
  const setTrigger = (patch) => setDraft((d) => ({ ...d, trigger: { ...d.trigger, ...patch } }));
  const setActions = (fn) => setDraft((d) => ({ ...d, actions: fn(d.actions || []) }));
  const allowed = ACTIONS_FOR[source] || ACTIONS_FOR.comment;
  const missing = allowed.filter((a) => !(draft.actions || []).some((x) => x.type === a));
  const kwErrors = (t.keywords || []).map((k) => [k, keywordError(k)]).filter(([, e]) => e);

  const changeSource = (src) => {
    // Story mentions rarely have text: start with "Every message" unless keywords were already set.
    // Leaving them again puts the earlier Match back, or asks for keywords, so a comment or DM rule
    // never silently becomes "answer everything".
    let match = t.match || 'any';
    if (src === 'story_mention' && source !== 'story_mention') {
      if (!(t.keywords || []).length && match !== 'always') {
        autoMatch.current = match;
        match = 'always';
      }
    } else if (src !== 'story_mention' && source === 'story_mention') {
      if (match === 'always') match = autoMatch.current || ((t.keywords || []).length ? 'always' : 'any');
      autoMatch.current = null;
    }
    setDraft((d) => {
      const ok = ACTIONS_FOR[src] || [];
      let actions = (d.actions || [])
        .map((a) => (ok.includes(a.type) ? a : a.type === 'reply_comment' || a.type === 'private_reply' ? { ...a, type: 'send_dm' } : src === 'comment' && a.type === 'send_dm' ? { ...a, type: 'reply_comment' } : null))
        .filter(Boolean);
      actions = actions.filter((a, i) => actions.findIndex((b) => b.type === a.type) === i);
      if (!actions.length) actions = [{ type: src === 'comment' ? 'reply_comment' : 'send_dm', texts: [''] }];
      return { ...d, trigger: { ...d.trigger, source: src, match, mediaIds: src === 'comment' ? d.trigger.mediaIds : null }, actions };
    });
  };

  const save = () => {
    if (errors.length) {
      setShowErrors(true);
      return;
    }
    onSave?.(clean(draft));
  };

  const footer = html`
    ${showErrors && errors.length ? html`<span class="rule-foot-error text-bad text-sm" role="alert">${errors.length === 1 ? errors[0].message : `Fix ${errors.length} problems above.`}</span>` : null}
    <${Button} variant="ghost" onClick=${onClose}>Cancel<//>
    <${Button} variant="primary" icon="check" loading=${saving} onClick=${save}>Save rule<//>`;

  return html`<${Modal} open=${open} wide title=${title || 'New rule'} onClose=${onClose} footer=${footer} class="rule-modal">
    <div class="rule-editor">
      <div class="rule-form stack stack-lg">
        <${Field} label="Rule name" error=${errFor('name')}>
          <${TextInput} value=${draft.name} placeholder="Price questions" data-autofocus="" onChange=${(v) => setDraft((d) => ({ ...d, name: v }))} />
        <//>

        <section class="rule-section stack" aria-labelledby="rule-when">
          <h3 class="rule-section-title label-caps" id="rule-when">When</h3>
          <${Field} label="Listen to" hint=${SOURCE_HINTS[source]}>
            <${Select} options=${SOURCE_OPTIONS} value=${source} onChange=${changeSource} />
          <//>
          <${Field} label="Match">
            <${Select} options=${MATCH_OPTIONS} value=${t.match || 'any'} onChange=${(v) => {
              autoMatch.current = null;
              setTrigger({ match: v });
            }} />
          <//>
          ${t.match !== 'always'
            ? html`<${Field} label="Keywords" error=${errFor('keywords')}
                hint=${html`Whole words, ignoring case, accents and emoji skin tones. End with <span class="mono">*</span> to match word starts (<span class="mono">discount*</span>). Start with <span class="mono">re:</span> for a regular expression.`}>
                <${ChipInput} values=${t.keywords || []} placeholder="price, how much, link…" onChange=${(v) => setTrigger({ keywords: v })} />
              <//>
              ${kwErrors.length && !showErrors
                ? html`<ul class="rule-kw-errors">${kwErrors.map(([k, e]) => html`<li key=${k} class="text-warn text-sm"><span class="mono">${k}</span>: ${e}</li>`)}</ul>`
                : null}`
            : html`<p class="muted text-sm">Every new ${SOURCE_NOUN[source] || 'message'} triggers this rule. Turn on “Only once per person” so people get one reply.</p>`}
          ${source === 'comment'
            ? html`<${Group} label="On" error=${errFor('scope')}>
                <${Segmented} label="Which posts" value=${Array.isArray(t.mediaIds) ? 'chosen' : 'all'}
                  options=${[{ value: 'all', label: 'All watched posts' }, { value: 'chosen', label: 'Chosen posts' }]}
                  onChange=${(v) => setTrigger({ mediaIds: v === 'chosen' ? t.mediaIds || [] : null })} />
              <//>
              ${Array.isArray(t.mediaIds)
                ? html`<${PostPicker} posts=${posts} gone=${gone} value=${t.mediaIds} onChange=${(ids) => setTrigger({ mediaIds: ids })} />
                    <p class="faint text-sm">Chosen posts are watched however old they are; posts outside Watched posts are checked every 30 minutes. Comments made before a post was watched are not answered.</p>`
                : html`<p class="faint text-sm">${watch ? `Your newest ${watch.posts} posts from the last ${watch.days} days` : 'Your recent posts'}, as set under Watched posts.</p>`}`
            : null}
        </section>

        <section class="rule-section stack" aria-labelledby="rule-then">
          <h3 class="rule-section-title label-caps" id="rule-then">Then</h3>
          <p class="muted text-sm">Use <span class="mono">{username}</span>, <span class="mono">{first_name}</span> or <span class="mono">{mention}</span> (@username) in messages. Postpilot does not get people’s names from Instagram, so <span class="mono">{first_name}</span> is their username too.</p>
          ${errFor('actions') ? html`<p class="field-error" role="alert"><span>${errFor('actions')}</span></p>` : null}
          <ol class="rule-actions">
            ${(draft.actions || []).map(
              (a, i) => html`<${ActionEditor} key=${i} action=${a} index=${i} count=${draft.actions.length} source=${source} aiReady=${aiReady}
                error=${errFor(`action-${i}`)}
                onChange=${(next) => setActions((list) => list.map((x, j) => (j === i ? next : x)))}
                onRemove=${() => setActions((list) => list.filter((_, j) => j !== i))}
                onMove=${(dir) => setActions((list) => {
                  const next = [...list];
                  const j = i + dir;
                  if (j < 0 || j >= next.length) return list;
                  [next[i], next[j]] = [next[j], next[i]];
                  return next;
                })} />`,
            )}
          </ol>
          ${missing.length
            ? html`<${Menu} trigger="Add action" label="Add action" align="start" size="sm"
                items=${missing.map((type) => ({ label: ACTION_LABELS[type], onClick: () => setActions((list) => [...list, { type, texts: TEXT_ACTIONS.has(type) ? [''] : [], ...(type === 'ai_reply' ? { guidance: '' } : {}) }]) }))} />`
            : null}
        </section>

        <${Toggle} checked=${!!draft.oncePerUser} onChange=${(v) => setDraft((d) => ({ ...d, oncePerUser: v }))}
          label="Only once per person" hint=${source === 'comment' ? "Each person gets this rule's reply one time, even if they comment again." : "Each person gets this rule's reply one time, even if they write again."} />
      </div>
      <aside class="rule-side">
        <${TestPanel} rule=${draft} blockedWords=${blockedWords} posts=${posts} />
        ${draft.stats && draft.stats.fired ? html`<p class="faint text-sm">This rule has fired <span class="num">${draft.stats.fired}</span> times. Saving keeps the count.</p>` : null}
        <p class="rule-side-note faint text-sm"><${Icon} name="info" size=${14} />The worker checks new comments and messages about every 10 minutes.</p>
      </aside>
    </div>
  <//>`;
}
