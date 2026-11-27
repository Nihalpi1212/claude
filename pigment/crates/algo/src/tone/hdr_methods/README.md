# HDR Toning's methods: the JavaScript Pigment's results

`js-cases.json` holds what Pigment 0.4's own `hdrToning` (`src/shared/pixels/hdr.js`) returns for the
Equalize Histogram, Exposure and Gamma and Highlight Compression methods on one small synthetic 8-bit
image (16 × 12, written into the file as RGBA hex: two grey ramps, two warm ramps, random mostly dark
colours, a few half-transparent pixels in the last row). The function is from Pigment 0.4.0 (tag
`pigment-v0.4.0`, commit `99dbdee` on the branch `claude/fervent-newton-263lz3`; `hdr.js` is the same at
the branch's head, `5305a81`). `tests.rs` beside it runs the Rust port on the same pixels and settings
and compares, within one level.

To write it again, from a checkout of that commit:

```
git archive 99dbdee pigment/src/shared | tar -x -C /tmp/pigment-0.4
node make-cases.mjs /tmp/pigment-0.4/pigment .
```
