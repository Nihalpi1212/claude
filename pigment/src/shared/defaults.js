// Settings defaults shared by main (settings.json) and the renderer. Add keys here; everything
// else reads settings through withDefaults() so missing or malformed stored values never surface.
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  rulerUnit: 'px', // px | in | cm | mm | pt | percent
  recentLimit: 20,
  restoreSession: false,
  lastSession: [],
  foreground: '#000000',
  background: '#ffffff',
  brush: { size: 24, hardness: 0.8, opacity: 1, flow: 1, spacing: 0.12, smoothing: 0.2, angle: 0, roundness: 1, pressureSize: true, pressureOpacity: false },
  brushPresets: [],
  swatches: [],
  panelLayout: null,
  panelsVisible: true,
  toolboxColumns: 1,
  showRulers: true,
  showGrid: false,
  gridSize: 50,
  gridSubdivisions: 4,
  snap: true,
  pixelGrid: true,
  showGuides: true,
  showSelectionEdges: true,
  checkerboardSize: 8,
  checkerboardLight: '#ffffff',
  checkerboardDark: '#cccccc',
  canvasBackground: 'auto', // auto (theme) | #hex
  newDocPreset: { width: 1920, height: 1080, dpi: 72, background: 'white', name: 'Untitled' },
  exportDefaults: { format: 'png', quality: 0.92, scale: 1 },
  historyLimit: 100,
  historyMemoryMB: 512,
  cursorStyle: 'outline', // outline | precise | dot
  autoSelectLayer: false,
  zoomWithWheel: false, // plain wheel zooms (true) or scrolls (false; Ctrl/Cmd+wheel zooms)
  animatedZoom: true,
  tools: {}, // per-tool option values keyed by tool id
  lastFilter: null,
  tourSeen: false,
  // panels and dialogs (lib/panels/*.js, lib/extras.js)
  swatchesEdited: false, // false: the Swatches panel shows DEFAULT_SWATCHES until the user changes the palette
  recentColors: [],
  colorPanelTarget: 'fg', // which colour the Color panel edits: fg | bg
  resampleMethod: 'bicubic', // Image Size default: bicubic | lanczos | bilinear | area | nearest
  transformInterpolation: 'bicubic', // free transform: bicubic | bilinear | nearest
  transformProportional: false, // true: transform handles keep proportions unless Shift is held
  transformScalesStrokes: false,
});

/** The Swatches panel's default palette (used until the user edits it; see swatchesEdited). */
export const DEFAULT_SWATCHES = Object.freeze([
  '#000000', '#1f1f1f', '#404040', '#606060', '#808080', '#a0a0a0', '#c0c0c0', '#e0e0e0', '#f2f2f2', '#ffffff',
  '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80', '#00ffff', '#0080ff', '#0000ff', '#8000ff',
  '#ff00ff', '#ff0080', '#f7977a', '#fbad82', '#fdc68c', '#fff799', '#c6df9c', '#a4d49d', '#81ca9d', '#7bcdc8',
  '#6ecff6', '#7ea7d8', '#8493ca', '#8882be', '#a187be', '#bc8dbf', '#f49bc1', '#f5999d', '#ed1c24', '#f26522',
  '#f7941d', '#fff200', '#8dc63f', '#39b54a', '#00a651', '#00a99d', '#00aeef', '#0072bc', '#0054a6', '#2e3192',
  '#662d91', '#92278f', '#ec008c', '#ed145b', '#9e0b0f', '#a0410d', '#a36209', '#aba000', '#598527', '#1a7b30',
  '#007236', '#00746b', '#0076a3', '#004b80', '#003471', '#1b1464', '#440e62', '#630460', '#9e005d', '#9e0039',
  '#c69c6d', '#a67c52', '#8c6239', '#754c24', '#603913', '#3c2415',
]);

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep-ish merge of stored values over the defaults (type-checked per key, arrays and objects copied). */
export function withDefaults(stored) {
  const out = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) out[key] = Array.isArray(value) ? value.slice() : isObject(value) ? { ...value } : value;
  if (isObject(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      if (value === undefined || value === null) continue;
      const def = DEFAULT_SETTINGS[key];
      if (key in DEFAULT_SETTINGS && def !== null && typeof def !== typeof value) continue;
      if (isObject(def) && isObject(value)) out[key] = { ...def, ...value };
      else out[key] = Array.isArray(value) ? value.slice() : isObject(value) ? { ...value } : value;
    }
  }
  return out;
}
