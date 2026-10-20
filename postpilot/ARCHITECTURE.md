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
Reading private data needs the passphrase (or the data key, which the worker holds as an Actions
secret); the encrypted files and the wrapped key are public, so the passphrase must be strong.
Changing anything also needs the owner's GitHub token. Settings can re-wrap the key under a new
passphrase or rotate the data key itself (re-encrypting everything).

## 1. Directory layout

```
postpilot/
  index.html              App shell (loads js/main.js as an ES module)
  bio.html                Public link-in-bio page (reads public/bio.json, no login)
  manifest.webmanifest    Installable on phones
  sw.js                   Service worker: push notifications and the Android share target (no caching)
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
    analytics.js          KPI math, period comparisons, aggregations, per-post history, monthly reports (pure)
    feed.js               RSS/Atom/RDF parser, og:image lookup, JPEG size (pure)
    mp4.js                MP4 metadata stripping and dimensions/duration
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
    push.js               Service worker registration (on app start) + push subscriptions + shared files
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
`inbox`, `log`, `bio` (public), `posts-archive` (published/canceled posts older than 90 days, moved there daily by
the worker so `posts` stays small), `analytics-media-history` (growth points of posts under 30 days old),
`reports` (monthly reports written by the worker). Shapes are documented in `core/model.js`; constructors `newPost`,
`newAsset`, `newRule`, `newList`; `validatePost(post, assetsById)`; `addHistory(post, event, detail)`.

Media: `media/<assetId>` (encrypted original, JPEG for photos), `media/<assetId>.thumb` (encrypted
JPEG, longest side 480px). Assets made from a link (CSV or RSS) carry `importUrl` until the worker's
`feeds` job has downloaded them (the page CSP keeps the browser from fetching other sites); downloaded
files have no separate thumbnail (`thumbPath === path`). Publishing exposes a plaintext copy (videos with their metadata boxes
renamed to `free` by `core/mp4.js`) at `public/tmp/<epochSec>-<random>.<ext>` on a separate
throwaway branch, `postpilot-public-tmp`, never on the data branch. That branch has no history:
every change points it at a new root commit (force) holding only the copies still needed. The worker
removes a copy as soon as Instagram has the media, and at the end of the publish job rewrites the
branch to hold only copies of containers Instagram is still processing. A carousel's files are exposed
together, before any container is created, so their copies share one rewrite. GitHub may keep unreferenced
commits reachable by their id for some time, so treat anything published as public.

Post lifecycle: `draft` -> `scheduled` -> `publishing` -> `published` | `failed`; `canceled` is
terminal. Reminder posts (`publishMode: 'reminder'`) go `scheduled` -> `reminded` (the worker sends a
push instead of calling Instagram) -> `published` when the owner taps "Mark as posted" in `#/post-now/<id>`.
A post deleted from Instagram becomes `canceled` with `deletedFromInstagramAt`; its media stays "used".
Only the worker moves a post from `scheduled` to `publishing`, `published` or `failed`, and a reminder post to
`reminded`. The app moves a scheduled post back to `draft` ("Move to drafts"), to `canceled` (delete), to
`reminded` ("Post by hand now" in the composer), or to `published` when the owner taps "Mark as posted" in
`#/post-now/<id>` (which accepts `reminded`, `scheduled`, `draft` and `failed` posts; "Remind me again in 1 hour"
there puts a reminder post back to `scheduled`). The app asks for immediate publishing by
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
| `#/planner` | planner.js | Month/week/day calendar, list, Instagram grid preview, search; drag to reschedule; best-time hints; AI ideas |
| `#/post-now/<id>` | post-now.js | Reminder posts: save files to the phone, copy caption, open Instagram, mark as posted (not in the nav) |
| composer drawer | composer.js | Create/edit post: type, media, crop, caption, hashtags, first comment, collaborators, tags, location, alt text, preview, AI assist, schedule / queue / publish now / draft |
| `#/library` | library.js | Media library: upload, folders, tags, unused filter, send to autopilot |
| `#/queues` | queues.js | Evergreen lists (recurring slots that recycle content); RSS/Atom feeds, CSV import and AI generation per list |
| `#/autopilot` | autopilot.js | Autopilot settings, upcoming generated posts, approve/reject drafts |
| `#/analytics` | analytics.js | Overview, Posts, Reels, Stories, Audience, Best times, Hashtags tabs; date range + compare; CSV export |
| `#/reports` | reports.js | Printable report builder (window.print) with logo and campaign section; past monthly reports |
| `#/inbox` | inbox.js | Comments, Messages (story reply/mention chips), Mentions, Invites (`#/inbox/invites`); reply/hide/delete; saved replies; AI suggestions |
| `#/automations` | automations.js | Keyword rules (comments, DMs, story replies, story mentions), watched-posts window, welcome DM, blocked words, collab auto-accept list, activity |
| `#/competitors` | competitors.js | Tracked accounts via Business Discovery (Facebook Login) |
| `#/hashtags` | hashtags.js | Hashtag sets, caption templates, saved replies, hashtag research (Facebook Login) |
| `#/bio` | bio.js | Link-in-bio editor + preview + publish |
| `#/settings` | settings.js | Instagram connection, AI, time zone, worker status/secret, security, backup/export, activity log |

