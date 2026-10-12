// App shell: context, layout (sidebar / phone tab bar), routing, toasts, confirm dialogs, composer host.

import { createIg } from '../core/ig.js';
import { relative } from '../core/time.js';
import { html, createContext, useCallback, useContext, useEffect, useErrorBoundary, useMemo, useRef, useState } from '../vendor/preact.js';
import { APP_NAME, DATA_BRANCH, ENDPOINTS, WORKER_WORKFLOW } from './config.js';
import { initData, readDoc, refreshNow, stopData, useDoc } from './data.js';
import { registerServiceWorker } from './push.js';
import { navigate, useRoute } from './router.js';
import { forget } from './session.js';
import { Icon } from './ui/icons.js';
import { Avatar, Button, Callout, ConfirmDialog, Drawer, IconButton, Spinner, ToastHost } from './ui/kit.js';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export const NAV = [
  { group: 'Plan', items: [
    { name: 'dashboard', label: 'Today', icon: 'home' },
    { name: 'planner', label: 'Planner', icon: 'calendar' },
    { name: 'library', label: 'Library', icon: 'image' },
    { name: 'queues', label: 'Queues', icon: 'repeat' },
    { name: 'autopilot', label: 'Autopilot', icon: 'robot' },
  ] },
  { group: 'Engage', items: [
    { name: 'inbox', label: 'Inbox', icon: 'inbox' },
    { name: 'automations', label: 'Automations', icon: 'bolt' },
  ] },
  { group: 'Measure', items: [
    { name: 'analytics', label: 'Analytics', icon: 'chart' },
    { name: 'reports', label: 'Reports', icon: 'download' },
    { name: 'competitors', label: 'Competitors', icon: 'users' },
    { name: 'hashtags', label: 'Hashtags', icon: 'hash' },
  ] },
  { group: 'Grow', items: [
    { name: 'bio', label: 'Link in bio', icon: 'link' },
    { name: 'settings', label: 'Settings', icon: 'settings' },
  ] },
];

const VIEWS = {
  dashboard: () => import('./views/dashboard.js'),
  planner: () => import('./views/planner.js'),
  library: () => import('./views/library.js'),
  queues: () => import('./views/queues.js'),
  autopilot: () => import('./views/autopilot.js'),
  inbox: () => import('./views/inbox.js'),
  automations: () => import('./views/automations.js'),
  analytics: () => import('./views/analytics.js'),
  reports: () => import('./views/reports.js'),
  competitors: () => import('./views/competitors.js'),
  hashtags: () => import('./views/hashtags.js'),
  bio: () => import('./views/bio.js'),
  settings: () => import('./views/settings.js'),
  onboarding: () => import('./views/onboarding.js'),
  // Opened from a reminder notification (#/post-now/<postId>); not in the navigation.
  'post-now': () => import('./views/post-now.js'),
};

function useLazyView(name) {
  const [state, setState] = useState({ name: null, Comp: null, error: null });
  useEffect(() => {
    let alive = true;
    const loader = VIEWS[name] || VIEWS.dashboard;
    loader()
      .then((m) => alive && setState({ name, Comp: m.default, error: null }))
      .catch((error) => alive && setState({ name, Comp: null, error }));
    return () => {
      alive = false;
    };
  }, [name]);
  return state.name === name ? state : { name, Comp: null, error: null };
}

function ViewOutlet({ name }) {
  const { Comp, error } = useLazyView(name);
  if (error) {
    return html`<div class="page"><${Callout} tone="danger" title="This screen failed to load">${String(error.message || error)}<//></div>`;
  }
  if (!Comp) return html`<div class="page view-loading"><${Spinner} label="Loading" /></div>`;
  return html`<${SafeView} key=${name} Comp=${Comp} />`;
}

/**
 * Whether a run record can be the run the app dispatched at `sinceMs`: started from the app (a scheduled
 * run that was already going would otherwise match) and finished after the request (5 s clock slack).
 */
