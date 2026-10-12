// Automations: keyword rules for comments and DMs, welcome message, blocked words, limits and activity.

import { uid } from '../../core/model.js';
import { formatDateTime, relative } from '../../core/time.js';
import { html, useEffect, useMemo, useRef, useState } from '../../vendor/preact.js';
import { getAi } from '../ai-client.js';
import { useApp } from '../app.js';
import { loadViewCss } from '../css.js';
import { getStore, mutate, refreshNow, useDocs } from '../data.js';
import { Icon } from '../ui/icons.js';
import { Badge, Button, Callout, ChipInput, EmptyState, Field, IconButton, Menu, PageHeader, Panel, Select, Skeleton, Stat, TextArea, TextInput, Toggle, cx } from '../ui/kit.js';
import { RuleEditor, STARTER_TEMPLATES, actionsSummary, triggerSummary } from '../ui/rule-editor.js';

loadViewCss('automations');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DM_PROBLEMS = {
  needs_advanced_access: {
    title: 'DM replies are limited until Meta approves your app',
    body: 'Instagram only lets your app message people who have a role on it until it gets Advanced Access to instagram_business_manage_messages. Apply through App Review in the Meta App Dashboard. Comment replies keep working meanwhile.',
  },
  dm_disabled: {
    title: 'Message access is turned off in Instagram',
    body: 'In the Instagram app open Settings → Messages and story replies → Message controls → Connected tools and turn on “Allow access to messages”. Postpilot checks again every few hours.',
  },
  no_permission: {
    title: 'Postpilot cannot read your messages',
    body: 'The Instagram connection is missing the messages permission. Replace the token in Settings with one that includes instagram_business_manage_messages.',
  },
};

const SKIP_REASONS = {
  ai_declined: 'The AI chose not to reply (spam, or it needs a person).',
  ai_not_configured: 'Skipped: AI replies need an Anthropic API key.',
  dm_blocked: 'Skipped: Instagram is blocking DMs for this app.',
  dm_hourly_limit: 'Skipped: the hourly DM limit was reached.',
  outside_window: 'Skipped: outside Instagram’s reply window.',
};

function who(u) {
  return u ? `@${String(u).replace(/^@/, '')}` : 'someone';
}

/** Plain-language line for one automations.activity entry. */
function describeActivity(a) {
  const u = who(a.username);
  const verb = {
    reply_comment: `Replied to ${u}’s comment`,
    private_reply: `Sent ${u} a private reply`,
    send_dm: a.ruleName === 'Welcome message' ? `Welcomed ${u} in DMs` : `Replied to ${u} in DMs`,
    hide_comment: `Hid a comment from ${u}`,
    delete_comment: `Deleted a comment from ${u}`,
    ai_reply: `AI reply to ${u}`,
  }[a.type] || `${String(a.type || 'Action').replace(/_/g, ' ')} for ${u}`;
  if (a.ok) return verb;
  if (a.skipped) return `${verb.replace(/^(Replied|Sent|Welcomed|Hid|Deleted)/, (m) => ({ Replied: 'Did not reply', Sent: 'Did not send', Welcomed: 'Did not welcome', Hid: 'Did not hide', Deleted: 'Did not delete' })[m])}`;
  return `Could not finish: ${verb.charAt(0).toLowerCase()}${verb.slice(1)}`;
}

