# Clarity and Dehaze, Grain: the JavaScript Pigment's results

`js-cases.txt` holds what Pigment 0.4's own `applyAdjustment` (`src/shared/pixels/adjust.js`, the kinds
`clarity-dehaze` and `grain` of `adjust-color.js`) returns on a small synthetic image (32 × 24, opaque, RGBA
hex), and `grainNoise` at a few positions, from the branch `claude/fervent-newton-263lz3` at `5305a81`
(the functions are the same as in Pigment 0.4.0, tag `pigment-v0.4.0`). `tests.rs` beside it runs the
Rust port on the same pixels and compares.

Color and Vibrance has no cases: Pigment follows Camera Raw's white-balance gains and the Vibrance
adjustment's own Vibrance and Saturation there (the plan's choice), not the app's formulas.

To write it again, from a checkout of that commit:

```
git archive 5305a81 pigment/src/shared | tar -x -C /tmp/pigment-0.4
echo '{"type":"module"}' > /tmp/pigment-0.4/pigment/package.json
node make-cases.mjs /tmp/pigment-0.4/pigment .
```
