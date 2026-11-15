# PKG presets-panels (package 9, sequence B 4/7, port 8859) — landed

S15 flag: `app.stubbed` lacks `window:panel-styles` (and every id of this package: `window:panel-shapes`,
`window:panel-tool-presets`, `edit:define-custom-shape`, `tool:preset`, `tool:reset`, `tool:reset-all`,
`layer:style-preset`). skeleton-05 "toolbox" runs its landed branch (no assertion on `without[0]`).

## Files (all mine)

- `src/renderer/lib/tool-presets.js` — MODULES entry (replaces the stub): re-registers `styles`, `shapes`,
  `tool-presets` (thumbnails; `styles` gets a built-in group `basics` with six styles `basic-*`), the five commands,
  the options-bar title slot `presets-panels:tool-preset` (order 0).
- `src/renderer/lib/panels/styles.js`, `shapes.js`, `tool-presets.js` (replace the stubs): the panels `styles`,
  `shapes` (group 'top') and `tool-presets` (group 'middle'); the drop handlers of `application/x-pigment-style` and
  `application/x-pigment-shape`.
- `src/renderer/lib/style-ui.js`: Styles row/page in the Layer Style dialog, New Style…, Make Default / Reset to Default.
- `src/renderer/lib/tools/vector.js`: `custom-shape` option kind for the Custom Shape tool, `shapeProps.unit` filled in
  `createShapeLayer` for kind 'custom', Defined Size / Proportions from the preset's width / height.
- New: `src/renderer/lib/presets-panels-model.js` (pure, Node-tested), `src/renderer/lib/presets-panels-ui.js` (grid,
  thumbnails, library actions, the `custom-shape` widget registered at import).
- `src/renderer/styles/presets-panels.css`, `docs/0.5/presets-panels.md`.
- Tests: `tests/unit/presets-panels.test.mjs` (7), `tests/e2e/presets-panels.spec.mjs` (11).

## API as built

Commands:
- `tool:preset` (a `tool-presets` id, or `{ tool, options, brush?, type?, color? }`): `record: true`; replay arg = the
  normalized data with `brush` through `withSampleData` (tip carried as dataUrl). Applies per S12.1 (activate, setOptions,
  setToolBrush `{ respectLocks: false, includeTool: false }`, setTypeDefaults, setColors).
- `tool:reset` (tool id, default active) and `tool:reset-all` (asks unless source api/action/assistant/repeat or arg
  `true` / `{ confirm: false }`): `record: false`.
- `layer:style-preset` (id, or `{ styles, blending?, opacity?, fillOpacity?, blend?, add? }`): one `setLayerProps` entry
  "Apply Style"; pattern refs resolved with `app.patterns.refFor`; missing pattern → its owner effect off + one toast;
  `add: true` merges (Shift-click). Replay arg = resolved data (refs with dataUrl). Group `layer:` → recorded by default.
- `edit:define-custom-shape` (`{ name, path, width, height }` replays without asking; else the current path, its
  selected components with the Path Selection tool; prompt "Shape Name"). Enabled while `currentPathTarget(app)`.

`lib/tool-presets.js` exports: `install`, `BUILTIN_STYLES`, `registerPresetsPanelsKinds()`, `isTypeTool(app, tool)`,
`inToolbox(app, tool)`, `captureToolPreset(app, toolId, { includeColor })`, `applyToolPreset(app, data)`,
`newToolPresetDialog(app, toolId?)`, `toolPresetFilter(app)`, `sortToolPresets(app)`, `toolPresetMenuItems(app, opts)`,
`resetKind(app, kind)`, `replaceKind(app, kind)` (preset-manager's when present), `openToolPresetPicker(app, anchor)`,
`styleForStore(app, data)`, `layerStyleSource(layer)`, `newStyleDialog(app, source)`, `addStylePreset(app, source,
{ name, effects, blending })`, `dropStyle(app, json, layer?)`, `dropShape(app, json, at?, layer?)`.

`lib/tools/vector.js` new exports: `customShapeSize(app, id)`, `customShapeUnit(app, id)`, `definableShapePath(app)`,
`definableShape(app)`.

`lib/presets-panels-model.js`: `STYLE_MIME`, `SHAPE_MIME`, `isPathValue`, `curveBounds`, `unitShape`,
`normalizeShapeData`, `definedShapeSize`, `dropShapeBox`, `isPatternRef`, `stylePatternRefs`, `normalizeStyleData`,
`resolveStyle`, `addStyle`, `enabledEffects`, `capturedOptions`, `nextPresetName`, `visibleToolPresets`, `sortedByTool`.

`lib/presets-panels-ui.js`: `VIEWS`, `panelPrefs`, `savePanelPrefs`, `styleThumbnail`, `shapeThumbnail`,
`toolPresetThumbnail`, `styleTitle`, `presetGrid(app, kind, opts)`, `renamePresetDialog`, `newGroupDialog`,
`renameGroupDialog`, `deletePresetsAction`, `deleteGroupAction`, `libraryMenuItems(app, kind)`; widget `custom-shape`.

Data: `styles` `{ styles, blending?, opacity?, fillOpacity?, blend? }` (refs `{ presetId, name }`; a ref without a
preset keeps its dataUrl); `shapes` `{ path, width?, height? }` (width/height = px size, kept from .csh too).
Settings `settings.presetPanels`: `currentToolOnly` (declared) plus `stylesView`, `shapesView`, `toolPresetsView`,
`pickerView`, `collapsed` (`{ 'kind:groupId': true }`), `styleDefaults` (`{ effectKey: values }`, Make Default).

## Deviations from the contract

1. Captured tool options are every option the tool shows at its current value (defaults included) plus the stored keys,
   so applying a preset sets all of them; `options.color` of a type tool and `type.char.color` are dropped without
   Include Color.
2. `tool:reset` / `tool:reset-all` are `record: false` (not document changes).
3. `layer:style-preset` accepts the extra key `add` (Shift-click) and applies `opacity` / `fillOpacity` / `blend` when a
   style holds them (New Style with Include Layer Blending Options) — .asl reports those and does not write them.
4. A canvas drop of a style applies it to the layer under the pointer through `app.tools.get('move').hitTest` (move.js,
   move-tool-depth's file; the active layer when there is no hit or no such method).
5. Make Default does not keep pattern fields.
6. Built-in styles (group `basics`): six, new in 0.5.

## Tests that skip or gate

`presets-panels.spec` "Styles panel": the PSD assertion runs only while `psdFeatures().effects` (psd-layers landed, so
it runs). Nothing else gates.

## For the integrator

- Nothing needed in files I do not own. No existing spec line had to change (S14.2's `shapes-live.spec.mjs:91` holds:
  `unit` is now present and checked).
- Known failures not mine: `tests/unit/psd-registry.test.mjs` (2, psd-layers), `skeleton-05.spec.mjs:858` and `:989`
  (icc-engine's ungated lines).
- color-picker-swatches may reuse `presetGrid` (it is generic over kinds) if it wants the same groups and drag reorder.
