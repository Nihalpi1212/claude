// Setup stepper: 1 Connect Instagram, 2 Turn on the worker, 3 Preferences, 4 Done.
// Shown after the workspace is created and whenever Instagram is not connected.
// Also exports WorkerSetup, TimeZoneField and testAiKey, which Settings reuses.

import { createAi } from '../../core/ai.js';
import { b64decode, b64encode, utf8 } from '../../core/crypto.js';
import { browserTimeZone, formatDay, formatTime, isValidTimeZone } from '../../core/time.js';
import { html, useEffect, useId, useMemo, useRef, useState } from '../../vendor/preact.js';
import { useApp } from '../app.js';
import { DATA_KEY_SECRET, ENDPOINTS, WORKER_WORKFLOW } from '../config.js';
import { loadViewCss } from '../css.js';
import { mutate, refreshNow, useDoc } from '../data.js';
import { buildHash } from '../router.js';
import { AccountCard, ConnectInstagram, CopyButton, ExtLink, MessagesReminder } from '../ui/connect-instagram.js';
import { Icon } from '../ui/icons.js';
import { Badge, Button, Callout, Field, PageHeader, Spinner, TextInput, cx } from '../ui/kit.js';

loadViewCss('onboarding');

const STEPS = [
  { id: 'instagram', label: 'Connect Instagram' },
  { id: 'worker', label: 'Turn on the worker' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'done', label: 'Done' },
];

// ---------------------------------------------------------------------------
// Time zone field (native searchable list)
// ---------------------------------------------------------------------------

let zones = null;
export function timeZoneList() {
  if (!zones) {
    try {
      zones = Intl.supportedValuesOf('timeZone');
    } catch {
      zones = [];
    }
    if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  }
  return zones;
}

