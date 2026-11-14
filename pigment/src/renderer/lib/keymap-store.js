// The keymap store (ARCHITECTURE.md "0.5 features", S9.2): app.keymap. One user overlay over the default tables of
// src/shared/keymap.js, persisted in settings.keymap, plus key sources (the actions' function keys) that shadow an
// application binding while they own its key. Every reader of a key goes through it: shortcuts.js, the type editor,
// the toolbox tooltips, the toolbar, Search, the actions engine, the shortcuts list, and main.js through the ui state
// (`keymap`: the resolved overlay as a JSON string). Skeleton file; shortcuts-editor writes through this API only.
import { effectiveKeys, keyConflicts, normalizeOverlay, isPlainKey, accelCollides, FIXED_KEYS } from '../../shared/keymap.js';
import { menuItemCommands } from '../../shared/menu-template.js';
import { paints } from './tool-traits.js';

export const KEYMAP_DEFAULT_SET = 'photoshop-defaults';
export const MENU_DEFAULT_SET = 'default';
export const MENU_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'];
const SCOPES = ['global', 'menu', 'renderer', 'type', 'paint'];
// the table an overlay entry of each scope lives in, and whether that table holds one key or a list
const TABLE = { menu: 'menu', renderer: 'renderer', type: 'type', paint: 'paint' };
const LISTS = new Set(['renderer', 'paint']);

const copy = (v) => JSON.parse(JSON.stringify(v));

/** settings.menus' shape (S9.2 MenuCustom), with anything malformed dropped. */
export function normalizeMenus(m) {
  const o = m && typeof m === 'object' ? m : {};
  const colors = {};
  if (o.colors && typeof o.colors === 'object') for (const [k, v] of Object.entries(o.colors)) if (typeof k === 'string' && MENU_COLORS.includes(v)) colors[k] = v;
  return {
    set: typeof o.set === 'string' && o.set ? o.set : MENU_DEFAULT_SET,
    hidden: Array.isArray(o.hidden) ? [...new Set(o.hidden.filter((k) => typeof k === 'string' && k))] : [],
    colors,
    showAll: !!o.showAll,
  };
}

export class KeymapStore {
  constructor(app) {
    this.app = app;
    this.sources = new Map(); // id -> () => [{ accel, label, priority }]
    this.cache = null;
    this.read();
    // an imported bundle (S10.7) or another writer replaced settings.keymap: take it over
    app.on?.('settings:changed', () => {
      const raw = JSON.stringify(this.snapshot(app.settings?.keymap));
      if (raw === JSON.stringify(this.snapshot(this.state))) return;
      this.read();
      this.changed('settings');
    });
  }

  snapshot(k) {
    const o = k && typeof k === 'object' ? k : {};
    return { set: typeof o.set === 'string' && o.set ? o.set : KEYMAP_DEFAULT_SET, overlay: normalizeOverlay(o.overlay), menus: normalizeMenus(o.menus) };
  }

  read() {
    this.state = this.snapshot(this.app.settings?.keymap);
    this.cache = null;
  }

  /** Saves settings.keymap and tells every reader. */
  commit(next, reason = 'set') {
    this.state = this.snapshot(next);
    this.cache = null;
    this.app.saveSettingsSoon?.({ keymap: copy(this.state) });
    this.changed(reason);
  }

  changed(reason) {
    this.cache = null;
    this.app.emit?.('keymap:changed', { reason });
    this.app.syncUiState?.();
  }

  /** The key sources' entries, each with its source id. */
  sourceEntries() {
    const out = [];
    for (const [id, list] of this.sources) {
      let entries = [];
      try {
        entries = list() ?? [];
      } catch (err) {
        console.warn(`key source ${id} failed`, err);
      }
      for (const e of entries) if (e && typeof e.accel === 'string') out.push({ id, accel: e.accel, label: String(e.label ?? id), priority: e.priority === 'over' ? 'over' : 'under' });
    }
    return out;
  }

