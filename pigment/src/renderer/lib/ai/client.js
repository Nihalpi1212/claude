// Renderer side of the AI bridge (see ARCHITECTURE.md "0.2 features: AI").
// In the desktop app every call goes to src/main/ai.js through window.pigment.ai; the renderer never
// holds a secret. In the browser build (npm run dev:web, e2e tests) there is no main process: API keys
// live in localStorage['pigment.ai.keys'] and requests go straight to the providers (the CSP allows the
// three hosts). Tests replace the transport with window.__pigmentTest.ai = { request(payload) -> body,
// status?() }, which every provider call prefers when present.
import { bridge, isElectron } from '../bridge.js';

const BASES = { openai: 'https://api.openai.com/v1', gemini: 'https://generativelanguage.googleapis.com/v1beta' };
const KEYS_STORAGE = 'pigment.ai.keys';

function browserKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEYS_STORAGE) || '{}') || {};
  } catch {
    return {};
  }
}
function setBrowserKeys(keys) {
  try {
    localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));
  } catch {
    /* private mode */
  }
}

/** The test transport, when a test installed one. */
const testAi = () => (typeof window !== 'undefined' ? window.__pigmentTest?.ai ?? null : null);

/** Calls a main-process AI method (status, setApiKey, signOut, chatgptSignIn, models, request, ...). */
export async function aiCall(method, payload = {}) {
  const t = testAi();
  if (t) {
    if (method === 'request') return t.request(payload);
    if (typeof t[method] === 'function') return t[method](payload);
    if (method === 'status') return { available: true, encryption: true, openai: { method: 'api_key' }, gemini: { method: 'api_key' } };
    if (method === 'models') return { data: [] };
    return null;
  }
  if (isElectron && typeof bridge.ai === 'function') {
    try {
      return await bridge.ai(method, payload);
    } catch (err) {
      throw parseBridgeError(err);
    }
  }
  return browserCall(method, payload);
}

/** Separates the message from the JSON { code, status } tail src/main/ai.js appends (Electron keeps only the message). */
export const AI_ERROR_SEPARATOR = '\u001f';

/** Restores { message, code, status } from an error that crossed the IPC bridge. */
export function parseBridgeError(err) {
  let message = String(err?.message ?? err ?? 'Request failed');
  // ipcRenderer.invoke wraps the main-process message: "Error invoking remote method 'pigment:ai': Error: <message>"
  message = message.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, '');
  let code = null;
  let status = 0;
  const i = message.indexOf(AI_ERROR_SEPARATOR);
  if (i >= 0) {
    try {
      const tail = JSON.parse(message.slice(i + 1));
      code = typeof tail.code === 'string' ? tail.code : null;
      status = Number(tail.status) || 0;
    } catch {
      /* no tail */
    }
    message = message.slice(0, i);
  }
  return Object.assign(new Error(message.trim() || 'Request failed'), { code, status });
}

/** Browser build: the same methods without a main process (API keys only). */
async function browserCall(method, payload) {
  const keys = browserKeys();
  switch (method) {
    case 'status':
      return { available: true, encryption: false, browser: true, openai: { method: keys.openai ? 'api_key' : null }, gemini: { method: keys.gemini ? 'api_key' : null } };
    case 'setApiKey': {
      const next = { ...keys, [payload.provider]: payload.key };
      setBrowserKeys(next);
      return browserCall('status', {});
    }
    case 'signOut': {
      const next = { ...keys };
      delete next[payload.provider];
      setBrowserKeys(next);
      return browserCall('status', {});
    }
    case 'chatgptSignIn':
    case 'chatgptSignInManual':
      throw Object.assign(new Error('Sign in with ChatGPT needs the desktop app; use an API key here'), { code: 'desktop_only' });
    case 'chatgptSignInStatus':
      return { pending: false };
    case 'chatgptSignInCancel':
      return null;
    case 'models': {
      const { provider } = payload;
      const r = await browserCall('request', { provider, path: provider === 'openai' ? '/models' : '/models?pageSize=200', method: 'GET' });
      return r.body;
    }
    case 'request':
      return browserRequest(keys, payload);
    default:
      throw new Error(`Unknown AI method ${method}`);
  }
}

async function browserRequest(keys, { provider, path, method = 'POST', json, multipart, stream = false, timeoutMs = 120000 }) {
  const key = keys[provider];
  if (!key) throw Object.assign(new Error(`${provider === 'openai' ? 'OpenAI' : 'Gemini'} is not connected`), { code: 'not_connected' });
  const url = `${BASES[provider]}${path}`;
  const headers = provider === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key };
  let body;
  if (multipart) {
    body = new FormData();
    for (const [k, v] of Object.entries(multipart.fields ?? {})) body.append(k, v);
    for (const f of multipart.files ?? []) {
      const bin = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      body.append(f.field, new Blob([bin], { type: f.type }), f.name);
    }
  } else if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(stream ? { ...json, stream: true } : json);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let parsed = null;
    if (stream && res.ok) parsed = aggregateSse(text);
    else {
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text };
      }
    }
    if (!res.ok) throw providerError(res.status, parsed);
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** Turns the SSE text of a streamed Responses API call into the final response object. */
export function aggregateSse(text) {
  let completed = null;
  let deltaText = '';
  for (const block of text.split(/\n\n+/)) {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') completed = ev.response ?? completed;
    else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') deltaText += ev.delta;
    else if (ev.type === 'error') throw providerError(0, { error: ev.error ?? ev });
  }
  if (completed) return completed;
  return { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: deltaText }] }] };
}

/** Normalises a provider error body into an Error with code/status. */
export function providerError(status, body) {
  const e = body?.error ?? body;
  const message = (e && typeof e === 'object' && (e.message || e.error_description)) || (typeof e === 'string' ? e : null) || `Request failed (${status})`;
  const code = (e && typeof e === 'object' && (e.code || e.type || e.status)) || null;
  return Object.assign(new Error(message), { status, code: typeof code === 'string' ? code : null, body });
}

/** Provider request helper used by lib/ai/providers.js: resolves to the parsed body. */
export async function aiRequest(payload) {
  const r = await aiCall('request', payload);
  return r && typeof r === 'object' && 'body' in r && 'status' in r ? r.body : r;
}

export const aiStatus = () => aiCall('status');
export { BASES as AI_BASES };