export function isDispatchedRunSince(run, sinceMs) {
  return !!run && run.trigger === 'workflow_dispatch' && Date.parse(run.finishedAt || 0) >= sinceMs - 5000;
}

/**
 * A worker run that had job errors. run.ok is also false when only a post failed to publish; the
 * worker itself is fine then (the failed post has its own alert), so the UI must not blame the worker.
 */
export function runBroken(run) {
  return !!run && run.ok === false && (run.errors || []).length > 0;
}

/** Poll the encrypted run log until a worker run that started after `sinceMs` has finished. */
export async function waitForWorkerRun(sinceMs, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      await refreshNow();
      const log = await readDoc('log');
      const run = (log.runs || []).find((r) => isDispatchedRunSince(r, sinceMs));
      if (run) return run;
    } catch {
      /* keep waiting */
    }
  }
  return null;
}

function SafeView({ Comp }) {
  const [error, reset] = useErrorBoundary((err) => console.error(err));
  if (error) {
    return html`<div class="page"><${Callout} tone="danger" title="Something went wrong on this screen"
      action=${html`<${Button} variant="secondary" size="sm" onClick=${reset}>Try again<//>`}>
      <span class="mono">${String(error.message || error)}</span>
    <//></div>`;
  }
  return html`<${Comp} />`;
}

function ComposerHost({ request, onClose }) {
  const [Comp, setComp] = useState(null);
  useEffect(() => {
    if (request && !Comp) import('./views/composer.js').then((m) => setComp(() => m.default));
  }, [request]);
  if (!request || !Comp) return null;
  return html`<${Comp} key=${request.key} initial=${request.initial} onClose=${onClose} />`;
}

function WorkerStatus() {
  const { data: log } = useDoc('log');
  const last = log && log.runs && log.runs[0];
  if (!last) {
    return html`<div class="worker-status" title="The background worker has not reported yet">
      <span class="dot"></span><span>Worker not running yet</span>
    </div>`;
  }
  const at = last.finishedAt || last.startedAt;
  const ageMin = (Date.now() - new Date(at).getTime()) / 60000;
  // GitHub can delay scheduled runs and idle runs only report every 30 minutes, so allow some slack.
  const broken = runBroken(last);
  const tone = broken ? 'bad' : ageMin > 90 ? 'warn' : 'ok';
  const label = broken ? 'Worker had a problem' : ageMin > 90 ? 'Worker is late' : 'Worker running';
  return html`<a class=${`worker-status is-${tone}`} href="#/settings?section=worker" title=${`${label}. Last run ${relative(at)}`}>
    <span class="dot"></span><span>${label}</span><span class="worker-meta">${relative(at)}</span>
  </a>`;
}

function useNavCounts() {
  const { data: posts } = useDoc('posts');
  const list = (posts && posts.posts) || [];
  return {
    planner: list.filter((p) => p.status === 'failed').length,
    autopilot: list.filter((p) => p.needsApproval && p.status === 'draft').length,
  };
}

function NavLinks({ route, onNavigate }) {
  const counts = useNavCounts();
  return NAV.map(
    (g) => html`<div class="nav-group">
      <div class="nav-group-label">${g.group}</div>
      ${g.items.map((it) => {
        const count = counts[it.name];
        return html`<a href=${it.name === 'dashboard' ? '#/' : `#/${it.name}`}
          class="nav-item"
          aria-current=${route.name === it.name ? 'page' : undefined}
          onClick=${onNavigate}>
          <${Icon} name=${it.icon} /><span class="nav-label">${it.label}</span>
          ${count ? html`<span class="nav-count is-attention" title=${it.name === 'planner' ? 'Failed posts' : 'Drafts to approve'}>${count}</span>` : null}
        </a>`;
      })}
    </div>`,
  );
}

