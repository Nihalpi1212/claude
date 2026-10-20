// Canned Claude Messages API for the dev server and tests.
//
// POST /v1/messages:
//   - with output_config.format.schema (structured outputs) -> a schema-valid JSON object in one
//     text block, with plausible Instagram-flavoured strings derived from property names;
//   - otherwise a short text answer.
//   - stream: true -> the same answer as Server-Sent Events.
// x-api-key 'bad-key' -> 401 authentication_error. Also: GET /v1/models, POST /v1/messages/count_tokens.

const CAPTIONS = [
  'Slow mornings and fresh glaze ✨ Every piece in this batch was thrown, trimmed and fired by hand, so no two are quite alike.\n\nWhich one would you pick? 👇',
  'Behind the scenes at the studio 🏺 This is what three weeks of patience looks like.\n\nSave this for your next slow Sunday.',
  'New colours just came out of the kiln 🧡 Warm clay, speckled cream and a deep forest green.\n\nTell us your favourite in the comments.',
  'Coffee first, clay second ☕ A quiet morning routine that ends with a full shelf of mugs.\n\nTap the link in bio to shop the drop.',
  'Process over perfection 🌿 Swipe to watch a lump of clay turn into a vase.\n\nWould you like a full studio tour reel?',
];
const HASHTAGS = [
  '#ceramics', '#handmade', '#pottery', '#studiolife', '#slowliving', '#interiordesign', '#madebyhand', '#stoneware',
  '#designinspo', '#coffeetime', '#homedecor', '#smallbusiness', '#potterylove', '#wheelthrown', '#creativeprocess', '#shopsmall',
  '#ceramicart', '#makersmovement', '#handmadeceramics', '#mugshot',
];
const REPLIES = [
  'Thank you so much! 🧡 It means a lot to us.',
  'Thanks for asking! I just sent you a DM with the details.',
  'Yes, we ship worldwide. Orders go out every Friday 📦',
  'So glad you like it! The next restock is this Friday ✨',
  'Great question. The workshop still has two spots left; details are in our bio.',
];
const IDEAS = [
  'Time-lapse reel of a mug from wedging to glazing',
  'Carousel: 5 glaze tests and what went wrong',
  'Studio tour story series with a poll on the next colour',
  'Packing an order, start to finish, with ASMR sound',
  'Before and after: raw clay vs. finished piece',
];
const SENTENCES = [
  'Reels posted in the evening reached about 40% more accounts than morning posts this month.',
  'Carousels earn the most saves, so they are a good format for tips and process breakdowns.',
  'Engagement dipped on weekends; consider moving one weekly post to Wednesday or Thursday.',
  'Questions about price and shipping are the most common comments, so a pinned FAQ comment could help.',
];

function h32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function textOf(body) {
  const parts = [];
  const add = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text') parts.push(b.text || '');
  };
  if (body.system) add(body.system);
  for (const m of body.messages || []) add(m.content);
  return parts.join('\n');
}

function singular(name) {
  return String(name || '').replace(/ies$/, 'y').replace(/s$/, '');
}

function fitString(s, schema) {
  let out = s;
  if (schema.maxLength !== undefined && out.length > schema.maxLength) out = out.slice(0, schema.maxLength);
  if (schema.minLength !== undefined) while (out.length < schema.minLength) out += ' more';
  return out;
}

