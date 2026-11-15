# Parity: Panels, workspaces and the application frame

Part of [Pigment and Photoshop: feature parity](../PARITY.md), as of Pigment 0.4 (November 2026). The rows planned for 0.4 ("0.4 · *package*") show their 0.4 status and the counts below include them; the other rows and the overview paragraph describe Pigment 0.3.1 as the audit found it.

Pigment's application frame is a fixed single-window shell: one native menu bar, a toolbox, an options bar, document tabs showing one document at a time, a right-hand dock of three hard-wired tab groups (14 panels) and a four-slot status bar. Inside that shell the Actions panel is the strongest part (button mode, sets, record/stop/play, Insert Menu Item/Stop/Conditional, function keys and colours, playback options, own JSON file format), and History, Info, Navigator and Paths exist in reduced form (flattened-only snapshots, linear history, a history brush that only paints from the last saved state, fixed Info readouts with no Panel Options, three stroke-path tools, no clipping paths). Entire panels and subsystems are absent: Timeline (video and frame animation, animated GIF, Render Video), Layer Comps, Notes, Measurement Log and Count tool, Tool Presets, and the cloud-bound Libraries, Comments, Version History and Content Credentials panels, which can only be offered as honest local substitutes. Panel and window management is the biggest structural gap: no dragging, floating, icon-collapsing or closing of panels, no saved or stock workspaces, no Window > Arrange (N-up, floating windows, Match Zoom/Location, New Window), no dragging layers or selections between documents, and no canvas right-click menus at all (canvas-view.js calls tool.onContextMenu but no tool implements it). Application services are thin: no auto-save or crash recovery (settings restoreSession/lastSession are dead keys), saves block the UI with no progress, no tiled rendering, cache levels, scratch disk or memory limit, no UI scaling or languages, no updater, a read-only shortcuts list instead of the Keyboard Shortcuts and Menus editor, and no toolbar editor. Shortcuts follow Photoshop for about 90 commands and all 20 tool letters, but several defaults do something else (Ctrl+F is Last Filter not Search, Ctrl+Y is Redo not Proof Colors, Alt+Ctrl+Z steps back instead of toggling, Ctrl+Alt+Shift+S opens Export As not Save for Web, Ctrl+Alt+Shift+E quick-exports instead of Stamp Visible, Ctrl+/ opens the shortcut list instead of locking layers, Ctrl+2 zooms to 200%), R selects Hand rather than Rotate View until Rotate View has been picked from the flyout, and the F-key panel shortcuts, numeric opacity keys, layer-navigation keys, Ctrl-for-Move and Ctrl/Alt+Space zoom are missing.

104 missing · 43 partial · 7 approximate · 8 not feasible · 47 done · 209 entries

## workspace

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Collapse to icons (icon dock with labels, Auto-Collapse Iconic Panels) | Dock double-arrow; Preferences > Workspace | Missing | Only a per-group collapse chevron (setCollapsed) that hides the group's body. | M | 0.8 · panel-docking |
| Floating panels and floating panel stacks | Drag a panel out of the dock | Missing | Absent. | M | 0.8 · panel-docking |
| Tab groups: reorder tabs, move a panel to another group, make a new group | Drag a panel tab | Missing | Absent (tabs are plain buttons). | M | 0.8 · panel-docking |
| Docking: drag panels between docks and columns, left/bottom docks, new dock columns | Drag a panel tab or title bar | Missing | No drag handling on panel tabs; a single right-hand column. | L | 0.8 · panel-docking |
| Drag layers between documents | Drag from canvas or Layers panel onto another tab/window | Missing | Layers panel drag is reorder-only within one document; tabs are not drop targets. Workaround: copy/paste. | M | 0.7 · edit-clipboard-finish |
| Drag selections (outline or selected pixels) between documents | Drag with a selection tool / Move tool to another document | Missing | Absent. | M | 0.7 · edit-clipboard-finish |
| Customize Toolbar dialog (reorder, regroup, Extra Tools, save/load preset, restore defaults, show/hide extras) | Edit > Toolbar… | Missing | Slot membership and order are hard-coded (SLOT_ORDER, register(tool, slot)). | M | 0.9 · workspaces-toolbar |
| Per-workspace keyboard shortcuts and menus | New Workspace dialog; Keyboard Shortcuts and Menus | Missing | Shortcuts are constants in src/shared/keymap.js; menus are built from a fixed template. | M | 0.9 · workspaces-toolbar |
| Workspace switcher in the options bar | Options bar, right end | Missing | Absent. | S | 0.9 · workspaces-toolbar |
| Tools panel: single/double column, float/dock, show/hide (Window > Tools) | Tools panel double-arrow; Window > Tools | Missing | Fixed 44 px single column; settings.toolboxColumns is defined in defaults.js but nothing reads it. | S | 0.8 · panel-docking |
| Arrange: Cascade, Tile (floating windows) | Window > Arrange | Missing | Absent. | M | 0.8 · document-windows |
| Arrange: tile all vertically/horizontally, 2-up, 3-up, 4-up, 6-up, Consolidate All to Tabs | Window > Arrange | Missing | Only the active document's frame is visible (documents.js activate hides the others). Each document already owns a CanvasView, so N-up is architecturally possible. | L | 0.8 · document-windows |
| Float in Window / Float All in Windows; floating document windows | Window > Arrange | Missing | Absent; one BrowserWindow, tabs only. | L | 0.8 · document-windows |
| Match Zoom / Match Location / Match Rotation / Match All | Window > Arrange | Missing | Absent (each view keeps its own zoom, pan and rotation). | S | 0.8 · document-windows |
| New Window for the same document | Window > Arrange > New Window for … | Missing | One CanvasView per document (doc.view); no second view. | M | 0.8 · document-windows |
| Options bar: show/hide separately, float, dock top or bottom, narrow options bar | Window > Options; drag gripper | Missing | Fixed at the top; hidden only together with toolbox and panels by Tab (.panels-hidden). | S | 0.8 · panel-docking |
| Stock workspaces (Essentials, Graphic and Web, Motion, Painting, Photography) | Window > Workspace | Missing | One fixed layout; no Workspace submenu. | M | 0.9 · workspaces-toolbar |
| Lock Workspace | Window > Workspace > Lock Workspace | Missing | No command; panels are immovable anyway, so it only matters once docking exists. | S | 0.9 · workspaces-toolbar |
| New Workspace (panel locations, optionally keyboard shortcuts, menus and toolbar) | Window > Workspace > New Workspace | Missing | Absent. | M | 0.9 · workspaces-toolbar |
| Window menu: list of open documents | Window menu, bottom | Missing | Not listed; View > Next/Previous Document (Ctrl+Tab) only. | S | 0.8 · document-windows |
| Document tabs | Document window tab bar | Partial | documents.js renderTabs: name @ zoom, unsaved dot, close button, middle-click close, + button, Ctrl+Tab cycling. Missing: colour mode/bit depth and active layer in the title, drag to reorder, tab context menu (Close, Close All, Close Others, Reveal, New Window), overflow menu for many tabs. | S | 0.8 · document-windows |
| Resize panels | Drag dock edge / group dividers | Partial | Dock width is draggable (220 px to 60% of the window, persisted). The three groups always share the height equally (flex: 1 1 0); no divider between groups. | S | 0.8 · panel-docking |
| Close a panel or tab group; Window menu check marks | Panel menu > Close / Close Tab Group; Window menu | Partial | Panels cannot be closed. Window menu items show a panel but are plain items without check marks (menu.js windowMenu), although the commands expose checked(). | S | 0.8 · panel-docking |
| Tab hides all panels and tools; Shift+Tab hides panels only; auto-show hidden panels on edge hover | Tab / Shift+Tab; Preferences > Workspace | Partial | Tab (window:toggle-panels) hides toolbox, options bar and panels. Shift+Tab and edge-hover reveal are absent. | S | 0.8 · panel-docking |
| Minimise / Zoom window commands | Window > Minimise (macOS), Window > Arrange > Minimise (Windows) | Partial | macOS roles minimise/zoom/front in menu.js; no menu item on Windows/Linux (the OS title bar buttons work). | S | 0.8 · document-windows |
| Reset Workspace / Delete Workspace | Window > Workspace | Partial | Window > Reset Workspace (panels.reset: width and collapse state; un-hides panels). No named workspaces to reset or delete. | S | 0.9 · workspaces-toolbar |
| Window menu: complete panel list | Window menu | Partial | Lists Pigment's 14 panels (Color, Swatches, Brushes, Properties, Adjustments, Character, Paths, Layers, Channels, History, Actions, Navigator, Info, AI Assistant). No entries or panels for Brush Settings, Character/Paragraph Styles, Clone Source, Comments, Content Credentials, Glyphs, Gradients, Histogram, Layer Comps, Libraries, Measurement Log, Modifier Keys, Notes, Paragraph, Patterns, Shapes, Styles, Timeline, Tool Presets, Version History, Plugins; no Options/Tools toggles. | S | 0.8 · panel-docking |
| Shortcuts that match Photoshop's defaults | keymap | Done | 0.4: Photoshop's default keys (Ctrl+F Search, Alt+Ctrl+Z Toggle Last State, Ctrl+Y Proof Colors, the layer keys, the export keys); menu keys do not act on the document while you type | S | 0.4 · conventions-shortcuts-fields |
| Panel dock: tabbed groups, click a tab to show a panel | Application frame, right dock | Approximate | lib/panels.js PanelDock: three fixed groups (top/middle/bottom) with tabs. Each panel's group is hard-coded at registration, so the layout cannot be rearranged; users notice immediately when they try to drag a tab. | S | 0.8 · panel-docking |
| Panel layout persistence between sessions | Application frame | Done | settings.panelLayout stores dock width, current tab per group and collapsed state |  |  |
| Collapse / minimise a panel group | Double-click a panel tab | Done | Collapse button on each group, persisted in settings.panelLayout (double-click on a tab does nothing) |  |  |