function AccountChip({ settings }) {
  const ig = settings && settings.ig;
  if (!ig) {
    return html`<a class="account-chip" href="#/onboarding">
      <${Icon} name="instagram-outline" />
      <span class="account-text"><span class="account-name">Connect Instagram</span><span class="account-handle">not connected</span></span>
    </a>`;
  }
  return html`<a class="account-chip" href="#/settings?section=instagram">
    <${Avatar} src=${ig.profilePictureUrl} name=${ig.name || ig.username} size=${32} />
    <span class="account-text"><span class="account-name">${ig.name || ig.username}</span><span class="account-handle">@${ig.username}</span></span>
  </a>`;
}

function Sidebar({ route, settings, onCompose }) {
  return html`<aside class="sidebar" aria-label="Main navigation">
    <a class="sidebar-brand" href="#/">
      <span class="brand-mark" aria-hidden="true"><${Icon} name="instagram-outline" size=${18} /></span>
      <span><span class="brand-name">${APP_NAME}</span><span class="brand-sub">Instagram autopilot</span></span>
    </a>
    <${Button} variant="primary" icon="plus" class="compose-button" onClick=${() => onCompose()}>New post<//>
    <nav class="nav"><${NavLinks} route=${route} /></nav>
    <div class="sidebar-foot">
      <${WorkerStatus} />
      <${AccountChip} settings=${settings} />
    </div>
  </aside>`;
}

function MobileTopbar({ settings, onCompose }) {
  const ig = settings && settings.ig;
  return html`<header class="mobile-topbar">
    <a class="sidebar-brand" href="#/">
      <span class="brand-mark" aria-hidden="true"><${Icon} name="instagram-outline" size=${16} /></span>
      <span class="brand-name">${APP_NAME}</span>
    </a>
    <span class="spacer"></span>
    <${IconButton} icon="plus" label="New post" onClick=${() => onCompose()} />
    ${ig && html`<a href="#/settings?section=instagram" aria-label="Account settings"><${Avatar} src=${ig.profilePictureUrl} name=${ig.username} size=${28} /></a>`}
  </header>`;
}