function stringFor(name, schema, i, salt) {
  const n = String(name || '').toLowerCase();
  const pickFrom = (arr) => arr[(salt + i) % arr.length];
  if (schema.format === 'date-time') return new Date(Date.UTC(2026, 9, 14 + i, 17, 0, 0)).toISOString();
  if (schema.format === 'date') return `2026-10-${String(14 + (i % 14)).padStart(2, '0')}`;
  if (schema.format === 'email') return 'hello@studionorth.example';
  if (schema.format === 'uri' || /url|link|website/.test(n)) return 'https://studionorth.example';
  if (/hashtag|^tag/.test(n)) return HASHTAGS[(salt + i * 3) % HASHTAGS.length];
  if (/^alt|alt_?text/.test(n)) return 'Three hand-thrown stoneware mugs in cream, rust and green on a wooden table in soft morning light.';
  if (/caption/.test(n)) return pickFrom(CAPTIONS);
  if (/first_?comment/.test(n)) return HASHTAGS.slice(salt % 8, (salt % 8) + 8).join(' ');
  if (/reply|response|answer|message|dm|text|draft/.test(n)) return pickFrom(REPLIES);
  if (/idea|concept|topic|hook|title|headline|angle/.test(n)) return pickFrom(IDEAS);
  if (/time|hour|slot/.test(n)) return ['18:30', '12:15', '20:00', '09:00'][(salt + i) % 4];
  if (/day|date/.test(n)) return ['Tuesday', 'Wednesday', 'Thursday', 'Sunday'][(salt + i) % 4];
  if (/emoji/.test(n)) return ['✨', '🌿', '☕', '🏺', '🧡'][(salt + i) % 5];
  if (/format|type|kind/.test(n)) return ['carousel', 'reel', 'feed', 'story'][(salt + i) % 4];
  if (/tone|style|voice|mood/.test(n)) return ['warm', 'playful', 'calm', 'confident'][(salt + i) % 4];
  if (/lang/.test(n)) return 'English';
  if (/name|user/.test(n)) return 'studio.north';
  if (/reason|why|explan|summary|insight|analysis|advice|tip|recommend|note|description|detail|takeaway|finding/.test(n)) return pickFrom(SENTENCES);
  if (/category|label|intent|sentiment/.test(n)) return ['question', 'praise', 'pricing', 'shipping'][(salt + i) % 4];
  return `Sample ${n.replace(/_/g, ' ') || 'text'}`;
}

/** Build a value that validates against `schema` (the subset structured outputs supports). */
export function synthesize(schema, name = '', i = 0, salt = 0, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[(salt + i) % schema.enum.length];
  const variants = schema.anyOf || schema.oneOf;
  if (Array.isArray(variants) && variants.length) {
    const nonNull = variants.find((v) => v && v.type !== 'null') || variants[0];
    return synthesize(nonNull, name, i, salt, depth + 1);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) return synthesize(Object.assign({}, ...schema.allOf), name, i, salt, depth + 1);
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') || type[0];
  if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
  if (schema.default !== undefined && type !== 'object' && type !== 'array') return schema.default;
  switch (type) {
    case 'object': {
      const out = {};
      for (const [k, sub] of Object.entries(schema.properties || {})) out[k] = synthesize(sub, k, i, salt, depth + 1);
      return out;
    }
    case 'array': {
      const min = schema.minItems ?? 0;
      const max = schema.maxItems ?? Infinity;
      let count = /hashtag|tag/.test(String(name).toLowerCase()) ? 8 : 3;
      count = Math.max(min, Math.min(max, count));
      const items = [];
      for (let k = 0; k < count; k++) items.push(synthesize(schema.items || { type: 'string' }, singular(name), k, salt + depth * 5 + (schema.items && schema.items.type === 'object' ? k * 7 : 0), depth + 1));
      if (schema.uniqueItems) return [...new Set(items.map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
      return items;
    }
    case 'string':
      return fitString(stringFor(name, schema, i, salt), schema);
    case 'integer':
    case 'number': {
      const lo = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : undefined);
      const hi = schema.maximum ?? (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - 1 : undefined);
      const n = String(name).toLowerCase();
      let v;
      if (lo !== undefined && hi !== undefined) v = lo + (hi - lo) * (0.6 + 0.1 * ((salt + i) % 4));
      else if (/score|confidence|probability|ratio|rate/.test(n)) v = 0.82;
      else if (/hour/.test(n)) v = [18, 12, 20, 9][(salt + i) % 4];
      else if (/weekday|day/.test(n)) v = [2, 3, 4, 0][(salt + i) % 4];
      else v = lo !== undefined ? lo + 3 : hi !== undefined ? Math.min(hi, 3) : 3 + i;
      return type === 'integer' ? Math.round(v) : Math.round(v * 100) / 100;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return null;
  }
}

function plainAnswer(prompt, salt) {
  const p = prompt.toLowerCase();
  if (/caption/.test(p)) return CAPTIONS[salt % CAPTIONS.length];
  if (/hashtag/.test(p)) return HASHTAGS.slice(salt % 5, (salt % 5) + 12).join(' ');
  if (/reply|comment|message|dm/.test(p)) return REPLIES[salt % REPLIES.length];
  if (/idea/.test(p)) return IDEAS.map((x, i) => `${i + 1}. ${x}`).join('\n');
  return SENTENCES[salt % SENTENCES.length];
}

/**
 * Caption rewrites (core/ai.js rewrite(), schema {rewritten}): a visible, deterministic change of the
 * fenced <text> so the composer flow can be checked end to end.
 */
function rewriteAnswer(prompt) {
  const m = /<text>\n([\s\S]*?)\n<\/text>/.exec(prompt);
  const text = (m ? m[1] : '').trim();
  const task = ([...prompt.matchAll(/^Task: (.*)$/gm)].pop() || [])[1] || ''; // the last one (the system prompt has its own)
  const tags = (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) || []).map((t) => t.trim());
  const body = text.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '').trim();
  const withTags = (s) => (tags.length ? `${s}\n\n${tags.join(' ')}` : s);
  if (/^Make it noticeably shorter/.test(task)) return withTags((body.split(/(?<=[.!?])\s/)[0] || body).trim());
  if (/^Make it longer/.test(task)) return withTags(`${body}\n\nEvery piece starts as a lump of clay and a quiet morning at the wheel. Which one would you take home?`);
  const lang = /^Translate it into ([^.]+)\./.exec(task);
  if (lang) return withTags(`[${lang[1]}] ${body}`);
  const tone = /^Rewrite it in a (\w+) tone/.exec(task);
  if (tone) return withTags(`(${tone[1]}) ${body}`);
  if (/call to action/.test(task)) return withTags(`${body}\n\nSave this post for your next studio visit.`);
  if (/^Fix spelling/.test(task)) return withTags(body.replace(/\s{2,}/g, ' ').replace(/\bi\b/g, 'I').replace(/^./, (c) => c.toUpperCase()));
  return text;
}

