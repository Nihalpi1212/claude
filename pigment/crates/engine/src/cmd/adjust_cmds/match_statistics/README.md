# Match Color statistics: a file the JavaScript Pigment wrote

`js-statistics.json` is the file Pigment 0.4's Match Color › Save Statistics… writes for the image in
`js-source.json` (12 × 10 pixels, 8-bit RGBA hex: saturated oranges, darker downwards). The statistics are the app's own
`labStatistics` (`src/shared/pixels/adjust-more.js`, CIE L*a*b* over D65), rounded and wrapped as
`matchColorEditor` does (`src/renderer/lib/adjust-more-ui.js`), from Pigment 0.4.0 (tag `pigment-v0.4.0`,
commit `99dbdee` on the branch `claude/fervent-newton-263lz3`). `tests.rs` beside it loads the file and
checks it against PhotoCraft's own (D50) statistics of the same pixels.

To write them again, from a checkout of that commit:

```
git archive 99dbdee pigment/src/shared | tar -x -C /tmp/pigment-0.4
node make-fixture.mjs /tmp/pigment-0.4/pigment .
```
