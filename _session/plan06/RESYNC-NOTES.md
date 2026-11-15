# Pigment 0.6 contract: what to re-sync once 0.5 is released

The 0.6 contract workflow (run wf_2d8aa515-cc9) finished at 02:24 UTC on Nov 15:

| Stage | Result |
|---|---|
| Draft | 159 KB |
| Review | 4 reviews from the builders' side, 15 findings each: 60 in all (9 blocker, 45 major, 6 minor) |
| Revise | The architect checked all 60 against the frozen tree and found every one accurate. 44 were applied as proposed; 16 were applied in part or decided otherwise, with reasons in "Review decisions" (16 items, which also answer the draft's seven open questions). |

**Files**

| File | What it is |
|---|---|
| `CONTRACT-06.md` | The final contract: 171,034 bytes, 1,839 lines. Part 1 has rules 16 to 20, 35 split behaviours, an ownership table of 51 rows over 82 files, E56 to E86, T1 to T18, 16 packages on ports 8851 to 8866 in two sequences, 26 reliance rows and the review decisions. Part 2 is the checklist, steps 0 to 14. |
| `CONTRACT-06.draft.md` | The reviewed draft, unchanged. |
| `tree/pigment` | The frozen tree the contract was checked against: wip05 snapshot 5ac705b, taken during the 0.5 skeleton round (steps 0 to 6). |

The contract's 0.5 names come from CONTRACT-05 and the hand-offs that existed while it was drafted, not from released code. Before skeleton-06 starts, run a re-sync pass (a workflow, one or two agents at a time):

1. **Refreeze the tree** at the pigment-v0.5.0 release commit and point the contract at it.
2. **Step 0 of Part 2: check every "Reliances on 0.5" row** (26 rows) against the released code. Wherever a row does not hold, record a facade the skeleton lands, or a note, before the packages start. The rows the architect flagged as most at risk:
   - the lcms2 symbols in icc-engine's build (CMYK, Gray and Lab pixel types; the proofing transform with GAMUTCHECK and SOFTPROOFING; multiprofile transforms; `cmsSaveProfileToMem`; black-point detection);
   - whether icc-engine uses `profileOf(doc)` everywhere;
   - the shape of `tools/move.js` (move-tool-depth's `onPointerDown` and `onKeyDown`);
   - the brush engine's `BrushStroke` shape;
   - psd-text's chainable TySh wrapper in `scripts/vendor-entries/ag-psd-text.js`;
   - the `.xmp` names behind T14.5's facade, read from `lib/develop/presets.js`.
3. **Fold in the deviations that landed after the draft:**
   - HANDOFF-4: `develop()` is in `develop-stages.js` with a fourth size argument; `developDefaults()` has `treatment`; `swatchColors` is gated on `settings.colorUI.swatchesMigrated`; the `font-library.js` stub.
   - HANDOFF-5: the extra exports of `preset-formats.js`; `OPEN_FILTERS` is unchanged; `TransformTool.planFor`, `beginDrag` and `previewBox`; the history label stays "Free transform"; `move-handles.js` is not imported yet.
   - The skeleton's fix pass, the 15 packages' reports and INTEGRATION-05.
   - Every name in `docs/0.5/` and in ARCHITECTURE.md's "The skeleton as landed".
4. **T18.2's line numbers:** find the `view.ctx` readers and the flat-image confirm specs by grep, and re-check every listed spec line against the released specs. Line numbers will have moved during 0.5.
5. **Release workflow path** (listed as unconfirmed in the contract): `.github/workflows/pigment-release.yml` at the repository root, with `pigment-ci.yml` beside it. It runs on `pigment-v*` tags, or on a manual run with a `tag` input.
6. **A fresh review round on the revised contract.** The 16 items decided otherwise and the new design in T2, T4, T5 to T8 and the open and save hooks were not reviewed again after the revision. Use reviewers who did not see the first round; their findings go to the architect the same way.
7. **Decisions that are the user's or need a licence check:**
   - Bundling a CMYK profile: color-settings decides, and only with a recorded licence. The contract says none is bundled.
   - LibRaw: a pinned prebuilt package (exact-version devDependency); check its licence (LGPL 2.1 / CDDL) and how `PIGMENT_REQUIRE_VENDOR` gates the release.
   - Smart filters stay pixels in PSD until 0.7 (linked-smart-objects).
8. **Known gaps the contract records,** to carry into docs/PARITY.md when 0.6 ships:
   - moving or transforming one channel is refused;
   - placed files keep their stored EXIF orientation;
   - a colour-channel edit at 16/32 bits loses the other channels' extra precision;
   - selection outlines moved past the canvas are dropped;
   - the OpenType PSD wrapper may fall back to ligatures only.
