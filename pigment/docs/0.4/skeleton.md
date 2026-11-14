# Pigment 0.4 skeleton: release notes

The skeleton of 0.4 (shared stores, models, registries, every menu item and key binding of the release, stub modules)
changes a few keys, menus and behaviours of 0.3.1 on purpose. These lines go into the 0.4 release notes; the packages'
own lines are in the other files of this folder (rule 7).

## Keys (Photoshop's defaults)

| Key | 0.3 | 0.4 |
|---|---|---|
| Ctrl+F | Last Filter | Edit > Search… (Last Filter is Alt+Ctrl+F) |
| Alt+Ctrl+F | (none) | Filter > Last Filter |
| Alt+Ctrl+Z | Step Backward | Edit > Toggle Last State (Step Backward and Step Forward have no key) |
| Alt+Shift+Ctrl+Z | Step Forward | (none) |
| Ctrl+Y | Redo | View > Proof Colors (redo with Shift+Ctrl+Z) |
| Alt+Shift+Ctrl+S | Export As… | Save for Web (Legacy)… |
| Alt+Shift+Ctrl+W | (none) | Export As… |
| Shift+Ctrl+' | (none) | Quick Export as PNG |
| Alt+Shift+Ctrl+E | Quick Export as PNG | Stamp Visible |
| Ctrl+/ | Keyboard Shortcuts | Lock Layers… (Keyboard Shortcuts is Alt+Shift+Ctrl+K, in the Edit menu) |
| Cmd+, (macOS) | Settings… | Hide / Show Layers (Settings… is Cmd+K, as on Windows and Linux) |
| Ctrl+E | Merge Down | Merge Down / Merge Layers / Merge Group, by what is selected |
| Ctrl+B / I / U, Ctrl+Shift+> / < while editing text | bold, italic, underline, size | Shift+Ctrl+B / I / U, Shift+Ctrl+. / , (and the rest of Photoshop's type keys) |
| digits, Shift+digits, /, \\, Shift+=, Shift+-, Alt+[ ] , ., Shift+Alt+letters | (none) | layer opacity and fill, lock transparency, mask overlay, blend modes, layer navigation (they never act while a text field has focus) |
| Alt+Shift+Ctrl+M, Alt+Shift+Ctrl+N, Alt+Ctrl+E, Alt+Ctrl+; | (none) | Menus…, New Layer without the dialog, Stamp Layers, Lock Guides |
| Alt+Ctrl+L / M / U / B | (none) | Levels, Curves, Hue/Saturation, Color Balance with the last-used values |

Six existing browser-test lines that pressed Ctrl+F for Last Filter now press Alt+Ctrl+F.

**Matching on every keyboard.** Shortcuts with Alt or Shift are matched by the physical key when the key typed is not a
letter or digit, so on macOS Option combinations work although Option changes the typed character (Option+[ types “):
Alt+[, Alt+], Alt+, , Alt+., Alt+\\ and the Shift+Alt letter keys all work. A letter always means the letter typed, on
every layout (on AZERTY, Ctrl+Alt+Z is Ctrl+Alt+Z, not the key in the US Z position). Plain keys still go by the character they type: on a keyboard where /
or \\ needs Shift (German, for example), the plain / and \\ shortcuts do not fire. On Windows and Linux, Shift+Alt+letter
no longer opens a menu by its mnemonic: Pigment takes the key for the blend-mode shortcut.

## Menus

- A new **Type** menu between Layer and Select: Panels (Character, Paragraph), Orientation, Text on Path, Release from
  Path, Flip Text on Path, Edit Text, Rasterize Type Layer. Layer > Type and Layer > Edit Text moved there.
- New items, disabled until their feature lands: Edit > Toggle Last State, Search…, Paste Special > Paste Without
  Formatting, Menus…; Image > Adjustments and Layer > New Adjustment Layer > Color and Vibrance…, Clarity and Dehaze…,
  Grain…; Layer > Layer Style > Create Layers, Hide All Effects, Scale Effects…; Layer > Vector Mask; Layer > Rasterize
  > Type, Shape, Fill Content, Vector Mask, Smart Object; Layer > Arrange > Reverse; Layer > Distribute by edges and
  centres; Layer > Lock Layers…, Lock All Layers in Group…; Select > Similar Layers; View > Show > Smart Guides; View >
  Pattern Preview; View > Snap To; View > Guides (Lock Guides, Clear Canvas / Selected Artboard / Selected Guides, New
  Guide…, New Guide Layout…, New Guides From Shape, Edit Selected Guides…); Window > Paragraph, Gradients, Patterns.
- Keyboard Shortcuts… moved to the Edit menu (the Help item stays, without a key). Define Pattern, New Group and
  Duplicate Layer gained "…". New Guide… and Clear Guides moved into View > Guides.
- Toggle Developer Tools (development builds) is F12 on macOS too.

## Behaviour

- `.pigment` files are written as version 3 (guides with ids and colours in a document store, rich text, vector masks,
  blending options, mask density and feather). Pigment 0.3 still opens them: it reads the plain guides and each text
  layer's first style (guide colours and other formatting are lost there). Version 2 files open unchanged, their text
  laid out exactly as 0.3 did.
- New Guide and Clear Guides commit a running Free Transform first, and are refused inside Blur Gallery, Select and
  Mask and Content-Aware Scale (0.3 let them through). Closing the window cancels a running Free Transform and the
  on-canvas workspaces before the first "Save changes?" question. Select and Mask answers Toggle Last State with its own
  undo.
- Moving, Canvas Size, Crop, Convert to Layers and placing a smart object keep a live shape's parameters with the shape
  (0.3 left them behind outside the path tools). Image Size and Convert to Layers also scale effect spread, choke,
  soften and the pattern overlay scale.
- Holding Ctrl/Cmd while dragging with the Move tool turns snapping off.
- New Fill Layer > Pattern without a pattern stops instead of only warning. Gradient Fill edits keep midpoints and
  opacity stops.
- The Layer Style dialog no longer rounds opacities to whole percents when another field changes.
- Preferences: the grid spacing is in a new "Guides, Grid & Slices" section.
- A settings file or browser storage that cannot be written shows one error toast ("Settings could not be saved…")
  instead of a console message only.
- Ctrl+E runs Merge Down with one layer selected, as before; an action records it as Merge Down.
- Layer > Distribute by edges answers "Not available yet" until the Layer menu work lands.

## PSD in 0.4 (until psd-layers and psd-text, 0.5)

- Masks: a layer's raster mask is written with its density, feather and an enabled vector mask baked in, so Photoshop
  shows what Pigment shows; a layer with only a vector mask gets a raster mask. A disabled raster mask without a
  vector mask is written disabled, as in 0.3.
- Blending options (knockout, Blend If, channels, the check boxes) are not written: the merged image is right, the layer
  in Photoshop is not.
- Text: besides 0.3's family, size, colour, underline, leading and tracking, PSD text gets faux bold and italic,
  strikethrough, caps, baseline shift, scales, auto kerning, the justifications, the box size and the first baseline. A
  text layer with formatting PSD text cannot hold yet (several styles in one layer, a text stroke, attributes outside
  that list) is written as pixels, with one note per save ("N text layers with formatting PSD text cannot hold yet were
  saved as pixels"). 0.3 wrote a stroked text layer as text without its stroke.
- Adjustments: as in 0.3, Hue/Saturation's Master only, Levels and Curves only in RGB.

## Adjustment parameters that change shape

- Hue/Saturation gains colour ranges (`ranges`, at most six) besides the Master values; a 0.3 single-range layer
  opens as Master 0 plus that range with Photoshop's default bounds. 16 and 32-bit documents apply layers with ranges
  through the 8-bit path.
- Levels and Curves gain a channel space (RGB, Gray, CMYK, Lab) and Curves a drawn (pencil) curve; documents at 16 and
  32 bits apply those through the 8-bit path; RGB curves and levels stay exact.
- Gradient Map takes the full gradient (midpoints, opacity stops, smoothness, Reverse, Dither) and stays exact at 16
  and 32 bits. Old Gradient Map layers render as before (an 8-bit difference of at most one level on some reversed
  gradients and where two stops share a position).
- Adjustment dialogs open with the defaults (Photoshop's behaviour); Alt+Ctrl+L, M, U and B reopen Levels, Curves,
  Hue/Saturation and Color Balance with the last values (adjust-tonal).

## Review decisions of the 0.4 contract

The contract was revised after four package engineers reviewed its draft. "Accepted" means the contract now says what
the finding proposed; "changed" means the finding is right and the fix differs; "kept" means the draft's design stays.
Section letters refer to ARCHITECTURE.md, "0.4 features (contracts)".

Four package engineers reviewed the draft (groups: type; styles, paints and adjustments; canvas and vector; layers and
conventions). Each finding was checked against the code. "Accepted" means the contract now says what the finding
proposed (where it is, in brackets); "changed" means the finding is right and the fix differs from its proposal;
"kept" means the draft's design stays, with the reason.

**Type**

1. Facade queries for extension layouts and the recursion (blocker): accepted. `layoutText` (displayed, extension
   first) and `shapeText` / `glyphRuns` (engine only, never an extension); extensions may answer the three queries,
   otherwise the facade derives them from `layout.glyphs`; `caretRect.angle`; quads; the stub implements the
   derivation so the two path-text specs pass on it (B.2, B.5).
2. `TextLayout.box` collides with 0.3's `lay.box` flag: accepted. The box is `frame`; `box`, `glyphs` and `anchor` are
   extension-only with their 0.3 meaning; the step-5 checklist keeps `textBox`, `hitBoxHandle` and `caretIndex` working
   (B.3, B.6, Part 2 step 5).
3. Edit > Undo reaches native undo on the hidden input; paste from the menu has no clipboard text: changed. The type
   session's `handle` answers the undo-like and clipboard ids before any command runs (guardModal is step 2), and
   `ownsFocus` makes `app.isTextTarget()` false for its input, so neither app.js routing nor edit-ops.js needs a type
   case; `bridge.readClipboardText()` added (B.8, E, O).
4. TYPE_KEYS collisions: mouse clicks swallowed, unfocused input, recorder: accepted. Menu clicks carry
   `triggeredByAccelerator` as source `'menu-key'`; the handle answers only `'key'` / `'menu-key'`; `typeKeyFor` in
   keymap.js; observers get `{ handledBy }`. The session policy is decided: `'commit'` (open question 5 of the draft),
   so a mouse menu command commits the text first (B.8, E, M.1, M.4, O).
5. `fromLegacy`, tracking, first baseline and clamps underspecified: accepted. Exact mapping both ways, unrounded
   tracking, no tracking after the last character, the first baseline at 0.8 × size for every engine (font metrics
   only for decorations), a `RANGES` table, `normalize` never rounds (A).
6. The stub breaker re-wraps 0.3 paragraphs: accepted. The stub breaks after U+0020 only; `Break.at` and the line range
   are defined; old documents carry `breakRules: 'legacy'`, which the UAX 14 breaker honours (A, B.3, B.6, package 4).
7. Composer and hyphenation interfaces incomplete: accepted. `spaceWidth`, `hyphenWidth`, `composerFor`, the split of
   hyphenation settings between the facade and the composer, `registerHyphenator(fn, { languages })`,
   `hyphenationLanguages()` (B.2, B.3).
8. No event when the caret moves: accepted. `target.selectionChanged(app)` emits `'type:selection'`; the stub provider
   calls it from the textarea; the Properties host re-renders type sections per frame (B.7, L.1).
9. Layer-level type options and later section plug-ins: changed. `applyTypeOptions`, `applyBox` and the extended edit
   result are accepted; the section registry lives in a skeleton file, `lib/type/sections.js`, instead of exports of
   the two panel modules, so a later package does not depend on module order or on a file another package rewrites
   (B.7, L.14).
10. `set text` flattens formatting: accepted. `replacePlain` (common prefix and suffix) with a unit test (A).
11. Fonts arrive asynchronously, no engine pinning or fallback, no test font: accepted. Relayout on
    `'type:fonts-changed'` without history; `supports(layer)`; `setEngine` / `engines`; `addFontData`,
    `__pigmentTest.addFont` and an OFL test font (B.2, B.3, B.4, package 1).
12. PSD export drops the new attributes of uniform layers: accepted. `PSD_TEXT_KEYS`, `psdExpressible`, the extended
    `textToPsd` and `boxBounds` from `layer.height`; `psdExpressible` lives in io.js and model.js exports
    `nonDefaultKeys` (J.8).
13. Specs pin 0.3 internals of tools/text.js: accepted. Stable exports and session shape (B.8), 0.3's multi-layer merge
    key instead of `history.group` (B.7), `TextLayout.height` is the box height with `contentHeight` separate (B.3).
14. Two stores for new-text defaults: accepted. Tool options hold the options-bar attributes, settings the rest, and the
    merge order is fixed (B.7, J.7).
15. Nested attribute semantics: accepted. Replaced whole, compared deeply, `{ deep: true }` for per-sub-key `MIXED`,
    unit tests (A).

**Styles, paints and adjustments**

1. Neighbourhood and seeded adjustments see rect-relative pixels (blocker): changed. `apply(img, params, rect, ctx)`
   with the document origin and `margin(params)` are accepted, but "read the backdrop grown by the margin, clamped to
   what is drawn" would still seam, because the compositor's target canvas is exactly the repaint rect; instead
   `composite()` grows the work rect by the margins and crops (I.4, K.3).
2. Layer Mask Hides Effects and Vector Mask Hides Effects need the two parts apart (blocker; also canvas-vector 2):
   accepted. `parts` on `maskCanvasFor`, `applyLayerMask`, `maskCacheKey`, and `hasEffectiveMask` (K.1, K.3).
3. Two check boxes cannot be built in compositor.js (blocker): accepted. The `applyStyles` options are named now,
   with `split` and the `STYLE_FEATURES` flags for the specs that need the real implementation (J.6, rule 8).
4. The Layer Style dialog does not snapshot `blending`; `ctx.blending` name clash (blocker): accepted. The skeleton
   changes `styleDialog`; the page context has `advanced` and 0..1 opacities (L.3).
5. `mergeStyles` drops `hidden` and breaks arrays; three copies of style scaling: accepted. `mergeStyles` keeps both,
   `scaleEffects` replaces the copies (J.6).
6. Live `{ ref }` stops in stored data: accepted. Refs only in presets and tool options; writers resolve; a defined
   fallback without colours (G.1).
7. Two incompatible placement shapes: accepted. One `GradientPlacement` (fraction scale, boolean align), flat on the
   effect objects; `spec.kinds` and `spec.placement` on the widget (G.1, H).
8. deep.js applies 0.3 float code to new params: accepted. `deepExact` asked before both branches, adjust-tonal declares
   it too, Gradient Map through the model, `isExactKind(kind, params)` for depth.js (I.4, J.9, ownership table).
9. No drop target for panel drags: accepted as E25 (L.9).
10. Panel-mode frame lifecycle and the 512 px source: accepted. `dispose` and same-element mounting in L.1; the frame
    releases its capture; `sampleBelow` (I.1, L.1).
11. A `PatternRef` without pixels breaks: accepted. Stored refs always carry `dataUrl`; `patterns` is reserved as a
    document collection (L.6, D).
12. New parameter shapes left to the packages: accepted. J.9 fixes Hue/Saturation ranges and the Levels/Curves `space`;
    PSD export keeps 0.3's subset until psd-layers (J.8, J.9).
13. Wrong claim that the compositor already styles groups well: accepted. Appendix item 13 corrected; group styles,
    their cache and the pass-through test are in K.3 with a measured target.
14. `splitEffects` stub returns null: accepted. The stub is real enough and the order and `clip` are documented (J.6).
15. adjust-color wraps a command adjust-tonal registers: accepted. `prepare` on the editor registration (I.2, rule 3).

**Canvas and vector**

1. Shapes go stale when moved or transformed (blocker): accepted. `mapShapeGeometry` at every site, listed (J.2, J.5).
   The draft's name for the structure.js function was wrong: it is `mapLayerAffine`.
2. Mask parts (blocker): accepted, as styles 2; `layer:mask 'apply'` bakes only the raster part (K.1).
3. Mask reads outside the hook: accepted. The full caller list, and the rule for reads that must stay on the raw raster
   mask (K.1); the 16-bit check is in masks-vector-masks' e2e, because the stub ignores vector masks in both paths.
4. No vector-mask thumbnail in the Layers panel: accepted, with the skeleton placing the row parts rather than a row
   registry: one small, fixed UI element does not justify a registry layers-panel-depth would have to host (L.15).
5. Hide All and Reveal All indistinguishable: accepted as `initialFill: 'hide' | 'reveal'`, with the combine semantics
   PSD uses (J.1).
6. Guide ids break three spec lines: accepted, both halves: the skeleton edits the three lines (M.8) and optional guide
   fields are stored only when set; `get guides()` is frozen. Non-enumerable ids were rejected: every copy (spread, JSON,
   structured clone) would lose them silently (D).
7. `view:` guide commands treated as harmless: accepted as the declarative `changesDocument` flag (E31), with the
   recorder storing the colour of a new guide (E, package 11).
8. Ruler origin and units only on the rulers: accepted as `lib/rulers.js` (L.10).
9. Snap call sites underspecified: accepted. `end()` only from canvas-view, `pointer`, `axis`, `excludeGuides`, the
   call-site table with `exclude`, and rule 10 for owners (F).
10. J.5 described parameters 0.3 does not store: accepted. 0.3's real shapes, the reading table and
    `normalizeShapeProps`; closed shapes keep 0.3's box form (W/H/X/Y, as Photoshop shows), so ellipses do not move to
    `cx, cy, rx, ry`; no `'rrect'` kind; arrows `null | { width, length, concavity }` (J.5).
11. Paint coordinate space undefined: accepted. `box` and `origin`, no stored from/to on shapes (G.3).
12. Path commands ignore registered kinds; `createShapeLayer` private: accepted (L.4).
13. Unregistered collections in `fromJSON`: accepted. Kept verbatim; `rulerOrigin` registered by the skeleton (D).
14. Transform and live-shape sections both shown: accepted as `hides` (L.1).
15. Ctrl as auto-select, snap-disable and spring-load: accepted as `p.temporary` from `view.tempToolVia`; the clause
    "Ctrl pressed again disables snapping" was dropped: while a spring-loaded Move is active Ctrl is held throughout,
    so there is no second press to detect (F).

**Layers and conventions**

1. The numeric field's type switch breaks about forty spec lines and two modules (blocker): accepted. The input stays a number
   input on focus and switches only on a keydown it cannot hold; the two checks match `data-numeric` (H). This closes
   open question 3 of the draft.
2. When the three layer dialogs open (blocker): accepted. Only for `'menu'`, `'menu-key'` and `'key'` without an
   argument, or `{ dialog: true }`; argument shapes; panel modifiers (M.3).
3. Toggle Last State missing from the undo-like lists; no non-recordable flag: accepted. `UNDO_LIKE`, `undoLike` and
   `record` flags, `app.historyStep` (E).
4. Navigation under a dialog cannot work on macOS: accepted as `dialogs.passesMenu` (E step 3, I.3).
5. How Search runs a command: accepted (package 16).
6. Alt combos never match on macOS: accepted (M.4 "Matching on every keyboard").
7. Layer property commands on several layers: accepted, with `setLayersProps` landed by the skeleton (M.3).
8. Background rules outside finish-layer-menu's files: accepted as `app.backgroundRules` (L.13). Kept: the Background
   is still recognised by name and position, as in 0.3; renaming it lifts its locks (Photoshop converts a renamed
   Background too), but renaming another bottom layer to "Background" still makes it one. A persisted flag needs
   io.js, new-document and flatten changes and is psd-layers' (0.5), which needs it for PSD's background flag.
9. Free Transform ignores links: accepted (the `collectTargets` call, ownership table, Part 2 step 8).
10. Isolation and sampling: accepted as `lib/sample.js` and `app.sampleSkip`, Info panel included (L.11).
11. "Numeric fields everywhere" cannot be met by owned files: accepted as the document-level enhancer (H).
12. Ctrl+E changes what `layer:merge-down` does: accepted. New id `layer:merge`, `layer:merge-group`, and
    `ctx.setReplayCommand` so actions record the concrete id. Because Ctrl+E moves to it and `layers.spec.mjs:26`
    presses Ctrl+E, the skeleton registers `layer:merge` working instead of stubbing it (M.3, M.6, E).
13. Ctrl spring-loading collides with tools that use Ctrl; no painting-tool classification: changed. The two tool
    properties are accepted, but the fallback table lives in a skeleton file (`lib/tool-traits.js`), not in
    conventions' `temp-tools.js`, so finish-layer-menu's digit commands do not import another package's new file (L.12).
14. Shift+Alt+letter may open a menu by its mnemonic: accepted. `before-input-event` in main.js and an Electron test (O).
15. layers-panel-depth features rest on stubs: accepted. The numeric stub honours `scrubby`; conventions is listed under
    "Same release"; group effect rows at integration; stubbed menu entries checked as present and disabled (H,
    package 14).

**The draft's open questions**, now decided: (1) adjustment dialogs open with the defaults and the Alt+Ctrl variants
with the last values (Photoshop; release note); (2) effect instances are arrays inside the existing keys; (3) the
numeric field, see layers 1; (4) sessions are cancelled (or committed) at the start of the before-close handler, as
in 0.3; (5) the type session policy is `'commit'`, see type 4; (6) multi-format text goes to PSD as pixels unless
`psdExpressible`; (7) the model stores px; (8) the skeleton does not render vector masks or density: the K.1 stub stays
0.3's, so 0.3 output cannot change before masks-vector-masks lands; (9) Settings moves to Cmd+K on macOS; (10) the
integration plan reserves time for the four type packages together.