function TabBar({ route, onCompose, onMore }) {
  const item = (name, label, icon) => html`<a class="tabbar-item" href=${name === 'dashboard' ? '#/' : `#/${name}`}
    aria-current=${route.name === name ? 'page' : undefined}><${Icon} name=${icon} size=${20} /><span>${label}</span></a>`;
  const inMore = !['dashboard', 'planner', 'inbox', 'analytics'].includes(route.name);
  return html`<nav class="tabbar" aria-label="Main navigation">
    ${item('dashboard', 'Today', 'home')}
    ${item('planner', 'Planner', 'calendar')}
    <button type="button" class="tabbar-item" onClick=${() => onCompose()}><${Icon} name="plus" size=${20} /><span>New</span></button>
    ${item('inbox', 'Inbox', 'inbox')}
    <button type="button" class=${`tabbar-item${inMore ? ' is-active' : ''}`} onClick=${onMore}><${Icon} name="menu" size=${20} /><span>More</span></button>
  </nav>`;
}

/** Plain-language reason the workspace could not be opened, and which way out to suggest first. */
function bootProblem(err, gh) {
  const repo = gh && gh.owner ? `${gh.owner}/${gh.repo}` : 'your repository';
  const status = err && err.status;
  if (err && err.name === 'DecryptError') {
    return {
      lockFirst: true,
      lockLabel: 'Lock and unlock with your passphrase',
      message: "This device's saved key no longer opens your workspace, for example because it was set up again on another device. Lock Postpilot and unlock with your passphrase.",
    };
  }
  const lockLabel = 'Lock and use a different token';
  if (status === 401) {
    return { lockFirst: true, lockLabel, message: 'GitHub rejected your access token. It may have expired or been revoked. Lock Postpilot and unlock with a new token.' };
  }
  if (status === 403 && /rate limit/i.test(err.message || '')) return { lockFirst: false, lockLabel, message: err.message };
  if (status === 403) return { lockFirst: true, lockLabel, message: `${err.message} If you made a new token, lock Postpilot and unlock with it.` };
  if (status === 404) {
    return {
      lockFirst: true,
      lockLabel,
      message: `GitHub could not find your Postpilot data (the ${DATA_BRANCH} branch of ${repo}). It may have been deleted, or this token cannot see the repository. Lock Postpilot and unlock again to set it up.`,
    };
  }
  if (status === 0) return { lockFirst: false, lockLabel, message: 'Could not reach GitHub. Check your internet connection. Postpilot tries again when you are back online.' };
  return { lockFirst: false, lockLabel, message: (err && (err.userMessage || err.message)) || String(err) };
}

/** Full-page error when the first read of the workspace fails (instead of an endless "Opening…" spinner). */
function BootError({ error, gh, onRetry, onLock }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const latest = useRef(onRetry);
  latest.current = onRetry;
  const retry = useCallback(() => {
    setBusy(true);
    return Promise.resolve()
      .then(() => latest.current())
      .catch(() => {})
      .finally(() => alive.current && setBusy(false));
  }, []);
  useEffect(() => {
    alive.current = true;
    // Opened offline: try again by itself once the connection is back.
    globalThis.addEventListener?.('online', retry);
    return () => {
      alive.current = false;
      globalThis.removeEventListener?.('online', retry);
    };
  }, []);
  const p = bootProblem(error, gh);
  return html`<div class="boot boot-error">
    <div class="stack" role="alert" style="max-width: 460px; text-align: left">
      <${Callout} tone="danger" title="Could not open your workspace">${p.message}<//>
      <div class="row">
        <${Button} variant=${p.lockFirst ? 'secondary' : 'primary'} icon="refresh" loading=${busy} onClick=${retry}>Try again<//>
        <${Button} variant=${p.lockFirst ? 'primary' : 'secondary'} icon="logout" onClick=${onLock}>${p.lockLabel}<//>
      </div>
    </div>
  </div>`;
}

function MoreDrawer({ open, onClose, route }) {
  return html`<${Drawer} open=${open} title="All screens" onClose=${onClose}>
    <nav class="nav" aria-label="All screens"><${NavLinks} route=${route} onNavigate=${onClose} /></nav>
    <div class="stack-sm" style="margin-top: 16px"><${WorkerStatus} /></div>
  <//>`;
}

