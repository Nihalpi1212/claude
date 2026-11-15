// Assistant panel (bottom group, "AI Assistant"): provider and chat-model selects, the "attach image"
// toggle, the conversation of the active document with the tool calls each answer made, and the input
// (Enter sends, Shift+Enter inserts a newline) with Send / Stop. The chat itself lives in
// lib/ai/assistant.js (app.assistant); this file only renders its state and forwards the user's input.
import { icon } from '../icons.js';
import { PROVIDERS } from '../ai/providers.js';

export function install(app) {
  const el = document.createElement('div');
  el.className = 'assistant-panel';
  el.innerHTML = `
    <div class="panel-toolbar assistant-toolbar">
      <select class="select" data-provider aria-label="Provider" title="Provider"></select>
      <select class="select" data-model aria-label="Chat model" title="Chat model"></select>
    </div>
    <div class="panel-toolbar assistant-toolbar assistant-toolbar-2">
      <label class="checkbox" title="Send a downscaled copy of the image with each message"><input type="checkbox" data-attach checked> Attach image</label>
      <span style="flex:1"></span>
      <button class="pbtn" data-accounts title="AI Accounts…">${icon('user')}</button>
      <button class="pbtn" data-clear title="Clear the conversation">${icon('trash')}</button>
    </div>
    <div class="assistant-messages" role="log" aria-live="polite"></div>
    <div class="assistant-compose">
      <textarea class="textarea assistant-input" data-input rows="2" placeholder="Ask about the image or tell the assistant what to change… (Enter sends, Shift+Enter for a new line)" aria-label="Message"></textarea>
      <div class="assistant-actions">
        <span class="muted assistant-status" data-status></span>
        <span style="flex:1"></span>
        <button class="btn assistant-stop" data-stop hidden>${icon('stop')} Stop</button>
        <button class="btn primary assistant-send" data-send title="Send (Enter)">Send</button>
      </div>
    </div>`;
  const providerSel = el.querySelector('[data-provider]');
  const modelSel = el.querySelector('[data-model]');
  const attach = el.querySelector('[data-attach]');
  const list = el.querySelector('.assistant-messages');
  const input = el.querySelector('[data-input]');
  const status = el.querySelector('[data-status]');
  const sendBtn = el.querySelector('[data-send]');
  const stopBtn = el.querySelector('[data-stop]');
  let aiStatus = null;
  let modelToken = 0;

  const visible = () => app.panels.isVisible('assistant');
  const ai = () => app.ai;

  // ---- provider / model selects ---------------------------------------------------------------------------------------

  function fillProviders() {
    const s = aiStatus ?? ai()?.current;
    const connected = Object.keys(PROVIDERS).filter((p) => !!s?.[p]?.method);
    const prefs = ai()?.prefs() ?? {};
    const want = prefs.chatProvider && connected.includes(prefs.chatProvider) ? prefs.chatProvider : connected.includes(prefs.defaultProvider) ? prefs.defaultProvider : connected[0] ?? null;
    providerSel.replaceChildren();
    if (!connected.length) {
      providerSel.append(new Option('Not connected', ''));
      providerSel.disabled = true;
      modelSel.replaceChildren(new Option('Sign in or add an API key', ''));
      modelSel.disabled = true;
      return;
    }
    providerSel.disabled = false;
    for (const p of connected) providerSel.append(new Option(PROVIDERS[p].label, p, false, p === want));
    providerSel.value = want;
    fillModels(want);
  }

  async function fillModels(provider) {
    const my = ++modelToken;
    modelSel.disabled = true;
    modelSel.replaceChildren(new Option('Loading…', ''));
    try {
      const listed = await ai().models(provider);
      if (my !== modelToken) return;
      const saved = ai().prefs()[`${provider}Chat`];
      const chosen = saved && listed.chat.includes(saved) ? saved : listed.default.chat;
      modelSel.replaceChildren();
      if (!listed.chat.length) {
        modelSel.append(new Option('No chat models', ''));
        return;
      }
      for (const id of listed.chat) modelSel.append(new Option(id, id, false, id === chosen));
      modelSel.disabled = false;
    } catch (err) {
      if (my !== modelToken) return;
      modelSel.replaceChildren(new Option(`Could not list models: ${err?.message ?? err}`, ''));
    }
  }

  providerSel.addEventListener('change', () => {
    ai()?.setPrefs({ chatProvider: providerSel.value });
    fillModels(providerSel.value);
  });
  modelSel.addEventListener('change', () => {
    if (modelSel.value) ai()?.setPrefs({ [`${providerSel.value}Chat`]: modelSel.value });
  });
  attach.addEventListener('change', () => app.saveSettingsSoon({ assistantAttach: attach.checked }));
  el.querySelector('[data-accounts]').addEventListener('click', () => ai()?.openAccounts());
  el.querySelector('[data-clear]').addEventListener('click', () => app.assistant?.clear());

  // ---- messages ---------------------------------------------------------------------------------------------------------

  function messageNode(m) {
    const row = document.createElement('div');
    row.className = `assistant-msg assistant-${m.role}${m.error ? ' assistant-error' : ''}${m.pending ? ' assistant-pending' : ''}`;
    if (m.role === 'user' && m.image) {
      const img = document.createElement('img');
      img.className = 'assistant-attachment';
      img.src = m.image;
      img.alt = 'Attached image';
      img.title = 'The image sent with this message';
      row.appendChild(img);
    }
    for (const c of m.calls ?? []) {
      const call = document.createElement('div');
      call.className = `assistant-call${c.pending ? ' pending' : ''}${c.result && typeof c.result === 'object' && c.result.error ? ' failed' : ''}`;
      call.innerHTML = `${icon(c.pending ? 'spinner' : c.result && typeof c.result === 'object' && c.result.error ? 'warning' : 'check')}<span></span>`;
      call.querySelector('span').textContent = app.assistant.describeCall(c) + (c.waiting ? ' — waiting for you to finish the dialog' : '');
      const detail = c.result && typeof c.result === 'object' && c.result.error ? c.result.error : JSON.stringify(c.args ?? {});
      call.title = detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
      row.appendChild(call);
    }
    if (m.text || (m.pending && !(m.calls ?? []).length)) {
      const text = document.createElement('div');
      text.className = 'assistant-text';
      if (m.pending && !m.text) {
        text.innerHTML = `${icon('spinner')}<span>Thinking…</span>`;
        text.classList.add('assistant-thinking');
      } else text.textContent = m.text;
      row.appendChild(text);
    }
    if (m.needsAccounts) {
      const b = document.createElement('button');
      b.className = 'btn';
      b.textContent = 'AI Accounts…';
      b.addEventListener('click', () => ai()?.openAccounts());
      row.appendChild(b);
    }
    return row;
  }

  function render() {
    const d = app.doc;
    list.replaceChildren();
    if (!d) {
      const empty = document.createElement('div');
      empty.className = 'panel-empty';
      empty.textContent = 'Open a document to chat about it.';
      list.appendChild(empty);
    } else {
      const messages = app.assistant?.messages(d) ?? [];
      if (!messages.length) {
        const empty = document.createElement('div');
        empty.className = 'panel-empty assistant-hint';
        empty.textContent = 'Ask about the image or describe an edit, for example "make it black and white with more contrast" or "add a title at the top".';
        list.appendChild(empty);
      }
      for (const m of messages) list.appendChild(messageNode(m));
    }
    const running = !!app.assistant?.isRunning(d);
    sendBtn.disabled = running || !d;
    sendBtn.hidden = running;
    stopBtn.hidden = !running;
    input.disabled = !d;
    status.textContent = running ? 'Working…' : '';
    list.scrollTop = list.scrollHeight;
  }

  // ---- input ------------------------------------------------------------------------------------------------------------

  async function send() {
    const text = input.value.trim();
    if (!text || !app.doc || app.assistant?.isRunning()) return;
    input.value = '';
    autosize();
    try {
      const sent = await app.assistant.send(text, { provider: providerSel.value || undefined, model: modelSel.value || undefined, attach: attach.checked });
      if (sent === null && !input.value) {
        // nothing was sent (no provider connected and the accounts dialog was closed): keep the typed text
        input.value = text;
        autosize();
      }
    } catch (err) {
      app.dialogs.toast(err?.message ?? String(err), { kind: 'error', timeout: 6000, action: /not connected|not available|model/i.test(err?.message ?? '') ? { label: 'AI Accounts…', run: () => ai()?.openAccounts() } : undefined });
    }
    input.focus();
  }
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, input.scrollHeight)}px`;
  }
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter inserts a newline; nothing here reaches the app's shortcuts
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') input.blur();
  });
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => {
    app.assistant?.stop();
    stopBtn.disabled = true;
    status.textContent = 'Stopping after the current step…';
  });

  // ---- wiring ----------------------------------------------------------------------------------------------------------

  app.on('assistant:changed', () => {
    stopBtn.disabled = false;
    if (visible()) render();
  });
  app.on('assistant:focus', () => requestAnimationFrame(() => input.focus()));
  app.on('doc:activated', () => visible() && render());
  app.on('doc:closed', () => visible() && render());
  app.on('ai:status', (s) => {
    aiStatus = s;
    if (visible()) fillProviders();
  });
  app.on('settings:changed', (patch) => {
    if (patch && 'assistantAttach' in patch) attach.checked = app.settings.assistantAttach !== false;
  });
  attach.checked = app.settings.assistantAttach !== false;

  app.panels.register({
    id: 'assistant',
    title: 'Assistant',
    icon: 'sparkle',
    element: el,
    group: 'bottom',
    order: 99,
    onShow: () => {
      fillProviders();
      render();
      // the accounts may have changed since the last look (sign-in, a key added): a changed status refills through ai:status
      ai()?.status().catch(() => {});
    },
  });
}