  compute() {
    if (this.cache) return this.cache;
    const user = effectiveKeys(this.state.overlay);
    const over = this.sourceEntries().filter((s) => s.priority === 'over');
    // an 'over' source (an action's function key) owns its key: the application binding on it is dropped from the
    // effective tables, so neither the page nor the native menu runs it as well (S9.3)
    const shadowed = { menu: [], renderer: {} };
    const effective = copy(user);
    if (over.length) {
      for (const [cmd, accel] of Object.entries(user.menu)) {
        if (over.some((s) => accelCollides(s.accel, accel))) {
          delete effective.menu[cmd];
          shadowed.menu.push(cmd);
        }
      }
      for (const [cmd, list] of Object.entries(user.renderer)) {
        const kept = list.filter((a) => !over.some((s) => accelCollides(s.accel, a)));
        if (kept.length === list.length) continue;
        shadowed.renderer[cmd] = kept;
        if (kept.length) effective.renderer[cmd] = kept;
        else delete effective.renderer[cmd];
      }
    }
    const resolved = copy(this.state.overlay);
    for (const cmd of shadowed.menu) resolved.menu = { ...(resolved.menu ?? {}), [cmd]: null };
    for (const [cmd, list] of Object.entries(shadowed.renderer)) resolved.renderer = { ...(resolved.renderer ?? {}), [cmd]: list };
    this.cache = { user, effective, resolved: normalizeOverlay(resolved) };
    return this.cache;
  }

  /** The user overlay applied, minus the bindings an 'over' key source shadows: { menu, renderer, type, paint }. */
  effective() {
    return this.compute().effective;
  }

  /** The overlay plus the removals of S9.3: what main.js receives (as JSON in the ui state). */
  resolvedOverlay() {
    return copy(this.compute().resolved);
  }

  /** The accelerators of cmd in a scope of the effective tables ('global': menu then renderer). */
  keysFor(cmd, scope = 'global') {
    const e = this.effective();
    switch (scope) {
      case 'menu': return e.menu[cmd] ? [e.menu[cmd]] : [];
      case 'renderer': return (e.renderer[cmd] ?? []).slice();
      case 'type': return e.type[cmd] ? [e.type[cmd]] : [];
      case 'paint': return (e.paint[cmd] ?? []).slice();
      default: return [e.menu[cmd], ...(e.renderer[cmd] ?? [])].filter(Boolean);
    }
  }

  overlay() {
    return copy(this.state.overlay);
  }

  /**
   * Binds cmd to `accels` in a scope (null or [] removes its keys there). In 'global' the first accelerator that is
   * not a plain key goes to the native menu when the command has a menu item, the others to the renderer table;
   * plain keys only ever go to the renderer (macOS's menu would take them while typing). Without `force` a conflict
   * changes nothing and is returned; with `force` the key is taken from the other commands of the scope, all in one
   * 'keymap:changed'. A key FIXED_KEYS holds, or one a key source (an action) owns, cannot be taken.
   */
  set(cmd, accels, { scope = 'global', force = false } = {}) {
    if (!SCOPES.includes(scope)) throw new Error(`keymap.set: unknown scope ${scope}`);
    const list = (accels == null ? [] : Array.isArray(accels) ? accels : [accels]).filter((a) => typeof a === 'string' && a.trim());
    const next = copy(this.state);
    const o = next.overlay;
    const put = (table, value) => {
      o[table] = { ...(o[table] ?? {}), [cmd]: value };
    };
    if (scope === 'global') {
      let menu = null;
      const rest = [];
      const hasItem = menuItemCommands().has(cmd);
      for (const a of list) {
        if (!menu && hasItem && !isPlainKey(a)) menu = a;
        else rest.push(a);
      }
      put('menu', menu);
      put('renderer', rest);
    } else {
      const table = TABLE[scope];
      put(table, LISTS.has(table) ? list : list[0] ?? null);
    }
    next.overlay = normalizeOverlay(o);
    const group = scope === 'type' ? 'type' : scope === 'paint' ? 'paint' : 'global';
    const conflicts = keyConflicts(effectiveKeys(next.overlay), this.sourceEntries()).filter((c) => c.scope === group && c.commands.includes(cmd));
    if (conflicts.length && !force) return conflicts;
    if (conflicts.length) {
      for (const c of conflicts) {
        for (const other of c.commands) {
          if (other === cmd) continue;
          // the fixed keys and the key sources' keys are not the keymap's to give away
          if ((FIXED_KEYS[other] && accelCollides(FIXED_KEYS[other].accel, c.accel)) || other.startsWith('source:')) return conflicts;
          const eff = effectiveKeys(next.overlay);
          const tables = group === 'global' ? ['menu', 'renderer'] : [group];
          for (const t of tables) {
            const cur = eff[t][other];
            if (cur == null) continue;
            if (LISTS.has(t)) {
              const kept = cur.filter((a) => !accelCollides(a, c.accel));
              if (kept.length !== cur.length) next.overlay[t] = { ...(next.overlay[t] ?? {}), [other]: kept };
            } else if (accelCollides(cur, c.accel)) next.overlay[t] = { ...(next.overlay[t] ?? {}), [other]: null };
          }
        }
      }
      next.overlay = normalizeOverlay(next.overlay);
    }
    this.commit(next, 'set');
    return conflicts;
  }

