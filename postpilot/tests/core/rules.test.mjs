import test from 'node:test';
import assert from 'node:assert/strict';
import {
  containsBlockedWord,
  evaluate,
  eventVars,
  findBlockedWord,
  hasFired,
  keywordError,
  matchedKeyword,
  matchRule,
  normalize,
  pickVariant,
  recordFired,
  renderTemplate,
} from '../../core/rules.js';
import { defaultDoc, newRule } from '../../core/model.js';

function rule(trigger = {}, partial = {}) {
  return newRule({
    id: partial.id || 'r_1',
    trigger: { source: 'comment', match: 'any', keywords: [], mediaIds: null, ...trigger },
    actions: [{ type: 'reply_comment', texts: ['Thanks {username}!'] }],
    oncePerUser: false,
    ...partial,
  });
}

function comment(text, partial = {}) {
  return { source: 'comment', id: 'c_1', text, mediaId: 'm_1', userId: 'u_1', username: 'jane.doe', isOwn: false, timestamp: '2026-10-12T12:00:00Z', ...partial };
}

test('normalize: case, diacritics, punctuation, apostrophes and emoji', () => {
  assert.equal(normalize('Héllo, WORLD!!!   Ça va?'), 'hello world ca va');
  assert.equal(normalize('Don’t stop'), 'dont stop');
  assert.equal(normalize('#Giveaway @friend'), 'giveaway friend');
  assert.equal(normalize('love❤️it'), 'love ❤ it');
  assert.equal(normalize('👍🏽👍'), '👍 👍');
  assert.equal(normalize('𝐁𝐨𝐥𝐝 ｆｕｌｌ ﬁne'), 'bold full fine');
  assert.equal(normalize('नमस्ते दोस्त!'), 'नमस्ते दोस्त'); // Devanagari vowel signs kept
  assert.equal(normalize('price: $99 + tax'), 'price $99 + tax');
  assert.equal(normalize(null), '');
  assert.equal(normalize(''), '');
});

test('matchRule: any keyword as a whole word or phrase', () => {
  const r = rule({ keywords: ['price', 'how much', 'discount*'] });
  assert.ok(matchRule(r, comment('What is the PRICE?')));
  assert.ok(matchRule(r, comment('price')));
  assert.ok(matchRule(r, comment('How much is it')));
  assert.ok(matchRule(r, comment('Any discounts today?')));
  assert.ok(matchRule(r, comment('Prïce???')));
  assert.ok(!matchRule(r, comment('priceless!')));
  assert.ok(!matchRule(r, comment('how is it, much love')));
  assert.ok(!matchRule(r, comment('')));
  assert.equal(matchedKeyword(r, comment('ok how much?')), 'how much');
});

test('matchRule: all, exact and always', () => {
  const all = rule({ match: 'all', keywords: ['size', 'available'] });
  assert.ok(matchRule(all, comment('Is size M available?')));
  assert.ok(!matchRule(all, comment('Is it available?')));
  const exact = rule({ match: 'exact', keywords: ['info', 'Send me the link'] });
  assert.ok(matchRule(exact, comment('INFO!')));
  assert.ok(matchRule(exact, comment('send me the link 🙏'.replace(' 🙏', '.'))));
  assert.ok(!matchRule(exact, comment('more info please')));
  const always = rule({ match: 'always', keywords: [] });
  assert.ok(matchRule(always, comment('anything at all')));
  assert.equal(matchedKeyword(always, comment('x')), null);
  assert.ok(!matchRule(rule({ keywords: [] }), comment('price')), 'no keywords never matches');
  assert.ok(!matchRule(rule({ keywords: ['  '] }), comment('price')));
});

test('matchRule: source, media filter and own events', () => {
  const r = rule({ keywords: ['link'], mediaIds: ['m_1', 'm_2'] });
  assert.ok(matchRule(r, comment('link please')));
  assert.ok(!matchRule(r, comment('link please', { mediaId: 'm_3' })));
  assert.ok(!matchRule(r, comment('link please', { mediaId: null })));
  assert.ok(matchRule(rule({ keywords: ['link'], mediaIds: [] }), comment('link', { mediaId: 'any' })), 'empty list = all media');
  assert.ok(!matchRule(r, comment('link please', { isOwn: true })), 'own comments never match');
  assert.ok(!matchRule(rule({ match: 'always' }), comment('x', { isOwn: true })));
  assert.ok(!matchRule(r, comment('link please', { source: 'dm' })));
  const dm = rule({ source: 'dm', keywords: ['link'] });
  assert.ok(matchRule(dm, { source: 'dm', id: 'm', text: 'Link?', userId: 'u' }));
  assert.ok(!matchRule(dm, { source: 'story_reply', id: 'm', text: 'Link?', userId: 'u' }));
  assert.ok(!matchRule(null, comment('x')));
  assert.ok(!matchRule(r, null));
});

