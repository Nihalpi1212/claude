// Provider request builders (see ARCHITECTURE.md "0.2 features: AI — Providers"): model catalogs, chat with
// a tool loop, image generation, masked image edits and image description for OpenAI and Google Gemini,
// built on aiRequest/aiCall from lib/ai/client.js. Nothing here touches the document: the features module
// decides where results go. Canvases cross the wire as base64 PNG; results are resampled back to the size
// the caller asked for with src/shared/pixels/transform.js resize.
import { aiRequest, aiCall } from './client.js';
import { resize } from '../../../shared/pixels/transform.js';

export const PROVIDERS = Object.freeze({
  openai: { id: 'openai', label: 'OpenAI', maxEdge: 1536 },
  gemini: { id: 'gemini', label: 'Google Gemini', maxEdge: 2048 },
});

/** Default models, first present wins (exact id, then id prefix). */
export const PREFERRED_MODELS = Object.freeze({
  openai: { chat: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o'], image: ['gpt-image-1.5', 'gpt-image-1', 'gpt-image-2'] },
  gemini: { chat: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'], image: ['gemini-3.1-flash-image', 'gemini-3.1-flash-image-preview', 'gemini-3-pro-image-preview', 'gemini-2.5-flash-image'] },
});

const OPENAI_SIZES = ['1024x1024', '1536x1024', '1024x1536'];
const DALLE3_SIZES = ['1024x1024', '1792x1024', '1024x1792'];
const DALLE2_SIZES = ['256x256', '512x512', '1024x1024'];
/** The sizes an OpenAI image model accepts (gpt-image-*: the three 1024/1536 shapes). */
export const openaiSizesFor = (model) => (/^dall-e-3/.test(String(model)) ? DALLE3_SIZES : /^dall-e-2/.test(String(model)) ? DALLE2_SIZES : OPENAI_SIZES);
const GEMINI_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];

const providerOf = (p) => {
  if (!PROVIDERS[p]) throw new Error(`Unknown AI provider "${p}"`);
  return PROVIDERS[p];
};

// ---- model catalogs ------------------------------------------------------------------------------------------------

function openaiKind(id) {
  const s = String(id).toLowerCase();
  if (/image|dall-e/.test(s)) return 'image';
  if (/embed|tts|whisper|transcri|audio|realtime|moderation|search|babbage|davinci|instruct|computer-use|sora|codex-mini/.test(s)) return 'other';
  if (/^(gpt|o\d|chatgpt)/.test(s)) return 'chat';
  return 'other';
}

function geminiKind(m) {
  const name = String(m?.name ?? '').replace(/^models\//, '').toLowerCase();
  const methods = Array.isArray(m?.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
  if (/image|imagen/.test(name)) return 'image';
  if (methods.includes('generateContent')) return /embedding|aqa|tts|audio|veo|live/.test(name) ? 'other' : 'chat';
  return 'other';
}

/** Normalises a catalog (already parsed by main, or a raw provider body in the browser build) to [{ id, kind, label? }]. */
export function normalizeCatalog(provider, raw) {
  if (Array.isArray(raw)) return raw.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, kind: m.kind ?? 'other', label: m.label }));
  const out = [];
  if (provider === 'gemini') {
    for (const m of Array.isArray(raw?.models) ? raw.models : []) {
      const id = String(m?.name ?? '').replace(/^models\//, '');
      if (id) out.push({ id, kind: geminiKind(m), label: m?.displayName });
    }
  } else {
    const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : [];
    for (const m of list) {
      const id = typeof m === 'string' ? m : m?.id ?? m?.slug;
      if (typeof id === 'string') out.push({ id, kind: openaiKind(id) });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function pickPreferred(preferred, available) {
  for (const p of preferred) if (available.includes(p)) return p;
  for (const p of preferred) {
    const hit = available.find((id) => id.startsWith(p));
    if (hit) return hit;
  }
  return available[0] ?? null;
}

/** { chat: string[], image: string[], default: { chat, image }, all } for a connected provider. */
export async function listModels(provider) {
  providerOf(provider);
  const raw = await aiCall('models', { provider });
  const all = normalizeCatalog(provider, raw);
  const chat = all.filter((m) => m.kind === 'chat').map((m) => m.id);
  const image = all.filter((m) => m.kind === 'image').map((m) => m.id);
  return { chat, image, default: { chat: pickPreferred(PREFERRED_MODELS[provider].chat, chat), image: pickPreferred(PREFERRED_MODELS[provider].image, image) }, all };
}

// ---- canvas helpers --------------------------------------------------------------------------------------------------

export function makeCanvas(width, height) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export const canvasToDataUrl = (canvas) => canvas.toDataURL('image/png');
export const canvasToBase64 = (canvas) => canvasToDataUrl(canvas).split(',')[1];

/** Decodes a base64 image (PNG, JPEG, WebP) into a canvas. */
export function canvasFromBase64(base64, mime = 'image/png') {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error('The model returned an image that could not be decoded'));
    img.src = `data:${mime || 'image/png'};base64,${base64}`;
  });
}

export const imageDataOf = (canvas) => canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);