/** Canonical zone name for typed text ("europe/berlin" -> "Europe/Berlin"), or null. */
export function matchTimeZone(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const exact = timeZoneList().find((z) => z.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  return t.includes('/') && isValidTimeZone(t) ? t : null;
}

/** TimeZoneField {value, onChange(zone), label?} - type to search; only valid zones reach onChange. */
export function TimeZoneField({ value, onChange, label = 'Time zone', hint }) {
  const [text, setText] = useState(value || '');
  const listId = useId();
  useEffect(() => setText(value || ''), [value]);
  const zone = matchTimeZone(text);
  const device = browserTimeZone();
  const options = useMemo(() => timeZoneList(), []);
  const error = text && !zone ? 'Pick a time zone from the list, for example Europe/Berlin or America/New_York.' : null;
  return html`<${Field}
    label=${label}
    error=${error}
    hint=${zone ? html`It is ${formatTime(new Date(), zone)} there now. ${hint || ''}` : hint}
    action=${device && device !== zone
      ? html`<button type="button" class="link-btn" onClick=${() => (setText(device), onChange?.(device))}>Use ${device} (this device)</button>`
      : null}
  >
    <${TextInput}
      list=${listId}
      icon="globe"
      value=${text}
      placeholder="Search, for example Berlin"
      autocomplete="off"
      spellcheck=${false}
      onChange=${(v) => {
        setText(v);
        const z = matchTimeZone(v);
        if (z) onChange?.(z);
      }}
    />
    <datalist id=${listId}>${options.map((z) => html`<option key=${z} value=${z} />`)}</datalist>
  <//>`;
}

// ---------------------------------------------------------------------------
// AI key test (used here and in Settings)
// ---------------------------------------------------------------------------

/** Ask Claude for one sample reply with these settings. Resolves to the reply text; throws AiError. */
export async function testAiKey({ apiKey, model, voice, language }) {
  const { default: Anthropic } = await import('../../vendor/anthropic-sdk.js');
  const ai = createAi({ Anthropic, apiKey: String(apiKey || '').trim(), model, baseURL: ENDPOINTS.anthropic, dangerouslyAllowBrowser: true, voice, language });
  const replies = await ai.replySuggestions({ kind: 'comment', message: 'This is beautiful! Where can I buy one?', count: 1, voice, language });
  return replies[0] || '';
}

export function aiKeyWarning(key) {
  const k = String(key || '').trim();
  if (!k || k.startsWith('sk-ant-')) return null;
  return 'Anthropic API keys start with sk-ant-. Check that you copied the whole key.';
}

// ---------------------------------------------------------------------------
// Worker setup: save the data key as an Actions secret, check the workflow, run it once.
// ---------------------------------------------------------------------------

function githubError(err, what) {
  const status = err && err.status;
  if (status === 0) return { title: 'Could not reach GitHub', body: 'Check your internet connection and try again.' };
  if (status === 401) return { title: 'GitHub rejected your token', body: 'It may have expired. Lock Postpilot, create a new token on GitHub and unlock again.' };
  if (status === 403 && /rate limit/i.test(err.message || '')) return { title: 'GitHub rate limit reached', body: 'Wait a few minutes and try again.' };
  if (status === 403) {
    return {
      title: `Your GitHub token is not allowed to ${what}`,
      body: 'Edit the token on GitHub (Settings → Developer settings → Fine-grained tokens) and give this repository "Actions: Read and write" and "Secrets: Read and write", then try again.',
    };
  }
  return { title: `Could not ${what}`, body: (err && err.message) || String(err) };
}

function runSummary(run) {
  const c = run.counts || {};
  const parts = [];
  if (c.published) parts.push(`${c.published} published`);
  if (c.snapshots) parts.push(`${c.snapshots} analytics snapshot${c.snapshots === 1 ? '' : 's'}`);
  if (c.replies) parts.push(`${c.replies} replies`);
  if (c.stories) parts.push(`${c.stories} stories saved`);
  return parts.join(', ');
}

/**
 * WorkerSetup {onContinue?, continueLabel?, onSkip?}
 * Saves POSTPILOT_DATA_KEY (sealed box of the base64 data key) as a repository secret, checks
 * that the workflow exists and is enabled, and lets the owner run it once and watch the result.
 */
export function WorkerSetup({ onContinue, continueLabel = 'Continue', onSkip }) {
  const { session, dispatchWorker, toast, tz } = useApp();
  const { gh, owner, repo } = session;
  const { data: log } = useDoc('log');
  const [secret, setSecret] = useState(undefined); // undefined: checking, null: missing, 'forbidden', {updated_at}
  const [workflow, setWorkflow] = useState(undefined); // undefined: checking, null: missing, 'forbidden', {state}
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(null);
  const [manual, setManual] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [watch, setWatch] = useState(null); // { since, baseline, ghRun, slow, record }
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  const keyText = useMemo(() => (session.dataKeyRaw ? b64encode(session.dataKeyRaw) : ''), [session]);

  async function checkWorkflow() {
    try {
      const wf = await gh.getWorkflow(WORKER_WORKFLOW);
      if (alive.current) setWorkflow(wf || null);
      return wf || null;
    } catch (err) {
      if (alive.current) setWorkflow(err.status === 403 ? 'forbidden' : 'error');
      return 'error';
    }
  }

  async function checkAll() {
    const [s] = await Promise.all([
      gh.getSecret(DATA_KEY_SECRET).catch((err) => (err.status === 403 ? 'forbidden' : undefined)),
      checkWorkflow(),
      gh.getRepo().then((r) => alive.current && r && r.default_branch && setBranch(r.default_branch)).catch(() => {}),
    ]);
    if (alive.current) setSecret(s === undefined ? 'unknown' : s);
  }

  useEffect(() => {
    checkAll();
  }, []);

  async function connect() {
    setError(null);
    setBusy('Encrypting your data key for GitHub…');
    let pk;
    try {
      pk = await gh.getSecretsPublicKey();
    } catch (err) {
      setBusy('');
      if (err.status === 403 || err.status === 404) {
        setManual(true);
        setError({
          title: 'Your GitHub token cannot save Actions secrets',
          body: 'Either give the token "Secrets: Read and write" for this repository and click "Connect worker" again, or add the secret yourself with the steps below.',
          tone: 'warning',
        });
      } else setError(githubError(err, 'save the secret'));
      return;
    }
    try {
      const { sealedBox } = await import('../../vendor/sealed-box.js');
      const sealed = sealedBox(utf8(keyText), b64decode(pk.key));
      setBusy('Saving it as a repository secret…');
      await gh.putSecret(DATA_KEY_SECRET, b64encode(sealed), pk.key_id);
      setSecret({ name: DATA_KEY_SECRET, updated_at: new Date().toISOString() });
      setManual(false);
      setBusy('Checking the worker workflow…');
      await checkWorkflow();
      await mutate('settings', (s) => {
        s.ui = { ...(s.ui || {}), workerConnectedAt: new Date().toISOString() };
      }, { message: 'worker connected', silent: true }).catch(() => {});
      toast('Worker connected. It can now read your encrypted data.', { kind: 'success' });
    } catch (err) {
      if (err.status === 403) {
        setManual(true);
        setError({ ...githubError(err, 'save Actions secrets'), tone: 'warning' });
      } else setError(githubError(err, 'save the secret'));
    } finally {
      if (alive.current) setBusy('');
    }
  }

  async function enableSchedule() {
    setError(null);
    setBusy('Turning the schedule back on…');
    try {
      await gh.request('PUT', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${WORKER_WORKFLOW}/enable`);
      await checkWorkflow();
      toast('The worker schedule is on again.', { kind: 'success' });
    } catch (err) {
      setError(githubError(err, 'turn the workflow on'));
    } finally {
      if (alive.current) setBusy('');
    }
  }

  async function runNow() {
    setError(null);
    const baseline = (log && log.runs && log.runs[0] && log.runs[0].startedAt) || null;
    setWatch({ since: Date.now(), baseline, ghRun: null, slow: false, record: null });
    try {
      await dispatchWorker('setup check');
    } catch (err) {
      setWatch(null);
      if (err.status === 422) {
        setError({ title: 'GitHub cannot start this workflow from the app', body: `The workflow file on "${branch}" needs the "workflow_dispatch" trigger. Use the file that ships with Postpilot.` });
      } else if (err.status === 404) {
        setError({ title: 'GitHub could not find the worker workflow', body: `Add .github/workflows/${WORKER_WORKFLOW} to the default branch "${branch}", then try again.` });
      } else setError(githubError(err, 'start the worker'));
    }
  }

  // While waiting: pull fresh data and the GitHub run status every few seconds.
  useEffect(() => {
    if (!watch || watch.record) return undefined;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      refreshNow().catch(() => {});
      try {
        const runs = await gh.listWorkflowRuns(WORKER_WORKFLOW, { perPage: 3 });
        const mine = (runs || []).find((r) => Date.parse(r.created_at) >= watch.since - 90_000);
        if (!stopped && alive.current && mine) setWatch((w) => (w ? { ...w, ghRun: mine } : w));
      } catch {
        /* status is a nicety */
      }
      if (!stopped && alive.current && Date.now() - watch.since > 6 * 60_000) setWatch((w) => (w ? { ...w, slow: true } : w));
    };
    const first = setTimeout(tick, 1500);
    const id = setInterval(tick, 5000);
    return () => {
      stopped = true;
      clearTimeout(first);
      clearInterval(id);
    };
  }, [watch && watch.since, watch && !!watch.record]);

  // The worker writes a run record into the log document when it finishes.
  useEffect(() => {
    if (!watch || watch.record) return;
    const latest = log && log.runs && log.runs[0];
    // A new record, finished after we asked (with slack for clock differences between GitHub and this device).
    const fresh = latest && Date.parse(latest.finishedAt || latest.startedAt) >= watch.since - 5 * 60_000;
    if (latest && fresh && latest.startedAt !== watch.baseline) {
      setWatch((w) => (w ? { ...w, record: latest } : w));
      mutate('settings', (s) => {
        s.ui = { ...(s.ui || {}), workerFirstRunAt: s.ui?.workerFirstRunAt || new Date().toISOString() };
      }, { message: 'worker first run', silent: true }).catch(() => {});
    }
  }, [log, watch]);

  const secretOk = secret && typeof secret === 'object';
  const wfOk = workflow && typeof workflow === 'object' && workflow.state === 'active';
  const wfDisabled = workflow && typeof workflow === 'object' && workflow.state && workflow.state !== 'active';
  const checking = secret === undefined || workflow === undefined;
  const ghRunFailed = watch && !watch.record && watch.ghRun && watch.ghRun.status === 'completed' && watch.ghRun.conclusion && watch.ghRun.conclusion !== 'success';
  const runUrl = watch && watch.ghRun && watch.ghRun.html_url && /^https:\/\//.test(watch.ghRun.html_url) ? watch.ghRun.html_url : null;
  const actionsUrl = `https://github.com/${owner}/${repo}/actions/workflows/${WORKER_WORKFLOW}`;

  return html`<div class="ws stack">
    <p class="ws-intro">
      The worker is a small program that runs in your repository's GitHub Actions every 10 minutes. It publishes scheduled posts, answers
      comments and DMs with your rules, saves story insights before they expire and takes a daily analytics snapshot. To read your
      encrypted data it needs your data key, stored as a repository secret that only GitHub Actions can read.
    </p>

    <ul class="ws-checks" aria-live="polite">
      <li class=${cx('ws-check', secretOk ? 'is-ok' : secret === undefined ? '' : 'is-todo')}>
        <span class="ws-check-icon">${secret === undefined ? html`<${Spinner} size=${14} label="Checking" />` : html`<${Icon} name=${secretOk ? 'check' : 'circle'} size=${14} />`}</span>
        <span>
          <strong>Data key secret</strong>
          <span class="muted">${secretOk
            ? ` saved${secret.updated_at ? ` ${formatDay(secret.updated_at, tz)}` : ''}`
            : secret === 'forbidden'
              ? ' cannot be checked with this token (it has no access to secrets)'
              : secret === undefined
                ? ' checking…'
                : ' not saved yet'}</span>
        </span>
      </li>
      <li class=${cx('ws-check', wfOk ? 'is-ok' : workflow === undefined ? '' : 'is-todo')}>
        <span class="ws-check-icon">${workflow === undefined ? html`<${Spinner} size=${14} label="Checking" />` : html`<${Icon} name=${wfOk ? 'check' : 'circle'} size=${14} />`}</span>
        <span>
          <strong>Worker workflow</strong>
          <span class="muted">${wfOk
            ? ` found on ${branch}, schedule on`
            : workflow === null
              ? ` missing on the default branch (${branch})`
              : wfDisabled
                ? ' turned off on GitHub'
                : workflow === 'forbidden'
                  ? ' cannot be checked with this token (it has no access to Actions)'
                  : workflow === undefined
                    ? ' checking…'
                    : ' could not be checked'}</span>
        </span>
      </li>
    </ul>

    ${workflow === null
      ? html`<${Callout} tone="danger" title="The worker workflow is missing"
          action=${html`<${Button} size="sm" variant="secondary" icon="refresh" onClick=${() => checkWorkflow()}>Check again<//>`}>
          GitHub only runs workflows that are on the default branch (<span class="mono">${branch}</span>) of <span class="mono">${owner}/${repo}</span>. Add <span class="mono">.github/workflows/${WORKER_WORKFLOW}</span> from Postpilot to that branch
          (or merge the branch that has it), then click Check again. <${ExtLink} href=${`https://github.com/${owner}/${repo}/tree/${branch}/.github/workflows`}>Open the workflows folder<//>
        <//>`
      : null}
    ${wfDisabled
      ? html`<${Callout} tone="warning" title=${workflow.state === 'disabled_inactivity' ? 'GitHub paused the worker schedule' : 'The worker workflow is turned off'}
          action=${html`<${Button} size="sm" variant="secondary" loading=${!!busy} onClick=${enableSchedule}>Turn it back on<//>`}>
          ${workflow.state === 'disabled_inactivity'
            ? 'In public repositories GitHub turns off scheduled workflows after 60 days without activity. Turn it back on to resume publishing.'
            : 'Someone turned the workflow off in the Actions tab. Turn it back on so the worker can run.'}
        <//>`
      : null}
    ${workflow === 'forbidden'
      ? html`<${Callout} tone="warning" title="Your token cannot see GitHub Actions">
          Give the token "Actions: Read and write" for this repository so Postpilot can start the worker and show its runs.
        <//>`
      : null}

    ${error ? html`<${Callout} tone=${error.tone || 'danger'} title=${error.title}>${error.body}<//>` : null}

    ${manual
      ? html`<div class="ws-manual">
          <ol class="ci-steps">
            <li>
              Copy your data key.
              <div class="ws-key">
                <code class="ws-key-value">${reveal ? keyText : '•'.repeat(24)}</code>
                <${Button} size="sm" variant="ghost" icon=${reveal ? 'eye-off' : 'eye'} onClick=${() => setReveal((r) => !r)}>${reveal ? 'Hide' : 'Show'}<//>
                <${CopyButton} text=${keyText} label="Copy key" />
              </div>
            </li>
            <li>
              Open <${ExtLink} href=${`https://github.com/${owner}/${repo}/settings/secrets/actions/new`}>New repository secret on GitHub<//>.
            </li>
            <li>
              Name it <code>${DATA_KEY_SECRET}</code> <${CopyButton} text=${DATA_KEY_SECRET} label="Copy name" variant="ghost" />, paste the key as the
              secret and click <strong>Add secret</strong>.
            </li>
            <li>Come back here and click <strong>Run worker now</strong> to test it.</li>
          </ol>
          <p class="muted text-sm">Keep the key private. Together with access to your repository it can decrypt your Postpilot data.</p>
        </div>`
      : null}

    ${busy ? html`<p class="ws-busy" role="status"><${Spinner} size=${14} label="" /> ${busy}</p>` : null}

    ${watch
      ? html`<div class="ws-run" aria-live="polite">
          ${watch.record
            ? watch.record.ok !== false && !(watch.record.errors || []).length
              ? html`<${Callout} tone="success" title="The worker ran successfully">
                  It finished in ${Math.max(1, Math.round((watch.record.durationMs || 0) / 1000))} s${runSummary(watch.record) ? ` (${runSummary(watch.record)})` : ''}.
                  From now on it runs every 10 minutes on its own.
                <//>`
              : html`<${Callout} tone="warning" title="The worker ran but reported problems">
                  <ul class="ws-errors">${(watch.record.errors || []).map((e, i) => html`<li key=${i}><strong>${e.job}:</strong> ${e.message}</li>`)}</ul>
                  ${!(watch.record.errors || []).length ? html`<p>A post failed to publish. Open the Planner to see why.</p>` : null}
                  <p>Details are in Settings → Activity log.</p>
                <//>`
            : ghRunFailed
              ? html`<${Callout} tone="danger" title="The worker run failed on GitHub">
                  It stopped before it could save its log. Most often the data key secret does not match this workspace: click
                  "Connect worker" to save it again.${runUrl ? html` <${ExtLink} href=${runUrl}>Open the run on GitHub<//>` : null}
                <//>`
              : html`<p class="ws-busy" role="status">
                  <${Spinner} size=${14} label="" />
                  ${watch.ghRun
                    ? watch.ghRun.status === 'in_progress'
                      ? 'The worker is running…'
                      : 'GitHub queued the run. Waiting for it to start…'
                    : 'Asking GitHub to start the worker. This usually takes under a minute…'}
                </p>
                ${watch.slow
                  ? html`<${Callout} tone="info" title="Still waiting">
                      GitHub sometimes takes a few minutes to start a run. You can continue; check the run on GitHub later. <${ExtLink} href=${actionsUrl}>Open the worker in GitHub Actions<//>
                    <//>`
                  : null}`}
        </div>`
      : null}

    <div class="row">
      ${!secretOk || manual
        ? html`<${Button} variant="primary" icon="key" loading=${!!busy && !watch} disabled=${checking && !secret} onClick=${connect}>Connect worker<//>`
        : html`<${Button} variant=${watch && watch.record ? 'secondary' : 'primary'} icon="play" disabled=${!!busy || (watch && !watch.record && !watch.slow && !ghRunFailed)}
            onClick=${runNow}>${watch && watch.record ? 'Run again' : 'Run worker now'}<//>`}
      ${secretOk && !manual ? html`<${Button} variant="ghost" icon="key" disabled=${!!busy} onClick=${connect}>Save the key again<//>` : null}
      ${manual ? html`<${Button} variant="secondary" icon="play" onClick=${runNow} disabled=${watch && !watch.record && !watch.slow}>Run worker now<//>` : null}
      <span class="spacer"></span>
      ${onSkip && !(watch && watch.record) ? html`<${Button} variant="ghost" onClick=${onSkip}>Skip for now<//>` : null}
      ${onContinue ? html`<${Button} variant=${watch && watch.record ? 'primary' : 'secondary'} iconRight="arrow-right" disabled=${!secretOk && !manual && !(watch && watch.record)}
        onClick=${onContinue}>${continueLabel}<//>` : null}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function InstagramStep({ onNext }) {
  const { settings, toast } = useApp();
  const [replace, setReplace] = useState(false);
  const ig = settings.ig;

  async function save(conn) {
    await mutate('settings', (s) => {
      s.ig = conn;
    }, { message: 'connect instagram' });
    toast(`Connected @${conn.username}.`, { kind: 'success' });
    setReplace(false);
    onNext();
  }

  if (ig && !replace) {
    return html`<div class="stack">
      <h2 class="ob-step-title">Instagram is connected</h2>
      <${AccountCard} connection=${ig} />
      <${MessagesReminder} />
      <div class="row">
        <${Button} variant="primary" iconRight="arrow-right" onClick=${onNext}>Continue<//>
        <${Button} variant="ghost" onClick=${() => setReplace(true)}>Use a different account<//>
      </div>
    </div>`;
  }
  return html`<div class="stack">
    <div>
      <h2 class="ob-step-title">Connect your Instagram account</h2>
      <p class="muted">Postpilot talks to Instagram with an access token from your own Meta app. It takes about five minutes, once.</p>
    </div>
    <${ConnectInstagram} initialMode=${(ig && ig.mode) || 'instagram'} onConnected=${save} onCancel=${replace ? () => setReplace(false) : undefined} />
  </div>`;
}

function initialZone(settings) {
  const device = browserTimeZone();
  const tz = settings.timezone;
  if (settings.ui && settings.ui.prefsSavedAt) return tz || device;
  return !tz || tz === 'UTC' ? device || 'UTC' : tz;
}

function PreferencesStep({ onNext, onBack }) {
  const { settings, toast } = useApp();
  const [tz, setTz] = useState(() => initialZone(settings));
  const [apiKey, setApiKey] = useState((settings.ai && settings.ai.apiKey) || '');
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);

  async function runTest() {
    setTest(null);
    if (!apiKey.trim()) return setTest({ ok: false, text: 'Paste an API key first.' });
    setTesting(true);
    try {
      const reply = await testAiKey({ apiKey, model: (settings.ai && settings.ai.model) || 'claude-opus-5-5', voice: settings.ai?.voice, language: settings.ai?.language });
      setTest({ ok: true, text: reply });
    } catch (err) {
      setTest({ ok: false, text: err.userMessage || err.message || String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function save(e) {
    e.preventDefault();
    if (!isValidTimeZone(tz)) return;
    setSaving(true);
    const key = apiKey.trim();
    try {
      await mutate('settings', (s) => {
        s.timezone = tz;
        s.ai = { ...(s.ai || {}), apiKey: key, enabled: key ? true : !!(s.ai && s.ai.enabled && s.ai.apiKey) };
        s.ui = { ...(s.ui || {}), prefsSavedAt: new Date().toISOString() };
      }, { message: 'preferences' });
      toast('Preferences saved.', { kind: 'success' });
      onNext();
    } catch {
      /* mutate already showed the error */
    } finally {
      setSaving(false);
    }
  }

  const warn = aiKeyWarning(apiKey);
  return html`<form class="stack" onSubmit=${save}>
    <div>
      <h2 class="ob-step-title">Preferences</h2>
      <p class="muted">Times in the planner, analytics and the worker's daily snapshot follow this time zone.</p>
    </div>
    <${TimeZoneField} value=${tz} onChange=${setTz} />
    <${Field}
      label="Anthropic API key (optional)"
      hint=${html`Turns on AI captions, hashtag ideas and reply suggestions. Create a key at <${ExtLink} href="https://console.anthropic.com/settings/keys">console.anthropic.com → API keys<//>; usage is billed to your Anthropic account.`}
      error=${warn}
      action=${html`<button type="button" class="link-btn" onClick=${() => setReveal((r) => !r)}>${reveal ? 'Hide' : 'Show'}</button>`}
    >
      <${TextInput} type=${reveal ? 'text' : 'password'} mono value=${apiKey} onChange=${(v) => (setApiKey(v), setTest(null))} placeholder="sk-ant-…" autocomplete="off" spellcheck=${false} />
    <//>
    ${test
      ? html`<${Callout} tone=${test.ok ? 'success' : 'danger'} title=${test.ok ? 'Claude answered' : 'The key did not work'}>${test.ok ? html`<q>${test.text}</q>` : test.text}<//>`
      : null}
    <div class="row">
      <${Button} type="submit" variant="primary" iconRight="arrow-right" loading=${saving} disabled=${!isValidTimeZone(tz)}>Save and continue<//>
      ${apiKey.trim() ? html`<${Button} variant="secondary" icon="sparkle" loading=${testing} onClick=${runTest}>Test key<//>` : null}
      <span class="spacer"></span>
      <${Button} variant="ghost" icon="arrow-left" onClick=${onBack}>Back<//>
    </div>
  </form>`;
}

function DoneStep() {
  const { settings, navigate, openComposer } = useApp();
  const ui = settings.ui || {};
  const ig = settings.ig;
  const workerOn = !!(ui.workerFirstRunAt || ui.workerConnectedAt);
  const ai = !!(settings.ai && settings.ai.enabled && settings.ai.apiKey);
  useEffect(() => {
    if (!ui.onboardedAt) {
      mutate('settings', (s) => {
        s.ui = { ...(s.ui || {}), onboardedAt: s.ui?.onboardedAt || new Date().toISOString() };
      }, { message: 'setup finished', silent: true }).catch(() => {});
    }
  }, []);
  const item = (ok, title, body, fix) => html`<li class=${cx('ob-done-item', ok ? 'is-ok' : 'is-todo')}>
    <span class="ws-check-icon"><${Icon} name=${ok ? 'check' : 'alert'} size=${14} /></span>
    <span><strong>${title}</strong><span class="muted"> ${body}</span>${fix ? html` <a href=${fix.href}>${fix.label}</a>` : null}</span>
  </li>`;
  return html`<div class="stack">
    <div>
      <h2 class="ob-step-title">You're set up</h2>
      <p class="muted">Here is what Postpilot will do for you. You can change any of it in Settings.</p>
    </div>
    <ul class="ob-done">
      ${item(!!ig, 'Instagram', ig ? `connected as @${ig.username}.` : 'not connected.', ig ? null : { href: '#/onboarding?step=instagram', label: 'Connect' })}
      ${item(workerOn, 'Worker', workerOn ? 'publishes, replies and saves analytics every 10 minutes.' : 'not turned on yet, so scheduled posts will not publish.', workerOn ? null : { href: '#/settings?section=worker', label: 'Turn it on' })}
      ${item(true, 'Time zone', `${settings.timezone}.`)}
      ${item(ai, 'AI', ai ? 'captions, hashtags and reply suggestions are on.' : 'off. Add an Anthropic key in Settings any time.', null)}
    </ul>
    <div class="row">
      <${Button} variant="primary" icon="plus" onClick=${() => (navigate('#/planner'), openComposer())}>Plan your first post<//>
      <${Button} variant="secondary" onClick=${() => navigate('#/')}>Go to Today<//>
      <${Button} variant="ghost" icon="link" onClick=${() => navigate('#/bio')}>Set up your link in bio<//>
    </div>
  </div>`;
}

export default function Onboarding() {
  const { settings, route, navigate, session } = useApp();

  // The app shows setup on any route while Instagram is missing. Pin the URL to #/onboarding so the
  // remaining steps stay on screen once Instagram is connected.
  useEffect(() => {
    if (route.name !== 'onboarding') {
      history.replaceState(null, '', buildHash('onboarding', {}));
      globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, [route.name]);

  const ui = settings.ui || {};
  const requested = route.name === 'onboarding' ? route.query.step : null;
  let step = STEPS.some((s) => s.id === requested) ? requested : settings.ig ? 'worker' : 'instagram';
  if (!settings.ig) step = 'instagram';
  const go = (id) => navigate(buildHash('onboarding', { step: id }));

  const done = {
    instagram: !!settings.ig,
    worker: !!(ui.workerConnectedAt || ui.workerFirstRunAt),
    preferences: !!ui.prefsSavedAt,
    done: !!ui.onboardedAt,
  };

  const stepIndex = STEPS.findIndex((s) => s.id === step);
  return html`<div class="page onboarding">
    <${PageHeader} eyebrow="Setup" title="Set up Postpilot" subtitle="Four short steps. Everything can be changed later in Settings." />
    <nav aria-label="Setup steps">
      <ol class="ob-steps">
        ${STEPS.map((s, i) => {
          const reachable = i === 0 || !!settings.ig;
          const current = s.id === step;
          return html`<li key=${s.id} class=${cx('ob-step', current && 'is-current', done[s.id] && !current && 'is-done')}>
            <button type="button" class="ob-step-btn" disabled=${!reachable} aria-current=${current ? 'step' : undefined} onClick=${() => go(s.id)}>
              <span class="ob-step-no" aria-hidden="true">${done[s.id] && !current ? html`<${Icon} name="check" size=${13} strokeWidth=${2.5} />` : String(i + 1).padStart(2, '0')}</span>
              <span class="ob-step-label">${s.label}</span>
              ${done[s.id] && !current ? html`<span class="sr-only"> (done)</span>` : null}
            </button>
          </li>`;
        })}
      </ol>
    </nav>
    <section class="panel ob-panel" aria-label=${`Step ${stepIndex + 1} of ${STEPS.length}: ${STEPS[stepIndex].label}`}>
      <div class="panel-body">
        ${step === 'instagram' ? html`<${InstagramStep} onNext=${() => go('worker')} />` : null}
        ${step === 'worker'
          ? html`<div class="stack">
              <div>
                <h2 class="ob-step-title">Turn on the worker <${Badge} tone="outline">GitHub Actions<//></h2>
                <p class="muted">One click saves your data key as a secret in <span class="mono">${session.owner}/${session.repo}</span>.</p>
              </div>
              <${WorkerSetup}
                onContinue=${() => go('preferences')}
                onSkip=${() => {
                  mutate('settings', (s) => {
                    s.ui = { ...(s.ui || {}), workerSkippedAt: new Date().toISOString() };
                  }, { silent: true }).catch(() => {});
                  go('preferences');
                }}
              />
            </div>`
          : null}
        ${step === 'preferences' ? html`<${PreferencesStep} onNext=${() => go('done')} onBack=${() => go('worker')} />` : null}
        ${step === 'done' ? html`<${DoneStep} />` : null}
      </div>
    </section>
  </div>`;
}