test('matchRule: scripts without spaces and emoji keywords', () => {
  assert.ok(matchRule(rule({ keywords: ['价格'] }), comment('请问价格多少？')));
  assert.ok(matchRule(rule({ keywords: ['ราคา'] }), comment('ราคาเท่าไหร่ครับ')));
  assert.ok(matchRule(rule({ keywords: ['🔥'] }), comment('so good🔥🔥')));
  assert.ok(matchRule(rule({ keywords: ['❤️'] }), comment('love it ❤')));
  assert.ok(matchRule(rule({ keywords: ['कीमत'] }), comment('इसकी कीमत क्या है?')));
});

test('regex keywords: matching, anchoring in exact mode and safety', () => {
  const r = rule({ keywords: ['re:\\b(?:price|cost)s?\\b'] });
  assert.ok(matchRule(r, comment('What are the COSTS?')));
  assert.ok(!matchRule(r, comment('costume')));
  const code = rule({ match: 'exact', keywords: ['re:[a-z]{3}\\d{3}'] });
  assert.ok(matchRule(code, comment('ABC123')));
  assert.ok(!matchRule(code, comment('my code ABC123')));
  // Invalid, too long and dangerous patterns never match and never throw.
  for (const bad of ['re:(', 're:[a-', `re:${'a'.repeat(201)}`, 're:(a+)+$', 're:(a|aa)*$', 're:(\\w+\\s?)*$', 're:(.*a){12}', 're:(a)\\1', 're:\\w*\\w*\\w*x', 're:']) {
    assert.doesNotThrow(() => matchRule(rule({ keywords: [bad] }), comment('a'.repeat(5000) + '!')));
    assert.ok(keywordError(bad), `${bad} is reported`);
  }
  const started = Date.now();
  const evil = rule({ keywords: ['re:(a+)+$', 're:(x|x)*y', 're:^(\\d+)*$'] });
  assert.ok(!matchRule(evil, comment('a'.repeat(4000) + 'b' + '1'.repeat(60) + 'z')));
  assert.ok(Date.now() - started < 200, 'rejected patterns do not run');
  // Allowed patterns run fast even on long input.
  const t2 = Date.now();
  assert.ok(!matchRule(rule({ keywords: ['re:.*foo.*bar'] }), comment('x'.repeat(5000))));
  assert.ok(Date.now() - t2 < 200);
  assert.equal(keywordError('re:\\bfree\\s+shipping\\b'), null);
  assert.equal(keywordError('re:(?:a|b)c'), null);
  assert.equal(keywordError('price'), null);
  assert.equal(keywordError('discount*'), null);
  assert.ok(keywordError(''));
  assert.ok(keywordError('!!!'));
});

test('renderTemplate: known, unknown, empty and fallback placeholders', () => {
  const vars = { username: 'jane', link: 'https://x.co', empty: '', nothing: null };
  assert.equal(renderTemplate('Hi {username}, see {link}', vars), 'Hi jane, see https://x.co');
  assert.equal(renderTemplate('Keep {unknown} and {UserName}', vars), 'Keep {unknown} and {UserName}');
  assert.equal(renderTemplate('A{empty}B{nothing}C', vars), 'ABC');
  assert.equal(renderTemplate('Hi {name|friend}! {empty|-}', vars), 'Hi friend! -');
  assert.equal(renderTemplate('{toString} {constructor}', vars), '{toString} {constructor}');
  assert.equal(renderTemplate('{json: true}', vars), '{json: true}');
  assert.equal(renderTemplate(null, vars), '');
  assert.deepEqual(eventVars({ username: '@jane', name: 'Jane Doe' }), { username: 'jane', mention: '@jane', name: 'Jane Doe', first_name: 'Jane' });
  assert.deepEqual(eventVars({ username: 'sam' }), { username: 'sam', mention: '@sam', name: 'sam', first_name: 'sam' });
});