  /** Back to the defaults for cmd (every scope), or for every command. */
  reset(cmd) {
    const next = copy(this.state);
    if (cmd === undefined) next.overlay = { v: 1 };
    else for (const t of ['menu', 'renderer', 'type', 'paint']) if (next.overlay[t]) delete next.overlay[t][cmd];
    this.commit(next, 'reset');
  }

  /** Keys bound to two commands of one scope in the user's tables (global includes FIXED_KEYS and the key sources). */
  conflicts() {
    return keyConflicts(this.compute().user, this.sourceEntries());
  }

  /**
   * The command a key press of cmd means now: while a painting tool is active, the enabled PAINT command bound to
   * the same key (main.js sends Shift+Alt+letter as the global command, S13.4), else cmd itself.
   */
  resolveKey(cmd, source) {
    if (source !== 'key' && source !== 'menu-key') return cmd;
    if (!paints(this.app.tools?.active)) return cmd;
    const own = this.keysFor(cmd, 'global');
    if (!own.length) return cmd;
    for (const [pcmd, list] of Object.entries(this.effective().paint)) {
      if (!list.some((a) => own.some((b) => accelCollides(a, b)))) continue;
      if (this.app.commands?.isEnabled?.(pcmd)) return pcmd;
    }
    return cmd;
  }

  // ---- named sets (presets of kind 'keyboard-shortcuts'; menu sets of kind 'menu-sets') ---------------------------

  sets() {
    const listed = this.app.presets?.list?.('keyboard-shortcuts') ?? [];
    if (listed.length) return listed;
    return [{ id: KEYMAP_DEFAULT_SET, name: 'Photoshop Defaults', builtin: true, data: { v: 1 } }];
  }

  activeSet() {
    return this.state.set;
  }

  async useSet(id) {
    if (id === KEYMAP_DEFAULT_SET && !this.app.presets?.list?.('keyboard-shortcuts')?.length) {
      this.commit({ ...copy(this.state), set: KEYMAP_DEFAULT_SET, overlay: { v: 1 } }, 'set-changed');
      return;
    }
    await this.app.presets.ready('keyboard-shortcuts');
    const p = this.app.presets.get('keyboard-shortcuts', id);
    if (!p) throw new Error(`No keyboard shortcut set ${id}`);
    this.commit({ ...copy(this.state), set: id, overlay: normalizeOverlay(p.data) }, 'set-changed');
  }

  async saveSet(name) {
    await this.app.presets.ready('keyboard-shortcuts');
    const p = this.app.presets.add('keyboard-shortcuts', { name, data: this.overlay() });
    this.commit({ ...copy(this.state), set: p.id }, 'set-changed');
    return p;
  }

  deleteSet(id) {
    this.app.presets.remove('keyboard-shortcuts', [id]);
    // the keys stay as they are; they now count as changes to the defaults
    if (this.state.set === id) this.commit({ ...copy(this.state), set: KEYMAP_DEFAULT_SET }, 'set-changed');
  }

  // ---- key sources (S9.3) ---------------------------------------------------------------------------------------

  /** list() → [{ accel, label, priority: 'over' | 'under' }]; returns the function that removes the source. */
  registerKeySource(id, list) {
    this.sources.set(id, list);
    this.changed('sources');
    return () => {
      if (this.sources.get(id) !== list) return;
      this.sources.delete(id);
      this.changed('sources');
    };
  }

  refreshSources() {
    this.changed('sources');
  }

  // ---- menu customisation (S9.5) --------------------------------------------------------------------------------

  menus() {
    return copy(this.state.menus);
  }

  setMenus(m) {
    this.commit({ ...copy(this.state), menus: normalizeMenus(m) }, 'menus');
  }
}
