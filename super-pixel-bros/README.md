# Super Pixel Bros

A detailed Super Mario-style platformer written from scratch in a single HTML5 file
(no dependencies, no assets, everything is drawn and synthesized in code).
It runs on macOS in Safari, Chrome, Firefox or Edge.

## Play on a Mac

* **Easiest:** double-click `index.html`.
* **Launcher:** double-click `play.command` (first time: right-click > Open).
* **Real app:** run `./make_app.sh` in Terminal to build `Super Pixel Bros.app`, then double-click it.

## Controls

| Action | Keys |
|---|---|
| Move | Arrow keys or A / D |
| Jump (hold for higher) | Space, Z, W, K or Up |
| Run / throw fireball | Shift, X or J |
| Pause | P or Esc |
| Mute | M |
| Start / continue | Enter or Space |

Debug URL parameters: `index.html?level=2&state=2` starts on world 1-2 as Fire form.

## Features

* 3 worlds: **1-1 Grasslands** (day), **1-2 Deep Caverns** (underground), **1-3 Moonlit Skyway** (night, cloud platforms)
* Tight Mario-style physics: acceleration, skidding, run speed, variable jump height, coyote time, jump buffering
* Question blocks, breakable bricks, multi-coin bricks, bump animation, block-bump kills enemies on top
* Power-ups: Super Mushroom, Fire Flower (fireballs), Star (invincibility), 1-UP; shrink/grow animation and invulnerability frames
* Enemies: Goombas, Koopa Troopas (stomp into shells, kick them, shell chains), Piranha Plants in pipes
* Warp pipes, hard-block staircases, pits, flagpole with height-based score, castle, time bonus
* Score popups, stomp combos, coin counter (100 coins = 1-UP), lives, countdown timer, hurry-up jingle, top score saved locally
* Parallax scenery: clouds, hills, bushes, starry night, moon; animated blocks and coins
* Chiptune music per world and sound effects, all synthesized with the Web Audio API
* Pixel-perfect scaling to any window size