test('pickVariant: stable per seed, varied across seeds', () => {
  const texts = ['A', 'B', 'C', ''];
  assert.equal(pickVariant(texts, 'c_1'), pickVariant(texts, 'c_1'));
  const seen = new Set(Array.from({ length: 60 }, (_, i) => pickVariant(texts, `c_${i}`)));
  assert.deepEqual([...seen].sort(), ['A', 'B', 'C']);
  assert.equal(pickVariant(['only'], 'x'), 'only');
  assert.equal(pickVariant(['', '  '], 'x'), '');
  assert.equal(pickVariant([], 'x'), '');
  assert.equal(pickVariant('single', 'x'), 'single');
});

test('blocked words: whole words, wildcards and patterns', () => {
  const words = ['spam', 'scam*', 're:buy\\s+followers'];
  assert.ok(containsBlockedWord('This is SPAM!!', words));
  assert.ok(containsBlockedWord('total scammer', words));
  assert.ok(containsBlockedWord('Buy   followers here', words));
  assert.ok(!containsBlockedWord('spammy but fine', ['spam']));
  assert.ok(!containsBlockedWord('hello', words));
  assert.ok(!containsBlockedWord('', words));
  assert.ok(!containsBlockedWord('spam', []));
  assert.equal(findBlockedWord('a scam', words), 'scam*');
});

test('evaluate: blocked words hide first and stop everything else', () => {
  const automations = defaultDoc('automations');
  automations.blockedWords = { enabled: true, words: ['idiot'], action: 'hide' };
  const rules = [rule({ match: 'always' })];
  assert.deepEqual(evaluate({ rules, event: comment('You idiot'), blockedWords: automations.blockedWords }), [
    { ruleId: null, type: 'hide_comment', reason: 'blocked_word' },
  ]);
  assert.equal(evaluate({ rules, event: comment('You idiot'), blockedWords: { ...automations.blockedWords, action: 'delete' } })[0].type, 'delete_comment');
  // Disabled blocked words are ignored; a plain array is accepted.
  assert.equal(evaluate({ rules, event: comment('You idiot'), blockedWords: { enabled: false, words: ['idiot'] } })[0].type, 'reply_comment');
  assert.equal(evaluate({ rules, event: comment('You idiot'), blockedWords: ['idiot'] })[0].type, 'hide_comment');
  // DMs with blocked words get no automated response.
  const dmRules = [rule({ source: 'dm', match: 'always' }, { actions: [{ type: 'send_dm', texts: ['hi'] }] })];
  assert.deepEqual(evaluate({ rules: dmRules, event: { source: 'dm', id: 'd', text: 'idiot', userId: 'u' }, blockedWords: ['idiot'], welcome: { enabled: true, text: 'Welcome' }, isFirstContact: true }), []);
});

test('evaluate: first matching enabled rule, rendered and varied', () => {
  const rules = [
    rule({ keywords: ['price'] }, { id: 'r_off', enabled: false, actions: [{ type: 'reply_comment', texts: ['disabled'] }] }),
    rule({ keywords: ['price'] }, {
      id: 'r_price',
      name: 'Price',
      actions: [
        { type: 'reply_comment', texts: ['Sent you a DM, {mention}!', 'Check your DMs {first_name}'] },
        { type: 'private_reply', texts: ['Here is the {keyword} list: {link}'] },
      ],
    }),
    rule({ match: 'always' }, { id: 'r_all' }),
  ];
  const actions = evaluate({ rules, event: comment('Price?', { name: 'Jane Doe' }), vars: { link: 'https://shop.example' } });
  assert.equal(actions.length, 2);
  assert.equal(actions[0].ruleId, 'r_price');
  assert.equal(actions[0].ruleName, 'Price');
  assert.ok(['Sent you a DM, @jane.doe!', 'Check your DMs Jane'].includes(actions[0].text));
  assert.deepEqual(actions[1], { ruleId: 'r_price', ruleName: 'Price', type: 'private_reply', text: 'Here is the price list: https://shop.example' });
  // Same event id -> same variant on retry.
  assert.deepEqual(evaluate({ rules, event: comment('Price?', { name: 'Jane Doe' }), vars: { link: 'https://shop.example' } }), actions);
  // Different comments spread over the variants.
  const variants = new Set(Array.from({ length: 30 }, (_, i) => evaluate({ rules, event: comment('price', { id: `c_${i}`, name: 'Jane Doe' }) })[0].text));
  assert.equal(variants.size, 2);
  // Non-matching keyword -> the catch-all rule.
  assert.equal(evaluate({ rules, event: comment('nice pic') })[0].ruleId, 'r_all');
  assert.deepEqual(evaluate({ rules: [], event: comment('hello') }), []);
  assert.deepEqual(evaluate({ rules, event: comment('price', { isOwn: true }) }), []);
  assert.deepEqual(evaluate({ rules }), []);
});