export function canvasFromImageData(img) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

/** High-quality resample of a canvas to width × height (same canvas when the size already matches). */
export function resampleTo(canvas, width, height, method = 'bicubic') {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (canvas.width === w && canvas.height === h) return canvas;
  return canvasFromImageData(resize(imageDataOf(canvas), w, h, { method }));
}

/** Scales a canvas down so its long edge is at most maxEdge (never up). */
export function downscale(canvas, maxEdge) {
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  if (s >= 1) return canvas;
  return resampleTo(canvas, Math.max(1, Math.round(canvas.width * s)), Math.max(1, Math.round(canvas.height * s)), 'area');
}

export function cropCanvas(canvas, x, y, width, height) {
  const c = makeCanvas(width, height);
  c.getContext('2d').drawImage(canvas, x, y, width, height, 0, 0, c.width, c.height);
  return c;
}

/** Resamples to width × height keeping the proportions: scales to cover, then crops the centre (never stretches). */
export function coverTo(canvas, width, height) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (canvas.width === w && canvas.height === h) return canvas;
  const s = Math.max(w / canvas.width, h / canvas.height);
  const sw = Math.min(canvas.width, Math.max(1, Math.round(w / s))), sh = Math.min(canvas.height, Math.max(1, Math.round(h / s)));
  const crop = sw === canvas.width && sh === canvas.height ? canvas : cropCanvas(canvas, Math.floor((canvas.width - sw) / 2), Math.floor((canvas.height - sh) / 2), sw, sh);
  return resampleTo(crop, w, h);
}

/** True when every pixel is fully opaque (an answer without an alpha channel). */
export function isOpaque(img) {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return false;
  return true;
}

/**
 * Keys out the near-white background connected to the image border (a "subject on white" answer): flood
 * from the edges over pixels whose channels all exceed `threshold`, then fade the ring of lighter pixels
 * next to the keyed area so the subject edge is not left with a white fringe. In place; returns the count.
 */
export function keyWhiteBorder(img, { threshold = 232 } = {}) {
  const { width: w, height: h, data: d } = img;
  const keyed = new Uint8Array(w * h);
  const stack = [];
  const isWhite = (i) => d[i * 4] >= threshold && d[i * 4 + 1] >= threshold && d[i * 4 + 2] >= threshold;
  const push = (i) => {
    if (!keyed[i] && isWhite(i)) {
      keyed[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  let count = 0;
  for (let i = 0; i < keyed.length; i++) {
    if (!keyed[i]) continue;
    d[i * 4 + 3] = 0;
    count++;
  }
  // soften the edge: an unkeyed pixel next to the keyed area keeps alpha in proportion to how far from white it is
  for (let i = 0; i < keyed.length; i++) {
    if (keyed[i]) continue;
    const x = i % w, y = (i - x) / w;
    const near = (x > 0 && keyed[i - 1]) || (x < w - 1 && keyed[i + 1]) || (y > 0 && keyed[i - w]) || (y < h - 1 && keyed[i + w]);
    if (!near) continue;
    const m = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    if (m > 200) d[i * 4 + 3] = Math.round((d[i * 4 + 3] * (255 - m)) / 55);
  }
  return count;
}

/**
 * Pads image (and mask) to the aspect ratio the provider will answer in, centred, so the answer is never
 * stretched. Returns { image, mask, x, y, width, height } where x/y/width/height locate the original.
 */
export function padToAspect(image, mask, aspect, { fill = null } = {}) {
  const w = image.width, h = image.height;
  let pw = w, ph = h;
  if (w / h < aspect) pw = Math.round(h * aspect);
  else ph = Math.round(w / aspect);
  if (pw === w && ph === h) return { image, mask, x: 0, y: 0, width: w, height: h };
  const x = Math.floor((pw - w) / 2), y = Math.floor((ph - h) / 2);
  const out = makeCanvas(pw, ph);
  const ctx = out.getContext('2d');
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, pw, ph);
  }
  ctx.drawImage(image, x, y);
  let paddedMask = null;
  if (mask) {
    // padding must never change: transparent in the mask (alpha 0 = keep)
    paddedMask = makeCanvas(pw, ph);
    paddedMask.getContext('2d').drawImage(mask, x, y);
  }
  return { image: out, mask: paddedMask, x, y, width: w, height: h };
}

/** OpenAI edit mask: alpha 0 where the image may change (the inverse of Pigment's alpha-255-changes mask). */
export function openaiMask(mask) {
  const img = imageDataOf(mask);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = 255 - d[i + 3];
  }
  return canvasFromImageData(img);
}