function approxTokens(s) {
  return Math.max(1, Math.ceil(String(s).length / 4));
}

export function createMockAnthropic() {
  const state = { requests: [], faults: [] };
  let seq = 0;

  function send(res, status, body, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'request-id': `req_mock_${++seq}`,
      ...extra,
    });
    res.end(body === null ? '' : JSON.stringify(body));
    return true;
  }

  const apiError = (res, status, type, message) => send(res, status, { type: 'error', error: { type, message }, request_id: `req_mock_${seq + 1}` });

  async function handle(req, res, path, body) {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return send(res, 204, null);
    const pathname = new URL(path, 'http://mock.local').pathname;
    const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!key) return apiError(res, 401, 'authentication_error', 'x-api-key header is required');
    if (key === 'bad-key') return apiError(res, 401, 'authentication_error', 'invalid x-api-key');
    const fault = state.faults.shift();
    if (fault) return apiError(res, fault.status || 529, fault.type || 'overloaded_error', fault.message || 'Overloaded');

    if (method === 'GET' && pathname === '/v1/models') {
      const ids = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
      return send(res, 200, { data: ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-06-01T00:00:00Z' })), has_more: false, first_id: ids[0], last_id: ids[ids.length - 1] });
    }
    let payload = body;
    if (Buffer.isBuffer(payload)) {
      try {
        payload = JSON.parse(payload.toString('utf8'));
      } catch {
        return apiError(res, 400, 'invalid_request_error', 'Request body must be JSON');
      }
    }
    payload = payload || {};
    if (method === 'POST' && pathname === '/v1/messages/count_tokens') {
      return send(res, 200, { input_tokens: approxTokens(textOf(payload)) });
    }
    if (method !== 'POST' || pathname !== '/v1/messages') return apiError(res, 404, 'not_found_error', `No route for ${method} ${pathname}`);
    if (!payload.model) return apiError(res, 400, 'invalid_request_error', 'model: Field required');
    if (!Array.isArray(payload.messages) || !payload.messages.length) return apiError(res, 400, 'invalid_request_error', 'messages: Field required');
    if (!payload.max_tokens) return apiError(res, 400, 'invalid_request_error', 'max_tokens: Field required');
    state.requests.push(payload);

    const prompt = textOf(payload);
    const salt = h32(prompt) % 997;
    const schema = (payload.output_config && payload.output_config.format && payload.output_config.format.schema) || (payload.output_format && payload.output_format.schema);
    const isRewrite = !!schema && Array.isArray(schema.required) && schema.required.includes('rewritten');
    const text = isRewrite ? JSON.stringify({ rewritten: rewriteAnswer(prompt) }) : schema ? JSON.stringify(synthesize(schema, '', 0, salt)) : plainAnswer(prompt, salt);
    const id = `msg_mock${String(h32(`${prompt}|${seq}`)).padStart(10, '0')}`;
    const usage = { input_tokens: approxTokens(prompt), output_tokens: approxTokens(text), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

    if (payload.stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'request-id': `req_mock_${++seq}`,
      });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (let i = 0; i < text.length; i += 48) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 48) } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      ev('message_stop', {});
      res.end();
      return true;
    }

    return send(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: payload.model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage,
    });
  }

  return { handle, state };
}
