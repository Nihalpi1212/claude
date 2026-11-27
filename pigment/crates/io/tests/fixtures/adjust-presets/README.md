# Adjustment preset files written by Pigment 0.4

These files were written by the JavaScript Pigment's own preset writers, not by hand:
`writeAcv` and `writeAlv` (`src/renderer/lib/adjust/tonal-formats.js`) and `writeAhu`,
`writeCha`, `writeAsv` and `writeBlw` (`src/renderer/lib/adjust/color-formats.js`), from Pigment
0.4.0 (tag `pigment-v0.4.0`, commit `99dbdee` on the branch `claude/fervent-newton-263lz3`; the
two files are the same at the branch's head, `5305a81`). `settings.json` holds the params each
file was written from, in the app's own terms. `crates/io/src/adjust_map/preset_files/tests.rs`
reads every one of them and checks the settings.

| File | Holds |
|---|---|
| `curves.acv` | a four-point composite curve, a red curve, an identity green and a two-point blue |
| `levels.alv` | composite, red and blue Levels (green left alone) |
| `hue-saturation.ahu` | master hue, saturation and lightness, the reds range moved and edited, blues desaturated |
| `sepia.ahu` | Colorize (hue 205, saturation 30, lightness -10) |
| `channel-mixer.cha` | Monochrome, gray mix 50 / 30 / 20 with a constant of 5 |
| `selective-color.asv` | Absolute, with reds, neutrals and blacks changed |
| `black-white.blw` | six weights and a tint (hue 35, saturation 25) |

To write them again, from a checkout of that commit:

```
git archive 99dbdee pigment/src/shared pigment/src/renderer/lib/adjust | tar -x -C /tmp/pigment-0.4
node make-fixtures.mjs /tmp/pigment-0.4/pigment .
```
