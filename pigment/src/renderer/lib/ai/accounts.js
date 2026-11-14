// AI accounts (see ARCHITECTURE.md "0.2 features: AI — Accounts"): the AI › AI Accounts… dialog (command
// ai:accounts) with one card per provider — OpenAI through Sign in with ChatGPT or an API key, Google Gemini
// through an API key — connection status, model preferences (settings.ai) and sign-out. Exposes app.ai for
// the feature commands: status(), ensureConnected(kind), providers, prefs. Secrets never reach this module:
// keys are sent to the main process once and only a status object comes back.
import { aiCall } from './client.js';
import { bridge } from '../bridge.js';
import { icon } from '../icons.js';
import * as providers from './providers.js';

const OPENAI_KEYS_URL = 'https://platform.openai.com/api-keys';
const GEMINI_KEYS_URL = 'https://aistudio.google.com/apikey';

export const DEFAULT_AI_PREFS = Object.freeze({ openaiChat: null, openaiImage: null, geminiChat: null, geminiImage: null, defaultProvider: 'openai' });

const EMPTY_STATUS = { available: false, encryption: false, openai: { method: null }, gemini: { method: null } };

/** Whether a provider in this status can serve chat or image requests. ChatGPT plans never run image models. */
export function providerFits(status, provider, kind) {
  const method = status?.[provider]?.method ?? null;
  if (!method) return false;
  if (kind === 'image') return method === 'api_key';
  return true;
}

export function install(app) {
  const modelCache = new Map(); // provider -> Promise<{ chat, image, default }>
  let current = null;

  const ai = {
    providers,
    get current() {
      return current;
    },
    /** The live status from the main process (also emits ai:status when it changed). */
    async status() {
      let s;
      try {
        s = (await aiCall('status')) ?? EMPTY_STATUS;
      } catch (err) {
        console.warn('ai status', err);
        s = EMPTY_STATUS;
      }
      const changed = JSON.stringify(s) !== JSON.stringify(current);
      current = s;
      if (changed) {
        app.emit('ai:status', s);
        app.commands.invalidate();
      }
      return s;
    },
    prefs() {
      return { ...DEFAULT_AI_PREFS, ...(app.settings.ai && typeof app.settings.ai === 'object' ? app.settings.ai : {}) };
    },
    setPrefs(patch) {
      app.saveSettingsSoon({ ai: { ...ai.prefs(), ...patch } });
    },
    fits: (provider, kind, status = current) => providerFits(status, provider, kind),
    /** Models of a connected provider, cached until the accounts change. */
    models(provider, { fresh = false } = {}) {
      if (fresh || !modelCache.has(provider)) {
        const p = providers.listModels(provider).catch((err) => {
          modelCache.delete(provider);
          throw err;
        });
        modelCache.set(provider, p);
      }
      return modelCache.get(provider);
    },
    /** The preferred model for a provider and kind: the saved preference when still listed, else the catalog default. */
    async model(provider, kind) {
      const key = `${provider}${kind === 'image' ? 'Image' : 'Chat'}`;
      const saved = ai.prefs()[key];
      try {
        const list = await ai.models(provider);
        const available = kind === 'image' ? list.image : list.chat;
        if (saved && available.includes(saved)) return saved;
        return list.default[kind === 'image' ? 'image' : 'chat'] ?? saved ?? null;
      } catch {
        return saved ?? null;
      }
    },
    /**
     * The provider to use for a kind of request ('chat' | 'image'), preferring settings.ai.defaultProvider.
     * Opens the accounts dialog when nothing fits and returns null if it still does not.
     */
    async ensureConnected(kind = 'chat') {
      const pick = (s) => {
        const order = [ai.prefs().defaultProvider, 'openai', 'gemini'].filter((p, i, a) => p && a.indexOf(p) === i);
        return order.find((p) => providerFits(s, p, kind)) ?? null;
      };
      let s = await ai.status();
      let provider = pick(s);
      if (provider) return provider;
      await accountsDialog(app, ai, { reason: kind });
      s = await ai.status();
      provider = pick(s);
      return provider;
    },
    openAccounts: () => accountsDialog(app, ai),
    invalidateModels: () => modelCache.clear(),
  };
  app.ai = ai;

  app.commands.registerAll({
    'ai:accounts': { run: () => accountsDialog(app, ai), label: 'AI Accounts…' },
  });
  // the status is fetched once at startup so menus and the assistant know what is connected
  app.on('app:ready', () => {
    ai.status().catch(() => {});
  });
}

