# Postpilot

Your private Instagram planner, publisher, analytics suite and autopilot. Postpilot covers most of what
Metricool does for Instagram, for one account (yours), and runs for free on your own GitHub account. No
server, no subscription, and nobody else can open it. What it does not do (and why) is listed under
"Good to know" below.

## What it does

| Area | Features |
|---|---|
| **Plan** | Month, week, day, list and Instagram-grid calendar with drag-to-reschedule and search · posts, carousels (up to 10), reels (cover frame, trial reels, share-to-feed) and stories · first comment, collaborators, user tags, location, alt text, "AI info" label · best-time suggestions and "add to queue" · drafts, duplicate, bulk actions · CSV import/export (media from your library or from links) · AI caption writer with rewrite actions (shorter, longer, fix grammar, call to action, tone, translate) and "ideas for next week" |
| **Automate** | Auto-publishing on schedule · **reminder posts** for what the API cannot post (music, link stickers, polls): your phone gets a notification and a "post now" screen with the files and caption ready · evergreen queues on fixed weekly slots, filled by hand, from RSS/Atom feeds, from a CSV or with AI · **Autopilot**: drop photos and videos in a pool and it writes captions (Claude AI, optional), picks your best times and fills your calendar, with or without your approval, and can repost your top posts · keyword auto-replies to comments and comment-to-DM private replies† (posts from the last 90 days, up to 50, plus any post you pick; both adjustable) · DM keyword replies, replies to your stories and stories that mention you† · welcome message† · hide comments with blocked words · collaboration invites accepted automatically from people you allow · push notifications to your phone · share photos into Postpilot from the Android share sheet |
| **Measure** | Follower growth, reach, views, interactions, accounts engaged, link taps with period comparison · reach and views from followers vs non-followers and by format · post, reel and story tables, with each young post's growth over time and views at 24 hours and 7 days (trial reels get a hint when they beat your median) · stories are captured while they are live (when first seen, then hourly, and on every run in their last 90 minutes) · audience demographics and online-follower heatmap · best times to post · hashtag performance · campaign results by post label · competitor benchmarks · printable/PDF reports with your logo, an automatic monthly report, and CSV export |
| **Engage** | Inbox for comments on your latest 12 posts and for DMs†, with saved replies and AI-suggested replies · hide, delete, private reply†, turn comments off · collaboration invites (accept or decline) · delete a published post (Facebook Login only) |
| **Grow** | Link-in-bio page with buttons and a grid of your posts, each linking wherever you want |

† Instagram lets your Meta app send DMs and private replies only to people who have a role on the app (you and
any testers) until Meta grants it **Advanced Access** through App Review and Business Verification. Publishing,
analytics, comment replies and moderation work without it. See step 5 of the setup.

## How it works

```
 Your browser (GitHub Pages)                 GitHub Actions (every 10 minutes)
 ┌──────────────────────────────┐            ┌──────────────────────────────────┐
 │ Postpilot app                │            │ Postpilot worker                 │
 │ - encrypts everything with   │   reads/   │ - publishes scheduled posts      │
 │   your passphrase            │   writes   │ - runs auto-replies and Autopilot│
 │ - live Instagram analytics   │◄──────────►│ - saves story and daily stats    │
 │   and inbox                  │  encrypted │ - refreshes your Instagram token │
 └──────────────────────────────┘   branch   └──────────────────────────────────┘
                 ▲            "postpilot-data"           │
                 └──────────── Instagram Graph API ◄─────┘
```

- Everything private (posts, captions, tokens, analytics, media) is encrypted with AES-256-GCM in your
  browser before it is saved to the `postpilot-data` branch of this repository. The repository is public
  (that is what keeps GitHub Pages and Actions free), but the data on that branch is unreadable without
  your passphrase.
- The web app is a locked shell for anyone else: opening it needs your GitHub token **and** your passphrase.
  If you turn on "Remember this device", that browser keeps the token and the data key, so anyone who can use
  that browser profile can open Postpilot without the passphrase. Only turn it on for your own devices; the
  lock button and Settings → Security → "Forget this device" remove them.
- The worker gets the data key through an encrypted GitHub Actions secret and prints only counts in its
  (public) logs.
- When a post is published, Instagram has to download the photo or video from a public URL. Postpilot
  puts an unencrypted copy on a throwaway `postpilot-public-tmp` branch for the minute Instagram
  needs, then wipes that branch, so the copy is not kept in any branch's history. GitHub may still serve an unreferenced copy to someone who
  saved its link for a while, so treat anything you publish as public.

## One-time setup (about 15 minutes)

You need: an Instagram **professional** account (Business or Creator) and this GitHub repository, set to
**public**.

### 1. Prepare the repository
- Make sure the repository is **public** (if it is not: repository **Settings → General → Danger Zone → Change
  visibility**). Instagram downloads the photos and videos you publish from it, and the link-in-bio page and
  free GitHub Pages need it public too. Your Postpilot data stays encrypted. In a private repository, posts
  that Postpilot publishes for you fail with "Instagram can only download media from a public repository".
- GitHub only runs scheduled workflows from a repository's default branch. Merge the branch that contains
  `postpilot/` into the default branch (or make that branch the default).

### 2. Turn on GitHub Pages
Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: your default
branch, folder `/ (root)` → Save**. After a minute the app is live at
`https://<your-username>.github.io/<repository>/postpilot/`.

### 3. Create a GitHub access token
Open <https://github.com/settings/personal-access-tokens/new> and create a **fine-grained** token:
- Repository access: **Only select repositories** → this repository.
- Permissions: **Contents**, **Actions** and **Secrets** set to **Read and write**.
- Expiration: up to you (Postpilot asks for a new one when it expires).

