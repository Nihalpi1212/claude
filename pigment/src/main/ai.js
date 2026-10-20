// AI accounts and requests for the main process (see ARCHITECTURE.md "0.2 features: AI").
//
// Everything secret lives here: API keys and ChatGPT tokens are kept in <userData>/ai-credentials.json,
// each value sealed with safeStorage when the OS offers it. The renderer only ever receives a status
// object and provider responses. The pure parts (PKCE, URL building, callback parsing, ID token
// checks, plan-route reshaping, SSE aggregation, error translation, model catalogs) are exported for
// Node unit tests; Electron comes in only through createAi()'s argument so the module loads anywhere.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

export const OPENAI_BASE = 'https://api.openai.com/v1';
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const BASES = { openai: OPENAI_BASE, gemini: GEMINI_BASE };
export const PROVIDER_NAMES = { openai: 'OpenAI', gemini: 'Gemini' };

/** Constants of the open-source "Sign in with ChatGPT" token-sharing flow. */
export const CHATGPT_AUTH = Object.freeze({
  authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
  tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
  issuer: 'https://auth.openai.com',
  resource: 'https://api.openai.com/v1',
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  planScope: 'chatgpt.tokens.use.direct',
  dynamicClientId: 'dynamic_agent_client',
  agentNameHint: 'Pigment',
  callbackPath: '/auth/callback',
  ports: [1455, 1456, 1457, 1458, 1459, 1460],
  signInTimeoutMs: 5 * 60 * 1000,
  refreshLeadMs: 5 * 60 * 1000,
});

/** Token errors after which the stored sign-in can never work again. */
export const FATAL_TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_client', 'invalid_refresh_token', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'token_expired']);

/** Request parameters the ChatGPT plan route refuses on POST /responses. */
export const PLAN_ROUTE_DROPPED_PARAMS = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_key', 'prompt_cache_options', 'prompt_cache_retention', 'safety_identifier', 'service_tier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user'];
/** Hosted tools the plan route refuses (function tools and web_search stay). */
export const PLAN_ROUTE_DROPPED_TOOLS = new Set(['code_interpreter', 'file_search', 'image_generation', 'mcp', 'tool_search']);

/** Human explanations of the plan route's error codes. */
export const SUBSCRIPTION_HINTS = Object.freeze({
  subscription_sharing_user_not_eligible: 'Your ChatGPT plan does not include use in third-party apps (a Plus or Pro plan is required). You can use an OpenAI API key instead.',
  subscription_sharing_usage_limit_exceeded: 'You have reached the usage limit of your ChatGPT plan. Try again later or use an OpenAI API key.',
  subscription_sharing_usage_unavailable: 'ChatGPT could not check the usage of your plan right now. Try again in a moment.',
  subscription_sharing_route_not_supported: 'This kind of request is not available through a ChatGPT plan. Use an OpenAI API key for it.',
  subscription_sharing_unsupported_capability: 'This capability (for example image generation) is not available through a ChatGPT plan. Use an OpenAI API key for it.',
  subscription_sharing_invalid_user: 'ChatGPT rejected this sign-in. Sign out and sign in with ChatGPT again.',
});

/** Separates the message from the JSON { code, status } tail when an error crosses the IPC bridge. */
export const AI_ERROR_SEPARATOR = '\u001f';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MODEL_CACHE_MS = 10 * 60 * 1000;