test('evaluate: oncePerUser with processed.users, recordFired and hasFired', () => {
  const rules = [
    rule({ keywords: ['guide'] }, { id: 'r_guide', oncePerUser: true, actions: [{ type: 'private_reply', texts: ['Here is the guide'] }] }),
    rule({ match: 'always' }, { id: 'r_thanks', actions: [{ type: 'reply_comment', texts: ['Thank you!'] }] }),
  ];
  const processed = defaultDoc('automations').processed;
  assert.equal(evaluate({ rules, event: comment('guide please'), processed })[0].ruleId, 'r_guide');
  assert.ok(!hasFired(processed, 'r_guide', 'u_1'));
  recordFired(processed, 'r_guide', 'u_1', '2026-10-12T12:00:00Z');
  assert.deepEqual(processed.users, { r_guide: { u_1: '2026-10-12T12:00:00Z' } });
  assert.ok(hasFired(processed, 'r_guide', 'u_1'));
  // Same user again: the once-per-user rule is skipped and the next matching rule applies.
  assert.equal(evaluate({ rules, event: comment('guide please', { id: 'c_2' }), processed })[0].ruleId, 'r_thanks');
  // Another user still gets the guide.
  assert.equal(evaluate({ rules, event: comment('guide please', { id: 'c_3', userId: 'u_2' }), processed })[0].ruleId, 'r_guide');
  assert.deepEqual(recordFired(undefined, 'r', 'u', 'now'), { users: { r: { u: 'now' } } });
  assert.deepEqual(recordFired({}, 'r', null), {});
});

test('evaluate: DMs use a matching rule, else the welcome message on first contact', () => {
  const welcome = { enabled: true, text: 'Hi {name|there}, thanks for writing!' };
  const rules = [rule({ source: 'dm', keywords: ['hours'] }, { id: 'r_hours', actions: [{ type: 'send_dm', texts: ['We are open 9-5.'] }] })];
  const dm = (text, partial = {}) => ({ source: 'dm', id: `d_${text}`, text, userId: 'u_9', username: 'sam', isOwn: false, ...partial });
  assert.deepEqual(evaluate({ rules, event: dm('Your hours?'), welcome, isFirstContact: true }), [
    { ruleId: 'r_hours', ruleName: 'New rule', type: 'send_dm', text: 'We are open 9-5.' },
  ]);
  assert.deepEqual(evaluate({ rules, event: dm('hello'), welcome, isFirstContact: true }), [
    { ruleId: null, type: 'send_dm', text: 'Hi sam, thanks for writing!', reason: 'welcome' },
  ]);
  assert.deepEqual(evaluate({ rules, event: dm('hello'), welcome, isFirstContact: false }), []);
  assert.deepEqual(evaluate({ rules, event: dm('hello'), welcome: { ...welcome, enabled: false }, isFirstContact: true }), []);
  assert.equal(evaluate({ rules, event: dm('hello', { source: 'story_reply' }), welcome, isFirstContact: true })[0].reason, 'welcome');
  // Comments never get the welcome DM.
  assert.deepEqual(evaluate({ rules: [], event: comment('hello'), welcome, isFirstContact: true }), []);
});

