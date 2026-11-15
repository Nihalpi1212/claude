# Eaves

The weather outside, on your Mac's desktop. Eaves is a small menu bar app: when it snows where you
live, snow falls across your screen and settles on top of your windows; when it rains, rain splashes
on them. It is free and open source (MIT).

Eaves is its own app, written from scratch. Every picture in it is drawn by code; it contains no
artwork, code or names from any other app.

## What it does

- **Follows the live weather** for a city you pick, or for where your Mac is. The menu bar shows the
  conditions and the temperature.
- **Ten scenes**: Snow, Blizzard, Rain, Thunderstorm, Mist, Falling Leaves, Petals, Fireflies,
  Sun Motes and Embers. Pick one by hand whenever you like.
- **Snow settles on your windows** and on the bottom of the screen. It follows a window when you
  move it, comes off if you shake the window, falls when the window closes, and melts when the snow
  stops (faster in the rain). Sweep the cursor through a pile to brush it away.
- **Leaves and petals land** on windows, lie there for a while, then blow off again.
- **Stays out of your way**: by default the window you are working in is kept clear and weather only
  lands on top of it. You can instead have weather in front of everything, or only over the desktop.
  It hides while an app is full screen, and clicks always go straight through it.
- **Seasonal scenes on dry days** (petals in spring, motes and fireflies in summer, leaves in
  autumn), which you can turn off.
- **The wind is real**: direction and strength come from the forecast.
- Works on every connected display. Uses no power when the sky is empty.

Open the menu bar icon for the scene, amount, and pause; **Settings…** has the rest.

## Install

Needs macOS 13 (Ventura) or later, on Apple silicon or Intel.

### Download a build

Every change is built by GitHub Actions. Open the latest successful **Eaves CI** run in the
repository's Actions tab, download the **Eaves-mac** artifact, unzip it twice, and drag **Eaves**
to your Applications folder.

Eaves is not signed with a paid Apple Developer ID, so macOS will not open it straight away. Once
only, either:

- open it, dismiss the warning, then go to **System Settings › Privacy & Security** and click
  **Open Anyway**; or
- run this in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Eaves.app
```

### Or build it yourself

Needs the Xcode Command Line Tools (`xcode-select --install`). An app you build yourself opens
without any warning.

```bash
cd eaves
./scripts/build-app.sh
open build
```

## Privacy

- Weather comes from [Open-Meteo](https://open-meteo.com), which needs no account. Eaves sends it the
  position of the place you follow, rounded to two decimals (about a kilometre), and nothing else.
  Open-Meteo's free service is for non-commercial use.
- Looking up your own position is optional and uses macOS Location Services, which asks first.
- To put snow on windows, Eaves reads the positions and sizes of the windows on screen. It does not
  read their titles or contents, and needs no Screen Recording or Accessibility permission.
- Nothing is collected and there is no analytics.

## Development

```bash
swift test                               # unit tests for the simulation and weather mapping
swift run Eaves --scene blizzard         # run from source, showing one scene
swift run Eaves --selftest 15            # run for 15 s, print what was drawn, exit 0 or 1
swift run Eaves --probe                  # ask the weather service for real, open Settings, exit 0 or 1
```

Layout: `Sources/EavesCore` is the simulation, the snow piles and the weather mapping (Foundation
only, unit tested). `Sources/Eaves` is the app: a click-through overlay window per screen drawn with
SpriteKit, the window tracker, the menu bar item and the Settings window.