## panels

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| History Options: Allow Non-Linear History | History panel menu > History Options | Missing | History is strictly linear: push() truncates entries after the index; entries are undo/redo closures, so deleting or keeping a middle state needs state-based storage. | L | 0.6 · history-panel-depth |
| History Options: Automatically Create New Snapshot When Saving, Show New Snapshot Dialog by Default, Make Layer Visibility Changes Undoable | History panel menu > History Options | Missing | No History Options dialog and no panel menu. | S | 0.6 · history-panel-depth |
| History: New Snapshot dialog (name, From) | History panel menu > New Snapshot / Alt-click button | Missing | Button creates 'Snapshot n' directly; no dialog. | S | 0.6 · history-panel-depth |
| History: set the History Brush source (left column of a state or snapshot) | History panel, source column | Missing | History Brush (tools/retouch.js) always reads history.savedSnapshot(), i.e. the image at the last open/save; no source column, cannot paint from an arbitrary state or snapshot. Art History Brush absent. | M | 0.6 · history-panel-depth |
| Measurement scale (Set Measurement Scale, presets, Select Data Points, Place Scale Marker) | Image > Analysis | Missing | No Image > Analysis submenu. | M | 0.9 · notes-count-measurement |
| Info panel: before/after values while an adjustment dialog is open | Info panel during Levels, Curves etc. | Missing | Single readout of the current composite only. | M | 0.7 · info-histogram-properties |
| Info panel: Panel Options dialog and panel menu | Info panel menu | Missing | No panel menu; only the inline CMYK/Lab/HSB select. | S | 0.7 · info-histogram-properties |
| Navigator: Ctrl-drag in thumbnail to zoom to a region; Panel Options (view box colour) | Navigator panel and panel menu | Missing | No region zoom gesture, view box colour fixed red, no panel menu. | S | 0.6 · view-navigation |
| Count tool (count groups, colours, marker and label size) | Toolbox (Eyedropper group) > Count tool | Missing | Absent. | M | 0.9 · notes-count-measurement |
| Note tool (author, colour) and notes on the canvas | Toolbox (Eyedropper group) > Note tool | Missing | No Note tool; eyedropper slot holds Eyedropper, Color Sampler, Ruler only. | M | 0.9 · notes-count-measurement |
| Notes: View > Show > Notes, import notes from PDF, PSD annotation round trip | View > Show > Notes; File > Import > Notes | Missing | Absent. | M | 0.9 · notes-count-measurement |
| Measurement Log panel (Record Measurements, data point columns, select/delete, export) | Window > Measurement Log | Missing | No panel. | M | 0.9 · notes-count-measurement |
| Notes panel (list, previous/next, edit text, delete, delete all) | Window > Notes | Missing | No panel. | M | 0.9 · notes-count-measurement |
| Info panel: colour samplers | Color Sampler tool + Info panel | Partial | Up to 8 samplers (Photoshop 10), drag to move, Alt-click to delete, listed in Info with RGB + hex. Missing: per-sampler readout mode, sample-size option, markers are drawn only while the Color Sampler tool is active, samplers are not saved in .pigment/PSD and are not undoable. | M | 0.7 · info-histogram-properties |
| History: automatically create first snapshot on open | History Options | Partial | An 'Open'/'New' state row always exists and history.savedImage keeps the opened composite, but there is no snapshot entry with thumbnail and no option. | S | 0.6 · history-panel-depth |
| History: Delete state, Clear History, drag state to trash | History panel menu / trash button | Partial | Trash button deletes only snapshots. Clearing is Edit > Purge > Histories (edit:purge); individual states cannot be deleted. | S | 0.6 · history-panel-depth |
| Info panel: first colour readout modes | Info panel > Panel Options > First Color Readout | Partial | Fixed RGB + alpha % + hex of the composite (panels/info.js). Missing modes: Actual Color, Proof Color, Grayscale, Web Color, HSB, CMYK, Lab, Total Ink, Opacity, and the eyedropper-icon popup. | S | 0.7 · info-histogram-properties |
| Info panel: second colour readout modes | Info panel > Panel Options > Second Color Readout | Partial | Select with CMYK / Lab / HSB (settings.infoSecondary). Missing Grayscale, Web Color, Total Ink, Opacity, Actual/Proof Color; CMYK is a profile-less formula, so values differ from Photoshop. | S | 0.7 · info-histogram-properties |
| Info panel: status information lines and Show Tool Hints | Info panel > Panel Options > Status Information | Partial | Fixed lines: document size/ppi, selection, active layer, bounds. No choice of Document Sizes, Profile, Scratch, Efficiency, Timing, Current Tool, Measurement Scale; tool hints appear in the status bar instead. | S | 0.7 · info-histogram-properties |
| Info panel: live W/H, angle, distance during marquee, transform, line and ruler drags | Info panel, lower right quadrant | Partial | Shows the selection's bounds after it changes and the active layer's bounds; no live W/H while dragging, no A/D for transforms or the Ruler tool (Ruler readout goes to the status bar hint). | M | 0.7 · info-histogram-properties |
| Ruler tool readouts (X, Y, W, H, A, L1, L2, protractor, Use Measurement Scale) | Ruler tool options bar + Info panel | Partial | tools/nav.js RulerTool: length/angle/ΔX/ΔY shown as status-bar text while dragging, Straighten layer, Clear. No options-bar fields, no protractor (Alt-drag second leg), line is not editable after release, nothing reaches the Info panel or a log. | S | 0.9 · notes-count-measurement |
| Panel menus (hamburger) on every panel | Top-right of each panel | Partial | Only the Actions panel has a panel menu. History, Info, Navigator and Paths have none; Layers, Channels, Paths, History snapshots, Swatches and Brushes offer row context menus instead. | M | 0.8 · panel-docking |
| History: snapshots (create, rename, delete, thumbnails) | History panel > Create new snapshot | Approximate | Snapshot = a flattened composite canvas only (history.snapshot). Photoshop's 'From: Full Document / Merged Layers / Current Layer' is absent, and clicking a snapshot replaces all layers with one flat layer as a new undoable step (restoreSnapshot) instead of returning to the layered state. | M | 0.6 · history-panel-depth |
| History: New Document from Current State / Snapshot | History panel button and menu | Approximate | newDocumentFrom() makes a new document with one flattened 'Background' layer; Photoshop duplicates the full layered state. | M | 0.6 · history-panel-depth |
| Info panel: 16-bit and 32-bit value readouts | Info panel | Done | lib/depth.js appends a deep readout (0–32768 scale or raw 65535 via settings.info16Range; floats for 32-bit) |  |  |
| Info panel: mouse coordinates and ruler units | Info panel > Panel Options > Mouse Coordinates | Done | X/Y in px plus a second line in the Preferences ruler unit (in, cm, mm, pt, %); unit is taken from Preferences, not a panel option |  |  |
| Navigator: zoom slider, zoom in/out buttons, zoom percentage field | Navigator panel | Done | Log slider 1%–6400%, buttons, field, plus Fit / 100% / Fill buttons |  |  |
| Tools panel: foreground/background swatches, swap, default, Quick Mask button | Tools panel bottom | Done | tools.js tool-colors block (tool:pick-fg/bg, swap X, default D) and select:quick-mask button (Q) |  |  |
| History panel: state list, click to travel, greyed future states | Window > History | Done | lib/panels/history.js; History.goTo in lib/history.js; shows 'Open'/'New' initial state and a counter |  |  |
| Navigator: proxy thumbnail with view box, drag to pan, click to centre | Window > Navigator | Done | panels/navigator.js; view box follows view rotation; wheel over thumbnail zooms |  |  |
| Options bar: per-tool options, persisted per tool | Window > Options | Done | ToolManager.renderOptions / buildControl in lib/tools.js (slider, number, select, checkbox, colour, segment, button, brush picker); values in settings.tools |  |  |
| Tools panel: Photoshop order, grouped slots, flyouts (long-press / right-click), Shift+letter cycling | Window > Tools | Done | lib/tools.js SLOT_ORDER, showFlyout (450 ms press or context menu), shortcuts.js Shift+letter |  |  |