/** Gemini mask: an opaque image, white where the image may change, black elsewhere. */
export function whiteMask(mask) {
  const img = imageDataOf(mask);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + 3];
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  return canvasFromImageData(img);
}

/** original where the mask is transparent, answer where it is opaque, blended in between. */
export function compositeThroughMask(original, answer, mask) {
  const w = original.width, h = original.height;
  const a = imageDataOf(original);
  const b = imageDataOf(answer.width === w && answer.height === h ? answer : resampleTo(answer, w, h));
  const m = imageDataOf(mask.width === w && mask.height === h ? mask : resampleTo(mask, w, h));
  const out = new ImageData(w, h);
  const o = out.data, p = a.data, q = b.data, k = m.data;
  for (let i = 0; i < o.length; i += 4) {
    const t = k[i + 3] / 255;
    if (t <= 0) {
      o[i] = p[i];
      o[i + 1] = p[i + 1];
      o[i + 2] = p[i + 2];
      o[i + 3] = p[i + 3];
    } else if (t >= 1) {
      o[i] = q[i];
      o[i + 1] = q[i + 1];
      o[i + 2] = q[i + 2];
      o[i + 3] = q[i + 3];
    } else {
      // blend with premultiplied colour so transparent answers do not darken the edge
      const pa = p[i + 3] / 255, qa = q[i + 3] / 255;
      const oa = pa + (qa - pa) * t;
      if (oa <= 0) o[i] = o[i + 1] = o[i + 2] = o[i + 3] = 0;
      else {
        for (let c = 0; c < 3; c++) o[i + c] = (p[i + c] * pa * (1 - t) + q[i + c] * qa * t) / oa;
        o[i + 3] = oa * 255;
      }
    }
  }
  return canvasFromImageData(out);
}

// ---- sizes and aspect ratios ----------------------------------------------------------------------------------------------

export function nearestOpenaiSize(width, height, sizes = OPENAI_SIZES) {
  const r = width / height;
  const edge = Math.max(width, height);
  let best = sizes[0], bestD = Infinity, bestEdge = 0;
  for (const s of sizes) {
    const [w, h] = s.split('x').map(Number);
    const d = Math.abs(Math.log(r) - Math.log(w / h));
    const e = Math.max(w, h);
    // same aspect (dall-e-2's squares): the smallest size that still holds the image, else the largest
    const better = d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && ((e >= edge && (bestEdge < edge || e < bestEdge)) || (e < edge && bestEdge < edge && e > bestEdge)));
    if (better) {
      bestD = d;
      best = s;
      bestEdge = e;
    }
  }
  return best;
}

