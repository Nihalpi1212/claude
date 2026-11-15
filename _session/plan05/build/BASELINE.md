# Pigment 0.5 builders round: baseline

The skeleton is committed on `claude/fervent-newton-263lz3`:

| Commit | What |
|---|---|
| f99f7e5 | The 0.5 skeleton (Part 2, steps 0 to 13, plus the fix pass for the three reviews' 24 findings). |
| FLAKE_COMMIT | The flake #26 fix, test-only: `tests/e2e/helpers.mjs` runAwait, and 23 direct command evaluates in 13 specs moved onto it. |

## Test counts at the start of the round

Measured on this machine (4 CPUs, one Playwright worker) on the tree with both commits:

| Suite | Command | Result |
|---|---|---|
| Unit | `cd /home/user/claude/pigment && node --test tests/unit/*.test.mjs` | **949 / 949** pass |
| Browser | `PIGMENT_E2E_PORT=<port> PIGMENT_E2E_OUT=tests/e2e/.artifacts-<name> npx playwright test -c tests/e2e/playwright.config.mjs --trace off` | BROWSER_RESULT |
| Electron | `xvfb-run -a npx playwright test -c tests/electron/playwright.config.mjs --trace off` | **8 / 8** pass |

The browser suite's three skips are expected:
- the two tests in `record-goldens.spec.mjs`, which run only with `PIGMENT_RECORD=1`. Never run them: they would re-record the 0.4 goldens over 0.5's code.
- the gated repaint-speed case.

A whole browser run takes about 20 minutes. With two engineers each running it on their own port at the same time, expect about twice that.

## Known flaky tests

**Flake #26** is fixed by FLAKE_COMMIT. The symptom: `page.evaluate: Execution context was destroyed, most likely because of a navigation`, usually inside `runAwait` or `openFixture`. It was not a navigation. Chromium 141's V8 14.1 inspector holds the promise that an awaited evaluate is waiting for weakly; a GC in an app microtask after that promise settles collects it, and Playwright reports the resulting "Promise was collected" with that text.
- `runAwait(page, cmd, arg, source = 'api')` now settles from a fresh task.
- In new tests, await app commands and other app promises through `runAwait`, or the same try/finally `setTimeout(0)` pattern. Never return the app's promise straight from a bare `page.evaluate`.
- The shipped Electron app (V8 15.2) is not affected.
- If the message still appears, report the whole message and the test name; do not reinstall node_modules.

No other test is known to be flaky. Before calling a failure a flake, re-run it alone with `--repeat-each 3`.

## CI

`.github/workflows/pigment-ci.yml` runs on every push that touches `pigment/`: `npm ci` (its postinstall builds the vendor bundles), the unit tests, the browser suite and the Electron tests, on ubuntu-24.04, with a 45-minute limit. CI on f99f7e5: CI_RESULT.