export class AiError extends Error {
  constructor(message, { code = null, status = 0, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

/** Error carried through ipcMain.handle: Electron keeps only the message, so the code rides in it. */
export function serializeAiError(err) {
  const message = err?.message ?? String(err);
  const tail = JSON.stringify({ code: err?.code ?? null, status: err?.status ?? 0 });
  const out = new Error(`${message}${AI_ERROR_SEPARATOR}${tail}`);
  out.code = err?.code ?? null;
  out.status = err?.status ?? 0;
  return out;
}

// ---- PKCE and the authorization URL -------------------------------------------------------------------------

export const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** S256 code challenge of a verifier. */
export function pkceChallenge(verifier) {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function createPkce() {
  const verifier = base64url(randomBytes(48));
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export const randomToken = (bytes = 24) => base64url(randomBytes(bytes));

export const newHostId = () => `urn:uuid:${randomUUID()}`;

/**
 * The authorize URL of the sign-in flow. The first sign-in (and every later one; the host id is what keeps
 * the installation stable) registers a dynamic agent client; the callback then carries the issued client id.
 */
export function buildAuthorizeUrl({ clientId = CHATGPT_AUTH.dynamicClientId, redirectUri, state, nonce, codeChallenge, hostId }) {
  if (!redirectUri || !state || !nonce || !codeChallenge) throw new AiError('Incomplete sign-in parameters', { code: 'internal' });
  const url = new URL(CHATGPT_AUTH.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', CHATGPT_AUTH.scope);
  url.searchParams.set('resource', CHATGPT_AUTH.resource);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (clientId === CHATGPT_AUTH.dynamicClientId) {
    url.searchParams.set('agent_name_hint', CHATGPT_AUTH.agentNameHint);
    if (hostId) url.searchParams.set('ext_agent_host_id', hostId);
  }
  return url.toString();
}

export const redirectUriFor = (port) => `http://127.0.0.1:${port}${CHATGPT_AUTH.callbackPath}`;

/**
 * Parses the callback the browser was sent to: a full URL, a path with a query, or a bare query string.
 * Returns { code, state, clientId, error, errorDescription }.
 */
export function parseCallback(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new AiError('Paste the full address of the page the browser landed on', { code: 'bad_callback' });
  let params;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) params = new URL(text).searchParams;
    else if (text.startsWith('/')) params = new URL(text, 'http://127.0.0.1').searchParams;
    else params = new URLSearchParams(text.replace(/^\?/, ''));
  } catch {
    throw new AiError('That does not look like a callback address', { code: 'bad_callback' });
  }
  const get = (k) => params.get(k) || null;
  const out = { code: get('code'), state: get('state'), clientId: get('client_id'), error: get('error'), errorDescription: get('error_description') };
  if (!out.code && !out.error) throw new AiError('The callback address carries no authorization code', { code: 'bad_callback' });
  return out;
}

// ---- JWT helpers and ID token checks ----------------------------------------------------------------------------

export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Checks the ID token claims that matter for the sign-in: issuer, audience (contains the client id),
 * expiry and, when given, the nonce. Returns the claims. The signature is not checked: the token came
 * over TLS straight from the token endpoint and is never used as a bearer credential.
 */
export function validateIdToken(token, { clientId, nonce = null, now = Date.now() / 1000 } = {}) {
  const claims = decodeJwt(token);
  if (!claims) throw new AiError('The sign-in answer carried no readable ID token', { code: 'invalid_id_token' });
  if (claims.iss !== CHATGPT_AUTH.issuer) throw new AiError('The ID token was not issued by auth.openai.com', { code: 'invalid_id_token' });
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (clientId && !aud.includes(clientId)) throw new AiError('The ID token was issued for another application', { code: 'invalid_id_token' });
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new AiError('The ID token has already expired', { code: 'invalid_id_token' });
  if (nonce && claims.nonce !== nonce) throw new AiError('The ID token does not match this sign-in attempt', { code: 'invalid_id_token' });
  return claims;
}

/** Account details an OpenAI token pair reveals (nothing secret: email, plan grant). */
export function accountInfo(tokens) {
  const id = decodeJwt(tokens?.id_token) ?? {};
  const access = decodeJwt(tokens?.access_token) ?? {};
  const email = typeof id.email === 'string' ? id.email : typeof access.email === 'string' ? access.email : null;
  const scopes = typeof tokens?.scope === 'string' ? tokens.scope.split(/\s+/) : Array.isArray(access.scp) ? access.scp : typeof access.scope === 'string' ? access.scope.split(/\s+/) : null;
  const plan = scopes ? scopes.includes(CHATGPT_AUTH.planScope) : undefined;
  return { email, plan };
}

/** earliest_refresh_at comes as seconds, milliseconds or an ISO date; returns epoch seconds (0 = none). */
export function parseRefreshAt(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value > 1e11 ? value / 1000 : value;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e11 ? n / 1000 : n;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t / 1000 : 0;
}

// ---- plan-route reshaping ----------------------------------------------------------------------------------------

function itemText(item) {
  if (typeof item?.content === 'string') return item.content;
  if (Array.isArray(item?.content)) return item.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).filter(Boolean).join('\n');
  return '';
}

/**
 * Reshapes a POST /responses body for the ChatGPT plan route: no storage, streamed, system/developer
 * messages become `instructions`, unsupported parameters and hosted tools are dropped, tool_choice only
 * as a string.
 */
export function reshapeForPlanRoute(body) {
  const out = { ...(body ?? {}) };
  for (const k of PLAN_ROUTE_DROPPED_PARAMS) delete out[k];
  out.store = false;
  out.stream = true;
  if (Array.isArray(out.input)) {
    const system = [];
    out.input = out.input.filter((it) => {
      if (it && (it.role === 'system' || it.role === 'developer') && (it.type === 'message' || !it.type)) {
        const t = itemText(it);
        if (t) system.push(t);
        return false;
      }
      return true;
    });
    if (system.length) out.instructions = [typeof out.instructions === 'string' ? out.instructions : '', ...system].filter(Boolean).join('\n\n');
  }
  if (Array.isArray(out.tools)) out.tools = out.tools.filter((t) => !PLAN_ROUTE_DROPPED_TOOLS.has(t?.type));
  if (out.tool_choice && typeof out.tool_choice === 'object') delete out.tool_choice;
  return out;
}

// ---- SSE aggregation -------------------------------------------------------------------------------------------------

/** Folds the SSE text of a streamed Responses API call into the `response` of response.completed. */
export function aggregateSse(text) {
  let completed = null;
  let failed = null;
  let deltaText = '';
  for (const block of String(text ?? '').split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
    if (!data || data === '[DONE]') continue;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    if (ev.type === 'response.completed' || ev.type === 'response.incomplete') completed = ev.response ?? completed;
    else if (ev.type === 'response.failed') failed = ev.response?.error ?? ev.error ?? { message: 'The response failed' };
    else if (ev.type === 'error') failed = ev.error ?? ev;
    else if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') deltaText += ev.delta;
  }
  if (failed) throw toAiError(0, { error: failed });
  if (completed) return completed;
  return { object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: deltaText }] }], partial: true };
}