export function nearestGeminiAspect(width, height) {
  const r = width / height;
  let best = GEMINI_RATIOS[0], bestD = Infinity;
  for (const s of GEMINI_RATIOS) {
    const [a, b] = s.split(':').map(Number);
    const d = Math.abs(Math.log(r) - Math.log(a / b));
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

const ratioOf = (s) => {
  const [a, b] = s.split(/[x:]/).map(Number);
  return a / b;
};

const isGptImage = (model) => /^gpt-image/.test(String(model));
/** background / input_fidelity exist on gpt-image-1 and gpt-image-1.5 only. */
const isGptImage1 = (model) => /^gpt-image-1(\.5)?(-|$)/.test(String(model));
const isGemini3 = (model) => /^gemini-3/.test(String(model));
/** Older image models answer only in TEXT+IMAGE mode; gemini-3.x accepts IMAGE alone. */
const geminiModalities = (model) => (isGemini3(model) ? ['IMAGE'] : ['TEXT', 'IMAGE']);
const geminiImageSize = (model, longEdge) => (isGemini3(model) ? (longEdge > 2048 ? '4K' : longEdge > 1024 ? '2K' : '1K') : undefined);

function dataUrlParts(url) {
  const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(String(url));
  if (!m) return null;
  return { mime: m[1] || 'image/png', base64: m[2] };
}

// ---- chat ------------------------------------------------------------------------------------------------------------------------

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

const resultText = (result) => (typeof result === 'string' ? result : JSON.stringify(result === undefined ? null : result));

const stoppedError = () => Object.assign(new Error('Stopped by the user'), { code: 'stopped' });

async function runTool(onToolCall, name, args) {
  try {
    return await onToolCall(name, args);
  } catch (err) {
    if (err?.code === 'stopped') throw err; // the user pressed Stop: abort the whole tool loop
    return { error: err?.message ?? String(err) };
  }
}

function openaiItem(m) {
  if (m.role === 'assistant') return { role: 'assistant', content: [{ type: 'output_text', text: m.text ?? '' }] };
  const content = [];
  if (m.text) content.push({ type: 'input_text', text: m.text });
  for (const url of m.images ?? []) content.push({ type: 'input_image', image_url: url, detail: 'auto' });
  if (!content.length) content.push({ type: 'input_text', text: '' });
  return { role: 'user', content };
}

/** Output items go back as input items; reasoning without encrypted content cannot be replayed with store: false. */
function replayableItem(it) {
  if (it.type === 'message') return { role: it.role ?? 'assistant', content: (it.content ?? []).filter((c) => c.type === 'output_text').map((c) => ({ type: 'output_text', text: c.text ?? '' })) };
  if (it.type === 'function_call') return { type: 'function_call', call_id: it.call_id, name: it.name, arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) };
  if (it.type === 'reasoning') return it.encrypted_content ? it : null;
  return it;
}

const outputText = (output) => output.filter((it) => it.type === 'message').flatMap((it) => it.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');

async function openaiChat({ model, instructions, messages, tools, onToolCall, maxRounds, shouldStop }) {
  const body = { model, input: messages.map(openaiItem), store: false };
  if (instructions) body.instructions = instructions;
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} }, strict: false }));
    body.tool_choice = 'auto';
  }
  const calls = [];
  let text = '';
  let truncated = false;
  for (let round = 0; ; round++) {
    if (round > 0 && shouldStop?.()) throw stoppedError();
    const res = await aiRequest({ provider: 'openai', path: '/responses', method: 'POST', json: body, timeoutMs: 180_000 });
    if (res?.error) throw new Error(res.error.message ?? 'The model request failed');
    const output = Array.isArray(res?.output) ? res.output : [];
    text = outputText(output) || (typeof res?.output_text === 'string' ? res.output_text : '');
    const functionCalls = output.filter((it) => it.type === 'function_call');
    if (!functionCalls.length || !onToolCall) break;
    if (round >= maxRounds) {
      truncated = true; // the model wanted more steps than allowed: the caller tells the user
      break;
    }
    // the whole history is resent each round: the model's items, then one output per call
    for (const it of output) {
      const item = replayableItem(it);
      if (item) body.input.push(item);
    }
    for (const fc of functionCalls) {
      const args = parseArgs(fc.arguments);
      const result = await runTool(onToolCall, fc.name, args);
      calls.push({ name: fc.name, args, result });
      body.input.push({ type: 'function_call_output', call_id: fc.call_id, output: resultText(result) });
    }
  }
  return { text, calls, truncated };
}