## 8. Worker (`worker/run.mjs`)

Env: `POSTPILOT_DATA_KEY` (base64 32 bytes, Actions secret), `GITHUB_TOKEN`, `GITHUB_REPOSITORY`,
`POSTPILOT_BRANCH` (default `postpilot-data`), optional endpoint overrides (section 3),
`POSTPILOT_NOW` (ISO, tests only), `POSTPILOT_MAX_WAIT_SEC` (default 540),
`POSTPILOT_GITHUB_WRITES_PER_MIN` (write pacing, below), `POSTPILOT_ALLOW_PRIVATE_LINKS=1` (turns the link
guard off: the dev server, whose demo feed is on localhost, or a self-hosted worker reading feeds on its own network).

Write pacing: GitHub answers 403 past its secondary rate limit (about 80 content-creating requests a
minute), and publishing a backlog makes many in a burst. Requests to the real API other than GET and HEAD
are paced to 60 a minute (`paceWrites` in `worker/context.mjs`; `POSTPILOT_GITHUB_WRITES_PER_MIN`
overrides it, 0 = off; the local mocks are not paced). A secondary limit without `retry-after` is waited
out once for a minute (`core/github.js`); a GitHub rate limit that remains (`GitHubError.isRateLimit`)
does not count as a publishing attempt.

Order per run (each job isolated with try/catch; one failing job never blocks the others):
1. `token` refresh (Instagram Login, when older than 6 days or < 10 days to expiry)
2. `outbox` commands queued by the app
3. `publish` due posts (`scheduledAt <= now + lookahead`; waits for posts due within the run window);
   reminder posts get a push right away and need no Instagram connection; posts whose media is still
   downloading wait
4. `feeds` download linked media (`importUrl`, up to 8 a run) and check RSS/Atom feeds (hourly per feed;
   from a feed's third failed check in a row, `feed.errorCount`, twice as long between checks each time, up
   to a day). Links go through the link guard (section 9)
5. `evergreen` fill list slots for the next `horizonDays`
6. `autopilot` keep the queue filled at best times (AI captions when configured), reposts of top posts
7. `automations` poll comments (watched-posts window + chosen posts) and DMs, apply rules, welcome DMs, blocked words
8. `invites` collaboration invites every 6 hours (auto-accept allowlist, otherwise notify)
9. `stories` capture live story insights before they expire
10. `analytics` daily snapshot (once per local day), media insights refresh, per-post history, audience weekly;
    links posts marked as posted by hand (`published` without `igMediaId`) to their Instagram media, by the
    pasted link's shortcode or else by type and time (history event `linked`); flags media deleted from
    Instagram as `analytics-media.media[id].deletedAt` ("Delete from Instagram" in the app, or a lookup of a
    post missing from the listing that Instagram cannot find; one it still finds, e.g. archived, gets
    `unlistedAt`). Flagged media keeps its numbers for totals; lists of posts leave it out
11. `competitors` daily (Facebook Login only)
12. `reports` monthly report, checked on days 1-3 of a month and made on the 2nd (once the month's last day
    was read again) or the 3rd, never the 1st
13. `bio` refresh grid images daily; posts deleted from Instagram leave the grid (and `public/bio.json`)
14. `housekeeping` sweep the throwaway media branch, trim logs, archive old posts
15. `maintenance` keep-alive of the schedule (every ~20 days, in GitHub Actions only; a refused call also
    waits the interval) and monthly compaction of the data branch
Then: Web Push notifications for this run's events to `settings.notifications.subscriptions`, and the run record.
Every write of the `log` document stores it whole again, so a run is recorded when it did or logged
something, and an idle run only as an hourly heartbeat (replacing the previous idle record). The app
says the worker is late when the newest record is older than 90 minutes.

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
- Link guard: the worker fetches links third parties pick (feeds, their pages and images, CSV links) only
  over http(s) on ports 80 and 443, and refuses any whose host resolves to a private or local address
  (loopback, private ranges, link-local such as cloud metadata, IPv4 inside IPv6), checking every redirect
  itself (`guardLinks` in `worker/context.mjs`). A refused link is a lasting import error (code `blocked`).
  DNS rebinding is not covered (fetch resolves the name again).
