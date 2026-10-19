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
});

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