/** Gemini accepts an OpenAPI subset: strip the JSON-schema keys it rejects. */
export function cleanSchema(schema) {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === '$schema' || k === 'additionalProperties' || k === 'default' || k === 'examples' || k === '$id' || k === 'strict') continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

/**
 * Gemini's Schema subset also needs a `type` on every schema and refuses OBJECT schemas without
 * properties, so open objects ("params": any keys) and untyped values travel as JSON strings; the
 * tool implementations parse them back (assistant.js parseMaybeJson).
 */
export function geminiSchema(schema) {
  const s = cleanSchema(schema);
  if (!s || typeof s !== 'object' || Array.isArray(s)) return s;
  const asJsonString = (desc, what) => ({ type: 'string', description: `${desc ? `${desc} ` : ''}(${what}, as a JSON string)`.trim() });
  if (s.type === 'object' || s.properties) {
    const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
    const keys = Object.keys(props);
    if (!keys.length) return asJsonString(s.description, 'an object');
    const out = { ...s, type: 'object', properties: {} };
    for (const k of keys) out.properties[k] = geminiSchema(props[k]);
    if (Array.isArray(out.required)) out.required = out.required.filter((k) => k in out.properties);
    return out;
  }
  if (s.type === 'array') return { ...s, type: 'array', items: s.items ? geminiSchema(s.items) : { type: 'string' } };
  if (Array.isArray(s.type)) return { ...s, type: s.type.find((t) => t !== 'null') ?? 'string' };
  if (!s.type) return asJsonString(s.description, 'any value');
  return s;
}

/** One Gemini function declaration; a tool without parameters declares none (an empty OBJECT is refused). */
export function geminiDeclaration(t) {
  const decl = { name: t.name, description: t.description ?? '' };
  const p = geminiSchema(t.parameters ?? { type: 'object', properties: {} });
  if (p && p.type === 'object' && Object.keys(p.properties ?? {}).length) decl.parameters = p;
  return decl;
}

function geminiContent(m) {
  const parts = [];
  if (m.text) parts.push({ text: m.text });
  for (const url of m.images ?? []) {
    const p = dataUrlParts(url);
    if (p) parts.push({ inline_data: { mime_type: p.mime, data: p.base64 } });
  }
  if (!parts.length) parts.push({ text: '' });
  return { role: m.role === 'assistant' ? 'model' : 'user', parts };
}

const geminiParts = (res) => res?.candidates?.[0]?.content?.parts ?? [];
const geminiText = (parts) => parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');