function RuleCard({ rule, index, count, onToggle, onMove, onEdit, onDuplicate, onDelete, busy }) {
  const fired = (rule.stats && rule.stats.fired) || 0;
  const last = rule.stats && rule.stats.lastFiredAt;
  return html`<li class=${cx('auto-rule', !rule.enabled && 'is-off')} data-rule-id=${rule.id}>
    <span class="auto-rule-no mono" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
    <div class="auto-rule-main">
      <div class="auto-rule-title">
        <button type="button" class="auto-rule-name" onClick=${onEdit}>${rule.name || 'Untitled rule'}</button>
        ${!rule.enabled ? html`<${Badge} tone="outline">Paused<//>` : null}
        ${rule.oncePerUser ? html`<${Badge} tone="neutral">Once per person<//>` : null}
      </div>
      <p class="auto-rule-when"><${Icon} name=${rule.trigger && rule.trigger.source === 'dm' ? 'message' : 'comment'} size=${14} />${triggerSummary(rule)}</p>
      <p class="auto-rule-then muted"><${Icon} name="arrow-right" size=${14} />${actionsSummary(rule) || 'No actions'}</p>
      <p class="auto-rule-stats faint text-sm">
        ${fired ? html`Fired <span class="num">${fired}</span> ${fired === 1 ? 'time' : 'times'}${last ? html` · last <time datetime=${last} title=${last}>${relative(last)}</time>` : null}` : 'Not fired yet'}
      </p>
    </div>
    <div class="auto-rule-side">
      <${Toggle} checked=${!!rule.enabled} disabled=${busy} aria-label=${`${rule.enabled ? 'Pause' : 'Turn on'} rule ${rule.name}`} onChange=${onToggle} />
      <div class="auto-rule-tools">
        <${IconButton} icon="arrow-up" size="sm" label=${`Move ${rule.name} up`} disabled=${index === 0 || busy} onClick=${() => onMove(-1)} />
        <${IconButton} icon="arrow-down" size="sm" label=${`Move ${rule.name} down`} disabled=${index === count - 1 || busy} onClick=${() => onMove(1)} />
        <${Menu} label=${`More actions for ${rule.name}`} size="sm"
          items=${[
            { label: 'Edit', icon: 'edit', onClick: onEdit },
            { label: 'Duplicate', icon: 'copy', onClick: onDuplicate },
            '-',
            { label: 'Delete', icon: 'trash', danger: true, onClick: onDelete },
          ]} />
      </div>
    </div>
  </li>`;
}

function ActivityFeed({ activity, logEntries, tz, onRefresh, refreshing }) {
  const [limit, setLimit] = useState(15);
  const items = useMemo(() => {
    const a = (activity || []).map((x, i) => ({ kind: 'action', at: x.at, key: `a${i}${x.at}`, x }));
    const l = (logEntries || []).map((x, i) => ({ kind: 'log', at: x.at, key: `l${i}${x.at}`, x }));
    return [...a, ...l].sort((p, q) => String(q.at).localeCompare(String(p.at)));
  }, [activity, logEntries]);
  return html`<${Panel} title="Activity" subtitle="What the automations did recently, newest first." flush class="auto-activity"
    actions=${html`<${Button} size="sm" variant="ghost" icon="refresh" loading=${refreshing} onClick=${onRefresh}>Refresh<//>`}>
    ${!items.length
      ? html`<${EmptyState} compact icon="bolt" title="Nothing yet" body="Replies, DMs and hidden comments show up here after the worker runs." />`
      : html`<ul class="list auto-feed">
          ${items.slice(0, limit).map((it) => {
            if (it.kind === 'log') {
              const e = it.x;
              const tone = e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : 'info';
              return html`<li class=${cx('list-row auto-feed-row', `is-log-${tone}`)} key=${it.key}>
                <span class="auto-feed-icon" aria-hidden="true"><${Icon} name=${tone === 'info' ? 'info' : 'alert'} size=${16} /></span>
                <div class="grow">
                  <p class=${cx('auto-feed-line', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>${e.message}</p>
                </div>
                <time class="auto-feed-time faint mono" datetime=${e.at} title=${formatDateTime(e.at, tz)}>${relative(e.at)}</time>
              </li>`;
            }
            const a = it.x;
            const icon = { reply_comment: 'comment', private_reply: 'send', send_dm: 'message', hide_comment: 'eye', delete_comment: 'trash' }[a.type] || 'bolt';
            return html`<li class=${cx('list-row auto-feed-row', a.ok ? 'is-ok' : a.skipped ? 'is-skip' : 'is-fail')} key=${it.key}>
              <span class="auto-feed-icon" aria-hidden="true"><${Icon} name=${icon} size=${16} /></span>
              <div class="grow">
                <p class="auto-feed-line">
                  <span class="strong">${describeActivity(a)}</span>
                  ${a.ruleName ? html` <span class="muted">· ${a.ruleName}</span>` : null}
                </p>
                ${a.text ? html`<p class="auto-feed-text muted clamp-2">“${a.text}”</p>` : null}
                ${a.skipped ? html`<p class="auto-feed-text text-warn text-sm">${SKIP_REASONS[a.skipped] || a.skipped}</p>` : null}
                ${a.error ? html`<p class="auto-feed-text text-bad text-sm">${a.error}</p>` : null}
              </div>
              <time class="auto-feed-time faint mono" datetime=${a.at} title=${formatDateTime(a.at, tz)}>${relative(a.at)}</time>
            </li>`;
          })}
        </ul>
        ${items.length > limit ? html`<div class="auto-feed-more"><${Button} size="sm" variant="ghost" onClick=${() => setLimit((n) => n + 20)}>Show more<//></div>` : null}`}
  <//>`;
}

function WelcomePanel({ doc, onSave }) {
  const w = doc.welcome || { enabled: false, text: '' };
  const [text, setText] = useState(w.text || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => setText(w.text || ''), [w.text]);
  const dirty = text.trim() !== String(w.text || '').trim();
  const save = async (patch, msg) => {
    setSaving(true);
    try {
      await onSave((d) => {
        d.welcome = { ...(d.welcome || {}), ...patch };
      }, msg);
    } finally {
      setSaving(false);
    }
  };
  return html`<${Panel} title="Welcome message" subtitle="Sent once to people who message you for the first time, when no rule matches.">
    <div class="stack">
      <${Toggle} checked=${!!w.enabled} disabled=${saving} label="Send a welcome message" onChange=${(v) => save({ enabled: v }, v ? 'Welcome message on' : 'Welcome message off')} />
      <${Field} label="Message" hint="Use {first_name} or {username}. Instagram limits DMs to 1,000 characters.">
        <${TextArea} value=${text} rows=${3} maxRows=${8} disabled=${saving} onChange=${setText} />
      <//>
      <div class="row row-end">
        <${Button} size="sm" variant="secondary" disabled=${!dirty || !text.trim() || text.length > 1000} loading=${saving} onClick=${() => save({ text: text.trim() }, 'Welcome message saved')}>Save message<//>
      </div>
    </div>
  <//>`;
}

function BlockedPanel({ doc, onSave }) {
  const b = doc.blockedWords || { enabled: false, words: [], action: 'hide' };
  const [words, setWords] = useState(b.words || []);
  const [action, setAction] = useState(b.action || 'hide');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setWords(b.words || []);
    setAction(b.action || 'hide');
  }, [JSON.stringify(b.words || []), b.action]);
  const dirty = JSON.stringify(words) !== JSON.stringify(b.words || []) || action !== (b.action || 'hide');
  const save = async (patch, msg) => {
    setSaving(true);
    try {
      await onSave((d) => {
        d.blockedWords = { enabled: false, words: [], action: 'hide', ...(d.blockedWords || {}), ...patch };
      }, msg);
    } finally {
      setSaving(false);
    }
  };
  return html`<${Panel} title="Blocked words" subtitle="Comments with these words are hidden and get no automatic reply. Messages with them are not answered.">
    <div class="stack">
      <${Toggle} checked=${!!b.enabled} disabled=${saving} label="Filter blocked words" onChange=${(v) => save({ enabled: v }, v ? 'Blocked words on' : 'Blocked words off')} />
      <${Field} label="Words and phrases" hint="Same matching as rule keywords.">
        <${ChipInput} values=${words} placeholder="Type a word and press Enter" onChange=${setWords} />
      <//>
      <${Field} label="What to do with the comment">
        <${Select} value=${action} onChange=${setAction} options=${[{ value: 'hide', label: 'Hide it (recommended)' }, { value: 'delete', label: 'Delete it' }]} />
      <//>
      <div class="row row-end">
        <${Button} size="sm" variant="secondary" disabled=${!dirty} loading=${saving} onClick=${() => save({ words, action }, 'Blocked words saved')}>Save blocked words<//>
      </div>
    </div>
  <//>`;
}

function LimitsPanel({ doc, onSave }) {
  const l = { maxActionsPerRun: 25, maxDmsPerHour: 40, ...(doc.limits || {}) };
  const [perRun, setPerRun] = useState(l.maxActionsPerRun);
  const [perHour, setPerHour] = useState(l.maxDmsPerHour);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setPerRun(l.maxActionsPerRun);
    setPerHour(l.maxDmsPerHour);
  }, [l.maxActionsPerRun, l.maxDmsPerHour]);
  const valid = Number.isInteger(perRun) && perRun >= 1 && perRun <= 200 && Number.isInteger(perHour) && perHour >= 0 && perHour <= 200;
  const dirty = perRun !== l.maxActionsPerRun || perHour !== l.maxDmsPerHour;
  const save = async () => {
    setSaving(true);
    try {
      await onSave((d) => {
        d.limits = { ...(d.limits || {}), maxActionsPerRun: perRun, maxDmsPerHour: perHour };
      }, 'Limits saved');
    } finally {
      setSaving(false);
    }
  };
  return html`<${Panel} title="Limits" subtitle="Keeps automated activity well under Instagram's rate limits.">
    <div class="stack">
      <div class="grid-2 auto-limits">
        <${Field} label="Actions per run" hint="1–200. The worker runs about every 10 minutes." error=${Number.isInteger(perRun) && perRun >= 1 && perRun <= 200 ? '' : 'Enter a number from 1 to 200.'}>
          <${TextInput} type="number" min="1" max="200" value=${perRun ?? ''} mono onChange=${setPerRun} />
        <//>
        <${Field} label="DMs per hour" hint="0 turns automated DMs off." error=${Number.isInteger(perHour) && perHour >= 0 && perHour <= 200 ? '' : 'Enter a number from 0 to 200.'}>
          <${TextInput} type="number" min="0" max="200" value=${perHour ?? ''} mono onChange=${setPerHour} />
        <//>
      </div>
      <div class="row row-end">
        <${Button} size="sm" variant="secondary" disabled=${!dirty || !valid} loading=${saving} onClick=${save}>Save limits<//>
      </div>
    </div>
  <//>`;
}