export const looksLikeSse = (text) => /^(data|event|id|retry):/m.test(String(text ?? '').slice(0, 2000));

// ---- error translation --------------------------------------------------------------------------------------------------

/** Turns a provider error body into { message, code, status }; subscription_sharing_* codes get a hint. */
export function translateError(status, body) {
  const e = body && typeof body === 'object' ? (body.error && typeof body.error === 'object' ? body.error : body) : null;
  let code = null;
  if (e) {
    for (const k of ['code', 'error', 'type', 'status', 'reason']) {
      if (typeof e[k] === 'string' && e[k]) {
        code = e[k];
        break;
      }
    }
  } else if (typeof body?.error === 'string') code = body.error;
  const raw = (e && (e.message || e.error_description)) || (typeof body === 'string' ? body : '') || (typeof body?.error_description === 'string' ? body.error_description : '');
  let message = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  const s = Number(status) || 0;
  if (code && SUBSCRIPTION_HINTS[code]) message = SUBSCRIPTION_HINTS[code];
  else if (!message) {
    if (s === 401) message = 'The provider rejected the credentials (sign in again or check the API key)';
    else if (s === 403) message = 'The provider refused this request';
    else if (s === 404) message = 'The model or endpoint was not found';
    else if (s === 429) message = 'Too many requests or the quota is exhausted; try again later';
    else if (s >= 500) message = 'The provider is having trouble; try again later';
    else message = s ? `Request failed (${s})` : 'Request failed';
  }
  if (!code && s === 429) code = 'rate_limited';
  return { message, code, status: s };
}

export const toAiError = (status, body) => {
  const t = translateError(status, body);
  return new AiError(t.message, { code: t.code, status: t.status });
};

// ---- model catalogs --------------------------------------------------------------------------------------------------------

export function openaiModelKind(id) {
  const s = String(id).toLowerCase();
  if (/image|dall-e/.test(s)) return 'image';
  if (/embed|tts|whisper|transcri|audio|realtime|moderation|search|babbage|davinci|instruct|computer-use|sora|codex-mini/.test(s)) return 'other';
  if (/^(gpt|o\d|chatgpt)/.test(s)) return 'chat';
  return 'other';
}

