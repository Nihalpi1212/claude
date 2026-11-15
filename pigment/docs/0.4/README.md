# Pigment 0.4: package notes

This folder collects what the sixteen 0.4 packages write for the user guide and the release notes while they are
built in parallel (ARCHITECTURE.md, "0.4 features (contracts)", rule 7).

**Rule 7.** A package writes its user-guide text, its release-note lines (every changed default or key) and its known
gaps into `docs/0.4/<package>.md`. The integrator merges them into `docs/USER-GUIDE.md`, the release notes and
ARCHITECTURE.md. Nobody edits USER-GUIDE.md, README.md or ARCHITECTURE.md during the parallel round.

One file per package, named after the package:

| Package | File |
|---|---|
| type-engine-core | `type-engine-core.md` |
| type-editing | `type-editing.md` |
| type-character-panel | `type-character-panel.md` |
| type-paragraph-panel | `type-paragraph-panel.md` |
| layer-style-blending | `layer-style-blending.md` |
| layer-style-effects | `layer-style-effects.md` |
| adjust-tonal | `adjust-tonal.md` |
| adjust-color | `adjust-color.md` |
| gradients | `gradients.md` |
| patterns | `patterns.md` |
| guides-snapping | `guides-snapping.md` |
| masks-vector-masks | `masks-vector-masks.md` |
| shapes-live | `shapes-live.md` |
| layers-panel-depth | `layers-panel-depth.md` |
| finish-layer-menu | `finish-layer-menu.md` |
| conventions-shortcuts-fields | `conventions-shortcuts-fields.md` |

Each file has three parts, in this order:

1. **User guide**: what a user needs to know to use the package's features, written for the user guide (plain
   words, Photoshop's names for menus and panels).
2. **Release notes**: one line per new feature worth naming, and one line for every changed default, key or behaviour
   of an existing feature (also those an existing spec asserts).
3. **Known gaps**: what the package's brief or contract asked for that it did not do, and why.

`skeleton.md` holds the skeleton's own release notes: the key changes, the layout notes, the behaviour changes of the
skeleton and the review decisions of the contract.
