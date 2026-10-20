# Pulse

A personal Spotify-style music app for iPhone, built as an installable web app (PWA).
Search and play music through YouTube. Personal use only.

## Features
Home with genre tiles and recently played, search, full-screen Now Playing (seek bar, shuffle, repeat,
queue), mini player, Liked Songs, custom playlists (create, rename, delete, add and remove songs),
import a YouTube playlist by link, add a song by pasting a YouTube link, lock-screen controls via the
Media Session API, backup export and import. Data stays on your device.

## How it works
* **Search**: YouTube Data API v3 with your own free API key (set in the app under Settings).
* **Playback**: the official YouTube embedded player. No audio is downloaded or extracted.

## Put it on your iPhone
1. Host this folder over HTTPS. The easiest way is GitHub Pages:
   repo **Settings > Pages > Deploy from a branch**, pick the branch and `/ (root)`.
   The app is then at `https://<user>.github.io/<repo>/pulse/`.
2. Open that address in **Safari** on the iPhone, tap **Share > Add to Home Screen**.
3. Open Pulse, go to **Settings** and paste your YouTube API key
   (Google Cloud Console > enable *YouTube Data API v3* > Credentials > API key; restrict it to your site address).

The embedded player does not work from a `file://` page, so it needs to be served over http(s).
To try it on a computer: `cd pulse && python3 -m http.server 8000`, then open http://localhost:8000.

## Limits to know about
* Search quota is about 100 searches per day on the free API tier. Results are cached per session.
* Playback may pause when the iPhone screen locks or the app goes to the background; this is a limit of
  YouTube's embedded player on iOS. YouTube ads can also play.
* Some videos block embedding and are skipped automatically.