export function geminiModelKind(model) {
  const name = String(model?.name ?? '').replace(/^models\//, '').toLowerCase();
  const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
  if (/image|imagen/.test(name)) return 'image';
  if (methods.includes('generateContent')) return /embedding|aqa|tts|audio|veo|live/.test(name) ? 'other' : 'chat';
  return 'other';
}

/**
 * Normalises a catalog answer into [{ id, kind, label }]. OpenAI API keys answer { data: [{ id }] }, the
 * ChatGPT plan route { models: [{ slug }] }, Gemini { models: [{ name: 'models/x', supportedGenerationMethods }] }.
 */
export function parseModelCatalog(provider, body) {
  const out = [];
  const seen = new Set();
  const push = (id, kind, label) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(label && label !== id ? { id, kind, label } : { id, kind });
  };
  if (provider === 'gemini') {
    for (const m of Array.isArray(body?.models) ? body.models : []) {
      const id = String(m?.name ?? '').replace(/^models\//, '');
      push(id, geminiModelKind(m), typeof m?.displayName === 'string' ? m.displayName : undefined);
    }
  } else {
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    for (const m of list) {
      const id = typeof m === 'string' ? m : m?.id ?? m?.slug;
      if (typeof id !== 'string') continue;
      push(id, openaiModelKind(id), typeof m?.display_name === 'string' ? m.display_name : typeof m?.title === 'string' ? m.title : undefined);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- callback page -----------------------------------------------------------------------------------------------------------

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function callbackPage({ ok, reason = '' }) {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  const body = ok ? 'Pigment is now connected to your ChatGPT account.' : `Pigment could not finish the sign-in${reason ? `: ${escapeHtml(reason)}` : ''}.`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pigment — ${title}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f6;color:#1e1e24;display:grid;place-items:center;height:100vh;margin:0}main{background:#fff;border:1px solid #d9d9e0;border-radius:12px;padding:32px 40px;max-width:460px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:6px 0;color:#5f6270}</style></head><body><main><h1>${title}</h1><p>${body}</p><p><strong>You can return to Pigment.</strong></p></main></body></html>`;
}

// ---- createAi ---------------------------------------------------------------------------------------------------------------

const clampTimeout = (ms) => Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(ms) || DEFAULT_TIMEOUT_MS));
const assertProvider = (p) => {
  if (p !== 'openai' && p !== 'gemini') throw new AiError('Unknown AI provider', { code: 'bad_request' });
  return p;
};
const notConnected = (provider) => new AiError(`${PROVIDER_NAMES[provider]} is not connected. Open AI › AI Accounts… to sign in or add an API key.`, { code: 'not_connected' });

/**
 * @param {object} ctx
 * @param {typeof import('electron')} ctx.electron   app (userData path), safeStorage, shell
 * @param {() => import('electron').BrowserWindow | null} [ctx.getWindow]
 * @param {{ get(): any, patch(p: object): Promise<any> }} ctx.settings   aiHostId lives here
 * @param {typeof fetch} [ctx.fetch]       test seam
 * @param {() => number} [ctx.now]         test seam (ms)
 * @param {string} [ctx.userDataDir]       overrides electron.app.getPath('userData')
 */
export function createAi({ electron, getWindow, settings, fetch: fetchImpl = globalThis.fetch, now = Date.now, userDataDir } = {}) {
  const safeStorage = electron?.safeStorage ?? null;
  const dataDir = () => userDataDir ?? electron?.app?.getPath?.('userData') ?? process.cwd();
  const credentialsPath = () => join(dataDir(), 'ai-credentials.json');

  let creds = null;
  const modelCache = new Map(); // `${provider}:${method}` -> { at, list }
  let pending = null; // the sign-in in progress
  let refreshing = null; // single-flight token refresh

  // ---- credential store ----------------------------------------------------------------------------------------
  const encryptionAvailable = () => {
    try {
      return !!safeStorage?.isEncryptionAvailable?.();
    } catch {
      return false;
    }
  };
  const seal = (value) => {
    if (encryptionAvailable()) return `enc:${safeStorage.encryptString(String(value)).toString('base64')}`;
    return `plain:${value}`;
  };
  const unseal = (value) => {
    if (typeof value !== 'string') return null;
    if (value.startsWith('plain:')) return value.slice(6) || null;
    if (!value.startsWith('enc:')) return null;
    if (!encryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64')) || null;
    } catch {
      return null; // the OS key changed: the value is lost, the account shows as disconnected
    }
  };

  async function load() {
    if (creds) return creds;
    try {
      const parsed = JSON.parse(await fs.readFile(credentialsPath(), 'utf8'));
      creds = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      creds = {};
    }
    return creds;
  }

  async function save() {
    const path = credentialsPath();
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify({ version: 1, ...creds }, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, path);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new AiError(`Could not save the AI credentials: ${err.message}`, { code: 'storage' });
    }
  }

  async function status() {
    const c = await load();
    const out = { available: true, encryption: encryptionAvailable(), openai: { method: null }, gemini: { method: null } };
    const o = c.openai;
    if (o?.method === 'api_key' && unseal(o.key)) out.openai = { method: 'api_key' };
    else if (o?.method === 'chatgpt' && (unseal(o.refreshToken) || unseal(o.accessToken))) {
      out.openai = { method: 'chatgpt' };
      if (typeof o.email === 'string' && o.email) out.openai.email = o.email;
      if (typeof o.plan === 'boolean') out.openai.plan = o.plan;
    }
    if (c.gemini?.method === 'api_key' && unseal(c.gemini.key)) out.gemini = { method: 'api_key' };
    if (pending) out.signInPending = true;
    return out;
  }

  // ---- HTTP ----------------------------------------------------------------------------------------------------------
  async function httpFetch(url, init, timeoutMs, who) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), clampTimeout(timeoutMs));
    try {
      const res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      return { res, text };
    } catch (err) {
      if (err?.name === 'AbortError') throw new AiError(`The ${who} request timed out`, { code: 'timeout' });
      throw new AiError(`Could not reach ${who}: ${err?.message ?? err}`, { code: 'network' });
    } finally {
      clearTimeout(timer);
    }
  }

  const parseJson = (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };

  /** One provider call with explicit credentials; resolves { status, body } or throws an AiError. */
  async function providerCall({ provider, path, method = 'POST', json, multipart, stream = false, timeoutMs, auth }) {
    const url = `${BASES[provider]}${path}`;
    const headers = { Accept: 'application/json, text/event-stream' };
    if (auth.kind === 'bearer') headers.Authorization = `Bearer ${auth.token}`;
    else headers['x-goog-api-key'] = auth.key;
    let body;
    if (multipart) {
      const form = new FormData();
      for (const [k, v] of Object.entries(multipart.fields ?? {})) form.append(k, String(v));
      for (const f of multipart.files ?? []) {
        if (!f || typeof f.field !== 'string' || typeof f.base64 !== 'string') continue;
        form.append(f.field, new Blob([Buffer.from(f.base64, 'base64')], { type: typeof f.type === 'string' ? f.type : 'application/octet-stream' }), typeof f.name === 'string' ? f.name : 'file');
      }
      body = form;
    } else if (json !== undefined && json !== null) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(stream ? { ...json, stream: true } : json);
    }
    const { res, text } = await httpFetch(url, { method, headers, body }, timeoutMs, PROVIDER_NAMES[provider]);
    const isSse = /text\/event-stream/i.test(res.headers?.get?.('content-type') ?? '') || (stream && looksLikeSse(text));
    if (!res.ok) throw toAiError(res.status, isSse ? sseError(text) : parseJson(text));
    const parsed = isSse ? aggregateSse(text) : parseJson(text);
    return { status: res.status, body: parsed };
  }

  /** The error body of a failed stream (the provider answers an error event or a plain JSON error). */
  function sseError(text) {
    try {
      aggregateSse(text);
    } catch (err) {
      return { error: { message: err.message, code: err.code } };
    }
    return parseJson(text);
  }

  // ---- ChatGPT tokens -----------------------------------------------------------------------------------------------
  async function tokenRequest(params, who) {
    const form = new URLSearchParams(params);
    const { res, text } = await httpFetch(CHATGPT_AUTH.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() }, 30_000, who);
    const body = parseJson(text);
    if (!res.ok) {
      const t = translateError(res.status, body);
      throw new AiError(t.message, { code: t.code ?? 'token_error', status: res.status });
    }
    if (!body || typeof body.access_token !== 'string') throw new AiError('The token endpoint answered without an access token', { code: 'token_error', status: res.status });
    return body;
  }

  function storeTokens(prev, tokens, { clientId, nonce }) {
    const idClaims = tokens.id_token ? validateIdToken(tokens.id_token, { clientId, nonce, now: now() / 1000 }) : null;
    const info = accountInfo(tokens);
    const expiresIn = Number(tokens.expires_in);
    const nowS = now() / 1000;
    return {
      method: 'chatgpt',
      clientId,
      accessToken: seal(tokens.access_token),
      refreshToken: tokens.refresh_token ? seal(tokens.refresh_token) : prev?.refreshToken ?? null,
      idToken: tokens.id_token ? seal(tokens.id_token) : prev?.idToken ?? null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? nowS + expiresIn : nowS + 3600,
      earliestRefreshAt: parseRefreshAt(tokens.earliest_refresh_at),
      email: info.email ?? (typeof idClaims?.email === 'string' ? idClaims.email : prev?.email ?? null),
      plan: typeof info.plan === 'boolean' ? info.plan : prev?.plan,
      signedInAt: prev?.signedInAt ?? nowS,
    };
  }

  async function clearOpenAi() {
    const c = await load();
    delete c.openai;
    modelCache.delete('openai:chatgpt');
    modelCache.delete('openai:api_key');
    await save();
  }

  async function refreshTokens() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const c = await load();
      const o = c.openai;
      if (o?.method !== 'chatgpt') throw notConnected('openai');
      const refreshToken = unseal(o.refreshToken);
      if (!refreshToken) {
        await clearOpenAi();
        throw new AiError('Your ChatGPT sign-in is no longer usable. Sign in again.', { code: 'signed_out' });
      }
      let tokens;
      try {
        tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: o.clientId, resource: CHATGPT_AUTH.resource }, 'ChatGPT');
      } catch (err) {
        if (FATAL_TOKEN_ERRORS.has(err.code)) {
          await clearOpenAi();
          throw new AiError('Your ChatGPT sign-in has expired. Sign in again.', { code: err.code, status: err.status });
        }
        throw err;
      }
      // a refreshed ID token has no nonce to check; issuer, audience and expiry still apply
      c.openai = storeTokens(o, tokens, { clientId: o.clientId, nonce: null });
      await save();
      return unseal(c.openai.accessToken);
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** A usable ChatGPT access token, refreshing 5 minutes before expiry (never before earliest_refresh_at). */
  async function accessToken({ force = false } = {}) {
    const c = await load();
    const o = c.openai;
    if (o?.method !== 'chatgpt') throw notConnected('openai');
    const token = unseal(o.accessToken);
    const nowS = now() / 1000;
    const expiresAt = Number(o.expiresAt) || 0;
    const earliest = Number(o.earliestRefreshAt) || 0;
    const stale = nowS >= expiresAt - CHATGPT_AUTH.refreshLeadMs / 1000;
    const allowed = nowS >= earliest;
    if (token && !force) {
      if (!stale) return token;
      // earliest_refresh_at not reached yet: the current token still works until it expires
      if (!allowed && nowS < expiresAt) return token;
    }
    return refreshTokens();
  }

  // ---- sign-in flow ------------------------------------------------------------------------------------------------------
  async function hostId() {
    const current = settings?.get?.()?.aiHostId;
    if (typeof current === 'string' && current.startsWith('urn:uuid:')) return current;
    const id = newHostId();
    try {
      await settings?.patch?.({ aiHostId: id });
    } catch (err) {
      console.warn('ai: could not persist the host id', err?.message);
    }
    return id;
  }

  function listenLoopback(ports, onRequest) {
    const tryPort = (i) =>
      new Promise((resolve, reject) => {
        if (i >= ports.length) return reject(new AiError(`Ports ${ports[0]}–${ports[ports.length - 1]} are all in use; close the program using them or paste the callback address manually`, { code: 'port_in_use' }));
        const server = createServer(onRequest);
        server.once('error', (err) => {
          if (err?.code === 'EADDRINUSE' || err?.code === 'EACCES') resolve(tryPort(i + 1));
          else reject(new AiError(`Could not start the sign-in listener: ${err.message}`, { code: 'listener' }));
        });
        server.listen(ports[i], '127.0.0.1', () => resolve({ server, port: ports[i] }));
      });
    return tryPort(0);
  }

  function finishPending(err, value) {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    try {
      p.server?.close();
    } catch {
      /* ignore */
    }
    if (err) p.reject(err);
    else p.resolve(value);
  }

  /** Exchanges the code of a callback (loopback or pasted) and stores the sign-in. */
  async function completeSignIn(parsed) {
    const p = pending;
    if (!p) throw new AiError('No sign-in is in progress', { code: 'no_sign_in' });
    if (parsed.error) throw new AiError(parsed.errorDescription || `Sign-in refused (${parsed.error})`, { code: parsed.error });
    if (parsed.state !== p.state) throw new AiError('The callback belongs to another sign-in attempt; start again', { code: 'state_mismatch' });
    if (p.exchanging) return p.exchanging;
    p.exchanging = (async () => {
      const clientId = parsed.clientId || CHATGPT_AUTH.dynamicClientId;
      const tokens = await tokenRequest({ grant_type: 'authorization_code', code: parsed.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, client_id: clientId, resource: CHATGPT_AUTH.resource }, 'ChatGPT');
      const c = await load();
      c.openai = storeTokens(null, tokens, { clientId, nonce: p.nonce });
      modelCache.delete('openai:chatgpt');
      await save();
      const s = await status();
      finishPending(null, s);
      return s;
    })();
    try {
      return await p.exchanging;
    } catch (err) {
      p.exchanging = null;
      throw err;
    }
  }

  async function chatgptSignIn({ port } = {}) {
    if (pending) return pending.promise;
    const preferred = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
    const ports = preferred ? [preferred, ...CHATGPT_AUTH.ports.filter((p) => p !== preferred)] : CHATGPT_AUTH.ports;
    const pkce = createPkce();
    const state = randomToken();
    const nonce = randomToken();
    const entry = { state, nonce, verifier: pkce.verifier, server: null, redirectUri: null, url: null, timer: null, exchanging: null };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    entry.promise.catch(() => {}); // the caller gets the rejection; nothing else must crash on it
    pending = entry;
    try {
      const onRequest = (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname !== CHATGPT_AUTH.callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        let parsed;
        try {
          parsed = parseCallback(url.toString());
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage({ ok: false, reason: err.message }));
          return;
        }
        completeSignIn(parsed).then(
          () => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(callbackPage({ ok: true })),
          (err) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(callbackPage({ ok: false, reason: err.message }));
            // a wrong state may be a stray request; the real callback can still arrive
            if (err.code !== 'state_mismatch') finishPending(err);
          }
        );
      };
      const { server, port: boundPort } = await listenLoopback(ports, onRequest);
      entry.server = server;
      entry.redirectUri = redirectUriFor(boundPort);
      entry.url = buildAuthorizeUrl({ redirectUri: entry.redirectUri, state, nonce, codeChallenge: pkce.challenge, hostId: await hostId() });
      entry.timer = setTimeout(() => finishPending(new AiError('The sign-in timed out after 5 minutes; try again', { code: 'timeout' })), CHATGPT_AUTH.signInTimeoutMs);
      try {
        await electron?.shell?.openExternal?.(entry.url);
      } catch (err) {
        console.warn('ai: could not open the browser', err?.message);
      }
    } catch (err) {
      finishPending(err instanceof AiError ? err : new AiError(err?.message ?? String(err), { code: 'sign_in' }));
    }
    return entry.promise;
  }

  const chatgptSignInStatus = async () => (pending ? { pending: true, url: pending.url ?? undefined } : { pending: false });

  async function chatgptSignInManual({ callbackUrl } = {}) {
    if (!pending) throw new AiError('Start "Sign in with ChatGPT" first, then paste the address the browser landed on', { code: 'no_sign_in' });
    const parsed = parseCallback(callbackUrl);
    try {
      return await completeSignIn(parsed);
    } catch (err) {
      if (err.code !== 'state_mismatch') finishPending(err);
      throw err;
    }
  }

  async function chatgptSignInCancel() {
    finishPending(new AiError('Sign-in cancelled', { code: 'cancelled' }));
    return null;
  }

  // ---- keys ---------------------------------------------------------------------------------------------------------------
  async function setApiKey({ provider, key } = {}) {
    assertProvider(provider);
    const k = typeof key === 'string' ? key.trim() : '';
    if (!k) throw new AiError('Enter an API key', { code: 'bad_request' });
    if (/\s/.test(k)) throw new AiError('An API key contains no spaces; check what you pasted', { code: 'bad_request' });
    const auth = provider === 'openai' ? { kind: 'bearer', token: k } : { kind: 'goog', key: k };
    // validate first: a models request is free and fails fast on a bad key
    const r = await providerCall({ provider, path: provider === 'openai' ? '/models' : '/models?pageSize=200', method: 'GET', timeoutMs: 30_000, auth });
    const c = await load();
    if (provider === 'openai' && c.openai?.method === 'chatgpt') finishPending(new AiError('Sign-in cancelled', { code: 'cancelled' }));
    c[provider] = { method: 'api_key', key: seal(k), addedAt: now() / 1000 };
    modelCache.set(`${provider}:api_key`, { at: now(), list: parseModelCatalog(provider, r.body) });
    await save();
    return status();
  }

  async function signOut({ provider } = {}) {
    assertProvider(provider);
    const c = await load();
    if (provider === 'openai') finishPending(new AiError('Sign-in cancelled', { code: 'cancelled' }));
    delete c[provider];
    modelCache.delete(`${provider}:api_key`);
    modelCache.delete(`${provider}:chatgpt`);
    await save();
    return status();
  }

  // ---- requests ----------------------------------------------------------------------------------------------------------
  function validateRequest(payload) {
    if (!payload || typeof payload !== 'object') throw new AiError('Bad request', { code: 'bad_request' });
    const provider = assertProvider(payload.provider);
    const path = typeof payload.path === 'string' && payload.path.startsWith('/') && !payload.path.startsWith('//') ? payload.path : null;
    if (!path) throw new AiError('The request path must start with /', { code: 'bad_request' });
    const method = payload.method === 'GET' ? 'GET' : payload.method === 'POST' || payload.method === undefined ? 'POST' : null;
    if (!method) throw new AiError('Only GET and POST requests are allowed', { code: 'bad_request' });
    const json = payload.json && typeof payload.json === 'object' ? payload.json : undefined;
    const multipart = payload.multipart && typeof payload.multipart === 'object' ? payload.multipart : undefined;
    return { provider, path, method, json, multipart, stream: !!payload.stream, timeoutMs: payload.timeoutMs };
  }

  async function request(payload) {
    const req = validateRequest(payload);
    const c = await load();
    if (req.provider === 'gemini') {
      const key = c.gemini?.method === 'api_key' ? unseal(c.gemini.key) : null;
      if (!key) throw notConnected('gemini');
      return providerCall({ ...req, auth: { kind: 'goog', key } });
    }
    const o = c.openai;
    if (o?.method === 'api_key') {
      const key = unseal(o.key);
      if (!key) throw notConnected('openai');
      return providerCall({ ...req, auth: { kind: 'bearer', token: key } });
    }
    if (o?.method !== 'chatgpt') throw notConnected('openai');
    // the plan route: the same endpoints with the ChatGPT access token; /responses bodies are reshaped
    const planRoute = req.method === 'POST' && /^\/responses(?:[?#]|$)/.test(req.path) && req.json;
    const shaped = planRoute ? { ...req, json: reshapeForPlanRoute(req.json), stream: true } : req;
    let token = await accessToken();
    try {
      return await providerCall({ ...shaped, auth: { kind: 'bearer', token } });
    } catch (err) {
      if (err.status !== 401) throw err;
      // an access token revoked early: refresh once and retry, then give up
      token = await accessToken({ force: true });
      return providerCall({ ...shaped, auth: { kind: 'bearer', token } });
    }
  }

  async function models({ provider } = {}) {
    assertProvider(provider);
    const c = await load();
    const method = c[provider]?.method ?? null;
    if (!method) throw notConnected(provider);
    const key = `${provider}:${method}`;
    const cached = modelCache.get(key);
    if (cached && now() - cached.at < MODEL_CACHE_MS) return cached.list;
    const r = await request({ provider, path: provider === 'openai' ? '/models' : '/models?pageSize=200', method: 'GET', timeoutMs: 30_000 });
    const list = parseModelCatalog(provider, r.body);
    modelCache.set(key, { at: now(), list });
    return list;
  }

  const handlers = { status, setApiKey, signOut, chatgptSignIn, chatgptSignInStatus, chatgptSignInManual, chatgptSignInCancel, models, request };

  return {
    async dispatch(method, payload = {}) {
      const fn = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : null;
      if (!fn) throw serializeAiError(new AiError(`Unknown AI method ${String(method)}`, { code: 'bad_request' }));
      try {
        return await fn(payload && typeof payload === 'object' ? payload : {});
      } catch (err) {
        // no secrets ever appear in messages; the code rides in the message across IPC
        throw serializeAiError(err instanceof AiError ? err : new AiError(err?.message ?? String(err), { code: err?.code ?? 'internal' }));
      }
    },
    // test seams
    _internal: { status, accessToken, load: () => load(), credentialsPath },
  };
}
