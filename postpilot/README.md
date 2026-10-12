# Postpilot

Your private Instagram planner, publisher, analytics suite and autopilot. Postpilot does what Metricool
does for Instagram, for one account (yours), and runs for free on your own GitHub account. No server,
no subscription, and nobody else can open it.

## What it does

| Area | Features |
|---|---|
| **Plan** | Month, week, list and Instagram-grid calendar with drag-to-reschedule · posts, carousels (up to 10), reels (cover frame, trial reels, share-to-feed) and stories · first comment, collaborators, user tags, location, alt text, "AI info" label · best-time suggestions and "add to queue" · drafts, duplicate, bulk actions · CSV import/export |
| **Automate** | Auto-publishing on schedule · evergreen queues that recycle content on fixed weekly slots · **Autopilot**: drop photos and videos in a pool and it writes captions (Claude AI, optional), picks your best times and fills your calendar, with or without your approval · keyword auto-replies to comments, comment-to-DM private replies, DM keyword replies, welcome message, hide comments with blocked words · push notifications to your phone |
| **Measure** | Follower growth, reach, views, interactions, accounts engaged, link taps with period comparison · post, reel and story tables (stories are saved every 10 minutes before Instagram deletes them) · audience demographics and online-follower heatmap · best times to post · hashtag performance · competitor benchmarks · printable/PDF reports and CSV export |
| **Engage** | Unified inbox for comments and DMs with saved replies and AI-suggested replies · hide, delete, private reply, turn comments off |
| **Grow** | Link-in-bio page with buttons and a grid of your posts, each linking wherever you want |

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
- The worker gets the data key through an encrypted GitHub Actions secret and prints only counts in its
  (public) logs.
- When a post is published, Instagram has to download the photo or video from a public URL. Postpilot
  puts an unencrypted copy on a throwaway `postpilot-public-tmp` branch for the minute Instagram
  needs, then wipes that branch, so the copy is not kept in any branch's history. GitHub may still serve an unreferenced copy to someone who
  saved its link for a while, so treat anything you publish as public.

## One-time setup (about 15 minutes)

You need: an Instagram **professional** account (Business or Creator) and this GitHub repository.

### 1. Put Postpilot on the default branch
GitHub only runs scheduled workflows from a repository's default branch. Merge the branch that contains
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

The app stays in Development mode; you do not need App Review for your own account. The worker refreshes
the token automatically before it expires (60 days).

Use **Facebook Login** instead (Instagram account linked to a Facebook Page) if you want competitor
benchmarks and hashtag research: those Instagram APIs are only available through Facebook Login.

### 6. Connect the worker
In the app, click **Connect worker**. It stores the data key as the `POSTPILOT_DATA_KEY` Actions secret
and starts the first run. From then on the worker runs every 10 minutes.

### 7. Optional
- **AI captions and replies:** add an Anthropic API key in Settings → AI.
- **Phone notifications:** Settings → Notifications. On iPhone, first add Postpilot to your Home Screen
  (Share → Add to Home Screen) and turn notifications on from there.
- **DM automations:** in the Instagram app, Settings → Messages and story replies → Message controls →
  Connected tools → turn on **Allow access to messages**.

## Good to know

- **Timing:** GitHub starts scheduled runs every 10 minutes but can delay them, sometimes by 10–20 minutes
  at busy times. Posts publish on the first run at or after their time. "Publish now" starts a run right away
  (usually live in 1–3 minutes).
- **Hashtags:** Instagram limits posts to 5 hashtags (since December 2025). Postpilot warns above 5.
- **DM automation limits:** Instagram allows one private reply per comment within 7 days, and DM replies only
  within 24 hours of the person's last message. Postpilot never sends unsolicited DMs. Sending DMs to people
  who do not have a role on your Meta app may require Meta's Advanced Access (App Review); comment replies,
  publishing and analytics work without it.
- **What the official API cannot do:** music from Instagram's library, story stickers and links, editing a
  caption after publishing, following/liking/unfollowing (automating those breaks Instagram's terms and gets
  accounts restricted, so Postpilot does not do it).
- **Storage:** media lives in this repository (encrypted). GitHub recommends keeping repositories under a few
  GB. Settings → Data can free space by removing media of posts published long ago. The worker compacts the
  data history monthly.
- **GitHub Actions terms:** GitHub's terms describe Actions as being for the software project in the repository,
  not a general-purpose serverless backend, so running a personal scheduler this way is a gray area and GitHub
  could limit the workflow. Postpilot keeps runs short (most finish in seconds). If it is ever blocked, the app
  keeps working, and the worker runs anywhere with Node 20+: `node postpilot/worker/run.mjs` with the
  `POSTPILOT_DATA_KEY`, `GITHUB_TOKEN` (a token with Contents read/write) and `GITHUB_REPOSITORY` environment
  variables, for example from a cron job on any always-on computer.

## Developing locally

```bash
cd postpilot
node dev/server.mjs --seed     # http://localhost:5173/postpilot/  passphrase: demo passphrase 123
npm test                       # unit + worker tests (no network)
node --test tests/e2e/<name>.spec.mjs   # browser tests (needs Playwright + Chromium)
```

The dev server mocks GitHub, the Instagram Graph API and the Anthropic API, and runs the worker in-process
when the app dispatches it. See `ARCHITECTURE.md` for the design.