async function geminiChat({ model, instructions, messages, tools, onToolCall, maxRounds, shouldStop }) {
  const body = { contents: messages.map(geminiContent) };
  if (instructions) body.systemInstruction = { parts: [{ text: instructions }] };
  if (tools.length) body.tools = [{ functionDeclarations: tools.map(geminiDeclaration) }];
  const calls = [];
  let text = '';
  let truncated = false;
  for (let round = 0; ; round++) {
    if (round > 0 && shouldStop?.()) throw stoppedError();
    const res = await aiRequest({ provider: 'gemini', path: `/models/${encodeURIComponent(model)}:generateContent`, method: 'POST', json: body, timeoutMs: 180_000 });
    if (res?.error) throw new Error(res.error.message ?? 'The model request failed');
    if (res?.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${res.promptFeedback.blockReason})`);
    const parts = geminiParts(res);
    text = geminiText(parts);
    const functionCalls = parts.filter((p) => p.functionCall && typeof p.functionCall.name === 'string');
    if (!functionCalls.length || !onToolCall) break;
    if (round >= maxRounds) {
      truncated = true;
      break;
    }
    // the model turn goes back verbatim (thought signatures included), then the function responses
    body.contents.push({ role: 'model', parts });
    const responses = [];
    for (const p of functionCalls) {
      const args = p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {};
      const result = await runTool(onToolCall, p.functionCall.name, args);
      calls.push({ name: p.functionCall.name, args, result });
      responses.push({ functionResponse: { name: p.functionCall.name, response: { result: result === undefined ? null : result } } });
    }
    body.contents.push({ role: 'user', parts: responses });
  }
  return { text, calls, truncated };
}

/**
 * Chat with an optional tool loop. messages: { role: 'user'|'assistant', text?, images?: dataUrl[] }[];
 * tools: { name, description, parameters }[]; onToolCall(name, args) -> result (any JSON value).
 */
export async function chat({ provider, model, instructions, messages = [], tools = [], onToolCall, maxRounds = 8, shouldStop = null }) {
  providerOf(provider);
  if (!model) throw new Error(`No ${PROVIDERS[provider].label} chat model is selected`);
  const args = { model, instructions, messages, tools, onToolCall, maxRounds: Math.max(0, maxRounds | 0), shouldStop };
  return provider === 'gemini' ? geminiChat(args) : openaiChat(args);
}

// ---- images -----------------------------------------------------------------------------------------------------------------------

function firstInlineImage(res) {
  for (const p of geminiParts(res)) {
    const d = p.inlineData ?? p.inline_data;
    if (d && typeof d.data === 'string') return { data: d.data, mime: d.mimeType ?? d.mime_type ?? 'image/png' };
  }
  return null;
}

function geminiImageFailure(res) {
  if (res?.promptFeedback?.blockReason) return `Gemini blocked the request (${res.promptFeedback.blockReason})`;
  const reason = res?.candidates?.[0]?.finishReason;
  const text = geminiText(geminiParts(res));
  return text ? `The model answered with text instead of an image: ${text.slice(0, 300)}` : reason && reason !== 'STOP' ? `The model returned no image (${reason})` : 'The model returned no image';
}

async function openaiImageResult(res) {
  const b64 = res?.data?.[0]?.b64_json;
  if (!b64) throw new Error(res?.data?.[0]?.url ? 'The model returned a link instead of image data; choose a gpt-image model' : 'The model returned no image');
  return canvasFromBase64(b64, 'image/png');
}

/** A new image of width × height from a prompt. */
export async function generateImage({ provider, model, prompt, width = 1024, height = 1024, transparent = false, n = 1 }) {
  providerOf(provider);
  if (!model) throw new Error(`No ${PROVIDERS[provider].label} image model is selected`);
  if (!prompt || !String(prompt).trim()) throw new Error('Enter a prompt');
  void n; // one image per call; the caller loops for variations
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  if (provider === 'gemini') {
    const aspectRatio = nearestGeminiAspect(w, h);
    const generationConfig = { responseModalities: geminiModalities(model), imageConfig: { aspectRatio } };
    const imageSize = geminiImageSize(model, Math.max(w, h));
    if (imageSize) generationConfig.imageConfig.imageSize = imageSize;
    // Gemini has no alpha output: a transparent background is asked for as plain white and keyed out afterwards
    const text = transparent ? `${String(prompt)}\n\nRender the subject alone on a plain, pure white (#ffffff) background with nothing else: no shadow, no floor, no frame.` : String(prompt);
    const res = await aiRequest({ provider, path: `/models/${encodeURIComponent(model)}:generateContent`, method: 'POST', json: { contents: [{ role: 'user', parts: [{ text }] }], generationConfig }, timeoutMs: 300_000 });
    const part = firstInlineImage(res);
    if (!part) throw new Error(geminiImageFailure(res));
    let out = await canvasFromBase64(part.data, part.mime);
    if (transparent) {
      const img = imageDataOf(out);
      if (isOpaque(img)) keyWhiteBorder(img);
      out = canvasFromImageData(img);
    }
    return coverTo(out, w, h);
  }
  const size = nearestOpenaiSize(w, h, openaiSizesFor(model));
  const json = { model, prompt: String(prompt), n: 1, size };
  if (isGptImage(model)) {
    json.quality = 'auto';
    json.output_format = 'png';
    if (isGptImage1(model)) json.background = transparent ? 'transparent' : 'auto';
  } else json.response_format = 'b64_json';
  const res = await aiRequest({ provider, path: '/images/generations', method: 'POST', json, timeoutMs: 300_000 });
  // the answer keeps its proportions: scaled to cover the requested size and cropped, never stretched
  return coverTo(await openaiImageResult(res), w, h);
}

/**
 * Edits an image from a prompt. mask: alpha 255 = pixels that may change. The answer comes back at the
 * image's size and, with a mask, composited through it so untouched pixels stay exact.
 */
export async function editImage({ provider, model, image, mask = null, prompt, transparent = false }) {
  const p = providerOf(provider);
  if (!model) throw new Error(`No ${p.label} image model is selected`);
  if (!image) throw new Error('No image to edit');
  const W = image.width, H = image.height;
  const small = downscale(image, p.maxEdge);
  const smallMask = mask ? (small === image ? mask : resampleTo(mask, small.width, small.height, 'bilinear')) : null;
  let answer;
  if (provider === 'openai') {
    if (/^dall-e-3/.test(String(model))) throw new Error('dall-e-3 cannot edit images; choose a gpt-image model (or dall-e-2) for this feature');
    const dalle2 = /^dall-e-2/.test(String(model));
    const size = nearestOpenaiSize(small.width, small.height, openaiSizesFor(model));
    const pad = padToAspect(small, smallMask, ratioOf(size));
    const fields = { model, prompt: String(prompt ?? ''), n: '1', size };
    if (isGptImage(model)) {
      fields.output_format = 'png';
      fields.quality = 'auto';
      if (isGptImage1(model)) {
        fields.input_fidelity = 'high';
        fields.background = transparent ? 'transparent' : 'auto';
      }
    } else fields.response_format = 'b64_json';
    // dall-e-2 takes exactly one square image under `image`; gpt-image models take a list under `image[]`
    const files = [{ field: dalle2 ? 'image' : 'image[]', name: 'image.png', type: 'image/png', base64: canvasToBase64(pad.image) }];
    if (pad.mask) files.push({ field: 'mask', name: 'mask.png', type: 'image/png', base64: canvasToBase64(openaiMask(pad.mask)) });
    const res = await aiRequest({ provider, path: '/images/edits', method: 'POST', multipart: { fields, files }, timeoutMs: 300_000 });
    const out = await openaiImageResult(res);
    answer = cropCanvas(resampleTo(out, pad.image.width, pad.image.height), pad.x, pad.y, pad.width, pad.height);
  } else {
    const aspectRatio = nearestGeminiAspect(small.width, small.height);
    const pad = padToAspect(small, smallMask, ratioOf(aspectRatio), { fill: '#ffffff' });
    const text = mask ? `${prompt ?? ''}\n\nEdit the first image. The second image is a mask: change only the white area of the first image and keep everything outside it exactly as it is. Answer with the whole edited image, same framing and size.` : String(prompt ?? '');
    const parts = [{ text }, { inline_data: { mime_type: 'image/png', data: canvasToBase64(pad.image) } }];
    if (pad.mask) parts.push({ inline_data: { mime_type: 'image/png', data: canvasToBase64(whiteMask(pad.mask)) } });
    const generationConfig = { responseModalities: geminiModalities(model), imageConfig: { aspectRatio } };
    const imageSize = geminiImageSize(model, Math.max(pad.image.width, pad.image.height));
    if (imageSize) generationConfig.imageConfig.imageSize = imageSize;
    const res = await aiRequest({ provider, path: `/models/${encodeURIComponent(model)}:generateContent`, method: 'POST', json: { contents: [{ role: 'user', parts }], generationConfig }, timeoutMs: 300_000 });
    const part = firstInlineImage(res);
    if (!part) throw new Error(geminiImageFailure(res));
    const out = await canvasFromBase64(part.data, part.mime);
    answer = cropCanvas(resampleTo(out, pad.image.width, pad.image.height), pad.x, pad.y, pad.width, pad.height);
  }
  const full = resampleTo(answer, W, H);
  return mask ? compositeThroughMask(image, full, mask) : full;
}

/** A text description of an image. */
export async function describeImage({ provider, model, image, prompt }) {
  const p = providerOf(provider);
  const small = downscale(image, Math.min(p.maxEdge, 1024));
  const { text } = await chat({
    provider,
    model,
    messages: [{ role: 'user', text: prompt || 'Describe this image in detail: subject, composition, colours, lighting, mood and any text it contains. Answer in plain prose.', images: [canvasToDataUrl(small)] }],
  });
  return text.trim();
}

export const providers = { listModels, chat, generateImage, editImage, describeImage };
