# Marquee for Mac (native SwiftUI)

A Stremio-style media center for macOS: browse catalogs, open a title, pick a source, watch it in a
native player. Marquee has no ads, no account and no tracking.

Like Stremio, Marquee hosts no video. What you can watch depends on the add-ons you install.
It comes with:

* **Internet Archive** (built in): thousands of public-domain films, cartoons, film noir,
  sci-fi/horror and classic TV that play right away.
* **Cinemeta**: Stremio's public catalog of movies and series (posters, descriptions, cast,
  episode lists). It lists titles but has **no video**, so its titles only play if another
  add-on supplies a source.
* **My Files**: your own video folders (starts with ~/Movies), plus a box to play any direct
  MP4 / MOV / HLS link.

Any add-on that speaks the open [Stremio add-on protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md)
can be installed from **Add-ons** by pasting its `manifest.json` address. Marquee has no torrent
engine, so it plays direct links only and torrent-only results are hidden. Only install add-ons
for content you have the right to watch.

## Features
* Discover rows from every installed catalog, a Movies / Series switch, and "See All" grids with genre filters
* Search across every add-on that supports it
* Title pages with backdrop, details, cast, trailer button, seasons and episodes
* Sources from all add-ons at once; right-click a source to copy the link or open it elsewhere
* Native player (AVKit): full screen, picture-in-picture, AirPlay, keyboard controls
* Resume where you left off, Continue Watching, watched marks, and a Library of saved titles
* File > Open Video… (⌘O) plays any file; MKV/AVI and other formats open in your default video app (e.g. IINA or VLC)

## Install without Xcode
1. On GitHub, open **Actions > Marquee macOS build**, pick the latest green run, and download the
   **Marquee-macOS** artifact. Unzip it (you may need to unzip twice) and drag **Marquee.app** to Applications.
2. The app isn't notarized by Apple, so the first launch is blocked. Open it once, then go to
   **System Settings > Privacy & Security** and click **Open Anyway**. Or in Terminal:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Marquee.app
   ```

## Build it yourself (needs Xcode 15 or later, macOS 14 or later)
```bash
brew install xcodegen
```
```bash
cd MarqueeApp && xcodegen generate && open Marquee.xcodeproj
```
Then press **Run** (⌘R). No Apple developer account is needed; the project signs to run locally.

## How it works
| File | What it does |
| --- | --- |
| `AddonClient.swift` | Stremio protocol client (manifest, catalog, meta, stream) and default add-ons |
| `ArchiveSource.swift` | Built-in Internet Archive source using archive.org's search and metadata APIs |
| `AppModel.swift` | Add-ons, library, watch progress and folders, saved to `~/Library/Application Support/Marquee/state.json`; local folder scanning |
| `BrowseViews.swift` | Discover, catalog grid, Search, Library |
| `DetailView.swift` | Title page, episodes, source list |
| `PlayerView.swift` | Player window with resume and progress saving |
| `SourcesViews.swift` | My Files and Add-ons screens |
| `Models.swift` | Data types with lenient JSON decoding (add-ons disagree on types) |

The **Marquee macOS build** GitHub Action compiles the app on every push to `MarqueeApp/`.
