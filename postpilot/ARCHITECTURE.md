# Postpilot architecture

Postpilot is a private, single-owner Instagram planner, publisher, analytics suite and
automation engine (a self-hosted alternative to Metricool) that runs entirely on the
owner's GitHub account at no cost:

| Piece | Where it runs | What it does |
|---|---|---|
| Web app (`postpilot/`) | GitHub Pages (static) | Planner, composer, analytics, inbox, automations, settings. Talks to the GitHub API (data) and the Instagram Graph API (live reads, quick actions) straight from the browser. |
| Worker (`postpilot/worker/`) | GitHub Actions cron (every 10 min) + on-demand dispatch | Publishes scheduled posts, runs auto-replies/DM rules, captures stories before they expire, snapshots daily analytics, refreshes the token, fills the autopilot queue. |
| Data (`postpilot-data` branch) | Same GitHub repo, orphan branch | AES-256-GCM encrypted JSON documents + encrypted media. Only `public/` is plaintext. |

The repo is public, so **everything private is encrypted** before it leaves the browser.
Only someone holding the owner's GitHub token AND passphrase (or the worker, which holds
the data key as an Actions secret) can read or change anything.

## 1. Directory layout

```
postpilot/
  index.html              App shell (loads js/main.js as an ES module)
  bio.html                Public link-in-bio page (reads public/bio.json, no login)
  manifest.webmanifest    Installable on phones
  sw.js                   Service worker (push notifications only, no caching)
  icons/                  App icons
  css/app.css             Design tokens + all component styles
  vendor/                 Vendored ES modules (do NOT edit):
    preact.js             preact + hooks + htm (exports html, render, h, Fragment, use*...)
    sealed-box.js         sealedBox(messageBytes, publicKeyBytes) for GitHub secrets
    anthropic-sdk.js      @anthropic-ai/sdk 0.128.0 (default export Anthropic)
  core/                   Environment-neutral modules shared by app + worker (no DOM, no Node APIs)
    crypto.js  github.js  store.js  model.js  time.js          (written, tested)
    ig.js                 Instagram Graph API client
    publish.js            Publishing pipeline (containers -> status -> publish -> first comment)
    schedule.js           Best-time scoring, queue slots, autopilot/evergreen planning (pure)
    analytics.js          KPI math, period comparisons, aggregations (pure)
    rules.js              Automation rule matching (pure)
    ai.js                 Claude-powered captions, hashtags, replies, insights
    webpush.js            Web Push (RFC 8291 + VAPID) used by the worker to notify the owner's devices
  js/                     Browser-only code (Preact + htm, no build step)
    main.js               Boot: lock screen / setup wizard / app
    config.js             Endpoints and constants (switches to local mocks on localhost)
    session.js            Unlock, remember-device, lock
    app.js                <App>: AppContext provider, layout, router outlet
    router.js             Hash router
    data.js               useDoc / useDocs / mutate hooks over the store (live-refreshing cache)
    push.js               Service worker registration + push subscription management
    media.js              Image processing (JPEG conversion, crop, thumbnails, video probe), asset upload, thumb URL cache
    ui/                   Reusable components (see section 6)
    views/                One module per screen (see section 7)
  worker/
    run.mjs               Worker entry point (node postpilot/worker/run.mjs)
    jobs/*.mjs            One module per job
    package.json          { "type": "module" } and runtime deps (none required)
  dev/
    mock-github.mjs       In-memory GitHub API (git data, refs, contents, raw, dispatch, secrets)
    mock-graph.mjs        In-memory Instagram Graph API with realistic demo data
    mock-anthropic.mjs    Canned Claude responses
    server.mjs            Serves the app at http://localhost:5173/postpilot/ with all mocks mounted
  tests/
    core/*.test.mjs       node:test unit tests
    worker/*.test.mjs     Worker against mock servers
    e2e/*.spec.mjs        Playwright smoke tests against dev/server.mjs
.github/workflows/postpilot-worker.yml   cron + workflow_dispatch
.github/workflows/postpilot-ci.yml       runs tests on changes under postpilot/
```

## 2. Conventions

- Plain JavaScript ES modules, no TypeScript, no bundler. Browser files import with relative paths
  including the `.js` extension. UI uses `import { html, useState, ... } from '../../vendor/preact.js'`.
