// Default settings shared by the main process (settings.json) and the renderer.
// See ARCHITECTURE.md "Settings" for the meaning of each key.
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  authorName: '',
  defaultZoom: 'auto',
  scrollMode: 0,
  spreadMode: 0,
  rememberLastPage: true,
  restoreSession: true,
  sidebarOpen: false,
  sidebarView: 'thumbnails',
  highlightFormFields: true,
  nightMode: false,
  highlightColor: '#ffff00',
  inkColor: '#e53935',
  inkThickness: 3,
  inkOpacity: 1,
  freeTextColor: '#1e1e1e',
  freeTextSize: 12,
  shapeColor: '#e53935',
  shapeWidth: 2,
  shapeOpacity: 1,
  noteColor: '#ffd54f',
  signatures: [],
  stampPresets: ['APPROVED', 'DRAFT', 'CONFIDENTIAL', 'FINAL', 'REVIEWED', 'VOID', 'SIGN HERE'],
  measureUnit: 'mm',
  recentLimit: 20,
  lastSession: [],
});

/** Returns a fresh settings object: defaults overlaid with the given (possibly partial/invalid) stored values. */
export function withDefaults(stored) {
  const out = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      if (value === undefined || value === null) continue;
      if (key in DEFAULT_SETTINGS && typeof DEFAULT_SETTINGS[key] !== typeof value && !(key === 'defaultZoom')) continue;
      out[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return out;
}
