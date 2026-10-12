// App shell: context, layout (sidebar / phone tab bar), routing, toasts, confirm dialogs, composer host.

import { createIg } from '../core/ig.js';
import { relative } from '../core/time.js';
import { html, createContext, useCallback, useContext, useEffect, useErrorBoundary, useMemo, useRef, useState } from '../vendor/preact.js';
import { APP_NAME, ENDPOINTS, WORKER_WORKFLOW } from './config.js';
import { initData, refreshNow, stopData, useDoc } from './data.js';
import { navigate, useRoute } from './router.js';
import { forget } from './session.js';
import { Icon } from './ui/icons.js';
import { Avatar, Button, ConfirmDialog, Spinner, ToastHost } from './ui/kit.js';

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

const TABBAR = ['dashboard', 'planner', '__compose', 'inbox', '__more'];

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
};

const ALL_ITEMS = NAV.flatMap((g) => g.items);

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
    return html`<div class="main-inner"><div class="callout callout-danger" role="alert">
      <strong>This screen failed to load.</strong> ${String(error.message || error)}
    </div></div>`;
  }
  if (!Comp) return html`<div class="main-inner view-loading"><${Spinner} /></div>`;
  return html`<${SafeView} key=${name} Comp=${Comp} />`;
}

function SafeView({ Comp }) {
  const [error, reset] = useErrorBoundary((err) => console.error(err));
  if (error) {
    return html`<div class="main-inner"><div class="callout callout-danger" role="alert">
      <p><strong>Something went wrong on this screen.</strong></p>
      <p class="mono muted">${String(error.message || error)}</p>
      <${Button} variant="secondary" onClick=${reset}>Try again<//>
    </div></div>`;
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

function WorkerStatus({ compact }) {
  const { data: log } = useDoc('log');
  const last = log && log.runs && log.runs[0];
  if (!last) return html`<div class="worker-status muted" title="The background worker has not reported yet">
    <span class="dot dot-neutral"></span>${compact ? '' : html`<span>Worker: no runs yet</span>`}
  </div>`;
  const ageMin = (Date.now() - new Date(last.finishedAt || last.startedAt).getTime()) / 60000;
  const tone = last.ok === false ? 'bad' : ageMin > 45 ? 'warn' : 'ok';
  const label = last.ok === false ? 'Worker reported a problem' : ageMin > 45 ? 'Worker is late' : 'Worker running';
  return html`<div class="worker-status" title=${`${label}. Last run ${relative(last.finishedAt || last.startedAt)}`}>
    <span class=${`dot dot-${tone}`}></span>${compact ? '' : html`<span>${label} · <span class="mono">${relative(last.finishedAt || last.startedAt)}</span></span>`}
  </div>`;
}

function Sidebar({ route, settings, onCompose }) {
  const ig = settings && settings.ig;
  return html`<aside class="sidebar" aria-label="Main navigation">
    <a class="brand" href="#/">
      <span class="brand-mark" aria-hidden="true"></span>
      <span class="brand-name">${APP_NAME}</span>
    </a>
    <${Button} variant="primary" icon="plus" class="compose-button" onClick=${() => onCompose()}>New post<//>
    <nav class="nav">
      ${NAV.map(
        (g) => html`<div class="nav-group">
          <div class="nav-group-label">${g.group}</div>
          ${g.items.map(
            (it) => html`<a href=${it.name === 'dashboard' ? '#/' : `#/${it.name}`}
              class=${`nav-item${route.name === it.name ? ' active' : ''}`}
              aria-current=${route.name === it.name ? 'page' : undefined}>
              <${Icon} name=${it.icon} /><span>${it.label}</span>
            </a>`,
          )}
        </div>`,
      )}
    </nav>
    <div class="sidebar-foot">
      ${ig
        ? html`<a class="account-chip" href="#/settings">
            <${Avatar} src=${ig.profilePictureUrl} name=${ig.username} size=${28} />
            <span class="account-name">@${ig.username}</span>
          </a>`
        : html`<a class="account-chip muted" href="#/onboarding"><${Icon} name="instagram-outline" /> <span>Connect Instagram</span></a>`}
      <${WorkerStatus} />
    </div>
  </aside>`;
}

function TabBar({ route, onCompose, onMore }) {
  const items = { dashboard: ALL_ITEMS[0], planner: ALL_ITEMS[1], inbox: ALL_ITEMS.find((i) => i.name === 'inbox') };
  return html`<nav class="tabbar" aria-label="Main navigation">
    ${TABBAR.map((name) => {
      if (name === '__compose') {
        return html`<button class="tab tab-compose" type="button" onClick=${() => onCompose()} aria-label="New post"><${Icon} name="plus" size=${22} /></button>`;
      }
      if (name === '__more') {
        const inMore = !['dashboard', 'planner', 'inbox'].includes(route.name);
        return html`<button class=${`tab${inMore ? ' active' : ''}`} type="button" onClick=${onMore}><${Icon} name="menu" /><span>More</span></button>`;
      }
      const it = items[name];
      return html`<a class=${`tab${route.name === name ? ' active' : ''}`} href=${name === 'dashboard' ? '#/' : `#/${name}`}>
        <${Icon} name=${it.icon} /><span>${it.label}</span></a>`;
    })}
  </nav>`;
}

function MoreSheet({ open, onClose, route }) {
  if (!open) return null;
  return html`<div class="sheet-backdrop" onClick=${onClose}>
    <div class="sheet" role="dialog" aria-label="All screens" onClick=${(e) => e.stopPropagation()}>
      ${NAV.map(
        (g) => html`<div class="nav-group">
          <div class="nav-group-label">${g.group}</div>
          <div class="sheet-grid">
            ${g.items.map(
              (it) => html`<a href=${it.name === 'dashboard' ? '#/' : `#/${it.name}`} class=${`sheet-item${route.name === it.name ? ' active' : ''}`} onClick=${onClose}>
                <${Icon} name=${it.icon} size=${20} /><span>${it.label}</span></a>`,
            )}
          </div>
        </div>`,
      )}
      <div class="sheet-foot"><${WorkerStatus} /></div>
    </div>
  </div>`;
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
    session.store.refresh().then(() => setReady(true)).catch((err) => {
      toast(err.message, { kind: 'error' });
      setReady(true);
    });
  }, [session]);

  useEffect(() => () => stopData(), []);

  const { data: settings } = useDoc('settings');
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

  const dispatchWorker = useCallback(
    async (reason = 'app') => {
      try {
        await session.gh.dispatchWorkflow(WORKER_WORKFLOW, (await session.gh.getRepo()).default_branch, { reason });
        toast('Worker started. Changes appear within a couple of minutes.', { kind: 'success' });
        // Pull fresh data a few times while the worker runs.
        for (const ms of [45_000, 90_000, 150_000]) setTimeout(() => refreshNow().catch(() => {}), ms);
      } catch (err) {
        toast(`Could not start the worker: ${err.message}. Check Settings → Worker.`, { kind: 'error' });
        throw err;
      }
    },
    [session],
  );

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
      lock: () => {
        forget();
        location.reload();
      },
    }),
    [session, settings, ig, tz, route, toast, confirm, dispatchWorker],
  );

  if (!ready || !settings) {
    return html`<div class="boot"><${Spinner} /><p class="muted">Opening your encrypted workspace…</p></div>`;
  }

  const needsOnboarding = !settings.ig && route.name !== 'onboarding' && route.name !== 'settings';
  const viewName = needsOnboarding ? 'onboarding' : route.name in VIEWS ? route.name : 'dashboard';

  return html`<${AppContext.Provider} value=${ctx}>
    <div class="app">
      <${Sidebar} route=${route} settings=${settings} onCompose=${() => ctx.openComposer()} />
      <main class="main" id="main">
        <${ViewOutlet} name=${viewName} />
      </main>
      <${TabBar} route=${route} onCompose=${() => ctx.openComposer()} onMore=${() => setMoreOpen(true)} />
      <${MoreSheet} open=${moreOpen} onClose=${() => setMoreOpen(false)} route=${route} />
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