- `core/` must run unchanged in modern browsers and Node 20+: use `fetch`, `globalThis.crypto`,
  `TextEncoder`, `structuredClone`. No `window`, `document`, `Buffer` (except feature-detected), `process`.
- Two-space indent, single quotes, semicolons, trailing commas. JSDoc on exported functions.
- Never render untrusted text as HTML. Preact escapes text; never use `dangerouslySetInnerHTML`.
- User-facing copy: plain, direct, active voice. Buttons say what they do ("Schedule post").
  Errors say what went wrong and what to do next. No exclamation marks in errors.
- All timestamps stored as UTC ISO strings. Display with `core/time.js` in `settings.timezone`.

## 3. Endpoints (`js/config.js`)

Production:
- GitHub API `https://api.github.com`
- Raw files `https://raw.githubusercontent.com`
- Instagram Login Graph `https://graph.instagram.com/v26.0` (token endpoints are unversioned `https://graph.instagram.com`)
- Facebook Login Graph `https://graph.facebook.com/v26.0`
- Resumable video upload `https://rupload.facebook.com/ig-api-upload/v26.0`
- Anthropic `https://api.anthropic.com`

On `localhost`/`127.0.0.1` the app uses the dev server mounts instead:
`/mock/gh` (GitHub API), `/mock/gh/raw` (raw files), `/mock/ig` (graph.instagram.com),
`/mock/fb` (graph.facebook.com), `/mock/rupload`, `/mock/anthropic`. The worker reads the same
overrides from env vars `POSTPILOT_GITHUB_API`, `POSTPILOT_RAW_BASE`, `POSTPILOT_IG_BASE`,
`POSTPILOT_FB_BASE`, `POSTPILOT_RUPLOAD_BASE`, `POSTPILOT_ANTHROPIC_BASE`.

## 4. Data (`core/store.js`, `core/model.js`)

`createStore({gh, key, branch, author, onChange})` returns:
- `read(name)` -> document (defaults filled by `model.migrateDoc`), deep copy, safe to mutate.
- `readMany([names])`, `readBytes(path, {decrypt})`, `exists(path)`, `list(prefix)`, `refresh()`, `head`.
- `transact(async tx => {...}, {message})` -> one commit for all writes; re-runs on conflict.
  `tx.read(name)`, `tx.write(name, value)`, `tx.readBytes(path)`, `tx.writeBytes(path, bytes, {encrypt=true})`,
  `tx.writePublic(path, jsonOrBytes)`, `tx.delete(path)`, `tx.exists(path)`, `tx.list(prefix)`.
  The function MUST be safe to re-run (no side effects outside tx; compute from what tx.read returns).
- `update(name, mutator, {message})` -> shorthand for a single-document transaction.

Documents (`model.DOC_NAMES`): `settings`, `posts`, `library`, `lists`, `automations`, `autopilot`,
`hashtags`, `competitors`, `analytics-daily`, `analytics-media`, `analytics-stories`, `audience`,
`inbox`, `log`, `bio` (public). Shapes are documented in `core/model.js`; constructors `newPost`,
`newAsset`, `newRule`, `newList`; `validatePost(post, assetsById)`; `addHistory(post, event, detail)`.

Media: `media/<assetId>` (encrypted original, JPEG for photos), `media/<assetId>.thumb` (encrypted
JPEG, longest side 480px). Publishing exposes a plaintext copy at `public/tmp/<random>.<ext>` only
while Instagram fetches it; the worker deletes it after the container finishes (and sweeps
leftovers older than 24h).

Post lifecycle: `draft` -> `scheduled` -> `publishing` -> `published` | `failed`; `canceled` is
terminal. Only the worker moves a post out of `scheduled`. The app asks for immediate publishing by
setting `scheduledAt` to now, `status: 'scheduled'`, then dispatching the worker workflow.

## 5. Instagram client (`core/ig.js`) and publishing (`core/publish.js`)

