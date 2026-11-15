# Pigment 0.5 builders round: baseline

The skeleton is committed on `claude/fervent-newton-263lz3`:

| Commit | What |
|---|---|
| f99f7e5 | The 0.5 skeleton (Part 2, steps 0 to 13, plus the fix pass for the three reviews' 24 findings). |
| 5305a81 | The flake #26 fix, test-only: `tests/e2e/helpers.mjs` runAwait, 23 direct command evaluates in 13 specs moved onto it, and `hunt2-layers.spec.mjs:204` made race-free. |

## Test counts at the start of the round

Measured on this machine (4 CPUs, one Playwright worker) on the tree with both commits:

| Suite | Command | Result |
|---|---|---|
| Unit | `cd /home/user/claude/pigment && node --test tests/unit/*.test.mjs` | **949 / 949** pass |
| Browser | `PIGMENT_E2E_PORT=<port> PIGMENT_E2E_OUT=tests/e2e/.artifacts-<name> npx playwright test -c tests/e2e/playwright.config.mjs --trace off` | 658 listed: **655 passed, 3 skipped, 0 failed**, in two full runs (19.9 and 20.3 minutes) |
| Electron | `xvfb-run -a npx playwright test -c tests/electron/playwright.config.mjs --trace off` | **8 / 8** pass |

The browser suite's three skips are expected:
- the two tests in `record-goldens.spec.mjs`, which run only with `PIGMENT_RECORD=1`. Never run them: they would re-record the 0.4 goldens over 0.5's code.
- the gated repaint-speed case.

A whole browser run takes about 20 minutes. With two engineers each running it on their own port at the same time, expect about twice that.

## Known flaky tests

**Flake #26** is fixed by 5305a81. The symptom: `page.evaluate: Execution context was destroyed, most likely because of a navigation`, usually inside `runAwait` or `openFixture`. It was not a navigation. Chromium 141's V8 14.1 inspector holds the promise that an awaited evaluate is waiting for weakly; a GC in an app microtask after that promise settles collects it, and Playwright reports the resulting "Promise was collected" with that text.
- `runAwait(page, cmd, arg, source = 'api')` now settles from a fresh task.
- In new tests, await app commands and other app promises through `runAwait`, or the same try/finally `setTimeout(0)` pattern. Never return the app's promise straight from a bare `page.evaluate`.
- The shipped Electron app (V8 15.2) is not affected.
- If the message still appears, report the whole message and the test name; do not reinstall node_modules.

The fix makes runAwait settle one task later, which exposed one racy test:
- `hunt2-layers.spec.mjs:204` measured a Layers row from the test (`boundingBox()`), then dispatched a drag in the page. The panel can rebuild its rows in the next frame, so the measured row could already be detached, and `boundingBox()` returned null. It failed 6 times in 30 with the new timing (0 in 30 before).
- It now measures the row inside the page, in the same `evaluate` as the drag, and passed 40 times in 40. Write new tests the same way: measure and act in one `page.evaluate`, or act with `page.mouse` on a box measured once the UI has settled (`expect(...).toBeVisible()` first).

No other test is known to be flaky. Before calling a failure a flake, re-run it alone with `--repeat-each 3`.

## CI

`.github/workflows/pigment-ci.yml` runs on every push that touches `pigment/`: `npm ci` (its postinstall builds the vendor bundles), the unit tests, the browser suite and the Electron tests, on ubuntu-24.04, with a 45-minute limit. CI on f99f7e5 is green: push run 43675759433 and pull_request run 43675762361, about 21 minutes each (the PSD text goldens pass on CI's fonts too).

The local diagnostic patch to Playwright (node_modules/playwright-core/lib/server/chromium/crExecutionContext.js, which appended "[original: …]" to the error) has been removed: node_modules is as `npm ci` installs it.
