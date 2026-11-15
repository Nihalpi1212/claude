# Pigment 0.5: package notes

This folder collects what the fifteen 0.5 packages write for the user guide and the release notes while they are
built in parallel (ARCHITECTURE.md, "0.5 features (contracts)", rule 7).

**Rule 7.** A package writes its user-guide text, its release-note lines (every changed default or key) and its known
gaps into `docs/0.5/<package>.md`. The integrator merges them into `docs/USER-GUIDE.md`, the release notes and
ARCHITECTURE.md. Nobody edits USER-GUIDE.md, README.md or ARCHITECTURE.md during the parallel round.

One file per package, named after the package. Each package runs its own specs on its own port (rule 14) with its
own artifacts directory; the skeleton's specs (`skeleton-05.spec.mjs`, `brush-golden.spec.mjs`) use 8850.

| # | Package | Port | Entry (MODULES, or how it loads) | File |
|---|---|---|---|---|
| 1 | brush-engine-core | 8851 | `lib/brush/define.js` | `brush-engine-core.md` |
| 2 | brush-settings-panel | 8852 | `lib/panels/brush-settings.js` | `brush-settings-panel.md` |
| 3 | brush-painting-behaviours | 8853 | `lib/tools/paint-keys.js` | `brush-painting-behaviours.md` |
| 4 | icc-engine | 8854 | `lib/color/cmm.js` | `icc-engine.md` |
| 5 | psd-layers | 8855 | files loaded by `lib/psd/index.js` | `psd-layers.md` |
| 6 | psd-text | 8856 | a file loaded by `lib/psd/index.js` | `psd-text.md` |
| 7 | camera-raw-workspace | 8857 | `lib/develop/workspace.js` | `camera-raw-workspace.md` |
| 8 | camera-raw-panels | 8858 | `lib/develop/tabs/index.js` | `camera-raw-panels.md` |
| 9 | presets-panels | 8859 | `lib/tool-presets.js` (and the Styles, Shapes, Tool Presets panels) | `presets-panels.md` |
| 10 | preset-files-manager | 8860 | `lib/preset-manager.js` | `preset-files-manager.md` |
| 11 | color-picker-swatches | 8861 | `lib/color-picker.js` | `color-picker-swatches.md` |
| 12 | type-fonts | 8862 | `lib/type/font-library.js` | `type-fonts.md` |
| 13 | type-menu-commands | 8863 | `lib/type/commands.js` | `type-menu-commands.md` |
| 14 | shortcuts-editor | 8864 | `lib/shortcuts-editor.js` | `shortcuts-editor.md` |
| 15 | move-tool-depth | 8865 | `lib/tools/move-handles.js`, imported by `lib/tools/move.js` | `move-tool-depth.md` |

A package runs the browser suite on its port with, for example,
`PIGMENT_E2E_PORT=8851 PIGMENT_E2E_OUT=tests/e2e/.artifacts-brush-engine-core npx playwright test -c tests/e2e/playwright.config.mjs`
(`PIGMENT_PARTIAL=1` while modules of other packages are missing, as in 0.4).

Each file has three parts, in this order:

1. **User guide**: what a user needs to know to use the package's features, written for the user guide (plain
   words, Photoshop's names for menus and panels).
2. **Release notes**: one line per new feature worth naming, and one line for every changed default, key or behaviour
   of an existing feature (also those an existing spec asserts).
3. **Known gaps**: what the package's brief or contract asked for that it did not do, and why.

Every package that bundles third-party data (type-fonts' OFL fonts, icc-engine's LittleCMS) lists it in its file for
the release notes' notices (rule 15).

`skeleton.md` holds the skeleton's own release notes: the key and menu changes, the behaviour changes of the skeleton
and where the skeleton as landed differs from the contract (the full list is in ARCHITECTURE.md, "The skeleton as
landed").
