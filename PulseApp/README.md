# Pulse for iPhone (native SwiftUI)

A Spotify-style music app that **keeps playing in the background and on the lock screen**.

Music comes from sources that allow free full-length streaming:
* **Audius**: a large open catalog, works with no setup.
* **Jamendo** (optional): free Creative Commons music; add a free client ID in the app's Settings.

Features: home with trending and genres, search, full-screen player (seek, shuffle, repeat, queue),
mini player, Liked Songs, playlists, listening history, lock-screen and Control Center controls,
headphone-unplug pause, interruption handling (calls, Siri).

## Build and run on your iPhone (needs a Mac with Xcode)
1. Install Xcode from the App Store, and [Homebrew](https://brew.sh) if you don't have it.
2. In Terminal:
   ```bash
   brew install xcodegen
   cd PulseApp
   xcodegen generate
   open Pulse.xcodeproj
   ```
3. In Xcode, click the **Pulse** project, then **Signing & Capabilities**: tick *Automatically manage signing*
   and choose your **Team** (sign in with your free Apple ID under Xcode > Settings > Accounts).
   If it complains about the bundle identifier, change `com.pulse.personal.app` to something unique.
4. Plug in your iPhone, select it as the run destination, press **Run** (⌘R).
   On the phone: Settings > Privacy & Security > Developer Mode (turn on), and after the first install,
   Settings > General > VPN & Device Management > trust your developer profile.

With a free Apple ID the app expires after 7 days; just press Run again to refresh it.
A paid developer account ($99/year) removes that limit.

## Notes
* Background audio is enabled through the `audio` background mode (set in `project.yml`) and an
  `.playback` audio session in `PlayerManager.swift`.
* The `iOS build check` GitHub Action compiles the app on every push to catch errors.