### 4. Open the app and create your passphrase
Open the app, enter your GitHub account, the repository name and the token, then choose a passphrase.
**Write the passphrase down. There is no reset.**

### 5. Connect Instagram
The app walks you through this. In short (Instagram Login, recommended):
1. In the Instagram app: Settings → Account type and tools → switch to a professional account if you have not.
2. Go to <https://developers.facebook.com/apps>, create an app and add the **Instagram** product
   ("Manage messaging & content on Instagram").
3. Open **API setup with Instagram business login → Generate access tokens → Add account**, log in to
   Instagram and accept. If asked, accept the tester invite in Instagram.
4. Click **Generate token**, copy it and paste it into Postpilot.

The app can stay in Development mode: publishing, analytics, comment replies and moderation on your own
account need no App Review. DMs and private replies (comment-to-DM, DM and story replies, the welcome message,
answering DMs in the Inbox) are different: until Meta grants your app **Advanced Access** to
`instagram_business_manage_messages` (`instagram_manage_messages` with Facebook Login) through App Review and
Business Verification, they only reach people who have a role on your Meta app. Postpilot tells you in
Automations and the Inbox when Instagram blocks them. The worker refreshes the token automatically before it
expires (60 days).

Use **Facebook Login** instead (Instagram account linked to a Facebook Page) if you want competitor
benchmarks and hashtag research: those Instagram APIs are only available through Facebook Login.

### 6. Connect the worker
In the app, click **Connect worker**. It stores the data key as the `POSTPILOT_DATA_KEY` Actions secret.
Then click **Run worker now** to test it. After that the worker runs every 10 minutes.

### 7. Optional
- **AI captions and replies:** in Settings → AI, add an Anthropic API key and turn on **Use AI features**.
- **Phone notifications:** Settings → Notifications. On iPhone, first add Postpilot to your Home Screen
  (Share → Add to Home Screen) and turn notifications on from there. Reminder posts need this to reach your
  phone (otherwise they only show on the Today screen).
- **Share into Postpilot:** on Android, install Postpilot (browser menu → Install app / Add to Home screen),
  then share photos or videos to it from any app. iPhone browsers do not support this.
- **Unlocking on your phone:** turn on **Remember this device** when you unlock Postpilot on your own phone.
  Otherwise, when Postpilot is closed, a reminder notification or a share opens the lock screen and you need
  your GitHub token and passphrase again.
- **DM automations:** in the Instagram app, Settings → Messages and story replies → Message controls →
  Connected tools → turn on **Allow access to messages**.

## Good to know

- **Timing:** GitHub starts scheduled runs every 10 minutes but can delay them, sometimes by 10–20 minutes
  at busy times. A run also waits up to 9 minutes for posts that come due while it is running, so most posts go
  out within a few minutes of their time; when GitHub delays runs, they go out on the next run. "Publish now"
  starts a run right away (usually live in 1–3 minutes).
- **Hashtags:** Instagram limits posts to 5 hashtags (since December 2025). Postpilot warns above 5.
- **DM automation limits:** Instagram allows one private reply per comment within 7 days, and DM replies only
  within 24 hours of the person's last message. Postpilot never sends unsolicited DMs. Sending DMs and private
  replies to people who do not have a role on your Meta app requires Meta's Advanced Access (App Review and
  Business Verification); comment replies, publishing and analytics work without it.
- **What Postpilot cannot post for you:** story stickers and links, polls, filters, and editing a caption after
  publishing are not in the official API. Music from Instagram's library is only in the API for some accounts on
  Facebook Login, and Postpilot does not support it yet. Use a reminder post for these: Postpilot notifies you at
  the right time with the files and caption ready to post by hand. Following, liking and unfollowing are not
  automated (that breaks Instagram's terms and gets accounts restricted).
- **Links and feeds:** the browser cannot download files from other websites, so photos and videos from RSS
  feeds and CSV links are downloaded by the worker (up to 8 a run). It can only publish JPEG photos it downloads;
  for PNG or WebP it tells you to download the file and upload it in the Library, which converts it.
- **Less certain Instagram features:** Meta documents story replies, story mentions and collaboration invites
  less clearly than the rest of the API. Postpilot handles the documented shapes; if Instagram refuses
  collaboration invites for your account, the Invites tab says so and you answer them in the Instagram app.
- **Storage:** media lives in this repository (encrypted). GitHub recommends keeping repositories under a few
  GB. Settings → Data can free space by removing media of posts published long ago. The worker compacts the
  data history monthly.
- **GitHub Actions terms:** GitHub's terms describe Actions as being for the software project in the repository,
  not a general-purpose serverless backend, so running a personal scheduler this way is a gray area and GitHub
  could limit the workflow. Postpilot keeps runs short (most finish in seconds). If it is ever blocked, the app
  keeps working, and the worker runs anywhere with Node 20+: `node postpilot/worker/run.mjs` with the
  `POSTPILOT_DATA_KEY`, `GITHUB_TOKEN` (a token with Contents read/write) and `GITHUB_REPOSITORY` environment
  variables, for example from a cron job on any always-on computer. Run it every 10 minutes. Two things then
  stop working: the app's "Publish now" and "Run now" buttons (they start the GitHub Actions workflow), and the
  keep-alive (every ~20 days) that stops GitHub from switching off scheduled workflows in quiet repositories,
  which is only needed in Actions.

## Developing locally

```bash
cd postpilot
node dev/server.mjs --seed     # http://localhost:5173/postpilot/  passphrase: demo passphrase 123
npm test                       # unit + worker tests (no network)
node --test tests/e2e/<name>.spec.mjs   # browser tests (needs Playwright + Chromium)
```

The dev server mocks GitHub, the Instagram Graph API and the Anthropic API, and runs the worker in-process
when the app dispatches it. See `ARCHITECTURE.md` for the design.