```js
createIg({ mode, token, userId, pageId, pageToken, igBase, fbBase, ruploadBase, fetchImpl, version })
  .get(path, params)                 // GET, access_token as query param (no preflight)
  .post(path, params)                // POST application/x-www-form-urlencoded (no preflight)
  .del(path, params)
  .paginate(path, params, {max})     // follows paging.next
  .me()                              // {id, user_id, username, name, profile_picture_url, followers_count, follows_count, media_count, biography, website, account_type}
  .media({limit, after})             // recent media with insights-ready fields
  .mediaInsights(media)              // metrics chosen by media_product_type, unsupported metrics dropped automatically
  .accountInsights({since, until})   // daily metrics -> {dayKey: {...}}
  .demographics()                    // follower_demographics breakdowns
  .onlineFollowers()
  .stories()                         // live stories with insights
  .comments(mediaId), .replies(commentId), .replyToComment(id, text), .hideComment(id, hide), .deleteComment(id)
  .conversations(), .messages(conversationId), .sendMessage(recipientId, text), .privateReply(commentId, text)
  .publishingLimit()
  .refreshToken()                    // Instagram Login only
  .businessDiscovery(username)       // Facebook Login only
  .hashtagSearch(tag), .hashtagMedia(id, 'top'|'recent')   // Facebook Login only
IgError { code, subcode, type, message, userMessage, isAuth, isRateLimit, isTransient, isPermanent }
```

`publishPost({ ig, post, assets, exposeMedia, readMedia, log })` runs the container flow for
feed/carousel/reel/story, polls `status_code`, publishes, adds the first comment, and returns
`{ igMediaId, permalink, containers }`; it throws `IgError` (or `PublishPendingError` when a video
is still processing so the next run can resume from `post.containers`).

## 6. App shell and UI kit

`js/app.js` provides `AppContext` via `useApp()`:

```js
{
  session,            // { gh, store, owner, repo, branch, login }
  settings,           // live settings doc
  ig,                 // createIg(...) for the connected account, or null
  tz,                 // settings.timezone
  navigate(hash),     // e.g. navigate('#/planner')
  route,              // { name, params, query }
  toast(message, {kind: 'info'|'success'|'error', action?: {label, onClick}}),
  confirm({title, body, confirmLabel, danger}) -> Promise<boolean>,
  openComposer(postIdOrPartialPost?),       // opens the composer drawer
  dispatchWorker(reason, {quiet, wait}) -> Promise<run|null>,  // workflow_dispatch; wait=true resolves with the finished run record
  lock(),
}
```

`js/data.js`:
- `useDoc(name)` -> `{ data, loading, error, reload }`; shares one in-memory cache; re-renders when any
  writer (this tab or `refresh()` polling) changes the doc. Polls `store.refresh()` every 60s while
  the tab is visible.
- `useDocs([names])` -> `{ data: {name: doc}, loading, error }`.
- `mutate(name, mutator, {message})` -> Promise<newDoc> (wraps `store.update`, updates cache, toasts on error unless `{silent: true}`).
- `transact(fn, {message})` -> Promise.

`js/ui/` components (all take `class` passthrough):
`Button {variant: 'primary'|'secondary'|'ghost'|'danger', size: 'sm'|'md', icon, loading, disabled, onClick}`,
`IconButton {icon, label, onClick}`, `Icon {name, size}` (inline SVG set in `ui/icons.js`),
`Panel {title, actions, children}`, `Tabs {tabs: [{id, label, badge}], value, onChange}`,
`Segmented {options, value, onChange}`, `Modal {open, title, onClose, footer, wide}`,
`Drawer {open, title, onClose, footer}`, `Field {label, hint, error, children}`,
`TextInput`, `TextArea {autosize}`, `Select {options}`, `Toggle {checked, onChange, label}`,
`Badge {tone: 'neutral'|'info'|'success'|'warning'|'danger'}`, `StatusPill {status}`,
`EmptyState {icon, title, body, action}`, `Spinner`, `Skeleton {lines}`, `Avatar {src, name}`,
`Stat {label, value, delta, format, sparkline}`, `DataTable {columns, rows, sortable, onRowClick}`,
`Menu {items, trigger}`, `MediaThumb {asset|assetId, size}`, `Callout {tone, title, children}`,
`DateTimeField {value(ISO), tz, onChange}`.
Charts (`ui/charts.js`, inline SVG, themed via CSS tokens): `LineChart {series, xLabels, height, format}`,
`BarChart {data, horizontal, format}`, `Heatmap {matrix 7x24, rowLabels, colLabels}`,
`Sparkline {values}`, `StackedBar {segments}`.