export function App({ session }) {
  const route = useRoute();
  const [ready, setReady] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);
  const [composer, setComposer] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const toastSeq = useRef(0);

  const toast = useCallback((message, opts = {}) => {
    const id = ++toastSeq.current;
    const t = { id, message, kind: opts.kind || 'info', action: opts.action };
    setToasts((list) => [...list.slice(-3), t]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), opts.duration || (t.kind === 'error' ? 8000 : 4000));
  }, []);

  useMemo(() => {
    initData(session.store, { onError: (err) => toast(err.userMessage || err.message || String(err), { kind: 'error' }) });
    // A failure here also fails the settings read below, which shows the boot error screen.
    session.store.refresh().then(() => setReady(true)).catch(() => setReady(true));
  }, [session]);

  useEffect(() => () => stopData(), []);
  // Notifications and sharing into Postpilot (Android share sheet) need the service worker.
  useEffect(() => void registerServiceWorker(), []);

  const { data: settings, error: settingsError, reload: reloadSettings } = useDoc('settings');
  const tz = (settings && settings.timezone) || 'UTC';

  const ig = useMemo(() => {
    const c = settings && settings.ig;
    if (!c || !c.token) return null;
    return createIg({
      mode: c.mode,
      token: c.token,
      userId: c.userId,
      pageId: c.pageId,
      pageToken: c.pageToken,
      igBase: ENDPOINTS.igBase,
      fbBase: ENDPOINTS.fbBase,
      ruploadBase: ENDPOINTS.rupload,
    });
  }, [settings && settings.ig && settings.ig.token, settings && settings.ig && settings.ig.userId, settings && settings.ig && settings.ig.mode]);

  const confirm = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setConfirmState({ ...opts, resolve });
      }),
    [],
  );

  /**
   * Start the worker workflow now. Options:
   *  - quiet: no "Worker started" toast (for screens that show their own progress)
   *  - wait: resolve only when the run has reported (returns its run record, or null on timeout)
   */
  const dispatchWorker = useCallback(
    async (reason = 'app', { quiet = false, wait = false, timeoutMs = 240_000 } = {}) => {
      const startedAt = Date.now();
      try {
        await session.gh.dispatchWorkflow(WORKER_WORKFLOW, (await session.gh.getRepo()).default_branch, { reason });
      } catch (err) {
        toast(`Could not start the worker: ${err.message}. Check Settings → Worker.`, { kind: 'error' });
        throw err;
      }
      if (!quiet) toast('Worker started. Changes appear within a couple of minutes.', { kind: 'success' });
      if (!wait) {
        // Pull fresh data a few times while the worker runs.
        for (const ms of [45_000, 90_000, 150_000]) setTimeout(() => refreshNow().catch(() => {}), ms);
        return null;
      }
      return waitForWorkerRun(startedAt, timeoutMs);
    },
    [session],
  );

  const lockNow = useCallback(() => {
    forget();
    location.reload();
  }, []);

  const ctx = useMemo(
    () => ({
      session,
      settings,
      ig,
      tz,
      route,
      navigate,
      toast,
      confirm,
      dispatchWorker,
      openComposer: (initial) => setComposer({ key: Date.now(), initial: initial || null }),
      lock: lockNow,
    }),
    [session, settings, ig, tz, route, toast, confirm, dispatchWorker],
  );

  const titleName = route.name;
  useEffect(() => {
    const item = NAV.flatMap((g) => g.items).find((i) => i.name === titleName);
    document.title = item ? `${item.label} · ${APP_NAME}` : APP_NAME;
  }, [titleName]);

  if (ready && !settings && settingsError) {
    // reload() re-reads the branch head too while it has never loaded (expired token, offline, missing branch).
    return html`<${BootError} error=${settingsError} gh=${session.gh} onRetry=${reloadSettings} onLock=${lockNow} />`;
  }
  if (!ready || !settings) {
    return html`<div class="boot"><${Spinner} /><p class="muted">Opening your encrypted workspace…</p></div>`;
  }

  // post-now needs no Instagram connection: reminders reach the owner while Instagram is disconnected.
  const needsOnboarding = !settings.ig && route.name !== 'onboarding' && route.name !== 'settings' && route.name !== 'post-now';
  const viewName = needsOnboarding ? 'onboarding' : route.name in VIEWS ? route.name : 'dashboard';

  return html`<${AppContext.Provider} value=${ctx}>
    <div class="app">
      <${Sidebar} route=${route} settings=${settings} onCompose=${() => ctx.openComposer()} />
      <${MobileTopbar} settings=${settings} onCompose=${() => ctx.openComposer()} />
      <main class="main" id="main">
        <${ViewOutlet} name=${viewName} />
      </main>
      <${TabBar} route=${route} onCompose=${() => ctx.openComposer()} onMore=${() => setMoreOpen(true)} />
      <${MoreDrawer} open=${moreOpen} onClose=${() => setMoreOpen(false)} route=${route} />
      <${ComposerHost} request=${composer} onClose=${() => setComposer(null)} />
      <${ConfirmDialog}
        open=${!!confirmState}
        title=${confirmState && confirmState.title}
        body=${confirmState && confirmState.body}
        confirmLabel=${confirmState && confirmState.confirmLabel}
        danger=${confirmState && confirmState.danger}
        onResolve=${(ok) => {
          confirmState && confirmState.resolve(ok);
          setConfirmState(null);
        }}
      />
      <${ToastHost} toasts=${toasts} onDismiss=${(id) => setToasts((l) => l.filter((t) => t.id !== id))} />
    </div>
  <//>`;
}
