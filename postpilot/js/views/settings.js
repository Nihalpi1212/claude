// Settings: Instagram, Worker, AI, Preferences, Notifications, Security, Data, Activity log, About.
// Sections are reachable with #/settings?section=<id> (used by the shell and other screens).

import { formatNumber } from '../../core/analytics.js';
import { unlockKeyring, WrongPassphraseError } from '../../core/crypto.js';
import { GRAPH_VERSION } from '../../core/ig.js';
import { DOC_NAMES, SCHEMA_VERSION, migrateDoc } from '../../core/model.js';
import { readKeyring } from '../../core/store.js';
import { dayKey, formatDateTime, formatDay, relative } from '../../core/time.js';
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { APP_NAME, DATA_BRANCH, DATA_KEY_SECRET, WORKER_WORKFLOW, bioPageUrl } from '../config.js';
import { loadViewCss } from '../css.js';
import { mutate, transact, useDoc } from '../data.js';
import { clearBlobCache } from '../idb.js';
import { saveBlob } from '../media.js';
import { NOTIFY_EVENTS, currentEndpoint, defaultNotifications, enablePush, needsHomeScreenInstall, pushSupported, removeDevice } from '../push.js';
import { setQuery } from '../router.js';
import { changePassphrase, forget } from '../session.js';
import { AccountCard, ConnectInstagram, CopyButton, ExtLink, MessagesReminder } from '../ui/connect-instagram.js';
import { Icon } from '../ui/icons.js';
import {
  Badge, Button, Callout, Checkbox, DataTable, EmptyState, Field, Modal, PageHeader, Panel, ProgressBar, Segmented, Select,
  Skeleton, StatusPill, TextArea, TextInput, Toggle, cx,
} from '../ui/kit.js';
import { TimeZoneField, WorkerSetup, aiKeyWarning, testAiKey } from './onboarding.js';

loadViewCss('settings');

const SECTIONS = [
  { id: 'instagram', label: 'Instagram', icon: 'instagram' },
  { id: 'worker', label: 'Worker', icon: 'refresh' },
  { id: 'ai', label: 'AI', icon: 'sparkle' },
  { id: 'preferences', label: 'Preferences', icon: 'sliders' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'security', label: 'Security', icon: 'shield' },
  { id: 'data', label: 'Data', icon: 'database' },
  { id: 'activity', label: 'Activity log', icon: 'list' },
  { id: 'about', label: 'About', icon: 'info' },
];

const DAY = 864e5;
const MB = 1024 * 1024;

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  if (n < MB) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Theme (per device)
// ---------------------------------------------------------------------------

const THEME_KEY = 'postpilot.theme';