// ---- dialog ------------------------------------------------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick, { primary = false, className = '' } = {}) {
  const b = el('button', `btn${primary ? ' primary' : ''}${className ? ` ${className}` : ''}`, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function link(label, url) {
  const a = el('a', 'ai-link', label);
  a.href = url;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    bridge.openExternal(url).catch(() => {});
  });
  return a;
}

function keyField({ placeholder, onConnect, helpUrl, helpLabel }) {
  const wrap = el('div', 'ai-key-row');
  wrap.dataset.noEnter = ''; // Enter connects the key; it must not close the dialog
  const input = el('input', 'input');
  input.type = 'password';
  input.placeholder = placeholder;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', placeholder);
  const connect = button('Connect', () => onConnect(input.value, connect, input), { primary: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      connect.click();
    }
  });
  wrap.append(input, connect);
  const help = el('div', 'ai-help muted');
  help.append(link(helpLabel, helpUrl));
  const box = el('div', 'ai-key');
  box.append(wrap, help);
  return box;
}

async function accountsDialog(app, ai, { reason = null } = {}) {
  const content = el('div', 'ai-accounts');
  let status = await ai.status();
  let closed = false;
  let signInTimer = null;
  const say = (msg, kind = 'error') => app.dialogs.toast(msg, { kind, timeout: kind === 'error' ? 7000 : 2500 });

  const refresh = async () => {
    status = await ai.status();
    if (!closed) render();
  };

  async function connectKey(provider, key, btn, input) {
    if (!key.trim()) {
      input.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      status = await aiCall('setApiKey', { provider, key: key.trim() });
      input.value = '';
      ai.invalidateModels();
      say(`${providers.PROVIDERS[provider].label} connected`, 'success');
      await refresh();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Connect';
      say(err?.message ?? 'The key was not accepted');
    }
  }

  async function signOut(provider) {
    try {
      await aiCall('signOut', { provider });
      ai.invalidateModels();
      await refresh();
    } catch (err) {
      say(err?.message ?? 'Could not sign out');
    }
  }

  async function startChatGpt() {
    if (status.browser) {
      say('Sign in with ChatGPT needs the desktop app; use an API key here');
      return;
    }
    // resolves when the browser comes back (or the user cancels / 5 minutes pass)
    const done = aiCall('chatgptSignIn', {});
    status = { ...status, signInPending: true };
    render();
    try {
      await done;
      ai.invalidateModels();
      say('Signed in with ChatGPT', 'success');
    } catch (err) {
      if (err?.code !== 'cancelled') say(err?.message ?? 'Sign-in failed');
    }
    await refresh();
  }

  function renderPending(card) {
    const box = el('div', 'ai-pending');
    box.append(el('div', 'ai-pending-text', 'Waiting for your browser… finish signing in to ChatGPT there, then come back.'));
    // no free loopback port: the browser cannot come back by itself, the pasted address is the only way
    const warn = el('p', 'ai-warning');
    warn.hidden = true;
    box.append(warn);
    aiCall('chatgptSignInStatus').then((s) => {
      if (!closed && s?.warning) {
        warn.textContent = `${s.warning}.`;
        warn.hidden = false;
      }
    }).catch(() => {});
    const row = el('div', 'ai-row');
    row.append(
      button('Copy link', async () => {
        try {
          const s = await aiCall('chatgptSignInStatus');
          if (!s?.url) return say('The sign-in link is not ready yet');
          bridge.writeClipboardText(s.url);
          say('Link copied; open it in any browser', 'success');
        } catch (err) {
          say(err?.message ?? 'Could not copy the link');
        }
      }),
      button('Cancel', async () => {
        await aiCall('chatgptSignInCancel').catch(() => {});
        await refresh();
      })
    );
    box.append(row);
    const manual = el('div', 'ai-key-row');
    manual.dataset.noEnter = '';
    const input = el('input', 'input');
    input.placeholder = 'Paste the address of the page the browser landed on';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Callback address');
    const use = button('Use', async () => {
      if (!input.value.trim()) return input.focus();
      use.disabled = true;
      try {
        await aiCall('chatgptSignInManual', { callbackUrl: input.value.trim() });
      } catch (err) {
        use.disabled = false;
        say(err?.message ?? 'That address did not work');
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        use.click();
      }
    });
    manual.append(input, use);
    box.append(el('div', 'muted ai-help', 'Browser on another computer? Paste the callback address here:'), manual);
    card.append(box);
    renderPendingPoll();
  }
  /** Polls while a sign-in is pending so a callback finished elsewhere (pasted address, timeout) updates the card. */
  function renderPendingPoll() {
    clearTimeout(signInTimer);
    signInTimer = setTimeout(async () => {
      if (closed) return;
      const s = await aiCall('chatgptSignInStatus').catch(() => null);
      if (s && !s.pending) await refresh();
      else if (!closed && status.signInPending) renderPendingPoll();
    }, 1500);
  }

  function modelSelect(provider, kind, label, { disabledNote = null } = {}) {
    const field = el('div', 'field ai-model');
    const lab = el('label', null, label);
    const select = el('select', 'select');
    select.dataset.ai = `${provider}-${kind}`;
    select.setAttribute('aria-label', `${providers.PROVIDERS[provider].label} ${label}`);
    field.append(lab, select);
    if (disabledNote) {
      select.disabled = true;
      select.append(new Option(disabledNote, ''));
      return field;
    }
    select.append(new Option('Loading…', ''));
    select.disabled = true;
    const prefKey = `${provider}${kind === 'image' ? 'Image' : 'Chat'}`;
    ai.models(provider).then(
      (list) => {
        if (closed) return;
        const ids = kind === 'image' ? list.image : list.chat;
        const saved = ai.prefs()[prefKey];
        const chosen = saved && ids.includes(saved) ? saved : list.default[kind];
        select.replaceChildren();
        if (!ids.length) {
          select.append(new Option(`No ${kind} models available`, ''));
          return;
        }
        for (const id of ids) select.append(new Option(id, id, false, id === chosen));
        select.disabled = false;
        select.addEventListener('change', () => ai.setPrefs({ [prefKey]: select.value || null }));
      },
      (err) => {
        if (closed) return;
        select.replaceChildren(new Option(`Could not list models: ${err?.message ?? err}`, ''));
      }
    );
    return field;
  }

  function card(provider) {
    const s = status[provider] ?? { method: null };
    const info = providers.PROVIDERS[provider];
    const c = el('section', `ai-card ai-card-${provider}`);
    c.dataset.provider = provider;
    const head = el('header', 'ai-card-head');
    const title = el('h3', null, info.label);
    const badge = el('span', `ai-badge${s.method ? ' connected' : ''}`);
    badge.innerHTML = s.method ? icon('check') : '';
    const state = el('span', 'ai-state');
    if (!s.method) state.textContent = 'Not connected';
    else if (s.method === 'chatgpt') state.textContent = `Signed in with ChatGPT${s.email ? ` · ${s.email}` : ''}${s.plan === false ? ' · plan access not granted' : ''}`;
    else state.textContent = `Connected with an API key${status.browser ? ' (kept in this browser)' : ''}`;
    badge.append(state);
    head.append(title, badge);
    c.append(head);

    if (provider === 'openai') {
      if (status.signInPending) renderPending(c);
      else if (!s.method) {
        const signin = button('Sign in with ChatGPT', startChatGpt, { primary: true, className: 'ai-chatgpt' });
        signin.disabled = !!status.browser;
        const row = el('div', 'ai-row');
        row.append(signin, el('span', 'muted', status.browser ? 'Desktop app only' : 'Uses your ChatGPT Plus or Pro plan for chat models'));
        c.append(row, el('div', 'ai-or', 'or'), el('div', 'ai-sub', 'Use an API key'), keyField({ placeholder: 'sk-…', helpUrl: OPENAI_KEYS_URL, helpLabel: 'Get a key at platform.openai.com', onConnect: (k, b, i) => connectKey('openai', k, b, i) }));
        c.append(el('p', 'muted ai-help', 'Image models (generative fill, generate image, remove background) need an API key; a ChatGPT plan covers chat and the assistant.'));
      } else {
        const models = el('div', 'ai-models');
        models.append(modelSelect('openai', 'chat', 'Chat model'), modelSelect('openai', 'image', 'Image model', s.method === 'chatgpt' ? { disabledNote: 'Needs an API key' } : {}));
        c.append(models);
        const row = el('div', 'ai-row');
        row.append(button('Sign out', () => signOut('openai')));
        if (s.method === 'chatgpt') row.append(el('span', 'muted', 'Add an API key after signing out to use image models.'));
        c.append(row);
      }
    } else {
      c.append(el('p', 'muted ai-help', 'Google offers no plan-based sign-in for third-party apps, so Gemini always uses an API key from Google AI Studio.'));
      if (!s.method) c.append(keyField({ placeholder: 'AIza…', helpUrl: GEMINI_KEYS_URL, helpLabel: 'Get a key at aistudio.google.com', onConnect: (k, b, i) => connectKey('gemini', k, b, i) }));
      else {
        const models = el('div', 'ai-models');
        models.append(modelSelect('gemini', 'chat', 'Chat model'), modelSelect('gemini', 'image', 'Image model'));
        const row = el('div', 'ai-row');
        row.append(button('Sign out', () => signOut('gemini')));
        c.append(models, row);
      }
    }
    return c;
  }

  function render() {
    clearTimeout(signInTimer);
    content.replaceChildren();
    if (reason) {
      const why = el('p', 'ai-reason');
      why.textContent = reason === 'image' ? 'This feature needs an image model: connect OpenAI or Gemini with an API key.' : 'This feature needs an AI provider: sign in or add an API key.';
      content.append(why);
    }
    if (!status.available) content.append(el('p', 'ai-warning', 'AI is not available in this build.'));
    content.append(card('openai'), card('gemini'));
    const foot = el('div', 'ai-foot');
    const def = el('div', 'field ai-default');
    const lab = el('label', null, 'Preferred provider');
    const select = el('select', 'select');
    select.dataset.ai = 'default-provider';
    select.append(new Option('OpenAI', 'openai'), new Option('Google Gemini', 'gemini'));
    select.value = ai.prefs().defaultProvider === 'gemini' ? 'gemini' : 'openai';
    // the preferred provider is what every feature starts from: the per-kind choices of earlier dialogs follow it
    select.addEventListener('change', () => ai.setPrefs({ defaultProvider: select.value, imageProvider: select.value, chatProvider: select.value }));
    def.append(lab, select);
    foot.append(def);
    if (status.encryption === false && !status.browser) foot.append(el('p', 'ai-warning', 'This system offers no secure storage: keys and tokens are kept unencrypted in ai-credentials.json in the app data folder.'));
    if (status.browser) foot.append(el('p', 'ai-warning', 'Browser build: keys are kept in this browser and requests go straight to the providers.'));
    content.append(foot);
  }
  render();

  await app.dialogs.open({ title: 'AI Accounts', content, width: 640, className: 'ai-accounts-dialog', buttons: [{ label: 'Close', value: true, primary: true }] });
  closed = true;
  clearTimeout(signInTimer);
  await ai.status();
}