test('evaluate: actions are adapted to the event source', () => {
  const mixed = [
    { type: 'reply_comment', texts: ['public'] },
    { type: 'send_dm', texts: ['private'] },
    { type: 'hide_comment' },
    { type: 'ai_reply', guidance: 'Be brief.', texts: ['fallback'] },
    { type: 'reply_comment', texts: [''] },
    { type: 'unknown', texts: ['x'] },
  ];
  const onComment = evaluate({ rules: [rule({ match: 'always' }, { actions: mixed })], event: comment('hey') });
  assert.deepEqual(onComment.map((a) => a.type), ['reply_comment', 'private_reply', 'hide_comment', 'ai_reply']);
  assert.deepEqual(onComment[3], { ruleId: 'r_1', ruleName: 'New rule', type: 'ai_reply', channel: 'comment', guidance: 'Be brief.', text: 'fallback' });
  const onDm = evaluate({ rules: [rule({ source: 'dm', match: 'always' }, { actions: mixed })], event: { source: 'dm', id: 'd', text: 'hey', userId: 'u' } });
  assert.deepEqual(onDm.map((a) => [a.type, a.text]), [['send_dm', 'public'], ['send_dm', 'private'], ['ai_reply', 'fallback']]);
  assert.equal(onDm[2].channel, 'dm');
  // A matching rule with nothing to send falls through to the next rule.
  const empty = rule({ match: 'always' }, { id: 'r_empty', actions: [{ type: 'reply_comment', texts: [''] }] });
  const next = rule({ match: 'always' }, { id: 'r_next' });
  assert.equal(evaluate({ rules: [empty, next], event: comment('hey') })[0].ruleId, 'r_next');
});

test('evaluate: story mentions answer by DM, get the welcome message and never cross sources', () => {
  const mention = (partial = {}) => ({ source: 'story_mention', id: 'sm_1', text: '', userId: 'u_7', username: 'trail.cafe', isOwn: false, ...partial });
  const thanks = rule({ source: 'story_mention', match: 'always' }, {
    id: 'r_thanks',
    actions: [
      { type: 'send_dm', texts: ['Thank you for the mention, {mention}!'] },
      { type: 'reply_comment', texts: ['not possible on a story mention'] },
      { type: 'hide_comment' },
      { type: 'ai_reply', guidance: 'Thank them.' },
    ],
  });
  const out = evaluate({ rules: [thanks], event: mention() });
  assert.deepEqual(out.map((a) => [a.type, a.text]), [['send_dm', 'Thank you for the mention, @trail.cafe!'], ['ai_reply', undefined]]);
  assert.equal(out[1].channel, 'dm');
  // A story-mention rule ignores DMs, story replies and comments, and the other way round.
  for (const source of ['dm', 'story_reply', 'comment']) assert.ok(!matchRule(thanks, mention({ source })));
  assert.ok(!matchRule(rule({ source: 'story_reply', match: 'always' }), mention()));
  assert.ok(!matchRule(rule({ source: 'dm', match: 'always' }), mention()));
  // Keywords cannot match the usual empty text of a mention.
  assert.ok(!matchRule(rule({ source: 'story_mention', keywords: ['thanks'] }), mention()));
  // No rule: the welcome message goes out on first contact, like a DM.
  const welcome = { enabled: true, text: 'Hi {username}!' };
  assert.deepEqual(evaluate({ rules: [], event: mention(), welcome, isFirstContact: true }), [{ ruleId: null, type: 'send_dm', text: 'Hi trail.cafe!', reason: 'welcome' }]);
  assert.deepEqual(evaluate({ rules: [], event: mention(), welcome, isFirstContact: false }), []);
  // A blocked word stops every automated answer.
  assert.deepEqual(evaluate({ rules: [thanks], event: mention({ text: 'free followers fast' }), blockedWords: { enabled: true, words: ['followers fast'] } }), []);
});

test('evaluate: story replies use story-reply rules with keywords', () => {
  const guide = rule({ source: 'story_reply', keywords: ['guide'] }, { id: 'r_guide', actions: [{ type: 'send_dm', texts: ['Here is the guide: {link}'] }], oncePerUser: true });
  const ev = { source: 'story_reply', id: 'sr_1', text: 'GUIDE please!', userId: 'u_3', username: 'pia', isOwn: false };
  assert.deepEqual(evaluate({ rules: [guide], event: ev, vars: { link: 'https://x.example/g' } }), [
    { ruleId: 'r_guide', ruleName: 'New rule', type: 'send_dm', text: 'Here is the guide: https://x.example/g' },
  ]);
  assert.deepEqual(evaluate({ rules: [guide], event: { ...ev, source: 'dm' } }), []);
  assert.deepEqual(evaluate({ rules: [guide], event: ev, processed: { users: { r_guide: { u_3: 'x' } } } }), []);
});