export function readTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme) {
  try {
    if (theme === 'light' || theme === 'dark') localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* storage unavailable: still apply for this page */
  }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------------------
// Backup / restore / free-up helpers (pure)
// ---------------------------------------------------------------------------

/** Copy of settings without access tokens, API keys and the push signing key. */
export function redactSettings(s) {
  const out = structuredClone(s || {});
  if (out.ig) for (const k of ['token', 'pageToken', 'userToken', 'appSecret']) if (k in out.ig) out.ig[k] = '';
  if (out.ai) out.ai.apiKey = '';
  if (out.notifications && out.notifications.vapid) out.notifications.vapid = { ...out.notifications.vapid, privateKeyJwk: null };
  return out;
}

/** Settings to write when restoring: secrets missing from the backup are kept from the current settings. */
export function mergeRestoredSettings(current, incoming) {
  const out = structuredClone(incoming);
  const cur = current || {};
  if (!out.ig || !out.ig.token) {
    out.ig = out.ig && cur.ig && out.ig.userId === cur.ig.userId ? { ...out.ig, token: cur.ig.token, pageToken: cur.ig.pageToken, userToken: cur.ig.userToken } : cur.ig || null;
  }
  if (out.ai && !out.ai.apiKey && cur.ai && cur.ai.apiKey) out.ai.apiKey = cur.ai.apiKey;
  if (!out.notifications || !out.notifications.vapid || !out.notifications.vapid.privateKeyJwk) out.notifications = cur.notifications || out.notifications;
  return out;
}

/** Validate a parsed backup file. Returns an error message or null. */
export function backupProblem(data) {
  if (!data || typeof data !== 'object') return 'This file is not a Postpilot backup.';
  if (data.app !== 'postpilot' || !data.docs || typeof data.docs !== 'object') return 'This file is not a Postpilot backup (it has no "docs" section).';
  const known = Object.keys(data.docs).filter((n) => DOC_NAMES.includes(n));
  if (!known.length) return 'This backup contains no Postpilot data.';
  if (data.schema && data.schema > SCHEMA_VERSION) return 'This backup was made by a newer version of Postpilot. Update the app first.';
  return null;
}

/**
 * Library originals that only old published posts use (published more than `days` ago).
 * Thumbnails stay, so post history keeps its pictures. `exists(path)` tells which files are present.
 */
export function freeUpPlan({ posts, library, lists, exists = () => true, now = Date.now(), days = 30 }) {
  const cutoff = now - days * DAY;
  const keep = new Set();
  const old = new Set();
  for (const p of (posts && posts.posts) || []) {
    const ids = (p.media || []).map((m) => m.assetId).concat(p.coverAssetId ? [p.coverAssetId] : []);
    const isOld = p.status === 'published' && Date.parse(p.publishedAt || p.scheduledAt || '') < cutoff;
    for (const id of ids) (isOld ? old : keep).add(id);
  }
  for (const l of (lists && lists.lists) || []) for (const it of l.items || []) for (const m of it.media || []) keep.add(m.assetId);
  const assets = ((library && library.assets) || []).filter(
    (a) => old.has(a.id) && !keep.has(a.id) && !a.autopilot && !a.originalRemovedAt && exists(a.path),
  );
  return { assets, bytes: assets.reduce((n, a) => n + (a.bytes || 0), 0) };
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

function tokenRows(c, tz) {
  const rows = [];
  if (c.mode === 'facebook' && !c.tokenExpiresAt) {
    rows.push(['Token', 'Facebook Page token. It does not expire, but stops working if you change your Facebook password, lose access to the Page or remove the app.']);
  } else if (c.tokenExpiresAt) {
    const left = Date.parse(c.tokenExpiresAt) - Date.now();
    rows.push(['Token valid until', html`${formatDay(c.tokenExpiresAt, tz)} <span class=${left < 10 * DAY ? 'text-warn' : 'muted'}>(${relative(c.tokenExpiresAt)})</span>`]);
  } else {
    const base = Date.parse(c.tokenRefreshedAt || c.connectedAt || '') || Date.now();
    rows.push(['Token valid until', html`about ${formatDay(new Date(base + 60 * DAY), tz)} <span class="muted">(estimated: Instagram tokens last 60 days)</span>`]);
  }
  if (c.mode !== 'facebook') {
    rows.push([
      'Last renewed',
      c.tokenRefreshedAt
        ? html`${formatDateTime(c.tokenRefreshedAt, tz)} <span class="muted">(${relative(c.tokenRefreshedAt)})</span>`
        : html`<span class="muted">Not yet. The worker renews the token about once a week, starting a day after you connect.</span>`,
    ]);
  }
  if (c.connectedAt) rows.push(['Connected', formatDateTime(c.connectedAt, tz)]);
  return rows;
}

function InstagramSection() {
  const { settings, ig, tz, toast, confirm } = useApp();
  const conn = settings.ig;
  const [replacing, setReplacing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState(null);

  async function saveConnection(next) {
    const prev = settings.ig;
    if (prev && prev.userId && next.userId !== prev.userId) {
      const ok = await confirm({
        title: `Switch to @${next.username}?`,
        body: `Postpilot manages @${prev.username} now. Scheduled posts will publish to @${next.username}. Analytics history of @${prev.username} stays in Postpilot.`,
        confirmLabel: 'Switch account',
      });
      if (!ok) return;
    }
    await mutate('settings', (s) => {
      s.ig = next;
    }, { message: 'replace instagram token' });
    setReplacing(false);
    setLive(null);
    toast(`Connected @${next.username}.`, { kind: 'success' });
  }

  async function check() {
    if (!ig) return;
    setChecking(true);
    setLive(null);
    const userId = conn.userId;
    try {
      const me = await ig.me();
      let quota = null;
      try {
        quota = await ig.publishingLimit();
      } catch {
        quota = null;
      }
      const now = new Date().toISOString();
      await mutate('settings', (s) => {
        if (!s.ig || s.ig.userId !== userId) return;
        for (const k of ['username', 'name', 'profilePictureUrl', 'accountType']) if (me[k]) s.ig[k] = me[k];
        if (typeof me.followersCount === 'number') s.ig.followersCount = me.followersCount;
        s.ig.status = { state: 'ok', at: s.ig.status && s.ig.status.state === 'ok' ? s.ig.status.at || now : now, checkedAt: now };
      }, { message: 'check instagram', silent: true }).catch(() => {});
      setLive({ ok: true, quota });
      toast('Instagram connection works.', { kind: 'success' });
    } catch (err) {
      setLive({ ok: false, message: err.userMessage || err.message || String(err) });
    } finally {
      setChecking(false);
    }
  }

  async function disconnect() {
    const ok = await confirm({
      title: 'Disconnect Instagram?',
      body: 'Scheduled posts stay in Postpilot but will not publish, and automations stop, until you connect again. Your posts, media and analytics history are kept.',
      confirmLabel: 'Disconnect',
      danger: true,
    });
    if (!ok) return;
    try {
      await mutate('settings', (s) => {
        s.ig = null;
      }, { message: 'disconnect instagram' });
      toast('Instagram disconnected.', { kind: 'success' });
    } catch {
      /* mutate showed the error */
    }
  }

  if (!conn) {
    return html`<div class="stack">
      <${Callout} tone="warning" title="Instagram is not connected">Connect your account to publish, read comments and messages, and collect insights.<//>
      <${ConnectInstagram} onConnected=${saveConnection} />
    </div>`;
  }

  const expired = conn.status && conn.status.state === 'expired';
  return html`<div class="stack">
    ${expired
      ? html`<${Callout} tone="danger" title="Instagram stopped accepting the saved login"
          action=${html`<${Button} size="sm" variant="primary" onClick=${() => setReplacing(true)}>Replace token<//>`}>
          ${conn.status.message || 'The token expired or was revoked.'} Posts stay scheduled and publish once you reconnect.
        <//>`
      : null}
    <${AccountCard} connection=${conn}>
      <div class="row settings-account-actions">
        <${Button} size="sm" variant="secondary" icon="refresh" loading=${checking} onClick=${check} disabled=${!ig}>Check connection<//>
        <${Button} size="sm" variant="secondary" icon="key" onClick=${() => setReplacing(true)}>Replace token<//>
        <${Button} size="sm" variant="ghost" icon="logout" onClick=${disconnect}>Disconnect<//>
      </div>
    <//>
    ${live
      ? live.ok
        ? html`<${Callout} tone="success" title="Connection works">
            ${live.quota ? `Published through the API in the last 24 hours: ${live.quota.used} of ${live.quota.total}.` : 'Instagram answered normally.'}
          <//>`
        : html`<${Callout} tone="danger" title="Instagram returned an error">${live.message}<//>`
      : null}
    <dl class="kv settings-kv">
      <dt>Connection</dt>
      <dd>${conn.mode === 'facebook' ? `Facebook Login${conn.pageName ? ` through the Page "${conn.pageName}"` : ''}` : 'Instagram Login (no Facebook Page)'}</dd>
      ${tokenRows(conn, settings.timezone || 'UTC').map(([k, v]) => html`<dt key=${k}>${k}</dt><dd>${v}</dd>`)}
      ${conn.status && conn.status.checkedAt ? html`<dt>Last checked</dt><dd>${relative(conn.status.checkedAt)}</dd>` : null}
    </dl>
    ${conn.mode !== 'facebook'
      ? html`<p class="muted text-sm">Competitor tracking, hashtag research and deleting posts need Facebook Login. Use "Replace token" and choose Facebook Login to switch.</p>`
      : null}
    <${MessagesReminder} />
    <${Modal} open=${replacing} wide title="Replace Instagram token" onClose=${() => setReplacing(false)}>
      ${replacing ? html`<${ConnectInstagram} initialMode=${conn.mode} onConnected=${saveConnection} onCancel=${() => setReplacing(false)} />` : null}
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const TRIGGERS = { schedule: 'Scheduled', workflow_dispatch: 'From the app', push: 'Code change' };

function runActivity(run) {
  const c = run.counts || {};
  const labels = { published: 'published', failed: 'failed', replies: 'replies', dms: 'DMs', hidden: 'hidden', stories: 'stories', snapshots: 'snapshots', autopilotCreated: 'autopilot drafts', evergreenCreated: 'queue posts', tokenRefreshed: 'token renewed' };
  const parts = Object.entries(labels)
    .filter(([k]) => c[k])
    .map(([k, label]) => `${c[k]} ${label}`);
  return parts.join(', ') || (run.idle ? 'Nothing to do' : '—');
}

function ghRunStatus(r) {
  if (r.status !== 'completed') return html`<${StatusPill} status=${r.status === 'in_progress' ? 'publishing' : 'queued'} label=${r.status === 'in_progress' ? 'Running' : 'Queued'} />`;
  if (r.conclusion === 'success') return html`<${StatusPill} status="done" label="Succeeded" />`;
  if (r.conclusion === 'cancelled' || r.conclusion === 'skipped') return html`<${StatusPill} status="canceled" label=${r.conclusion === 'skipped' ? 'Skipped' : 'Canceled'} />`;
  return html`<${StatusPill} status="failed" label="Failed" />`;
}

function WorkerSection() {
  const { session, settings, dispatchWorker, tz, toast } = useApp();
  const { data: log } = useDoc('log');
  const [ghRuns, setGhRuns] = useState(undefined);
  const [secret, setSecret] = useState(undefined);
  const [setupOpen, setSetupOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  async function load() {
    const [runs, sec] = await Promise.all([
      session.gh.listWorkflowRuns(WORKER_WORKFLOW, { perPage: 5 }).catch((err) => (err.status === 403 ? 'forbidden' : 'error')),
      session.gh.getSecret(DATA_KEY_SECRET).catch((err) => (err.status === 403 ? 'forbidden' : 'error')),
    ]);
    if (!alive.current) return;
    setGhRuns(runs);
    setSecret(sec);
  }
  useEffect(() => {
    load();
  }, []);

  async function runNow() {
    setStarting(true);
    try {
      await dispatchWorker('settings');
      setTimeout(() => alive.current && load(), 2500);
    } catch {
      /* dispatchWorker showed the error */
    } finally {
      setStarting(false);
    }
  }

  const enabled = !(settings.worker && settings.worker.enabled === false);
  const runs = (log && log.runs) || [];
  const last = runs[0];
  return html`<div class="stack">
    <${Toggle}
      checked=${enabled}
      label="Worker on"
      hint=${enabled
        ? 'Publishes scheduled posts, runs automations and autopilot, and saves analytics every 10 minutes.'
        : 'Paused: nothing is published or answered. The worker only keeps your Instagram token fresh.'}
      onChange=${(v) =>
        mutate('settings', (s) => {
          s.worker = { ...(s.worker || {}), enabled: v };
        }, { message: v ? 'resume worker' : 'pause worker' })
          .then(() => toast(v ? 'Worker resumed.' : 'Worker paused.', { kind: 'success' }))
          .catch(() => {})}
    />
    <dl class="kv settings-kv">
      <dt>Data key secret</dt>
      <dd>
        ${secret === undefined
          ? html`<${Skeleton} height=${14} width=${160} />`
          : secret && typeof secret === 'object'
            ? html`<span class="text-ok">Saved</span>${secret.updated_at ? html` <span class="muted">${formatDay(secret.updated_at, tz)}</span>` : null}`
            : secret === null
              ? html`<span class="text-bad">Missing.</span> The worker cannot read your data until you connect it.`
              : secret === 'forbidden'
                ? html`<span class="muted">Cannot be checked: the GitHub token has no access to secrets.</span>`
                : html`<span class="muted">Could not be checked right now.</span>`}
      </dd>
      <dt>Last run</dt>
      <dd>
        ${last
          ? html`${formatDateTime(last.finishedAt || last.startedAt, tz)} <span class="muted">(${relative(last.finishedAt || last.startedAt)})</span>
              ${last.ok === false ? html` <${Badge} tone="danger">Problems<//>` : html` <${Badge} tone="success">OK<//>`}`
          : html`<span class="muted">The worker has not reported yet.</span>`}
      </dd>
      <dt>Schedule</dt>
      <dd>Every 10 minutes on GitHub Actions. GitHub can delay scheduled runs by 5 to 30 minutes when it is busy.</dd>
    </dl>
    <div class="row">
      <${Button} variant="primary" icon="play" loading=${starting} onClick=${runNow}>Run now<//>
      <${Button} variant="secondary" icon="key" onClick=${() => setSetupOpen(true)}>Connect worker again<//>
      <${ExtLink} href=${`https://github.com/${session.owner}/${session.repo}/actions/workflows/${WORKER_WORKFLOW}`}>Open in GitHub Actions<//>
    </div>

    <div>
      <h3 class="settings-sub">Recent runs</h3>
      ${runs.length
        ? html`<${DataTable}
            dense
            rowKey=${(r) => r.startedAt}
            columns=${[
              { key: 'startedAt', label: 'When', render: (r) => html`<span class="nowrap">${formatDateTime(r.startedAt, tz)}</span>` },
              { key: 'trigger', label: 'Started', render: (r) => TRIGGERS[r.trigger] || 'Manual' },
              {
                key: 'ok',
                label: 'Result',
                render: (r) => (r.ok === false ? html`<${StatusPill} status="failed" label="Problems" />` : r.idle ? html`<${StatusPill} status="paused" label="Idle" />` : html`<${StatusPill} status="done" label="OK" />`),
              },
              { key: 'durationMs', label: 'Took', align: 'right', render: (r) => (r.durationMs != null ? `${Math.max(1, Math.round(r.durationMs / 1000))} s` : '—') },
              {
                key: 'activity',
                label: 'Activity',
                render: (r) => html`<span>${runActivity(r)}</span>${(r.errors || []).length
                  ? html`<ul class="settings-run-errors">${r.errors.map((e, i) => html`<li key=${i}><strong>${e.job}:</strong> ${e.message}</li>`)}</ul>`
                  : null}`,
              },
            ]}
            rows=${runs.slice(0, 10)}
          />`
        : html`<${EmptyState} compact icon="clock" title="No runs yet" body="Run the worker once to check that everything is connected." />`}
    </div>

    ${Array.isArray(ghRuns) && ghRuns.length
      ? html`<div>
          <h3 class="settings-sub">On GitHub</h3>
          <ul class="list">
            ${ghRuns.map(
              (r) => html`<li key=${r.id} class="list-row">
                ${ghRunStatus(r)}
                <span class="grow">${TRIGGERS[r.event] || r.event} <span class="muted">· ${relative(r.created_at)}</span></span>
                ${/^https:\/\//.test(r.html_url || '') ? html`<${ExtLink} href=${r.html_url}>Details<//>` : null}
              </li>`,
            )}
          </ul>
        </div>`
      : ghRuns === 'forbidden'
        ? html`<p class="muted text-sm">GitHub run history is hidden: the token has no "Actions: Read" permission.</p>`
        : null}

    <${Modal} open=${setupOpen} wide title="Connect the worker" onClose=${() => (setSetupOpen(false), load())}>
      ${setupOpen ? html`<${WorkerSetup} onContinue=${() => (setSetupOpen(false), load())} continueLabel="Done" />` : null}
    <//>
  </div>`;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

const MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best writing, default)' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster, lower cost)' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, lowest cost)' },
];

const EMOJI = [
  { value: 'none', label: 'None' },
  { value: 'some', label: 'A few' },
  { value: 'lots', label: 'Lots' },
];

function pickAi(a = {}) {
  return {
    enabled: !!a.enabled,
    apiKey: a.apiKey || '',
    model: a.model || 'claude-opus-5-5',
    voice: a.voice || '',
    language: a.language || 'English',
    emoji: a.emoji || 'some',
  };
}

function AiSection() {
  const { settings, toast } = useApp();
  const saved = pickAi(settings.ai || {});
  const savedKey = JSON.stringify(saved);
  const [base, setBase] = useState(savedKey);
  const [form, setForm] = useState(saved);
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(form) !== base;

  // Follow outside changes (another tab, a restore) while there are no unsaved edits.
  useEffect(() => {
    if (!dirty && savedKey !== base) {
      setBase(savedKey);
      setForm(saved);
    }
  }, [savedKey]);

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setError('');
  };

  async function save(e) {
    e.preventDefault();
    const next = { ...form, apiKey: form.apiKey.trim() };
    if (next.enabled && !next.apiKey) return setError('Add an API key to turn AI features on.');
    setSaving(true);
    try {
      const doc = await mutate('settings', (s) => {
        s.ai = { ...(s.ai || {}), provider: 'anthropic', ...next };
      }, { message: 'ai settings' });
      const fresh = pickAi(doc.ai);
      setBase(JSON.stringify(fresh));
      setForm(fresh);
      toast('AI settings saved.', { kind: 'success' });
    } catch {
      /* mutate showed the error */
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTest(null);
    if (!form.apiKey.trim()) return setTest({ ok: false, text: 'Paste an API key first.' });
    setTesting(true);
    try {
      const reply = await testAiKey(form);
      setTest({ ok: true, text: reply });
    } catch (err) {
      setTest({ ok: false, text: err.userMessage || err.message || String(err) });
    } finally {
      setTesting(false);
    }
  }

  const models = MODELS.some((m) => m.value === form.model) ? MODELS : [...MODELS, { value: form.model, label: form.model }];
  return html`<form class="stack" onSubmit=${save}>
    <${Toggle} checked=${form.enabled} onChange=${(v) => set({ enabled: v })} label="Use AI features"
      hint="Captions, hashtag ideas, reply suggestions, AI replies in automations and autopilot captions, written by Claude." />
    <div class="grid-2">
      <${Field}
        label="Anthropic API key"
        error=${aiKeyWarning(form.apiKey)}
        hint=${html`Create one at <${ExtLink} href="https://console.anthropic.com/settings/keys">console.anthropic.com → API keys<//>. Usage is billed to your
          Anthropic account. Stored encrypted; the worker uses it too.`}
        action=${html`<button type="button" class="link-btn" onClick=${() => setReveal((r) => !r)}>${reveal ? 'Hide' : 'Show'}</button>`}
      >
        <${TextInput} id="settings-ai-key" type=${reveal ? 'text' : 'password'} mono value=${form.apiKey} onChange=${(v) => (set({ apiKey: v }), setTest(null))}
          placeholder="sk-ant-…" autocomplete="off" spellcheck=${false} />
      <//>
      <${Field} label="Model" hint="Opus writes best. Sonnet and Haiku are faster and cost less per caption.">
        <${Select} value=${form.model} options=${models} onChange=${(v) => set({ model: v })} />
      <//>
    </div>
    <${Field} label="Brand voice" hint="How your captions and replies should sound. Claude follows this in every suggestion.">
      <${TextArea} value=${form.voice} onChange=${(v) => set({ voice: v })} rows=${2} maxRows=${8} placeholder="Warm, calm and concise. Talks like a maker, never salesy." />
    <//>
    <div class="grid-2">
      <${Field} label="Language" hint="Captions are written in this language. Replies follow the language of the message.">
        <${TextInput} value=${form.language} onChange=${(v) => set({ language: v })} placeholder="English" list="settings-languages" />
      <//>
      <${Field} label="Emoji in captions">
        <${Segmented} options=${EMOJI} value=${form.emoji} onChange=${(v) => set({ emoji: v })} label="Emoji in captions" />
      <//>
    </div>
    <datalist id="settings-languages">
      ${['English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian', 'Dutch', 'Polish', 'Turkish', 'Japanese', 'Korean', 'Chinese'].map((l) => html`<option key=${l} value=${l} />`)}
    </datalist>
    ${error ? html`<${Callout} tone="danger">${error}<//>` : null}
    ${test
      ? html`<${Callout} tone=${test.ok ? 'success' : 'danger'} title=${test.ok ? 'Claude answered a sample comment' : 'The test failed'}>
          ${test.ok ? html`<q class="settings-quote">${test.text}</q>` : test.text}
        <//>`
      : null}
    <div class="row">
      <${Button} type="submit" variant="primary" loading=${saving} disabled=${!dirty}>Save AI settings<//>
      <${Button} variant="secondary" icon="sparkle" loading=${testing} onClick=${runTest} disabled=${!form.apiKey.trim()}>Test<//>
      ${dirty ? html`<span class="muted text-sm">Unsaved changes</span>` : null}
    </div>
  </form>`;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function PreferencesSection() {
  const { settings, toast } = useApp();
  const [tz, setTz] = useState(settings.timezone || 'UTC');
  const [theme, setTheme] = useState(readTheme);
  const [firstComment, setFirstComment] = useState((settings.publishing && settings.publishing.defaultFirstComment) || '');
  const savedFirst = (settings.publishing && settings.publishing.defaultFirstComment) || '';
  useEffect(() => setTz(settings.timezone || 'UTC'), [settings.timezone]);
  useEffect(() => setFirstComment(savedFirst), [savedFirst]);

  async function saveTz() {
    const zone = tz;
    try {
      await mutate('settings', (s) => {
        s.timezone = zone;
      }, { message: 'time zone' });
      toast(`Time zone set to ${zone}.`, { kind: 'success' });
    } catch {
      /* mutate showed the error */
    }
  }

  async function saveFirstComment() {
    const text = firstComment;
    try {
      await mutate('settings', (s) => {
        s.publishing = { ...(s.publishing || {}), defaultFirstComment: text };
      }, { message: 'default first comment' });
      toast('Default first comment saved.', { kind: 'success' });
    } catch {
      /* mutate showed the error */
    }
  }

  return html`<div class="settings-groups">
    <div class="stack">
      <${TimeZoneField} value=${tz} onChange=${setTz} hint="The planner, analytics days and the worker's schedule use it." />
      ${tz !== settings.timezone ? html`<div class="row"><${Button} variant="primary" size="sm" onClick=${saveTz}>Save time zone<//></div>` : null}
    </div>
    <${Field} label="Theme" hint="Only for this device.">
      <${Segmented}
        label="Theme"
        value=${theme}
        options=${[
          { value: 'system', label: 'System', icon: 'monitor' },
          { value: 'light', label: 'Light', icon: 'sun' },
          { value: 'dark', label: 'Dark', icon: 'moon' },
        ]}
        onChange=${(v) => (setTheme(v), applyTheme(v))}
      />
    <//>
    <div class="stack">
      <h3 class="settings-sub">Publishing</h3>
      <${Toggle}
        checked=${!(settings.publishing && settings.publishing.retryFailed === false)}
        label="Retry failed posts automatically"
        hint="When Instagram has a temporary problem, the worker tries again on the next runs (up to 4 times)."
        onChange=${(v) =>
          mutate('settings', (s) => {
            s.publishing = { ...(s.publishing || {}), retryFailed: v };
          }, { message: 'retry setting' })
            .then(() => toast(v ? 'Failed posts will be retried.' : 'Failed posts will not be retried.', { kind: 'success' }))
            .catch(() => {})}
      />
      <${Field} label="Default first comment" hint="Added to autopilot posts. Leave empty for none.">
        <${TextArea} value=${firstComment} onChange=${setFirstComment} rows=${2} maxRows=${6} placeholder="Shop the collection: link in bio" />
      <//>
      ${firstComment !== savedFirst ? html`<div class="row"><${Button} size="sm" variant="primary" onClick=${saveFirstComment}>Save first comment<//></div>` : null}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function NotificationsSection() {
  const { settings, toast, confirm, tz } = useApp();
  const n = { ...defaultNotifications(), ...(settings.notifications || {}) };
  const events = { ...defaultNotifications().events, ...(n.events || {}) };
  const subs = n.subscriptions || [];
  const supported = pushSupported();
  const ios = needsHomeScreenInstall();
  const [mine, setMine] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    currentEndpoint().then(setMine).catch(() => setMine(null));
  }, []);
  const registered = !!mine && subs.some((s) => s.endpoint === mine);

  async function enable() {
    setBusy(true);
    setError('');
    try {
      const rec = await enablePush();
      setMine(rec.endpoint);
      toast('Notifications are on for this device.', { kind: 'success' });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(sub) {
    const ok = await confirm({
      title: `Remove ${sub.device || 'this device'}?`,
      body: 'It will stop receiving Postpilot notifications. You can turn them on again from that device.',
      confirmLabel: 'Remove device',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeDevice(sub.endpoint);
      if (sub.endpoint === mine) setMine(null);
      toast('Device removed.', { kind: 'success' });
    } catch (err) {
      toast(err.message || String(err), { kind: 'error' });
    }
  }

  return html`<div class="stack">
    <p class="muted">The worker sends a notification to your phone or computer when something needs you, even when Postpilot is closed.</p>
    ${ios
      ? html`<${Callout} tone="info" title="On iPhone and iPad, add Postpilot to your Home Screen first">
          In Safari tap <strong>Share</strong> → <strong>Add to Home Screen</strong>, open Postpilot from the new icon, then come back here and turn
          notifications on. Apple only allows web notifications for apps on the Home Screen.
        <//>`
      : !supported
        ? html`<${Callout} tone="warning" title="This browser cannot receive notifications">Use a current version of Chrome, Edge, Firefox or Safari.<//>`
        : null}
    ${error ? html`<${Callout} tone="danger" title="Notifications could not be turned on">${error}<//>` : null}
    <div class="row">
      ${registered
        ? html`<${Badge} tone="success" icon="check">On for this device<//>`
        : html`<${Button} variant="primary" icon="bell" loading=${busy} disabled=${!supported || ios} onClick=${enable}>Turn on notifications for this device<//>`}
    </div>
    <div>
      <h3 class="settings-sub">Devices</h3>
      ${subs.length
        ? html`<ul class="list">
            ${subs.map(
              (s) => html`<li key=${s.endpoint} class="list-row">
                <${Icon} name="bell" />
                <span class="grow">
                  <span>${s.device || 'Device'}</span>${s.endpoint === mine ? html` <${Badge} tone="accent">This device<//>` : null}
                  <span class="muted text-sm"> · added ${s.createdAt ? formatDay(s.createdAt, tz) : 'earlier'}</span>
                </span>
                <${Button} size="sm" variant="ghost" icon="trash" onClick=${() => remove(s)} aria-label=${`Remove ${s.device || 'device'}`}>Remove<//>
              </li>`,
            )}
          </ul>`
        : html`<p class="muted text-sm">No devices yet.</p>`}
    </div>
    <div>
      <h3 class="settings-sub">Notify me when</h3>
      <div class="settings-toggles">
        ${NOTIFY_EVENTS.map(
          (ev) => html`<${Toggle}
            key=${ev.id}
            checked=${!!events[ev.id]}
            label=${ev.label}
            onChange=${(v) =>
              mutate('settings', (s) => {
                const cur = { ...defaultNotifications(), ...(s.notifications || {}) };
                cur.events = { ...defaultNotifications().events, ...(cur.events || {}), [ev.id]: v };
                s.notifications = cur;
              }, { message: 'notification settings' })
                .then(() => toast(v ? `Notifications on: ${ev.label.toLowerCase()}.` : `Notifications off: ${ev.label.toLowerCase()}.`, { kind: 'success' }))
                .catch(() => {})}
          />`,
        )}
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function rememberedHere() {
  try {
    return !!localStorage.getItem('postpilot.session');
  } catch {
    return false;
  }
}

function SecuritySection() {
  const { session, toast, confirm, lock } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remembered = rememberedHere();

  async function change(e) {
    e.preventDefault();
    setError('');
    if (!current) return setError('Enter your current passphrase.');
    if (next.length < 10) return setError('Use a new passphrase of at least 10 characters. A short sentence works well.');
    if (next !== next2) return setError('The two new passphrases do not match.');
    if (next === current) return setError('The new passphrase is the same as the current one.');
    setBusy(true);
    try {
      const keyring = await readKeyring(session.gh, DATA_BRANCH);
      if (!keyring) throw new Error('Could not read the keyring from the data branch. Reload and try again.');
      await unlockKeyring(keyring, current);
      await changePassphrase(session, next);
      setCurrent('');
      setNext('');
      setNext2('');
      toast('Passphrase changed. Use the new one next time you unlock.', { kind: 'success' });
    } catch (err) {
      setError(err instanceof WrongPassphraseError ? 'The current passphrase is not right. Check for typos and caps lock.' : err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  async function forgetDevice() {
    const ok = await confirm({
      title: 'Forget this device?',
      body: 'Postpilot removes the saved login, the cached encrypted files and the repository name from this browser, then locks. Nothing on GitHub changes.',
      confirmLabel: 'Forget and lock',
      danger: true,
    });
    if (!ok) return;
    forget();
    try {
      localStorage.removeItem('postpilot.hint');
    } catch {
      /* ignore */
    }
    await clearBlobCache().catch(() => {});
    location.reload();
  }

  return html`<div class="settings-groups">
    <dl class="kv settings-kv">
      <dt>GitHub account</dt>
      <dd>${session.login ? `@${session.login}` : '—'}</dd>
      <dt>Repository</dt>
      <dd><span class="mono">${session.owner}/${session.repo}</span>, data on the <span class="mono">${DATA_BRANCH}</span> branch</dd>
      <dt>This device</dt>
      <dd>${remembered ? 'Remembered: Postpilot opens without your passphrase on this browser.' : 'Not remembered: Postpilot locks when you close this tab.'}</dd>
      <dt>Encryption</dt>
      <dd>AES-256-GCM in your browser. Only the link-in-bio page and media handed to Instagram while publishing are public.</dd>
    </dl>
    <div class="row">
      <${Button} variant="secondary" icon="lock" onClick=${lock}>Lock now<//>
      <${Button} variant="ghost" icon="logout" onClick=${forgetDevice}>Forget this device<//>
    </div>
    <form class="stack settings-narrow" onSubmit=${change}>
      <h3 class="settings-sub">Change passphrase</h3>
      <p class="muted text-sm">Your data key stays the same, so the worker keeps working. Other devices need the new passphrase next time they unlock.</p>
      <${Field} label="Current passphrase">
        <${TextInput} type="password" value=${current} onChange=${setCurrent} autocomplete="current-password" />
      <//>
      <${Field} label="New passphrase" hint="At least 10 characters.">
        <${TextInput} type="password" value=${next} onChange=${setNext} autocomplete="new-password" />
      <//>
      <${Field} label="Repeat new passphrase">
        <${TextInput} type="password" value=${next2} onChange=${setNext2} autocomplete="new-password" />
      <//>
      ${error ? html`<${Callout} tone="danger">${error}<//>` : null}
      <div class="row"><${Button} type="submit" variant="primary" icon="key" loading=${busy}>Change passphrase<//></div>
    </form>
  </div>`;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function storageSummary(store, library) {
  const files = store && store.head ? [...store.head.files.entries()] : [];
  const assetBytes = new Map(((library && library.assets) || []).map((a) => [a.path, a.bytes || 0]));
  const sum = { media: 0, mediaCount: 0, thumbs: 0, thumbCount: 0, docs: 0, docCount: 0, pub: 0, pubCount: 0 };
  for (const [path, f] of files) {
    const size = f.size || assetBytes.get(path) || 0;
    if (path.startsWith('media/') && path.endsWith('.thumb')) {
      sum.thumbs += size;
      sum.thumbCount++;
    } else if (path.startsWith('media/')) {
      sum.media += size;
      sum.mediaCount++;
    } else if (path.startsWith('db/')) {
      sum.docs += size;
      sum.docCount++;
    } else if (path.startsWith('public/')) {
      sum.pub += size;
      sum.pubCount++;
    }
  }
  sum.total = sum.media + sum.thumbs + sum.docs + sum.pub;
  return sum;
}

function DataSection() {
  const { session, tz, toast, confirm } = useApp();
  const { data: library } = useDoc('library');
  const { data: posts } = useDoc('posts');
  const { data: lists } = useDoc('lists');
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [busy, setBusy] = useState('');
  const [restoreError, setRestoreError] = useState('');
  const fileRef = useRef(null);

  const sum = storageSummary(session.store, library);
  const plan = useMemo(
    () => (library && posts && lists ? freeUpPlan({ posts, library, lists, exists: (p) => !session.store.head || session.store.head.files.has(p) }) : { assets: [], bytes: 0 }),
    [library, posts, lists],
  );

  async function backup() {
    setBusy('backup');
    try {
      const docs = await session.store.readMany(DOC_NAMES);
      if (!includeSecrets) docs.settings = redactSettings(docs.settings);
      const data = {
        app: 'postpilot',
        kind: 'backup',
        schema: SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        repository: `${session.owner}/${session.repo}`,
        includesSecrets: includeSecrets,
        docs,
      };
      saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `postpilot-backup-${dayKey(new Date(), tz)}.json`);
      toast('Backup downloaded. It is not encrypted, so keep it somewhere private.', { kind: 'success' });
    } catch (err) {
      toast(`Could not create the backup: ${err.message || err}`, { kind: 'error' });
    } finally {
      setBusy('');
    }
  }

  async function restoreFile(file) {
    setRestoreError('');
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return setRestoreError(`"${file.name}" is not a valid backup file (it is not JSON).`);
    }
    const problem = backupProblem(data);
    if (problem) return setRestoreError(problem);
    const names = Object.keys(data.docs).filter((n) => DOC_NAMES.includes(n));
    const when = data.exportedAt ? formatDateTime(data.exportedAt, tz) : 'an unknown date';
    const ok = await confirm({
      title: 'Restore this backup?',
      body: `Your current posts, settings and other data are replaced with the backup from ${when} (${names.length} sections). Photos and videos are not part of a backup; the ones still in your repository keep working. Access tokens missing from the backup are kept.`,
      confirmLabel: 'Replace my data',
      danger: true,
    });
    if (!ok) return;
    setBusy('restore');
    try {
      await transact(async (tx) => {
        for (const name of names) {
          let value = data.docs[name];
          if (!value || typeof value !== 'object') continue;
          if (name === 'settings') value = mergeRestoredSettings(await tx.read('settings'), value);
          tx.write(name, migrateDoc(name, structuredClone(value)));
        }
      }, { message: 'restore backup' });
      toast('Backup restored.', { kind: 'success' });
    } catch {
      /* transact showed the error */
    } finally {
      setBusy('');
    }
  }

  async function freeUp() {
    const ok = await confirm({
      title: `Remove ${plan.assets.length} original file${plan.assets.length === 1 ? '' : 's'}?`,
      body: `This deletes the full-size photos and videos (${fmtBytes(plan.bytes)}) that are only used by posts published more than 30 days ago. Thumbnails and post history stay, so your planner and analytics still show them. You cannot republish those posts afterwards.`,
      confirmLabel: 'Free up space',
      danger: true,
    });
    if (!ok) return;
    setBusy('free');
    try {
      const res = await transact(async (tx) => {
        const [p, lib, l] = [await tx.read('posts'), await tx.read('library'), await tx.read('lists')];
        const fresh = freeUpPlan({ posts: p, library: lib, lists: l, exists: (path) => tx.exists(path) });
        const ids = new Set(fresh.assets.map((a) => a.id));
        const now = new Date().toISOString();
        for (const a of lib.assets) {
          if (!ids.has(a.id)) continue;
          tx.delete(a.path);
          a.originalRemovedAt = now;
        }
        if (ids.size) tx.write('library', lib);
        return fresh;
      }, { message: 'free up space' });
      toast(res.assets.length ? `Removed ${res.assets.length} original file${res.assets.length === 1 ? '' : 's'} (${fmtBytes(res.bytes)}).` : 'Nothing to remove.', { kind: 'success' });
    } catch {
      /* transact showed the error */
    } finally {
      setBusy('');
    }
  }

  const LIMIT = 1024 * MB;
  return html`<div class="settings-groups">
    <div class="stack">
      <h3 class="settings-sub">Backup</h3>
      <p class="muted">Downloads all your Postpilot data (posts, library details, queues, automations, analytics, settings) as one JSON file. Photos and videos stay in your repository.</p>
      <${Checkbox} checked=${includeSecrets} onChange=${setIncludeSecrets} label="Include access tokens and API keys"
        hint="Off by default. The file is not encrypted; with this on, anyone who gets it can use your Instagram connection." />
      <div class="row">
        <${Button} variant="primary" icon="download" loading=${busy === 'backup'} onClick=${backup}>Download backup<//>
        <${Button} variant="secondary" icon="upload" loading=${busy === 'restore'} onClick=${() => fileRef.current && fileRef.current.click()}>Restore from backup…<//>
        <input ref=${fileRef} type="file" accept="application/json,.json" class="sr-only" tabindex="-1" aria-hidden="true"
          onChange=${(e) => {
            const f = e.currentTarget.files && e.currentTarget.files[0];
            e.currentTarget.value = '';
            restoreFile(f);
          }} />
      </div>
      ${restoreError ? html`<${Callout} tone="danger" title="Could not restore">${restoreError}<//>` : null}
    </div>

    <div class="stack">
      <h3 class="settings-sub">Storage</h3>
      <div class="settings-storage">
        <div class="row row-between"><span>Data branch in use</span><strong class="num">${fmtBytes(sum.total)}</strong></div>
        <${ProgressBar} value=${sum.total} max=${LIMIT} tone=${sum.total > 0.8 * LIMIT ? 'warn' : 'accent'} label="Storage used of 1 GB" />
        <dl class="kv settings-kv">
          <dt>Photos and videos</dt><dd class="num">${sum.mediaCount} files · ${fmtBytes(sum.media)}</dd>
          <dt>Thumbnails</dt><dd class="num">${sum.thumbCount} files · ${fmtBytes(sum.thumbs)}</dd>
          <dt>Encrypted data</dt><dd class="num">${sum.docCount} documents · ${fmtBytes(sum.docs)}</dd>
          <dt>Public files</dt><dd class="num">${sum.pubCount} files · ${fmtBytes(sum.pub)}</dd>
        </dl>
        <p class="muted text-sm">GitHub recommends keeping a repository under 1 GB. Old versions of your data are compacted by the worker about once a month.</p>
      </div>
      <div class="row">
        <${Button} variant="secondary" icon="trash" loading=${busy === 'free'} disabled=${!plan.assets.length} onClick=${freeUp}>Free up space<//>
        <span class="muted text-sm">${plan.assets.length
          ? `${plan.assets.length} original file${plan.assets.length === 1 ? '' : 's'} (${fmtBytes(plan.bytes)}) only used by posts published more than 30 days ago.`
          : 'Nothing to free up: no originals are used only by posts older than 30 days.'}</span>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

const LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
];
const LEVEL_TONE = { error: 'danger', warn: 'warning', info: 'neutral' };
const LEVEL_LABEL = { error: 'Error', warn: 'Warning', info: 'Info' };

function ActivitySection() {
  const { tz } = useApp();
  const { data: log, loading } = useDoc('log');
  const [level, setLevel] = useState('all');
  const [job, setJob] = useState('all');
  const [limit, setLimit] = useState(40);
  const entries = (log && log.entries) || [];
  const jobs = useMemo(() => [...new Set(entries.map((e) => e.job).filter(Boolean))].sort(), [entries]);
  const shown = entries.filter((e) => (level === 'all' || e.level === level) && (job === 'all' || e.job === job));

  if (loading && !log) return html`<${Skeleton} lines=${4} />`;
  return html`<div class="stack">
    <div class="toolbar">
      <${Segmented} size="sm" label="Level" options=${LEVELS} value=${level} onChange=${(v) => (setLevel(v), setLimit(40))} />
      <${Select} class="settings-job-select" aria-label="Job" value=${job} onChange=${(v) => (setJob(v), setLimit(40))}
        options=${[{ value: 'all', label: 'All jobs' }, ...jobs.map((j) => ({ value: j, label: j }))]} />
      <span class="spacer"></span>
      <span class="muted text-sm num">${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}</span>
    </div>
    ${shown.length
      ? html`<ul class="list settings-log">
          ${shown.slice(0, limit).map(
            (e, i) => html`<li key=${`${e.at}-${i}`} class="list-row row-top settings-log-row">
              <time class="mono muted settings-log-time" datetime=${e.at}>${formatDateTime(e.at, tz)}</time>
              <${Badge} tone=${LEVEL_TONE[e.level] || 'neutral'}>${LEVEL_LABEL[e.level] || e.level}<//>
              <span class="settings-log-job mono">${e.job}</span>
              <span class="grow settings-log-msg">${e.message}</span>
            </li>`,
          )}
        </ul>
        ${shown.length > limit ? html`<div class="row"><${Button} variant="ghost" size="sm" onClick=${() => setLimit((n) => n + 60)}>Show more<//></div>` : null}`
      : html`<${EmptyState} compact icon="list" title=${entries.length ? 'No entries match' : 'No activity yet'}
          body=${entries.length ? 'Try another level or job.' : 'The worker writes here when it publishes, replies or runs into a problem.'} />`}
  </div>`;
}

// ---------------------------------------------------------------------------
// About
// ---------------------------------------------------------------------------

function AboutSection() {
  const { session } = useApp();
  const repoUrl = `https://github.com/${session.owner}/${session.repo}`;
  const bio = bioPageUrl();
  return html`<div class="stack">
    <p>${APP_NAME} is your private Instagram planner, publisher, analytics and automation tool. It runs for free on your own GitHub account:
      the app on GitHub Pages, the worker on GitHub Actions and your encrypted data on the <span class="mono">${DATA_BRANCH}</span> branch.</p>
    <dl class="kv settings-kv">
      <dt>Repository</dt><dd><${ExtLink} href=${repoUrl}>${session.owner}/${session.repo}<//></dd>
      <dt>Link in bio page</dt><dd class="row"><span class="mono break">${bio}</span> <${CopyButton} text=${bio} label="Copy" variant="ghost" /></dd>
      <dt>Instagram API</dt><dd>Graph API ${GRAPH_VERSION}</dd>
      <dt>Data format</dt><dd>Version ${SCHEMA_VERSION}</dd>
    </dl>
  </div>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SECTION_INFO = {
  instagram: { title: 'Instagram', subtitle: 'The account Postpilot publishes to and reads from.' },
  worker: { title: 'Worker', subtitle: 'The background job on GitHub Actions that publishes and replies for you.' },
  ai: { title: 'AI', subtitle: 'Claude writes captions, hashtags and replies with your own Anthropic key.' },
  preferences: { title: 'Preferences', subtitle: 'Time zone, theme and publishing defaults.' },
  notifications: { title: 'Notifications', subtitle: 'Push notifications from the worker to your devices.' },
  security: { title: 'Security', subtitle: 'Passphrase, this device and encryption.' },
  data: { title: 'Data', subtitle: 'Backups and storage on GitHub.' },
  activity: { title: 'Activity log', subtitle: 'What the worker did, newest first.' },
  about: { title: 'About', subtitle: null },
};

const SECTION_BODY = {
  instagram: InstagramSection,
  worker: WorkerSection,
  ai: AiSection,
  preferences: PreferencesSection,
  notifications: NotificationsSection,
  security: SecuritySection,
  data: DataSection,
  activity: ActivitySection,
  about: AboutSection,
};

function scrollToSection(id, smooth) {
  const el = document.getElementById(`settings-${id}`);
  if (!el) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: smooth && !reduce ? 'smooth' : 'auto', block: 'start' });
  el.focus({ preventScroll: true });
}

export default function Settings() {
  const { route } = useApp();
  const requested = SECTIONS.some((s) => s.id === route.query.section) ? route.query.section : null;
  const [active, setActive] = useState(requested || 'instagram');
  const first = useRef(true);

  useEffect(() => {
    if (requested) {
      setActive(requested);
      const smooth = !first.current;
      requestAnimationFrame(() => scrollToSection(requested, smooth));
    }
    first.current = false;
  }, [requested]);

  // Highlight the section in view.
  useEffect(() => {
    if (typeof IntersectionObserver !== 'function') return undefined;
    const els = SECTIONS.map((s) => document.getElementById(`settings-${s.id}`)).filter(Boolean);
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.dataset.section);
      },
      { rootMargin: '-72px 0px -65% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const jump = (id) => {
    setActive(id);
    if (id === requested) scrollToSection(id, true);
    else setQuery({ section: id });
  };

  return html`<div class="page settings-page">
    <${PageHeader} title="Settings" subtitle="Your Instagram connection, the worker, AI, notifications, security and data." />
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings sections">
        ${SECTIONS.map(
          (s) => html`<button key=${s.id} type="button" class=${cx('settings-nav-item', active === s.id && 'is-active')}
            aria-current=${active === s.id ? 'true' : undefined} onClick=${() => jump(s.id)}>
            <${Icon} name=${s.icon} size=${16} /><span>${s.label}</span>
          </button>`,
        )}
      </nav>
      <div class="settings-sections">
        ${SECTIONS.map((s) => {
          const Body = SECTION_BODY[s.id];
          const info = SECTION_INFO[s.id];
          return html`<${Panel} key=${s.id} id=${`settings-${s.id}`} data-section=${s.id} tabindex="-1" class="settings-section"
            title=${info.title} subtitle=${info.subtitle}>
            <${Body} />
          <//>`;
        })}
      </div>
    </div>
  </div>`;
}