## app-frame

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Dialogs: movable, canvas stays visible and navigable while a dialog is open | All adjustment and filter dialogs | Done | 0.4: dialogs move and remember their place; the canvas is not dimmed and can be zoomed and panned; a click beside a dialog does not cancel it | M | 0.4 · conventions-shortcuts-fields |
| Drag out to the OS or another application | Drag a layer or document out of the window | Missing | Absent. | S | 0.8 · document-windows |
| Search (tools, menu commands, panels, help, documents) | Edit > Search (Ctrl+F); Discover panel | Partial | 0.4: menu commands, tools and panels; no open documents or help topics beyond the Help menu, no Discover panel | M | 0.4 · conventions-shortcuts-fields |
| Automatic updates | Help > Updates (Creative Cloud) | Missing | package.json build.publish is null and there is no updater. electron-updater against GitHub Releases is possible; macOS auto-update needs signed builds, which Pigment does not have. | M | 0.8 · status-bar-help |
| Multiple application windows | OS level | Missing | main.js keeps a single mainWindow; a second launch focuses it. | L | 0.8 · document-windows |
| Scrubby sliders (drag on a field label) and popup sliders | Options bar and panel numeric fields | Done | 0.4: scrubby labels everywhere and popup sliders on the fields that declare them (Opacity, Fill and others); hand-built inputs in older dialogs scrub but have no popup | S | 0.4 · conventions-shortcuts-fields |
| Auto-save recovery information and crash recovery | Preferences > File Handling > Automatically Save Recovery Information Every … | Missing | Nothing is saved in the background. main.js offers 'Reload (unsaved changes are lost)' when the renderer dies; settings restoreSession and lastSession exist in defaults.js but nothing reads or writes them. | L | 0.6 · file-handling-autosave |
| Context menus on the canvas, per tool | Right-click the canvas | Missing | canvas-view.js forwards button 2 to tool.onContextMenu, but no tool defines it, so right-click does nothing (no brush picker for paint tools, no selection menu, no layer list for Move, no transform/type/path menus). | L | 0.8 · context-menus-task-bar |
| Status bar: Save Progress | Status bar > Save Progress | Missing | Saving shows 'Saving name…' text with a busy cursor; no percentage. | S | 0.8 · workers-progress |
| Status bar menu: Document Profile, Measurement Scale, Smart Objects | Status bar > arrow menu | Missing | Absent (no ICC profiles and no measurement scale exist to report). | S | 0.8 · status-bar-help |
| Status bar menu: Scratch Sizes, Efficiency, Timing, Current Tool | Status bar > arrow menu | Missing | No memory, efficiency or timing readouts; current tool is shown only in the options bar title. | S | 0.8 · status-bar-help |
| Status bar: click for print-size preview, Alt-click for dimensions/channels/resolution | Status bar readout area | Missing | Absent. | S | 0.8 · status-bar-help |
| Contextual Task Bar | Window > Contextual Task Bar | Missing | No floating task bar suggesting next steps (Select Subject, Remove Background, Generative Fill, pin/reset position). | M | 0.8 · context-menus-task-bar |
| Status bar: zoom field and document readout | Document window status bar | Partial | app.js setupStatusbar: editable zoom %, fixed text 'W × H px · ppi · n layers', tool hint, pointer X/Y. One fixed readout, no chooser. | S | 0.8 · status-bar-help |
| Help: application help (F1) | Help > Photoshop Help | Partial | Help > Pigment Help opens docs/USER-GUIDE.md on GitHub in the browser (needs a network connection; the guide is not bundled for offline use); F1 is unbound. | S | 0.8 · status-bar-help |
| Help: About, System Info, GPU compatibility, Updates, legal notices | Help menu | Partial | About dialog with version and licence only. No System Info report, no update check, no third-party notices dialog. | S | 0.8 · status-bar-help |
| Home screen: New / Open, preset quick start, recent files | Home screen | Partial | lib/welcome.js: New image, Open, New from clipboard, 7 size presets, recent list (name + path, remove), drop hint. Missing: recent-file thumbnails, list/grid toggle, sort and filter, 'Auto show the Home Screen' preference, Home button to return while documents are open. | M | 0.9 · home-new-doc-browser |
| Drag and drop inside the app: colours, layer styles, channels, history states, swatches to canvas | Panels and canvas | Partial | Layers reorder/into groups, Actions steps and Filter Gallery entries are draggable. Missing: drag a swatch or foreground chip onto a layer/Swatches, drag effects between layers, drag items onto panel buttons (new/trash). | M | 0.7 · edit-clipboard-finish |
| Tooltips and rich tooltips | Preferences > Tools > Show Tooltips / Use Rich Tooltips | Partial | Plain title-attribute tooltips with the shortcut (tools.js) and a per-tool hint line in the status bar. No rich (animated) tooltips and no preference to switch tooltips off; Adobe's tooltip videos cannot be reused, own illustrations would be needed. | M | 0.8 · status-bar-help |
| Context menus in panels and chrome | Right-click panel rows, tabs, rulers, status bar | Partial | Present on Layers rows, smart filter rows, layer eye (colour labels), Channels, Paths, History snapshots, Swatches, Brush presets, Actions, toolbox slots. Missing on History states, Info readouts, Navigator, document tabs, rulers (units), status bar, options-bar tool icon, panel tabs. | M | 0.8 · context-menus-task-bar |
| Status bar menu: Document Sizes, Document Dimensions (ruler units), Layer Count | Status bar > arrow menu | Partial | Dimensions in px with ppi and the layer count are always shown; no flattened/layered byte sizes, no ruler-unit dimensions, no menu. | S | 0.8 · status-bar-help |
| Discover / Learn: hands-on tutorials, quick actions, What's New | Help > Hands-on Tutorials; Discover panel | Not feasible | Adobe-hosted tutorial content. Substitute: Pigment's own bundled guide and sample walkthroughs; the welcome screen has a static six-item feature list. |  |  |
| High-DPI (Retina) rendering | Application frame | Done | canvas-view.js, rulers, Navigator and path thumbnails size their backing stores by devicePixelRatio |  |  |
| Window state restore | Application launch | Done | main.js saves bounds and maximised state and checks the window is on a connected display |  |  |
| Unsaved-changes prompts on close and quit | Close document / quit | Done | documents.js confirmDiscard (Save / Don't Save / Cancel) for each dirty document; main.js before-close handshake with a hung-renderer guard |  |  |
| Drag and drop files from the OS (open; place into the current document) | Drop on the application window | Done | app.js setupDragAndDrop: drop opens; Shift-drop places as layer (smart object by preference). Differs from Photoshop only in that a plain drop on an open document opens instead of placing. |  |  |
| Recent files list | File > Open Recent; Home screen | Done | recent.json store, menu shows 15 with Clear Recent Files, welcome list with remove; settings.recentLimit (20) has no Preferences field |  |  |
| Notifications | In-app notifications | Done | dialogs.toast (info / success / error, optional action button) in an aria-live region; no Adobe account notification feed, which does not apply |  |  |
| Native menu bar synced to document state (enable/disable, check marks, dynamic Undo label) | Menu bar | Done | menu.js buildMenuTemplate from app.syncUiState; stubbed commands greyed |  |  |
| File associations | OS 'Open with' | Done | electron-builder fileAssociations: .pigment, .psd, .png, .jpg/.jpeg, .webp, .gif, .bmp, .tif/.tiff, .tga |  |  |
| Single instance and opening files from the OS | OS file open / second launch | Done | requestSingleInstanceLock, second-instance and macOS open-file handlers queue files (main.js, startup-files.js) |  |  |

## timeline

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Render Video (H.264 / QuickTime / DPX and image sequences; size, frame rate, range, alpha) | File > Export > Render Video | Missing | Absent. WebM/VP9 and, where the platform encoder exists, H.264 MP4 can be written with WebCodecs plus an open muxer; Adobe Media Encoder formats such as ProRes and DPX presets cannot be matched faithfully. | L | 0.11 · render-video |
| Export animated GIF (Save for Web animation controls, looping) | File > Export > Save for Web (Legacy) | Missing | src/shared/pixels/gif.js reads and writes a single frame; Save for Web has no animation section (README). | M | 0.10 · animation-io |
| Image sequence import and export | File > Open (Image Sequence); Render Video > Image Sequence | Missing | Absent (Load Files into Stack loads stills as layers, not as a sequence). | M | 0.10 · animation-io |
| Open animated GIF / video frames as layers or frames | File > Open; File > Import > Video Frames to Layers | Missing | Animated GIFs open as their first frame only. | M | 0.10 · animation-io |
| Video layers: open/import video, New Video Layer from File, New Blank Video Layer | File > Open; Layer > Video Layers | Missing | Absent. Feasible with Chromium's decoders (H.264, VP9, AV1 via WebCodecs); ProRes/HEVC depend on the OS and cannot be guaranteed. | XL | 0.10 · video-timeline-core |
| Video layers editing: paint/clone per frame, onion skins, Insert/Duplicate/Delete Frame, Replace Footage, Interpret Footage, Restore Frame | Layer > Video Layers; Timeline menu > Onion Skin Settings | Missing | Absent. | L | 0.11 · video-keyframes-effects |
| Frame animation: per-frame layer visibility / position / opacity / style, Unify buttons, Propagate Frame 1 | Timeline + Layers panel animation options | Missing | Absent. | M | 0.9 · frame-animation |
| Video timeline: motion presets (Pan & Zoom, Pan, Zoom, Rotate, Rotate & Zoom) | Timeline clip popup > Motion | Missing | Absent. | M | 0.11 · video-keyframes-effects |
| Video timeline: keyframe interpolation (linear / hold), keyframe navigator, copy/paste keyframes | Timeline panel | Missing | Absent. | M | 0.11 · video-keyframes-effects |
| Frame animation: frame strip with thumbnails, new / duplicate / delete / select frames | Timeline panel (frame animation) | Missing | Absent. | L | 0.9 · frame-animation |
| Frame animation: per-frame delay and looping options (Once, 3 Times, Forever, Other) | Timeline panel (frame animation) | Missing | Absent. | M | 0.9 · frame-animation |
| Video timeline: tracks, video groups, clip trim, split at playhead, move, duration and speed | Timeline panel (video) | Missing | Absent. | XL | 0.10 · video-timeline-core |
| Video timeline: audio tracks (add audio, volume, fade in/out, mute) | Timeline panel > Audio Track | Missing | Absent; CSP even sets media-src 'none'. | L | 0.11 · video-keyframes-effects |
| Video timeline: transitions (Fade, Cross Fade, Fade with Black / White / Color) | Timeline panel > Transition button | Missing | Absent. | M | 0.11 · video-keyframes-effects |
| Frame animation: Tween (frames to add, layers, parameters) | Timeline panel > Tween | Missing | Absent. | M | 0.9 · frame-animation |
| Frame animation: Make Frames From Layers, Flatten Frames Into Layers, Reverse Frames | Timeline panel menu | Missing | Absent. | S | 0.9 · frame-animation |
| Frame animation: Optimize Animation (bounding box, redundant pixel removal), frame disposal | Timeline panel menu | Missing | Absent. | M | 0.9 · frame-animation |
| Video timeline: comments track, Global Light track | Timeline panel menu > Show | Missing | Absent. | S | 0.11 · video-keyframes-effects |
| Video timeline: playback, scrub, work area, loop, frame rate, timecode, playback resolution | Timeline panel transport and menu | Missing | Absent. | L | 0.10 · video-timeline-core |
| Video timeline: keyframes for Position, Opacity, Style, Transform (smart objects), mask position/enable, text warp | Timeline panel, layer property rows | Missing | Absent. | L | 0.11 · video-keyframes-effects |
| Timeline panel shell (Create Video Timeline / Create Frame Animation, convert between them) | Window > Timeline | Missing | No timeline code at all (README: 'Timeline, animation and video' missing). | XL | 0.9 · frame-animation |

## shortcuts

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Brush and cursor keys | , . < > (previous/next/first/last brush), Caps Lock (precise cursors), Alt+right-drag HUD size/hardness, Shift+Alt+right-click HUD colour picker | Missing | Only [ ] and Shift+[ ] are handled (app.js adjustBrush); cursor style is a preference, not a Caps Lock toggle; no HUD. | M | 0.5 · brush-painting-behaviours |
| File shortcuts not bound | Alt+Ctrl+S Save a Copy, Alt+Shift+Ctrl+O Open As, Alt+Shift+Ctrl+P Print One Copy | Missing | file:save-copy exists without a key; Open As and Print One Copy do not exist. (Bridge shortcuts Alt+Ctrl+O / Shift+Ctrl+W do not apply.) | S | 0.8 · print |
| View and navigation shortcuts not bound | Ctrl+Space / Alt+Space zoom, Home/End/PageUp/PageDown scrolling, Shift+Tab, Alt+Ctrl+; lock guides, Shift+Ctrl+H target path, double-click Zoom/Hand tool icons | Missing | Space is handled as Hand regardless of Ctrl/Alt; the paging keys and the other combos are unbound (double-click on the canvas with the Hand tool fits the image). | S | 0.6 · view-navigation |
| Keyboard Shortcuts dialog: edit shortcuts for application menus, panel menus and tools | Edit > Keyboard Shortcuts… (Alt+Shift+Ctrl+K) | Missing | help:shortcuts shows a read-only table (app.js shortcutsDialog) built from keymap.js constants; nothing can be changed. | L | 0.5 · shortcuts-editor |
| Menus customisation (hide items, colour items, menu sets, Show All Menu Items) | Edit > Menus… (Alt+Shift+Ctrl+M) | Missing | Absent. | M | 0.5 · shortcuts-editor |
| Function keys F1, F5, F6, F7, F8, F12 | Help (F1), Brush Settings (F5), Color (F6), Layers (F7), Info (F8), Revert (F12) | Missing | Only Shift+F5, Shift+F6, Alt+F9 and F11 are bound; F12 toggles developer tools in unpackaged builds and Revert has no key. The panels exist as window:panel-color / -layers / -info commands, so binding is trivial. | S | 0.5 · skeleton-05 |
| Tool letter keys for tools that do not exist | K Frame; Shift-cycling members: Artboard (V), Slice (C), Note / Count (I), Content-Aware Move / Remove (J), Mixer Brush (B), Art History Brush (Y), Curvature Pen (P), Type Mask (T) | Missing | These tools are absent, so K does nothing and Shift+letter cycles shorter lists. | S | 0.10 · brush-tips-mixer |
| Keyboard shortcut sets (save .kys, load, delete), Summarize, conflict warnings, legacy undo / channel shortcut options | Keyboard Shortcuts and Menus dialog | Missing | Absent. | M | 0.5 · shortcuts-editor |
| Layer keyboard shortcuts: opacity digits, lock toggle, layer navigation, blend-mode keys | Number keys (opacity/flow), / (lock), Alt+[ ] (select layer), Alt+, . (bottom/top), Shift+Plus/Minus and Alt+Shift+letter (blend modes), Ctrl+, (hide), Alt+Shift+Ctrl+N | Partial | 0.4: digits and Shift+digits (opacity, Fill), /, Alt+[ ] , ., Shift+= / -, Shift+Alt+letters, Ctrl+,; the digits do not set a painting tool's opacity or flow yet (0.5) | M | 0.4 · finish-layer-menu |
| Edit shortcuts not bound | Shift+Ctrl+F Fade, Shift+Backspace Fill dialog, Alt/Ctrl+Shift+Backspace fill preserving transparency, Alt+Shift+Ctrl+T transform again with copy, Shift+Ctrl+K Color Settings | Missing | edit:fade has no accelerator; the Shift variants do not match because eventMatches requires exact modifiers; no Color Settings dialog. | S | 0.7 · edit-clipboard-finish |
| Ctrl+2…5 and Ctrl+\ (channel selection) | Channels: composite / individual channels / layer mask | Partial | Ctrl+2 zooms to 200%; Ctrl+3/4/5 and Ctrl+\ do nothing. Alt+\ toggles the mask view. | S | 0.6 · channels-depth |
| Ctrl+F and Alt+Ctrl+F | Edit > Search (Ctrl+F); Filter > Last Filter (Alt+Ctrl+F) | Done | 0.4: Ctrl+F is Search, Alt+Ctrl+F Last Filter | S | 0.4 · conventions-shortcuts-fields |
| Alt+Ctrl+Z (Toggle Last State) | Edit > Toggle Last State | Done | 0.4: Toggle Last State | S | 0.4 · conventions-shortcuts-fields |
| Alt+Shift+Ctrl+S and Alt+Shift+Ctrl+W | File > Export > Save for Web (Legacy) / Export As | Done | 0.4: Save for Web (Legacy) and Export As | S | 0.4 · conventions-shortcuts-fields |
| Ctrl+/ (Lock Layers), Alt+Shift+Ctrl+K, Alt+Shift+Ctrl+M | Layer > Lock Layers; Edit > Keyboard Shortcuts / Menus | Partial | 0.4: Lock Layers…, Keyboard Shortcuts…; Alt+Shift+Ctrl+M is bound to Edit › Menus…, which comes with the shortcut editor (0.5) | S | 0.4 · conventions-shortcuts-fields |
| Alt+Shift+Ctrl+E (Stamp Visible), Alt+Ctrl+E (Stamp Layers), Shift+Ctrl+' (Quick Export) | Layers stamp shortcuts; File > Export > Quick Export as PNG | Done | 0.4: Stamp Visible, Stamp Layers and Quick Export as PNG | S | 0.4 · conventions-shortcuts-fields |
| Tool letter keys: R and H share one slot | R Rotate View, H Hand | Partial | Rotate View is registered in the 'hand' slot (tools/nav.js) and shortcuts.js resolves a letter to the slot's last-used tool, so R selects Hand until Rotate View has been chosen from the flyout, and H then selects Rotate View. | S | 0.6 · view-navigation |
| Ctrl+Y | View > Proof Colors (Ctrl+Y) | Done | 0.4: Proof Colors (redo is Shift+Ctrl+Z) | S | 0.4 · conventions-shortcuts-fields |
| Shortcut list and shortcut hints in tooltips and flyouts | Help; tooltips | Done | Help > Keyboard Shortcuts (Ctrl+/) lists MENU_KEYS and RENDERER_KEYS by group; toolbox tooltips and flyouts show the key |  |  |

## automation

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Actions: Insert Path | Actions panel menu | Missing | No command; a recorded path cannot be inserted into an action. | S | 0.8 · actions-recording |
| Actions: Replace Actions | Actions panel menu | Missing | Only Load (append), Clear All Actions and Reset Actions exist. | S | 0.8 · actions-recording |
| Actions: Allow Tool Recording (brush and other tool strokes) | Actions panel menu > Allow Tool Recording | Missing | No stroke recording; lib/actions.js warns once: 'actions record commands and selections, not tool strokes'. | L | 0.8 · actions-recording |
| Actions: Photoshop .atn files (read and write) | Actions panel menu > Load / Save Actions | Missing | Explicitly refused: 'Photoshop .atn action files cannot be read'. The .atn container is publicly documented; the real work is mapping each Photoshop action descriptor to a Pigment command (and back). | L | 0.8 · actions-atn |
| Actions: bundled extra sets (Commands, Frames, Image Effects, LAB Black & White, Production, Star Trails, Text Effects, Textures, Video Actions) | Actions panel menu, bottom list | Missing | No bundled sets beyond Default Actions; Adobe's .atn files cannot be shipped or read. | M | 0.8 · actions-atn |
| Actions: sets (New Set, rename, Set Options), duplicate, delete, drag reorder | Actions panel | Partial | New Set, rename, duplicate, delete, drag steps and actions (including into another action/set). Sets themselves cannot be reordered by drag, and Alt-drag to duplicate is absent. | S | 0.8 · actions-recording |
| Actions: what recording captures | Actions panel > Record | Partial | Records menu commands with confirmed dialog settings, tool-made selections (as result), Free Transform, layer picks by name, fg/bg colours, guides, Save As. Not recorded (README, ARCHITECTURE known gaps): Move-tool drags, layer drag-reorder (layer:move-to), Warp/Perspective Warp/Puppet Warp sessions, Fade, in-place edits of adjustment/fill/smart-filter layers, Save a Copy. | L | 0.8 · actions-recording |
| Actions: Record / Stop / Play buttons, play from selected step | Actions panel footer | Partial | actions:record / stop / play in the footer. 'Play single step' exists only as command actions:play-step with no UI (Photoshop: Ctrl-click Play or Ctrl-double-click a step). No 'Record Again'. | S | 0.8 · actions-recording |
| Actions: modal control (dialog toggle) per step / action / set | Actions panel, second column | Partial | actions:toggle-dialog works for commands registered with dialog:true, but the dialog opens with the command's own start values, not the recorded settings (ARCHITECTURE known gaps); Photoshop opens it pre-filled with the recorded values. | M | 0.8 · actions-recording |
| Actions: Default Actions set | Actions panel | Approximate | lib/actions/defaults.js rebuilds 10 actions under Photoshop's names from Pigment commands (Vignette, Frame Channel, Wood Frame, Cast Shadow, Water Reflection, Custom RGB to Grayscale, Molten Lead, Sepia Toning, Quadrant Colors, Gradient Map). Photoshop's set has about 40 and results differ. | M | 0.8 · actions-atn |
| Actions: Save Actions / Load Actions | Actions panel menu | Approximate | Own JSON format .pigment-actions (engine.saveFile / loadFile); saves the selected set, loading appends. Works, but files are not interchangeable with Photoshop. | S |  |
| Actions: re-record a step through its dialog (double-click step) | Actions panel, double-click a step | Approximate | actions:edit-step opens the step's argument as raw JSON (stepArgDialog) instead of re-opening the command's dialog. Users notice: editing needs knowledge of Pigment's argument shapes. | M | 0.8 · actions-recording |
| Actions: New Action / Action Options (name, set, function key with Shift/Ctrl, colour) | Actions panel > New Action, Action Options | Done | actionDialog in lib/actions/dialogs.js: F2–F12 with Shift and Ctrl/Cmd, 7 colours, key-conflict check; key handler in actions.js runs before the shortcut table. ARCHITECTURE notes it is unverified whether an action key beats a native menu accelerator (F11 full screen, F12 dev tools). |  |  |
| Actions: Clear All Actions, Reset Actions | Actions panel menu | Done | actions:clear, actions:reset (restores the Default Actions set) |  |  |
| Actions: Insert Conditional | Actions panel menu | Done | actions:insert-conditional; 24 tests in actions/model.js (document orientation/mode/depth, selection, layer type/lock/mask/effects…) with then/else action |  |  |
| Actions: Insert Menu Item | Actions panel menu | Done | actions:insert-menu-item with a searchable grouped command list (lib/actions/dialogs.js) |  |  |
| Actions: Insert Stop (message, Allow Continue) | Actions panel menu | Done | actions:insert-stop; makeStopStep(message, allowContinue) |  |  |
| Actions panel: Button Mode | Actions panel menu > Button Mode | Done | actions:button-mode; renderButtons draws one coloured button per action with its function key; click plays |  |  |
| Actions: Playback Options (Accelerated / Step by Step / Pause For) | Actions panel menu > Playback Options | Done | actions:playback-options; engine.playback {mode, pauseSeconds 0.1–60} |  |  |
| Actions: include/exclude checkbox on steps, actions and sets | Actions panel, first column | Done | actions:toggle-step and setAll() in panels/actions.js, with mixed (indeterminate) state on parents |  |  |
| Actions: playback error handling (command unavailable: Stop / Continue) | Actions playback | Done | lib/actions.js playback asks Stop or Continue; steps may be marked optional |  |  |
| Actions panel: list mode (sets > actions > steps, expand/collapse, select, step details) | Window > Actions (Alt+F9) | Done | lib/panels/actions.js renderTree: tree with twisties, step settings unfold (stepDetails), keyboard arrows/Delete/Enter; engine in lib/actions.js |  |  |

## layers

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Layer Comps: export (Layer Comps to Files, Layer Comps to PDF) and PSD round trip | File > Export > Layer Comps to Files / to PDF | Missing | Absent; comps in an opened PSD are dropped. | M | 0.8 · layer-comps |
| Layer Comps: apply comp, next/previous, Last Document State | Layer Comps panel | Missing | Absent. | M | 0.8 · layer-comps |
| Layer Comps: update comp (all, or visibility / position / appearance separately), out-of-date warning icons | Layer Comps panel footer | Missing | Absent. | M | 0.8 · layer-comps |
| Layer Comps: comments, duplicate, delete, rename, Layer Comp Options | Layer Comps panel menu | Missing | Absent. | S | 0.8 · layer-comps |
| Layer Comps: choose a smart object's layer comp from the parent document | Properties panel (smart object) > Layer Comp | Missing | Absent; smart objects render their whole embedded document. | M | 0.8 · layer-comps |
| Layer Comps panel: create comp capturing Visibility / Position / Appearance (layer style) | Window > Layer Comps > New Layer Comp | Missing | No panel, no model (no 'layerComp' anywhere in src; README lists layer comps as missing). | L | 0.8 · layer-comps |

## performance

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Save in Background with progress | Preferences > File Handling > Save in Background | Missing | documents.js writeTo encodes on the renderer thread under app.busy: the UI is blocked with a busy cursor and no progress or cancel. | L | 0.8 · workers-progress |
| Big documents: tiled rendering, image pyramid, Cache Levels and Cache Tile Size | Preferences > Performance > History & Cache | Missing | Every layer is one full-size canvas and the compositor caches a full-size composite per document version (dirty-rect repaint for strokes); zoomed-out views resample that composite each paint. Limits: 30,000 px per side, 250 MP (extras.js). | XL | 0.10 · tile-store |
| Memory usage limit | Preferences > Performance > Memory Usage | Missing | Only history memory per document is capped (historyMemoryMB); deep-pixel stashes are outside that cap (ARCHITECTURE known gaps). No overall limit or usage readout. | M | 0.11 · scratch-memory-limits |
| Scratch disks | Preferences > Scratch Disks | Missing | All pixel data, undo patches and deep (16/32-bit) buffers live in RAM; nothing spills to disk. | XL | 0.11 · scratch-memory-limits |
| Multithreading for pixel work | Performance | Partial | Only Select and Mask runs in a worker (select-mask/engine.js); filters, adjustments, transforms and encoding run on the UI thread. | L | 0.8 · workers-progress |
| Progress and cancel for long operations | Progress dialogs (filters, transforms, open) | Partial | app.busy shows status text and blocks input; only Batch / Image Processor have a progress dialog (automate/batch.js). Filters and file opens cannot be cancelled and show no percentage. | M | 0.8 · workers-progress |
| GPU use and GPU settings (Use Graphics Processor, advanced settings, animated zoom, flick panning) | Preferences > Performance > Graphics Processor Settings; Preferences > Tools | Approximate | Rendering is Canvas 2D, which Chromium accelerates; no WebGL/WebGPU pipeline, no GPU preferences or diagnostics. Rotate view and scrubby zoom work; animated zoom and flick panning are not implemented (settings.animatedZoom is unused, setZoom ignores animate). Users notice on large documents and heavy filters. | L | 0.11 · gpu-pipeline |

## prefs

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| UI languages | Preferences > Interface > UI Language | Missing | English strings are hard-coded throughout the modules and menu.js; no string table or locale switch. | L | 0.10 · accessibility-i18n-input |
| UI scaling and UI font size (Scale UI To Font) | Preferences > Interface > UI Scaling, UI Font Size | Missing | No zoom-factor or font-size setting and no zoom roles in the menu. | S | 0.10 · accessibility-i18n-input |
| Canvas surround colour and border per screen mode | Preferences > Interface; right-click the pasteboard | Missing | settings.canvasBackground ('auto') is defined but unused; surround follows the theme, no border options. | S | 0.7 · screen-modes-extras |
| Workspace preferences (open documents as tabs, enable floating document window docking, large tabs, restore default workspaces) | Preferences > Workspace | Missing | Preferences has no workspace section; documents are always tabs. | S | 0.8 · panel-docking |
| UI colour theme and highlight colour | Preferences > Interface > Color Theme, Highlight Color | Partial | Light / Dark / Match the system (View > Theme, Preferences). Photoshop has four brightness levels plus a highlight-colour choice and neutral colour mode. | S | 0.8 · preferences-dialog |
| Preferences > Tools toggles (Use Shift Key for Tool Switch, Overscroll, Flick Panning, Zoom Resizes Windows, Zoom Clicked Point to Center, Show Tooltips) | Preferences > Tools | Partial | Only 'Zoom with the scroll wheel' exists; the rest are absent. | S | 0.8 · preferences-dialog |
| Reset preferences | Preferences > General > Reset Preferences On Quit; modifier keys at launch | Done | Preferences > Reset All Settings… (keeps open documents, recents and window bounds); a corrupt settings.json is set aside and defaults are used |  |  |
| History states limit and history memory | Preferences > Performance > History States | Done | Preferences: History states 1–1000 (default 100; Photoshop 50) and History memory 64–16384 MB per document; History.trim drops oldest |  |  |

## vector

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Paths: vector mask path row / create vector mask from path | Paths panel + Layers mask button (Ctrl-click) | Done | 0.4: the vector mask shows as a row in the Paths panel; Make Vector Mask and Make Shape Layer from a path | L | 0.4 · masks-vector-masks |
| Paths panel menu and Panel Options (thumbnail size) | Paths panel menu | Missing | Row context menu only (Save/Rename/Delete/Make Selection/Fill/Stroke); no panel menu, fixed 40×30 thumbnails. | S | 0.7 · pen-paths |
| Paths panel: Duplicate Path, drag to reorder, drag to buttons | Paths panel menu / drag | Missing | No path:duplicate command (only Alt-drag of subpaths with the Path Selection tool); rows are not draggable. | S | 0.7 · pen-paths |
| Paths: Clipping Path (path, flatness) exported in PSD/TIFF/EPS | Paths panel menu > Clipping Path | Missing | No clipping-path designation and no writer for the clipping-path resource. | M | 0.7 · pen-paths |
| Paths: Fill Path dialog | Paths panel > Fill Path | Partial | Contents foreground/background/colour/black/white/50% grey, opacity, feather, anti-alias. Missing: Pattern, History, Content-Aware contents, blending mode, Preserve Transparency. | S | 0.7 · pen-paths |
| Paths: Stroke Path dialog (tool list, Simulate Pressure) | Paths panel > Stroke Path | Partial | Tools Brush, Pencil, Eraser + Simulate Pressure (strokePathPixels). Photoshop also strokes with Clone/Pattern Stamp, Healing, History/Art History Brush, Smudge, Blur, Sharpen, Dodge, Burn, Sponge, Color Replacement, Background Eraser, Mixer Brush. | M | 0.7 · pen-paths |
| Paths: Make Selection (feather, anti-alias, new/add/subtract/intersect), Ctrl-click path | Paths panel > Load path as selection | Done | path:make-selection dialog incl. fill rule; Ctrl-click with Shift/Alt/Shift+Alt for add/subtract/intersect |  |  |
| Paths: Make Work Path from selection (tolerance) | Paths panel > Make Work Path | Done | path:from-selection, tolerance 0.5–10 px (pathFromSelectionMask) |  |  |
| Paths panel: save, rename, new, delete path | Paths panel footer / double-click | Done | path:save, path:rename (inline), path:new, path:delete |  |  |
| Paths panel: Work Path, saved paths, shape path rows with thumbnails, select/deselect | Window > Paths | Done | panels/paths.js rows(): work path, doc.paths, active shape layer path; click empty area deselects; saved in .pigment |  |  |

## input

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Pen tablet: tilt, rotation, barrel wheel, eraser end, side buttons | Brush Settings controls (Pen Tilt, Rotation, Stylus Wheel) | Missing | tiltX/tiltY are read in canvas-view.js but no brush code uses them; twist and the eraser end (buttons bit 32) are not read. | M | 0.5 · brush-engine-core |
| Modifier Keys panel (on-screen Shift / Ctrl / Alt for touch devices) | Window > Modifier Keys | Missing | Absent. | S | 0.10 · accessibility-i18n-input |
| Spring-loaded and temporary tools (Ctrl = Move, Alt = Eyedropper, Space = Hand, hold a tool key) | Keyboard modifiers on the canvas | Done | 0.4: Ctrl = Move, Alt = Eyedropper, Space, Ctrl+Space and Alt+Space, and holding a tool key; a held tool key switches the real tool while held | M | 0.4 · conventions-shortcuts-fields |
| Touch and gestures | Preferences > Tools > Enable Gestures; touch devices | Partial | Pinch zoom (touch events and trackpad ctrl-wheel), two-finger trackpad scroll pans. Missing: two-finger touch pan and rotate, trackpad rotate, two-finger tap undo / three-finger redo, touch shortcuts; a single finger paints through pointer events with no palm rejection. | M | 0.10 · accessibility-i18n-input |
| Pen tablet: pressure via pointer events | Brush options (pressure for size / opacity) | Done | canvas-view.js norm() passes pen pressure and coalesced events; BRUSH_OPTIONS pressureSize / pressureOpacity |  |  |

## view

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Scroll All Windows / Zoom All Windows | Hand and Zoom tool options bar | Missing | Hand and Zoom tool options (tools/nav.js) have no such options; only one document is visible. | S | 0.8 · document-windows |
| Status bar: 32-bit Exposure slider | Status bar > 32-bit Exposure | Missing | No view-exposure control for 32-bit documents (32-bit is display-referred in lib/depth.js). | M | 0.10 · hdr-32bit |
| Tools panel: Screen Mode button | Tools panel bottom | Missing | No screen-mode control (see screen modes). | S | 0.7 · screen-modes-extras |
| Screen modes (Standard, Full Screen With Menu Bar, Full Screen) on F | View > Screen Mode; F | Partial | OS full screen only (View > Toggle Full Screen, F11 / Ctrl+Cmd+F) and Tab to hide chrome; no three-mode cycle, F is unbound. | S | 0.7 · screen-modes-extras |

## presets

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Reset Tool / Reset All Tools | Options bar: right-click the tool icon | Missing | Only Preferences > Reset All Settings…, which also resets swatches, brush presets and the layout. | S | 0.5 · presets-panels |
| Tool presets: load / save / replace / reset, .tpl files | Tool Presets panel menu | Missing | Absent. | M | 0.5 · presets-panels |
| Tool Presets panel and options-bar preset picker (save current tool settings, Current Tool Only) | Window > Tool Presets; options bar leftmost control | Missing | No tool presets. Tool options persist per tool in settings.tools; the Brushes panel holds brush-tip presets only. | M | 0.5 · presets-panels |

## accessibility

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Accessibility (screen reader roles, contrast, reduced motion) | Whole application | Partial | ARIA roles on toolbars, tablists, listboxes, trees, dialogs (aria-modal), status and toast live regions, focus-visible rings. No forced-colours/high-contrast styles, no prefers-reduced-motion handling, icon-only buttons are named by title only, canvas state is not announced. | M | 0.10 · accessibility-i18n-input |
| Keyboard-only operation | Whole application | Partial | Native menus with mnemonics, dialog focus trap with Enter/Escape, Actions tree arrow keys, popovers focus their first item. Missing: arrow-key navigation inside popover menus (Tab only) and across panel tabs, a way to move focus between toolbox / options bar / panels, keyboard reordering in lists. | M | 0.10 · accessibility-i18n-input |

## metadata

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| History Log (metadata / text file / both; Sessions, Concise, Detailed) | Preferences > History Log | Missing | No edit log is written to metadata or a file. | M | 0.8 · file-info-dialog |
| Content Credentials panel (C2PA: enable per document, edits and activity, attach on export, publish to cloud, connected accounts) | Window > Content Credentials | Not feasible | Adobe-issued signing certificate, trust list, cloud publishing and account linking cannot be reproduced. Substitute: read and display existing manifests and write a self-signed manifest with an open C2PA library (validators will show an unrecognised issuer). |  |  |

## cloud

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Home screen: cloud tabs (Your files, Shared with you, Lightroom photos, Deleted) | Home screen sidebar | Not feasible | Adobe cloud storage and Lightroom sync. No substitute needed beyond local recent files. |  |  |
| Share button, Share for Review, Invite to Edit, quick share | Options bar > Share; File > Share | Not feasible | Adobe cloud review/collaboration. Substitute: OS share sheet or 'copy merged image / export and reveal' for local sharing. |  |  |
| Comments panel (Share for Review comments on cloud documents) | Window > Comments | Not feasible | Needs Adobe's cloud review service. Closest honest substitute: local Notes stored in the document. |  |  |
| Libraries panel (Creative Cloud Libraries, synced assets, Adobe Stock search) | Window > Libraries | Not feasible | Adobe cloud service and Stock catalogue. Substitute: a local library file/folder of colours, styles, brushes and linked graphics the user can share as a file. |  |  |
| Version History panel (cloud document versions: name, bookmark, revert, open) | Window > Version History | Not feasible | Tied to Adobe cloud documents. Substitute: named local versions kept inside the .pigment file or beside it. |  |  |

## scripting

| Feature | Where in Photoshop | Status | In Pigment | Effort | Planned |
|---|---|---|---|---|---|
| Plugins: UXP plugins panel, Plugins menu, legacy Extensions (CEP), 8BF filter plug-ins | Plugins menu; Window > Extensions (legacy) | Not feasible | Adobe's proprietary plug-in hosts and native binary plug-ins cannot be run. Substitute: Pigment's own JavaScript module/plugin API (the MODULES list in app.js already loads feature modules). |  |  |