Layout: left sidebar (desktop) / bottom tab bar + "More" sheet (phone, < 760px). Content max width 1200px.

## 7. Screens (`js/views/*.js`, each `export default function View()`)

| Route | Module | Purpose |
|---|---|---|
| `#/` | dashboard.js | Today: account header, KPIs vs previous period, next posts, worker health, alerts, quick actions |
| `#/planner` | planner.js | Month/week calendar, list, Instagram grid preview; drag to reschedule; best-time hints |
| composer drawer | composer.js | Create/edit post: type, media, crop, caption, hashtags, first comment, collaborators, tags, location, alt text, preview, AI assist, schedule / queue / publish now / draft |
| `#/library` | library.js | Media library: upload, folders, tags, unused filter, send to autopilot |
| `#/queues` | queues.js | Evergreen lists (recurring slots that recycle content) |
| `#/autopilot` | autopilot.js | Autopilot settings, upcoming generated posts, approve/reject drafts |
| `#/analytics` | analytics.js | Overview, Posts, Reels, Stories, Audience, Best times, Hashtags tabs; date range + compare; CSV export |
| `#/reports` | reports.js | Printable report builder (window.print) |
| `#/inbox` | inbox.js | Comments, Messages, Mentions; reply/hide/delete; saved replies; AI suggestions |
| `#/automations` | automations.js | Keyword rules (comment reply, private reply DM, DM reply, hide), welcome DM, blocked words, activity |
| `#/competitors` | competitors.js | Tracked accounts via Business Discovery (Facebook Login) |
| `#/hashtags` | hashtags.js | Hashtag sets, caption templates, saved replies, hashtag research (Facebook Login) |
| `#/bio` | bio.js | Link-in-bio editor + preview + publish |
| `#/settings` | settings.js | Instagram connection, AI, time zone, worker status/secret, security, backup/export, activity log |

## 8. Worker (`worker/run.mjs`)

Env: `POSTPILOT_DATA_KEY` (base64 32 bytes, Actions secret), `GITHUB_TOKEN`, `GITHUB_REPOSITORY`,
`POSTPILOT_BRANCH` (default `postpilot-data`), optional endpoint overrides (section 3),
`POSTPILOT_NOW` (ISO, tests only), `POSTPILOT_MAX_WAIT_SEC` (default 540).

Order per run (each job isolated with try/catch; one failing job never blocks the others):
1. `token` refresh (Instagram Login, when older than 6 days or < 10 days to expiry)
2. `outbox` commands queued by the app
3. `publish` due posts (`scheduledAt <= now + lookahead`; waits for posts due within the run window)
4. `evergreen` fill list slots for the next `horizonDays`
5. `autopilot` keep the queue filled at best times (AI captions when configured)
6. `automations` poll recent comments/DMs, apply rules, welcome DMs, blocked words
7. `stories` capture live story insights before they expire
8. `analytics` daily snapshot (once per local day), media insights refresh, audience weekly
9. `competitors` daily (Facebook Login only)
10. `bio` refresh grid images daily
11. `housekeeping` sweep `public/tmp`, trim logs, record run summary
12. `notify` send Web Push notifications for this run's events to `settings.notifications.subscriptions`

Public-log rule: Actions logs of a public repo are public. The worker prints ONLY counts and
generic status ("published 1 post"). Never print captions, usernames, comment text, ids, tokens
or URLs. Mask the Instagram token with `::add-mask::` immediately after decrypting settings.
Detailed logs go to the encrypted `log` doc. Exit code 1 only when a post failed to publish
(GitHub then emails the owner); otherwise exit 0.

## 9. Security rules

- PAT and data key live in `sessionStorage` by default; `localStorage` only when "Remember this device" is on.
- `index.html` ships a strict Content-Security-Policy: scripts `'self'`; connect-src limited to the endpoints above.
- No secrets in URLs except Graph API `access_token` query params (required by Graph; never logged).
- The bio page and anything under `public/` must never contain private data.
