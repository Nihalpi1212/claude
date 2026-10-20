// Pure parts of src/main/ai.js (the module loads without Electron) and createAi with a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CHATGPT_AUTH, AI_ERROR_SEPARATOR, FATAL_TOKEN_ERRORS,
  createPkce, pkceChallenge, buildAuthorizeUrl, redirectUriFor, parseCallback, decodeJwt, validateIdToken, accountInfo, parseRefreshAt,
  reshapeForPlanRoute, aggregateSse, translateError, parseModelCatalog, openaiModelKind, geminiModelKind, serializeAiError, callbackPage, createAi, AiError,
} from '../../src/main/ai.js';

const b64url = (s) => Buffer.from(typeof s === 'string' ? s : JSON.stringify(s)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fakeJwt = (claims) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}.sig`;

test('PKCE: S256 challenge of the verifier, URL-safe and unpadded', () => {
  const { verifier, challenge, method } = createPkce();
  assert.equal(method, 'S256');
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(challenge, pkceChallenge(verifier));
  assert.equal(pkceChallenge('abc'), createHash('sha256').update('abc').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  assert.notEqual(createPkce().verifier, verifier);
});

test('authorize URL carries the open flow parameters, the dynamic client and the host id', () => {
  const url = new URL(buildAuthorizeUrl({ redirectUri: redirectUriFor(1455), state: 'st', nonce: 'nn', codeChallenge: 'ch', hostId: 'urn:uuid:1234' }));
  assert.equal(url.origin + url.pathname, CHATGPT_AUTH.authorizeUrl);
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('client_id'), 'dynamic_agent_client');
  assert.equal(p.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(p.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(p.get('resource'), 'https://api.openai.com/v1');
  assert.equal(p.get('state'), 'st');
  assert.equal(p.get('nonce'), 'nn');
  assert.equal(p.get('code_challenge'), 'ch');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('agent_name_hint'), 'Pigment');
  assert.equal(p.get('ext_agent_host_id'), 'urn:uuid:1234');
  // an issued client id needs no registration hints
  const issued = new URL(buildAuthorizeUrl({ clientId: 'oaiapp_x', redirectUri: redirectUriFor(1456), state: 's', nonce: 'n', codeChallenge: 'c', hostId: 'urn:uuid:1' }));
  assert.equal(issued.searchParams.get('client_id'), 'oaiapp_x');
  assert.equal(issued.searchParams.get('agent_name_hint'), null);
  assert.equal(issued.searchParams.get('redirect_uri'), 'http://127.0.0.1:1456/auth/callback');
});

test('callback parsing accepts a URL, a path or a bare query and reads the issued client id', () => {
  const full = parseCallback('http://127.0.0.1:1455/auth/callback?code=abc&state=xyz&client_id=oaiapp_123');
  assert.deepEqual(full, { code: 'abc', state: 'xyz', clientId: 'oaiapp_123', error: null, errorDescription: null });
  assert.equal(parseCallback('/auth/callback?code=c&state=s').clientId, null);
  assert.equal(parseCallback('code=c&state=s').code, 'c');
  assert.equal(parseCallback('?error=access_denied&error_description=No+thanks').errorDescription, 'No thanks');
  assert.throws(() => parseCallback('http://127.0.0.1:1455/auth/callback'), /authorization code/);
  assert.throws(() => parseCallback(''), /Paste/);
});

test('ID token claims: issuer, audience, expiry and nonce are checked', () => {
  const now = 1_800_000_000;
  const good = { iss: 'https://auth.openai.com', aud: ['oaiapp_1', 'other'], exp: now + 600, nonce: 'n1', email: 'me@example.com' };
  assert.equal(validateIdToken(fakeJwt(good), { clientId: 'oaiapp_1', nonce: 'n1', now }).email, 'me@example.com');
  assert.equal(validateIdToken(fakeJwt({ ...good, aud: 'oaiapp_1' }), { clientId: 'oaiapp_1', nonce: null, now }).iss, 'https://auth.openai.com');
  assert.throws(() => validateIdToken(fakeJwt({ ...good, iss: 'https://evil.example' }), { clientId: 'oaiapp_1', nonce: 'n1', now }), /auth\.openai\.com/);
  assert.throws(() => validateIdToken(fakeJwt(good), { clientId: 'oaiapp_2', nonce: 'n1', now }), /another application/);
  assert.throws(() => validateIdToken(fakeJwt({ ...good, exp: now - 1 }), { clientId: 'oaiapp_1', nonce: 'n1', now }), /expired/);
  assert.throws(() => validateIdToken(fakeJwt(good), { clientId: 'oaiapp_1', nonce: 'n2', now }), /match this sign-in/);
  assert.throws(() => validateIdToken('not-a-jwt', { clientId: 'oaiapp_1', now }), /ID token/);
  assert.equal(decodeJwt('a.b'), null);
  const info = accountInfo({ id_token: fakeJwt(good), access_token: 'x', scope: 'openid chatgpt.tokens.use.direct' });
  assert.deepEqual(info, { email: 'me@example.com', plan: true });
  assert.equal(accountInfo({ id_token: fakeJwt(good), scope: 'openid' }).plan, false);
  assert.equal(accountInfo({ access_token: fakeJwt({ scp: ['chatgpt.tokens.use.direct'] }) }).plan, true);
  assert.equal(parseRefreshAt(1_800_000_000), 1_800_000_000);
  assert.equal(parseRefreshAt(1_800_000_000_000), 1_800_000_000);
  assert.equal(parseRefreshAt('2027-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z') / 1000);
  assert.equal(parseRefreshAt(undefined), 0);
});

test('plan-route reshaping: store false, stream true, instructions from system messages, dropped params and tools', () => {
  const body = {
    model: 'gpt-5',
    temperature: 0.2,
    top_p: 0.9,
    max_output_tokens: 100,
    metadata: { a: 1 },
    user: 'u',
    store: true,
    instructions: 'Be brief.',
    input: [
      { role: 'system', content: 'You are Pigment.' },
      { role: 'developer', content: [{ type: 'input_text', text: 'Tools are undoable.' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
    tools: [{ type: 'function', name: 'f' }, { type: 'web_search' }, { type: 'image_generation' }, { type: 'code_interpreter' }, { type: 'mcp' }],
    tool_choice: { type: 'function', name: 'f' },
  };
  const out = reshapeForPlanRoute(body);
  assert.equal(out.store, false);
  assert.equal(out.stream, true);
  assert.equal(out.instructions, 'Be brief.\n\nYou are Pigment.\n\nTools are undoable.');
  assert.deepEqual(out.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  assert.deepEqual(out.tools.map((t) => t.type), ['function', 'web_search']);
  for (const k of ['temperature', 'top_p', 'max_output_tokens', 'metadata', 'user', 'tool_choice']) assert.equal(k in out, false, k);
  assert.equal(out.model, 'gpt-5');
  // string tool_choice and string input survive; the original body is untouched
  assert.equal(reshapeForPlanRoute({ input: 'hello', tool_choice: 'auto' }).tool_choice, 'auto');
  assert.equal(body.store, true);
});

test('SSE aggregation returns the completed response and raises stream errors', () => {
  const events = [
    { type: 'response.created', response: { id: 'r1' } },
    { type: 'response.output_text.delta', delta: 'Hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.completed', response: { id: 'r1', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello' }] }] } },
  ];
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  const res = aggregateSse(text);
  assert.equal(res.id, 'r1');
  assert.equal(res.output[0].content[0].text, 'Hello');
  // no completed event: the deltas become the message
  const partial = aggregateSse('data: {"type":"response.output_text.delta","delta":"part"}\n\n');
  assert.equal(partial.output[0].content[0].text, 'part');
  assert.equal(partial.partial, true);
  assert.throws(() => aggregateSse('data: {"type":"error","error":{"message":"boom","code":"server_error"}}\n\n'), /boom/);
  assert.throws(() => aggregateSse('data: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"x"}}}\n\n'), /usage limit/);
});

test('error translation: provider bodies, subscription hints and HTTP fallbacks', () => {
  assert.deepEqual(translateError(400, { error: { message: 'Bad prompt', type: 'invalid_request_error', code: null } }), { message: 'Bad prompt', code: 'invalid_request_error', status: 400 });
  assert.deepEqual(translateError(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }), { message: 'You have reached the usage limit of your ChatGPT plan. Try again later or use an OpenAI API key.', code: 'subscription_sharing_usage_limit_exceeded', status: 429 });
  for (const code of ['subscription_sharing_user_not_eligible', 'subscription_sharing_usage_unavailable', 'subscription_sharing_route_not_supported', 'subscription_sharing_unsupported_capability', 'subscription_sharing_invalid_user']) {
    const t = translateError(403, { error: { code } });
    assert.equal(t.code, code);
    assert.ok(t.message.length > 20, code);
  }
  assert.equal(translateError(429, { error: { code: 429, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }).code, 'RESOURCE_EXHAUSTED');
  assert.equal(translateError(401, null).code, null);
  assert.match(translateError(401, null).message, /credentials/);
  assert.match(translateError(500, { raw: '' }).message, /trouble/);
  assert.equal(translateError(429, {}).code, 'rate_limited');
  assert.equal(translateError(400, { error: 'invalid_grant', error_description: 'bad code' }).code, 'invalid_grant');
  assert.equal(translateError(400, { error: 'invalid_grant', error_description: 'bad code' }).message, 'bad code');
  assert.ok(FATAL_TOKEN_ERRORS.has('refresh_token_reused'));
  const e = serializeAiError(new AiError('Nope', { code: 'x', status: 418 }));
  const [msg, tail] = e.message.split(AI_ERROR_SEPARATOR);
  assert.equal(msg, 'Nope');
  assert.deepEqual(JSON.parse(tail), { code: 'x', status: 418 });
});

test('model catalogs: API keys ({ data }), the plan route ({ models[].slug }) and Gemini', () => {
  const api = parseModelCatalog('openai', { data: [{ id: 'gpt-4.1' }, { id: 'gpt-image-1' }, { id: 'text-embedding-3-small' }, { id: 'dall-e-3' }, { id: 'whisper-1' }, { id: 'o3' }] });
  assert.deepEqual(api, [{ id: 'dall-e-3', kind: 'image' }, { id: 'gpt-4.1', kind: 'chat' }, { id: 'gpt-image-1', kind: 'image' }, { id: 'o3', kind: 'chat' }, { id: 'text-embedding-3-small', kind: 'other' }, { id: 'whisper-1', kind: 'other' }]);
  const plan = parseModelCatalog('openai', { models: [{ slug: 'gpt-5.1', title: 'GPT-5.1' }, { slug: 'gpt-5-codex' }] });
  assert.deepEqual(plan, [{ id: 'gpt-5-codex', kind: 'chat' }, { id: 'gpt-5.1', kind: 'chat', label: 'GPT-5.1' }]);
  const gem = parseModelCatalog('gemini', {
    models: [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/imagen-4.0-generate-001', supportedGenerationMethods: ['predict'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    ],
  });
  assert.deepEqual(gem.map((m) => [m.id, m.kind]), [['gemini-2.5-flash-image', 'image'], ['gemini-2.5-flash-preview-tts', 'other'], ['gemini-2.5-pro', 'chat'], ['imagen-4.0-generate-001', 'image'], ['text-embedding-004', 'other']]);
  assert.equal(gem[2].label, 'Gemini 2.5 Pro');
  assert.equal(openaiModelKind('gpt-4o-realtime-preview'), 'other');
  assert.equal(geminiModelKind({ name: 'models/veo-3', supportedGenerationMethods: ['predictLongRunning'] }), 'other');
  assert.deepEqual(parseModelCatalog('openai', null), []);
  assert.match(callbackPage({ ok: true }), /You can return to Pigment/);
  assert.match(callbackPage({ ok: false, reason: '<x>' }), /&lt;x&gt;/);
});

// ---- createAi with a fake fetch ------------------------------------------------------------------------------------

function fakeElectron() {
  return {
    app: { getPath: () => '/unused' },
    shell: { openExternal: async () => {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`sealed:${s}`),
      decryptString: (buf) => buf.toString().replace(/^sealed:/, ''),
    },
  };
}

function fakeSettings(initial = {}) {
  let value = { ...initial };
  return { get: () => value, patch: async (p) => (value = { ...value, ...p }) };
}

const jsonResponse = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('createAi: API keys are validated, sealed on disk, used for requests and listed in status; errors carry codes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigment-ai-'));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://api.openai.com/v1/models') {
      if (init.headers.Authorization !== 'Bearer sk-good') return jsonResponse(401, { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } });
      return jsonResponse(200, { data: [{ id: 'gpt-4.1' }, { id: 'gpt-image-1' }] });
    }
    if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200')) {
      assert.equal(init.headers['x-goog-api-key'], 'AIza-good');
      return jsonResponse(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] });
    }
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, undefined, 'api keys do not force streaming');
      return jsonResponse(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: `echo:${body.input}` }] }] });
    }
    if (url === 'https://api.openai.com/v1/images/edits') {
      assert.ok(init.body instanceof FormData);
      const file = init.body.get('image[]');
      assert.equal(file.name, 'img.png');
      assert.equal(file.type, 'image/png');
      assert.equal(init.body.get('prompt'), 'make it blue');
      return jsonResponse(200, { data: [{ b64_json: 'AAAA' }] });
    }
    return jsonResponse(404, { error: { message: 'nope' } });
  };
  const ai = createAi({ electron: fakeElectron(), settings: fakeSettings(), fetch: fetchImpl, userDataDir: dir });
  try {
    const empty = await ai.dispatch('status');
    assert.deepEqual(empty, { available: true, encryption: true, openai: { method: null }, gemini: { method: null } });
    await assert.rejects(ai.dispatch('setApiKey', { provider: 'openai', key: 'sk-bad' }), (err) => {
      assert.match(err.message, /Incorrect API key/);
      assert.ok(err.message.includes(AI_ERROR_SEPARATOR));
      assert.equal(err.code, 'invalid_api_key');
      return true;
    });
    await assert.rejects(ai.dispatch('request', { provider: 'openai', path: '/responses', json: { input: 'x' } }), /not connected/);
    const s1 = await ai.dispatch('setApiKey', { provider: 'openai', key: ' sk-good ' });
    assert.equal(s1.openai.method, 'api_key');
    const s2 = await ai.dispatch('setApiKey', { provider: 'gemini', key: 'AIza-good' });
    assert.equal(s2.gemini.method, 'api_key');
    const onDisk = JSON.parse(await readFile(join(dir, 'ai-credentials.json'), 'utf8'));
    assert.equal(onDisk.openai.key, `enc:${Buffer.from('sealed:sk-good').toString('base64')}`);
    assert.ok(!JSON.stringify(onDisk).includes('sk-good'), 'the key is never stored in clear');
    const models = await ai.dispatch('models', { provider: 'openai' });
    assert.deepEqual(models, [{ id: 'gpt-4.1', kind: 'chat' }, { id: 'gpt-image-1', kind: 'image' }]);
    const gm = await ai.dispatch('models', { provider: 'gemini' });
    assert.deepEqual(gm, [{ id: 'gemini-2.5-flash', kind: 'chat' }]);
    const r = await ai.dispatch('request', { provider: 'openai', path: '/responses', json: { input: 'hi' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.output[0].content[0].text, 'echo:hi');
    const m = await ai.dispatch('request', { provider: 'openai', path: '/images/edits', multipart: { fields: { prompt: 'make it blue' }, files: [{ field: 'image[]', name: 'img.png', type: 'image/png', base64: Buffer.from('png').toString('base64') }] } });
    assert.equal(m.body.data[0].b64_json, 'AAAA');
    await assert.rejects(ai.dispatch('request', { provider: 'openai', path: 'responses' }), /start with/);
    await assert.rejects(ai.dispatch('request', { provider: 'openai', path: '/x', method: 'DELETE' }), /GET and POST/);
    await assert.rejects(ai.dispatch('nope'), /Unknown AI method/);
    const s3 = await ai.dispatch('signOut', { provider: 'openai' });
    assert.equal(s3.openai.method, null);
    assert.equal(s3.gemini.method, 'api_key');
    // a fresh instance reads the file back and decrypts
    const again = createAi({ electron: fakeElectron(), settings: fakeSettings(), fetch: fetchImpl, userDataDir: dir });
    assert.equal((await again.dispatch('status')).gemini.method, 'api_key');
    assert.ok(!calls.some((c) => JSON.stringify(c.url).includes('sk-good')), 'keys never appear in URLs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createAi: ChatGPT sign-in through the loopback callback, plan-route reshaping, SSE, refresh rotation and fatal errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigment-ai-'));
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const settings = fakeSettings();
  const electron = fakeElectron();
  let opened = null;
  electron.shell.openExternal = async (url) => {
    opened = url;
  };
  const tokenCalls = [];
  let refreshCount = 0;
  let failRefresh = null;
  const idToken = (nonce, aud = 'oaiapp_42') => fakeJwt({ iss: 'https://auth.openai.com', aud, exp: now() / 1000 + 3600, nonce, email: 'me@example.com' });
  const fetchImpl = async (url, init) => {
    if (url === CHATGPT_AUTH.tokenUrl) {
      const form = new URLSearchParams(init.body);
      tokenCalls.push(Object.fromEntries(form));
      if (form.get('grant_type') === 'authorization_code') {
        assert.equal(form.get('code'), 'the-code');
        assert.equal(form.get('client_id'), 'oaiapp_42');
        assert.equal(form.get('resource'), 'https://api.openai.com/v1');
        assert.ok(form.get('code_verifier'));
        return jsonResponse(200, { access_token: 'access-1', refresh_token: 'refresh-1', id_token: idToken(form.get('nonce') ?? expectedNonce), expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', earliest_refresh_at: now() / 1000 + 60 });
      }
      if (form.get('grant_type') === 'refresh_token') {
        refreshCount++;
        if (failRefresh) return jsonResponse(400, { error: failRefresh, error_description: 'gone' });
        assert.equal(form.get('refresh_token'), `refresh-${refreshCount}`);
        return jsonResponse(200, { access_token: `access-${refreshCount + 1}`, refresh_token: `refresh-${refreshCount + 1}`, id_token: idToken(undefined), expires_in: 3600 });
      }
    }
    if (url === 'https://api.openai.com/v1/responses') {
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true);
      assert.equal(body.store, false);
      assert.equal(body.temperature, undefined);
      assert.equal(body.instructions, 'sys');
      const token = init.headers.Authorization.replace('Bearer ', '');
      const ev = { type: 'response.completed', response: { id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: `ok:${token}` }] }] } };
      return jsonResponse(200, `event: response.completed\ndata: ${JSON.stringify(ev)}\n\n`, { 'content-type': 'text/event-stream' });
    }
    if (url === 'https://api.openai.com/v1/models') {
      if (init.headers.Authorization === 'Bearer access-1') return jsonResponse(401, { error: { message: 'expired', code: 'token_expired' } });
      return jsonResponse(200, { models: [{ slug: 'gpt-5.1' }] });
    }
    return jsonResponse(404, { error: { message: `no route ${url}` } });
  };
  let expectedNonce = null;
  const ai = createAi({ electron, settings, fetch: fetchImpl, now, userDataDir: dir });
  try {
    const signIn = ai.dispatch('chatgptSignIn', { port: 18455 });
    await new Promise((r) => setTimeout(r, 50));
    const pendingStatus = await ai.dispatch('chatgptSignInStatus');
    assert.equal(pendingStatus.pending, true);
    assert.equal(pendingStatus.url, opened);
    const auth = new URL(opened);
    assert.equal(auth.searchParams.get('client_id'), 'dynamic_agent_client');
    assert.match(settings.get().aiHostId, /^urn:uuid:/);
    assert.equal(auth.searchParams.get('ext_agent_host_id'), settings.get().aiHostId);
    const redirect = new URL(auth.searchParams.get('redirect_uri'));
    assert.equal(redirect.pathname, '/auth/callback');
    expectedNonce = auth.searchParams.get('nonce');
    // a wrong state is refused and keeps the sign-in open
    const bad = await fetch(`${redirect.origin}/auth/callback?code=x&state=wrong&client_id=oaiapp_42`);
    assert.match(await bad.text(), /another sign-in attempt/);
    assert.equal((await ai.dispatch('chatgptSignInStatus')).pending, true);
    // the real callback: the browser page says to return to Pigment, the dispatch resolves with the status
    const page = await fetch(`${redirect.origin}/auth/callback?code=the-code&state=${auth.searchParams.get('state')}&client_id=oaiapp_42`);
    assert.match(await page.text(), /You can return to Pigment/);
    const s = await signIn;
    assert.deepEqual(s.openai, { method: 'chatgpt', email: 'me@example.com', plan: true });
    assert.equal((await ai.dispatch('chatgptSignInStatus')).pending, false);
    const stored = JSON.parse(await readFile(join(dir, 'ai-credentials.json'), 'utf8')).openai;
    assert.equal(stored.clientId, 'oaiapp_42');
    assert.ok(stored.accessToken.startsWith('enc:') && !JSON.stringify(stored).includes('access-1'));
    // the plan route reshapes /responses and aggregates the stream
    const r = await ai.dispatch('request', { provider: 'openai', path: '/responses', json: { input: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], temperature: 1 } });
    assert.equal(r.body.output[0].content[0].text, 'ok:access-1');
    assert.equal(refreshCount, 0);
    // a 401 refreshes once and retries; tokens rotate
    const models = await ai.dispatch('models', { provider: 'openai' });
    assert.deepEqual(models, [{ id: 'gpt-5.1', kind: 'chat' }]);
    assert.equal(refreshCount, 1);
    assert.equal(tokenCalls[1].grant_type, 'refresh_token');
    assert.equal(tokenCalls[1].client_id, 'oaiapp_42');
    assert.equal(tokenCalls[1].resource, 'https://api.openai.com/v1');
    // 5 minutes before expiry the next request refreshes again (earliest_refresh_at long passed)
    clock += 3600 * 1000 - 200 * 1000;
    const r2 = await ai.dispatch('request', { provider: 'openai', path: '/responses', json: { input: [{ role: 'developer', content: 'sys' }] } });
    assert.equal(r2.body.output[0].content[0].text, 'ok:access-3');
    assert.equal(refreshCount, 2);
    // a fatal refresh error clears the sign-in
    clock += 3600 * 1000;
    failRefresh = 'refresh_token_invalidated';
    await assert.rejects(ai.dispatch('request', { provider: 'openai', path: '/responses', json: { input: 'x' } }), /sign in again/i);
    assert.equal((await ai.dispatch('status')).openai.method, null);
    // manual callback and cancel
    const second = ai.dispatch('chatgptSignIn', { port: 18456 });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(ai.dispatch('chatgptSignInManual', { callbackUrl: 'http://127.0.0.1:1455/auth/callback?code=c&state=nope' }), /another sign-in attempt/);
    await ai.dispatch('chatgptSignInCancel');
    await assert.rejects(second, (err) => err.code === 'cancelled');
    assert.equal((await ai.dispatch('chatgptSignInStatus')).pending, false);
  } finally {
    await ai.dispatch('chatgptSignInCancel').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('createAi: without safeStorage the status warns and values are stored plain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pigment-ai-'));
  const electron = fakeElectron();
  electron.safeStorage.isEncryptionAvailable = () => false;
  const ai = createAi({ electron, settings: fakeSettings(), fetch: async () => jsonResponse(200, { models: [] }), userDataDir: dir });
  try {
    const s = await ai.dispatch('setApiKey', { provider: 'gemini', key: 'AIza-x' });
    assert.equal(s.encryption, false);
    assert.equal(s.gemini.method, 'api_key');
    const onDisk = JSON.parse(await readFile(join(dir, 'ai-credentials.json'), 'utf8'));
    assert.equal(onDisk.gemini.key, 'plain:AIza-x');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
