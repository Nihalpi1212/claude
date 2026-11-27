# Auto Color Correction Options: the JavaScript Pigment's results

`js-cases.json` holds what Pigment 0.4's own functions return on five small synthetic images
(24 × 24, written into the file as RGBA hex): `autoLevelsParams` and `autoTonalParams`
(`src/shared/pixels/adjust-tonal.js`) and `autoBrightnessContrast`
(`src/renderer/lib/adjust/simple-editors.js`), from Pigment 0.4.0 (tag `pigment-v0.4.0`, commit
`99dbdee` on the branch `claude/fervent-newton-263lz3`; the two files are the same at the branch's
head, `5305a81`). `tests.rs` beside it runs the Rust port on the same pixels and options and
compares.

To write it again, from a checkout of that commit:

```
git archive 99dbdee pigment/src/shared pigment/src/renderer/lib/adjust | tar -x -C /tmp/pigment-0.4
node make-cases.mjs /tmp/pigment-0.4/pigment .
```