export default function AutomationsView() {
  const { settings, ig, tz, toast, confirm, dispatchWorker, navigate } = useApp();
  const { data, error } = useDocs(['automations', 'log', 'analytics-media']);
  const doc = data.automations;
  const log = data.log;
  const [editor, setEditor] = useState(null); // { rule, mode: 'new'|'edit', title }
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);

  const aiReady = !!getAi(settings);
  const posts = useMemo(() => {
    const m = (data['analytics-media'] && data['analytics-media'].media) || {};
    return Object.values(m)
      .filter((x) => x && x.id && x.productType !== 'STORY')
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  }, [data['analytics-media']]);

  const save = (fn, message) =>
    mutate('automations', (d) => {
      d.rules ||= [];
      fn(d);
    }, { message: 'automations: update' }).then((r) => {
      if (message) toast(message, { kind: 'success' });
      return r;
    });

  if (error && !doc) {
    return html`<div class="page"><${PageHeader} title="Automations" />
      <${Callout} tone="danger" title="Automations could not be loaded">${error.message || String(error)} Reload the page to try again.<//></div>`;
  }
  if (!doc) {
    return html`<div class="page"><${PageHeader} title="Automations" subtitle="Reply to comments and messages automatically while you are away." />
      <div class="panel"><div class="panel-body"><${Skeleton} lines=${4} /></div></div>
      <div class="panel"><div class="panel-body"><${Skeleton} lines=${6} /></div></div></div>`;
  }

  const rules = doc.rules || [];
  const status = doc.status || {};
  const dmProblem = DM_PROBLEMS[status.dm];
  const stats = doc.stats || {};
  const firedTotal = rules.reduce((n, r) => n + ((r.stats && r.stats.fired) || 0), 0);
  const logEntries = ((log && log.entries) || []).filter((e) => e.job === 'automations').slice(0, 50);
  const lastRun = log && log.runs && log.runs[0];
  const pausedUntil = doc.cursors && Date.parse(doc.cursors.pausedUntil || '') > Date.now() ? doc.cursors.pausedUntil : null;

  const toggleMaster = async (on) => {
    setBusy(true);
    try {
      await save((d) => {
        const was = d.enabled !== false;
        d.enabled = on;
        d.cursors ||= {};
        // Rules only answer what arrives after automations are switched on (see worker/jobs/automations.mjs).
        if (on && !was) d.cursors.startedAt = new Date().toISOString();
        if (!on) d.cursors.startedAt = null;
      }, on ? 'Automations are on. New comments and messages get answered on the next run.' : 'Automations paused. Nothing is sent until you turn them back on.');
    } catch {
      /* toast shown by mutate */
    } finally {
      setBusy(false);
    }
  };

  const toggleRule = async (id, on) => {
    setBusy(true);
    try {
      await save((d) => {
        const r = d.rules.find((x) => x.id === id);
        if (r) r.enabled = on;
      }, on ? 'Rule turned on' : 'Rule paused');
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  const moveRule = async (id, dir) => {
    setBusy(true);
    try {
      await save((d) => {
        const i = d.rules.findIndex((x) => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= d.rules.length) return;
        [d.rules[i], d.rules[j]] = [d.rules[j], d.rules[i]];
      }, dir < 0 ? 'Moved up' : 'Moved down');
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  const duplicateRule = async (rule) => {
    try {
      await save((d) => {
        const i = d.rules.findIndex((x) => x.id === rule.id);
        const src = d.rules[i] || rule;
        const copy = { ...structuredClone(src), id: uid('r_'), name: `${src.name} (copy)`, enabled: false, createdAt: new Date().toISOString(), stats: { fired: 0, lastFiredAt: null } };
        d.rules.splice(i < 0 ? d.rules.length : i + 1, 0, copy);
      }, 'Rule duplicated. The copy is paused until you turn it on.');
    } catch {
      /* toast shown */
    }
  };

  const deleteRule = async (rule) => {
    const ok = await confirm({ title: `Delete “${rule.name}”?`, body: 'The rule stops answering right away. Replies it already sent stay on Instagram.', confirmLabel: 'Delete rule', danger: true });
    if (!ok) return;
    try {
      await save((d) => {
        d.rules = d.rules.filter((x) => x.id !== rule.id);
      }, 'Rule deleted');
    } catch {
      /* toast shown */
    }
  };

  const saveRule = async (rule) => {
    setSaving(true);
    const isNew = editor && editor.mode === 'new';
    try {
      await save((d) => {
        const i = d.rules.findIndex((x) => x.id === rule.id);
        if (i >= 0) {
          // Keep the worker's counters, which may have changed while the editor was open.
          d.rules[i] = { ...rule, stats: d.rules[i].stats || rule.stats, enabled: d.rules[i].enabled };
        } else {
          d.rules.push({ ...rule, createdAt: rule.createdAt || new Date().toISOString(), stats: { fired: 0, lastFiredAt: null } });
        }
      }, isNew ? `Rule “${rule.name}” created` : `Rule “${rule.name}” saved`);
      if (alive.current) setEditor(null);
    } catch {
      /* toast shown */
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshNow();
    } catch (err) {
      toast(`Could not refresh: ${err.message}`, { kind: 'error' });
    } finally {
      if (alive.current) setRefreshing(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    let before = null;
    try {
      before = ((await getStore().read('log')).runs || [])[0]?.startedAt || null;
      await dispatchWorker('automations');
    } catch {
      setRunning(false);
      return;
    }
    // Watch for the run to finish (the worker usually takes 1-3 minutes on GitHub).
    const deadline = Date.now() + 4 * 60_000;
    while (alive.current && Date.now() < deadline) {
      await sleep(3000);
      try {
        await refreshNow();
        const latest = ((await getStore().read('log')).runs || [])[0];
        if (latest && latest.startedAt !== before && latest.finishedAt) {
          const c = latest.counts || {};
          const n = (c.replies || 0) + (c.dms || 0) + (c.hidden || 0) + (c.deleted || 0);
          toast(n ? `Worker finished: ${n} automated ${n === 1 ? 'action' : 'actions'}.` : 'Worker finished. Nothing new to answer.', { kind: 'success' });
          break;
        }
      } catch {
        /* keep polling */
      }
    }
    if (alive.current) setRunning(false);
  };

  const openNew = () => setEditor({ mode: 'new', title: 'New rule', rule: null });
  const openTemplate = (tpl) => setEditor({ mode: 'new', title: tpl.title, rule: tpl.build() });

  return html`<div class="page automations">
    <${PageHeader} title="Automations" subtitle="Reply to comments and messages automatically. The worker checks Instagram about every 10 minutes."
      actions=${html`
        <${Button} variant="secondary" icon="refresh" loading=${running} onClick=${runNow} disabled=${!ig}>${running ? 'Running…' : 'Run now'}<//>
        <${Button} variant="primary" icon="plus" onClick=${openNew}>New rule<//>`} />

    ${!ig
      ? html`<${Callout} tone="warning" title="Instagram is not connected" action=${html`<${Button} size="sm" onClick=${() => navigate('#/settings?section=instagram')}>Open Settings<//>`}>
          Automations need a connected Instagram account. You can still prepare rules.
        <//>`
      : null}

    <section class="auto-master panel" aria-label="Automations status">
      <div class="auto-master-row">
        <div class="auto-master-text">
        <${Toggle} checked=${doc.enabled !== false} disabled=${busy} onChange=${toggleMaster}
          label=${doc.enabled !== false ? 'Automations are on' : 'Automations are paused'}
          hint=${doc.enabled !== false
            ? doc.cursors && doc.cursors.startedAt
              ? `Answering comments and messages that arrived after ${formatDateTime(doc.cursors.startedAt, tz)}.`
              : 'Starts answering new comments and messages on the next worker run.'
            : 'Nothing is sent automatically. Turning them back on only answers new activity.'} />
        <p class="auto-lastrun faint text-sm">${lastRun ? html`Worker last checked <time datetime=${lastRun.finishedAt || lastRun.startedAt} title=${formatDateTime(lastRun.finishedAt || lastRun.startedAt, tz)}>${relative(lastRun.finishedAt || lastRun.startedAt)}</time>` : 'The worker has not run yet.'}</p>
        </div>
        <div class="stats auto-stats">
          <${Stat} label="Comment replies" value=${stats.replies || 0} />
          <${Stat} label="DMs sent" value=${stats.dms || 0} />
          <${Stat} label="Hidden" value=${(stats.hidden || 0) + (stats.deleted || 0)} />
          <${Stat} label="Rules fired" value=${firedTotal} />
        </div>
      </div>
      ${pausedUntil
        ? html`<${Callout} tone="warning" title="Paused while Instagram limits this account">
            <p>Instagram asked apps to slow down for this account, so automations resume ${relative(pausedUntil)} (${formatDateTime(pausedUntil, tz)}). New comments and messages that arrive meanwhile are checked when they resume.</p>
          <//>`
        : null}
      ${dmProblem
        ? html`<${Callout} tone="warning" title=${dmProblem.title}>
            <p>${dmProblem.body}</p>
            ${status.message ? html`<p class="faint text-sm">Instagram said: ${status.message}</p>` : null}
          <//>`
        : null}
    </section>

    <div class="auto-layout">
      <div class="auto-col stack stack-lg">
        <${Panel} title="Rules" subtitle="Checked in order for each new comment or message. The first rule that matches answers; later rules are skipped." flush>
          ${!rules.length
            ? html`<${EmptyState} icon="bolt" title="No rules yet" body="Start with a template below, or write your own keyword rule." action=${html`<${Button} variant="primary" icon="plus" onClick=${openNew}>Create a rule<//>`} />`
            : html`<ol class="auto-rules" aria-label="Rules in priority order">
                ${rules.map(
                  (r, i) => html`<${RuleCard} key=${r.id} rule=${r} index=${i} count=${rules.length} busy=${busy}
                    onToggle=${(v) => toggleRule(r.id, v)} onMove=${(dir) => moveRule(r.id, dir)}
                    onEdit=${() => setEditor({ mode: 'edit', title: 'Edit rule', rule: r })}
                    onDuplicate=${() => duplicateRule(r)} onDelete=${() => deleteRule(r)} />`,
                )}
              </ol>`}
        <//>

        <${Panel} title="Starter templates" subtitle="Open one, adjust the wording, then save it as a rule.">
          <ul class="auto-templates">
            ${STARTER_TEMPLATES.map(
              (t) => html`<li key=${t.id} class="auto-template">
                <div class="grow">
                  <p class="strong">${t.title}</p>
                  <p class="muted text-sm">${t.body}</p>
                </div>
                <${Button} size="sm" variant="secondary" onClick=${() => openTemplate(t)} aria-label=${`Use template: ${t.title}`}>Use template<//>
              </li>`,
            )}
          </ul>
        <//>

        <${ActivityFeed} activity=${doc.activity} logEntries=${logEntries} tz=${tz} onRefresh=${refresh} refreshing=${refreshing} />
      </div>

      <div class="auto-col stack stack-lg">
        <${WelcomePanel} doc=${doc} onSave=${save} />
        <${BlockedPanel} doc=${doc} onSave=${save} />
        <${LimitsPanel} doc=${doc} onSave=${save} />
        <section class="auto-policy" aria-labelledby="auto-policy-title">
          <h2 class="label-caps" id="auto-policy-title">Instagram's rules</h2>
          <p class="muted text-sm">
            Instagram allows one private reply per comment, sent within 7 days of the comment. DM replies are only allowed within 24 hours of the person's last message, and apps may never send unsolicited DMs. Postpilot follows these limits and picks among your reply versions so automatic replies don't repeat word for word.
          </p>
        </section>
      </div>
    </div>

    <${RuleEditor} open=${!!editor} rule=${editor && editor.rule} title=${editor && editor.title} posts=${posts} aiReady=${aiReady}
      blockedWords=${doc.blockedWords} saving=${saving} onClose=${() => !saving && setEditor(null)} onSave=${saveRule} />
  </div>`;
}

