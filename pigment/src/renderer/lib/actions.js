// Actions engine: records finished commands into actions and plays them back.
//
// - app.actions is the engine: sets › actions › steps (shape in actions/model.js), kept in
//   settings.actions; the built-in "Default Actions" set is re-created when no set is left.
// - Recording listens to 'command:done' (lib/commands.js). A thin wrapper around commands.run tracks
//   which commands are running so that only the outermost command becomes a step: a command that runs
//   others (Edit > Transform > Flip runs edit:transform; Enter commits a crop through image:crop-rect)
//   would otherwise be recorded twice. Free Transform is recorded when its session commits
//   ('transform:committed' from lib/image-ops.js); selections made with tools are recorded as their result.
// - Playback runs each step with source 'action' and waits for it; a step with its dialog toggle on runs
//   without its argument so the command asks again; Stop steps show a message; conditional steps play
//   another action of the set depending on the document state.
// The panel is lib/panels/actions.js; Batch and the other File > Automate commands are lib/automate.js.
import { COMMAND_LABELS, MENU_KEYS, RENDERER_KEYS, parseAccelerator } from '../../shared/keymap.js';
import { bridge, isMac } from './bridge.js';
import { canvasIsBlank } from './document.js';
import { Selection } from './selection.js';
import { baseName, extOf, isLayeredPath } from './io.js';
import * as M from './actions/model.js';
import * as D from './actions/dialogs.js';
import { defaultActionSets } from './actions/defaults.js';
import { encodeSelection, selectionMask } from './actions/selection-data.js';

/** Enter / Escape only finish what a tool started: what they trigger is recorded as if the user ran it directly. */
const TRANSPARENT = /^app:(enter|escape)$/;
const MAX_DEPTH = 12;
/** Sources of commands that code runs (lib/automate.js, other commands, playback), as opposed to user gestures. */
const PROGRAMMATIC = /^(api|action)$/;
const GROUP_NAMES = { file: 'File', edit: 'Edit', image: 'Image', layer: 'Layer', select: 'Select', filter: 'Filter', ai: 'AI', text: 'Type', path: 'Shape', view: 'View', tool: 'Colors' };

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
const currentSelection = (d) => (d?.selection && !d.selection.isEmpty ? d.selection : null);

class ActionsEngine {
  constructor(app) {
    this.app = app;
    this.sets = [];
    this.playback = { ...M.DEFAULT_PLAYBACK };
    this.buttonMode = false;
    /** { set, action } while recording, else null */
    this.recording = null;
    /** { action, step, cancelled } while an action plays, else null */
    this.playing = null;
    /** Batch (lib/automate.js) sets this while it runs: { overrideSave(doc, arg), overrideOpen } */
    this.batch = null;
    /** What the panel has selected: ids */
    this.selection = { set: null, action: null, step: null };
    this.frames = [];
    this.warned = new Set();
    this.load();
  }

  // ---- state --------------------------------------------------------------------------------------------------
  load() {
    const stored = this.app.settings.actions;
    this.sets = M.normalizeSets(stored?.sets);
    if (!this.sets.length) this.sets = defaultActionSets();
    this.playback = { ...M.DEFAULT_PLAYBACK, ...(M.PLAYBACK_MODES.includes(stored?.playback?.mode) ? stored.playback : {}) };
    this.buttonMode = !!stored?.buttonMode;
    const set = this.sets[0];
    this.selection = { set: set?.id ?? null, action: set?.actions[0]?.id ?? null, step: null };
  }

  persist() {
    this.app.saveSettingsSoon({ actions: { sets: M.cloneData(this.sets), playback: { ...this.playback }, buttonMode: this.buttonMode } });
  }

  changed(reason = 'edit', { save = true } = {}) {
    if (save) this.persist();
    this.app.emit('actions:changed', { reason });
    this.app.commands.invalidate();
  }

  /** The playback options under the name the contract uses ({ mode, pauseSeconds }). */
  get playbackOptions() {
    return this.playback;
  }

  get selectedSet() {
    return this.sets.find((s) => s.id === this.selection.set) ?? null;
  }
  get selectedAction() {
    return M.findAction(this.sets, this.selection.action)?.action ?? null;
  }
  get selectedStep() {
    return M.findStep(this.sets, this.selection.step)?.step ?? null;
  }

  select({ set = null, action = null, step = null } = {}) {
    if (step) {
      const f = M.findStep(this.sets, step);
      if (f) this.selection = { set: f.set.id, action: f.action.id, step };
    } else if (action) {
      const f = M.findAction(this.sets, action);
      if (f) this.selection = { set: f.set.id, action, step: null };
    } else this.selection = { set, action: null, step: null };
    this.changed('select', { save: false });
  }

  /** Label of a command as menus show it (the command's own label, the shortcut table, or its id made readable). */
  labelFor(id, arg) {
    const def = this.app.commands.commands.get(id);
    let known = null;
    try {
      known = typeof def?.label === 'function' ? def.label() : def?.label;
    } catch {
      known = null;
    }
    if (known === 'Not available yet') known = null;
    return M.commandLabel(id, arg, known ?? COMMAND_LABELS[id]);
  }

  /** Plain state of the active document for conditional steps (see CONDITIONS in actions/model.js). */
  documentState() {
    const d = this.app.doc;
    if (!d) return { open: false, layer: null };
    const l = d.active;
    const bottom = d.root.children[0];
    return {
      open: true,
      width: d.width,
      height: d.height,
      mode: d.mode ?? 'rgb',
      depth: d.depth ?? 8,
      layers: d.layers().filter((x) => !x.isGroup).length,
      hasSelection: !!d.selection && !d.selection.isEmpty,
      channels: d.channels?.length ?? 0,
      layer: l
        ? {
            type: l.type,
            background: this.app.isBackgroundLayer ? !!this.app.isBackgroundLayer(l) : l === bottom && l.type === 'raster' && l.name === 'Background',
            mask: !!l.mask,
            visible: !!l.visible,
            locked: !!(l.locked?.all || l.locked?.pixels || l.locked?.position || l.locked?.transparency),
            styles: !!l.styles && Object.values(l.styles).some((s) => s?.enabled),
            group: !!l.isGroup,
            clip: !!l.clip,
            empty: l.type === 'raster' && canvasIsBlank(l.canvas),
          }
        : null,
    };
  }

  // ---- sets and actions ---------------------------------------------------------------------------------------
  newSet(name) {
    const set = M.makeSet(M.uniqueName(name || 'Set 1', this.sets.map((s) => s.name)));
    this.sets.push(set);
    this.selection = { set: set.id, action: null, step: null };
    this.changed('new-set');
    return set;
  }

  /** Adds an action to a set (the selected one, or a new "Set 1" when there is none). */
  newAction({ name, set = null, functionKey = null, color = null, steps = [] } = {}) {
    let target = (typeof set === 'string' ? this.sets.find((s) => s.id === set) : set) ?? this.selectedSet ?? this.sets[0];
    if (!target) target = this.newSet('Set 1');
    const action = M.makeAction(M.uniqueName(name || 'Action 1', target.actions.map((a) => a.name)), steps);
    const fk = M.normalizeFunctionKey(functionKey);
    if (fk && !M.functionKeyOwner(this.sets, fk)) action.functionKey = fk;
    if (color && M.colorOf(color)) action.color = color;
    target.actions.push(action);
    delete target.collapsed;
    this.selection = { set: target.id, action: action.id, step: null };
    this.changed('new-action');
    return action;
  }

  rename(target, name) {
    const text = String(name ?? '').trim();
    if (!target || !text) return false;
    if ('steps' in target || 'actions' in target) target.name = text;
    else target.label = text;
    this.changed('rename');
    return true;
  }

  setActionOptions(action, { name, functionKey, color }) {
    if (name) action.name = name;
    const fk = M.normalizeFunctionKey(functionKey);
    if (fk && !M.functionKeyOwner(this.sets, fk, action)) action.functionKey = fk;
    else if (!fk) delete action.functionKey;
    if (color && M.colorOf(color)) action.color = color;
    else delete action.color;
    this.changed('options');
  }

  /** Deletes a set, an action or a step (objects from this.sets). */
  delete(target) {
    if (!target) return false;
    if (this.recording && (target === this.recording.action || target === this.recording.set)) this.stopRecording();
    for (const set of this.sets) {
      if (set === target) {
        this.sets.splice(this.sets.indexOf(set), 1);
        const next = this.sets[0];
        this.selection = { set: next?.id ?? null, action: null, step: null };
        this.changed('delete');
        return true;
      }
      const ai = set.actions.indexOf(target);
      if (ai >= 0) {
        set.actions.splice(ai, 1);
        const next = set.actions[Math.min(ai, set.actions.length - 1)];
        this.selection = { set: set.id, action: next?.id ?? null, step: null };
        this.changed('delete');
        return true;
      }
      for (const action of set.actions) {
        const si = action.steps.indexOf(target);
        if (si >= 0) {
          action.steps.splice(si, 1);
          const next = action.steps[Math.min(si, action.steps.length - 1)];
          this.selection = { set: set.id, action: action.id, step: next?.id ?? null };
          this.changed('delete');
          return true;
        }
      }
    }
    return false;
  }

  duplicate(target) {
    if (!target) return null;
    for (const set of this.sets) {
      if (set === target) {
        const copy = M.duplicateSet(set, M.uniqueName(`${set.name} copy`, this.sets.map((s) => s.name)));
        this.sets.splice(this.sets.indexOf(set) + 1, 0, copy);
        this.selection = { set: copy.id, action: null, step: null };
        this.changed('duplicate');
        return copy;
      }
      const ai = set.actions.indexOf(target);
      if (ai >= 0) {
        const copy = M.duplicateAction(target, M.uniqueName(`${target.name} copy`, set.actions.map((a) => a.name)));
        set.actions.splice(ai + 1, 0, copy);
        this.selection = { set: set.id, action: copy.id, step: null };
        this.changed('duplicate');
        return copy;
      }
      for (const action of set.actions) {
        const si = action.steps.indexOf(target);
        if (si >= 0) {
          const copy = { ...M.cloneData(target), id: M.newId('s') };
          action.steps.splice(si + 1, 0, copy);
          this.selection = { set: set.id, action: action.id, step: copy.id };
          this.changed('duplicate');
          return copy;
        }
      }
    }
    return null;
  }

  /** Moves a step inside its action or into another one (drag and drop in the panel). */
  moveStep(stepId, actionId, index) {
    const from = M.findStep(this.sets, stepId);
    const to = M.findAction(this.sets, actionId);
    if (!from || !to) return false;
    from.action.steps.splice(from.index, 1);
    const at = Math.max(0, Math.min(to.action.steps.length, from.action === to.action && index > from.index ? index - 1 : index));
    to.action.steps.splice(at, 0, from.step);
    this.selection = { set: to.set.id, action: to.action.id, step: stepId };
    this.changed('move');
    return true;
  }

  moveAction(actionId, setId, index) {
    const from = M.findAction(this.sets, actionId);
    const to = this.sets.find((s) => s.id === setId);
    if (!from || !to) return false;
    const i = from.set.actions.indexOf(from.action);
    from.set.actions.splice(i, 1);
    const at = Math.max(0, Math.min(to.actions.length, from.set === to && index > i ? index - 1 : index));
    to.actions.splice(at, 0, from.action);
    this.selection = { set: to.id, action: actionId, step: null };
    this.changed('move');
    return true;
  }

  /** Where a new step goes: after the selected step, else at the end of the selected (or recording) action. */
  insertStep(step, action = this.recording?.action ?? this.selectedAction) {
    if (!action) return false;
    const sel = this.selectedStep;
    const at = sel && action.steps.includes(sel) && !this.recording ? action.steps.indexOf(sel) + 1 : action.steps.length;
    action.steps.splice(at, 0, step);
    delete action.collapsed;
    const set = M.findAction(this.sets, action.id)?.set;
    this.selection = { set: set?.id ?? null, action: action.id, step: step.id };
    this.changed('step');
    return true;
  }

  async insertStop(arg) {
    const action = this.recording?.action ?? this.selectedAction;
    if (!action) return this.needAction();
    const stop = arg && typeof arg === 'object' ? { message: String(arg.message ?? ''), allowContinue: !!arg.allowContinue } : await D.stopStepDialog(this.app);
    if (!stop) return null;
    const step = M.makeStopStep(stop.message, stop.allowContinue);
    this.insertStep(step, action);
    return step;
  }

  /** Commands Insert Menu Item offers: everything registered that a step may run, grouped by menu. */
  menuCommands() {
    const out = [];
    for (const id of this.app.commands.commands.keys()) {
      if (M.isIgnoredCommand(id) || /^(actions:|layer:select$|layer:move-to|layer:smart-filter$|image:crop-rect|file:open-paths|edit:transform$|filter:apply$|image:adjust$)/.test(id)) continue;
      if (this.app.stubbed?.includes(id)) continue;
      const group = GROUP_NAMES[/^([a-z]+):/.exec(id)?.[1]] ?? 'Other';
      out.push({ id, label: this.labelFor(id), group });
    }
    const order = Object.values(GROUP_NAMES);
    return out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.label.localeCompare(b.label));
  }

  async insertMenuItem(arg) {
    const action = this.recording?.action ?? this.selectedAction;
    if (!action) return this.needAction();
    const id = typeof arg === 'string' ? arg : arg?.command ?? (await D.menuItemDialog(this.app, this.menuCommands()));
    if (!id) return null;
    if (!this.app.commands.has(id)) {
      this.app.dialogs.toast(`Unknown command: ${id}`, { kind: 'error' });
      return null;
    }
    const step = M.makeMenuItemStep(id, this.labelFor(id));
    this.insertStep(step, action);
    return step;
  }

  async insertConditional(arg) {
    const action = this.recording?.action ?? this.selectedAction;
    if (!action) return this.needAction();
    const set = M.findAction(this.sets, action.id)?.set;
    const c = arg && typeof arg === 'object' ? arg : await D.conditionalDialog(this.app, set);
    if (!c) return null;
    const step = M.makeConditionalStep(c.test, c.thenAction, c.elseAction);
    this.insertStep(step, action);
    return step;
  }

  needAction() {
    this.app.dialogs.toast('Select an action first (or create one with the New Action button)', { kind: 'error' });
    return null;
  }

  // ---- files --------------------------------------------------------------------------------------------------
  /** Load Actions…: adds the sets of a *.pigment-actions file. */
  async loadFile(path) {
    let file = typeof path === 'string' ? path : null;
    if (!file) {
      // Photoshop's .atn files are a binary format Pigment does not read: the file type list says so
      const picked = await bridge.openFileDialog({ title: 'Load Actions', filters: [{ name: 'Pigment actions (Photoshop .atn files are not supported)', extensions: [M.FILE_EXTENSION, 'json'] }] });
      file = Array.isArray(picked) ? picked[0] : picked;
      if (!file) return null;
    }
    let sets;
    try {
      if (/\.atn$/i.test(file)) throw new Error('Photoshop .atn action files cannot be read. Pigment loads its own .pigment-actions files (JSON).');
      if (window.__pigmentTest?.pending?.[file]) await window.__pigmentTest.pending[file];
      sets = M.parseActionsFile(await bridge.readFile(file));
    } catch (err) {
      this.app.reportError(err, 'Could not load the actions');
      return null;
    }
    for (const set of sets) {
      set.name = M.uniqueName(set.name, this.sets.map((s) => s.name));
      // a function key plays one action: keys already taken here are dropped from the loaded copy
      for (const a of set.actions) if (a.functionKey && M.functionKeyOwner(this.sets, a.functionKey)) delete a.functionKey;
      this.sets.push(set);
    }
    this.selection = { set: sets[0].id, action: sets[0].actions[0]?.id ?? null, step: null };
    this.changed('load');
    this.app.dialogs.toast(`Loaded ${sets.length === 1 ? `“${sets[0].name}”` : `${sets.length} action sets`}`, { kind: 'success', timeout: 2200 });
    return sets;
  }

  /** Save Actions…: writes the selected set (Photoshop saves sets, not single actions). */
  async saveFile(set = this.selectedSet, path) {
    if (!set) {
      this.app.dialogs.toast('Select an action set to save', { kind: 'error' });
      return false;
    }
    const target = typeof path === 'string' ? path : await bridge.saveFileDialog({ title: 'Save Actions', defaultPath: `${set.name.replace(/[\\/:*?"<>|]+/g, '-')}.${M.FILE_EXTENSION}`, filters: [{ name: 'Pigment actions', extensions: [M.FILE_EXTENSION] }] });
    if (!target) return false;
    try {
      await bridge.writeFile(/\.[a-z0-9-]+$/i.test(target) ? target : `${target}.${M.FILE_EXTENSION}`, new TextEncoder().encode(M.serializeSets([set])));
    } catch (err) {
      this.app.reportError(err, 'Could not save the actions');
      return false;
    }
    this.app.dialogs.toast(`Saved the set “${set.name}”`, { kind: 'success', timeout: 2000 });
    return true;
  }

  /** Reset Actions: back to the built-in set only. */
  reset() {
    if (this.recording) this.stopRecording();
    this.sets = defaultActionSets();
    this.selection = { set: this.sets[0].id, action: this.sets[0].actions[0]?.id ?? null, step: null };
    this.changed('reset');
  }

  /** Clear All Actions: an empty panel (the default set returns the next time Pigment starts with no set). */
  clearAll() {
    if (this.recording) this.stopRecording();
    this.sets = [];
    this.selection = { set: null, action: null, step: null };
    this.changed('clear');
  }

  // ---- recording ----------------------------------------------------------------------------------------------
  /** Starts recording into an action (the selected one; a new "Action n" when none is selected). */
  record(action = this.selectedAction) {
    if (this.playing) return false;
    if (this.recording) this.stopRecording();
    const target = action ?? this.newAction({});
    const set = M.findAction(this.sets, target.id)?.set;
    if (!set) return false;
    delete target.collapsed;
    delete set.collapsed;
    this.recording = {
      set, action: target, marks: new Map(), redo: [], lastSelection: new WeakMap(), seen: new WeakSet(),
      lastActive: new WeakMap(), layers: new WeakSet(), colors: { fg: this.app.settings.foreground, bg: this.app.settings.background },
    };
    // history entries that exist now are not part of the recording; later ones made outside commands are tool work
    for (const d of this.app.docs?.docs ?? []) {
      for (const entry of d.history?.entries ?? []) this.recording.seen.add(entry);
      this.recording.lastSelection.set(d, currentSelection(d));
      this.noteLayers(d);
    }
    this.warned.clear();
    this.selection = { set: set.id, action: target.id, step: null };
    this.changed('record', { save: false });
    return true;
  }

  stopRecording() {
    if (!this.recording) return false;
    // the action itself is selected afterwards, so Play runs it from its first step
    this.selection = { set: this.recording.set.id, action: this.recording.action.id, step: null };
    this.recording = null;
    this.changed('record-stop');
    return true;
  }

  /** Stop button: ends recording, or stops the action that is playing after its current step. */
  stop() {
    if (this.recording) return this.stopRecording();
    if (this.playing) {
      this.playing.cancelled = true;
      return true;
    }
    return false;
  }

  appendRecorded(step, mark) {
    const rec = this.recording;
    if (!rec) return;
    rec.action.steps.push(step);
    if (mark) rec.marks.set(step.id, mark);
    rec.redo.length = 0;
    this.selection = { set: rec.set.id, action: rec.action.id, step: step.id };
    this.changed('recorded');
  }

  warnOnce(key, message) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.app.dialogs.toast(message, { kind: 'info', timeout: 4500 });
  }

  /** Remembers a document's layers and its active layer, so a later click on another layer is known as a change. */
  noteLayers(d) {
    const rec = this.recording;
    if (!rec || !d?.layers) return;
    for (const l of d.layers()) rec.layers.add(l);
    rec.lastActive.set(d, d.active ?? null);
  }

  /**
   * The active layer changed. The Layers panel and the Move tool's auto-select pick layers without a
   * command, so the pick itself is recorded ("Select layer"), by name: ids differ between documents.
   * Layers a command made active, and layers a tool has just created, are not picks.
   */
  onLayerActivated({ doc: d, layer } = {}) {
    const rec = this.recording;
    if (!rec || !d) return;
    const before = rec.lastActive.get(d) ?? null;
    const known = !!layer && rec.layers.has(layer);
    this.noteLayers(d);
    if (this.playing || this.frames.length || d !== this.app.doc || !layer || layer === before || !known) return;
    const steps = rec.action.steps;
    const last = steps[steps.length - 1];
    // clicking through several layers: the step keeps the last one
    if (last?.command === 'actions:select-layer' && rec.marks.get(last.id)?.pick) steps.pop();
    this.appendRecorded(M.makeStep('actions:select-layer', { name: layer.name, index: d.layers().indexOf(layer) }, `Select layer “${layer.name}”`), { pick: true });
  }

  /** 'command:done' while recording. `fr` is the wrapper's frame of this run (null for transparent commands). */
  onCommandDone(e, fr) {
    const rec = this.recording;
    if (!rec) return;
    const d = this.app.doc;
    // whatever the command did to the selection or the layers is its own doing, not a tool's (see onHistoryChanged)
    if (d) {
      rec.lastSelection.set(d, currentSelection(d));
      this.noteLayers(d);
    }
    if (!fr) return;
    if (!fr.nested && e.source !== 'action' && /^edit:(undo|redo|step-backward|step-forward)$/.test(e.id)) return this.followUndo(d);
    const entryNow = d?.history?.entries[d.history.index] ?? null;
    if (fr.nested && fr.parent) {
      // Part of another command. Should that command end up cancelled (Focus Area hands over to Select and
      // Mask and cancels itself), what this one did is the step: it is kept with the parent until then.
      if (e.cancelled) fr.parent.children.push(...fr.children);
      else if (e.source !== 'action') fr.parent.children.push({ e, fr, doc: d, entry: fr.doc === d && entryNow !== fr.histEntry ? entryNow : null });
      return;
    }
    if (e.cancelled && fr.children.length) {
      for (const child of fr.children) {
        // only work that is still there: a command that undid its own steps before cancelling left nothing to record
        const at = child.entry ? child.doc?.history?.entries.indexOf(child.entry) ?? -1 : -1;
        if (at < 0 || at > child.doc.history.index) continue;
        this.recordEvent({ ...child.e, nested: false }, { ...child.fr, nested: false }, child);
      }
      return;
    }
    this.recordEvent({ ...e, nested: fr.nested }, fr, null);
  }

  /** Turns a finished top-level command into a step, or says why it cannot be one. */
  recordEvent(e, fr, made) {
    const rec = this.recording;
    const d = this.app.doc;
    let event = e;
    // commands whose own form cannot be replayed are recorded as the equivalent that can
    const sub = !fr.nested && !e.cancelled && e.source !== 'action' ? this.substitute(e, fr) : null;
    if (sub === false) return;
    if (sub) event = { ...event, ...sub, replayable: true };
    const decision = M.recordDecision(event, { label: sub?.label ?? this.labelFor(event.id, event.arg) });
    if (decision.record) {
      const entry = made ? made.entry : d?.history?.entries[d.history.index];
      this.appendRecorded(decision.step, entry && fr.doc === d && entry !== fr.histEntry ? { doc: d, entry } : null);
    } else if (decision.reason === 'unreplayable') this.warnOnce(`u:${e.id}`, `${decision.label} could not be recorded: it has no replayable form`);
    else if (decision.reason === 'data') this.warnOnce(`d:${e.id}`, `${decision.label} could not be recorded: its settings cannot be stored in an action`);
  }

  /**
   * Replacement for a finished command: { id, arg, label? }, false (record nothing) or null (record as is).
   * Open / Save As / Close report through their result; a layer chosen by id is recorded by name.
   */
  substitute(e, fr) {
    const d = this.app.doc;
    switch (e.id) {
      case 'file:open':
        return e.result?.path ? { id: 'file:open-paths', arg: [e.result.path], label: `Open: ${baseName(e.result.path)}` } : false;
      case 'file:open-paths':
        return Array.isArray(e.arg) && e.arg.length ? { id: e.id, arg: e.arg, label: `Open: ${e.arg.map((p) => String(p).split(/[\\/]/).pop()).join(', ')}` } : false;
      case 'file:save':
      case 'file:close':
      case 'file:close-all':
      case 'file:revert':
        return e.result === false ? false : null;
      case 'file:save-as':
        if (e.result !== true || !d?.path) return false;
        return { id: 'actions:save-as', arg: { path: d.path, ...(d.saveOpts?.quality ? { quality: d.saveOpts.quality } : {}) }, label: `Save As: ${d.path.split(/[\\/]/).pop()}` };
      case 'file:save-copy':
        this.warnOnce('u:file:save-copy', 'Save a Copy could not be recorded: use Save As or Export As while recording');
        return false;
      case 'view:new-guide': {
        // run from the menu it asks for the position and reports nothing: the guide it added is the argument
        if (e.arg && typeof e.arg === 'object') return null;
        const g = d && fr.doc === d && d.guides.length > fr.guides ? d.guides[d.guides.length - 1] : null;
        return g ? { id: e.id, arg: { axis: g.axis, pos: g.pos }, label: `New Guide: ${g.axis === 'y' ? 'horizontal' : 'vertical'} at ${g.pos} px` } : false;
      }
      case 'layer:visibility':
      case 'layer:properties':
      case 'select:from-layer':
        // the Layers panel passes the layer's id; the active layer needs none, so the step works in any document
        return typeof e.arg === 'string' && fr.doc?.active?.id === e.arg ? { id: e.id, arg: undefined } : null;
      case 'layer:rename':
        return e.arg?.id && e.arg?.name ? { id: e.id, arg: { name: e.arg.name } } : null;
      case 'layer:select': {
        if (['all', 'none', 'next', 'prev'].includes(e.arg)) return null;
        const layer = fr.doc?.find?.(e.arg) ?? d?.find?.(e.arg);
        if (!layer) return false;
        return { id: 'actions:select-layer', arg: { name: layer.name, index: (fr.doc ?? d).layers().indexOf(layer) }, label: `Select layer “${layer.name}”` };
      }
      default:
        return null;
    }
  }

  /** Undo while recording takes the step that made the undone change back out; Redo returns it. */
  followUndo(d) {
    const rec = this.recording;
    if (!rec || !d?.history) return;
    const steps = rec.action.steps;
    // a step is undone while the history entry it made sits after the current state
    const undone = (step) => {
      const mark = step && rec.marks.get(step.id);
      return !!mark && mark.doc === d && d.history.entries.indexOf(mark.entry) > d.history.index;
    };
    const redone = (step) => {
      const mark = step && rec.marks.get(step.id);
      const at = mark && mark.doc === d ? d.history.entries.indexOf(mark.entry) : -1;
      return at >= 0 && at <= d.history.index;
    };
    let changed = false;
    while (undone(steps[steps.length - 1])) {
      rec.redo.push(steps.pop());
      changed = true;
    }
    while (redone(rec.redo[rec.redo.length - 1])) {
      steps.push(rec.redo.pop());
      changed = true;
    }
    if (changed) {
      this.selection = { set: rec.set.id, action: rec.action.id, step: steps[steps.length - 1]?.id ?? null };
      this.changed('recorded');
    }
  }

  /**
   * The foreground or background colour changed. The colour panel, the swatches, the eyedropper and the
   * colour picker set colours without a command, so the change itself is recorded ("Set Foreground Color");
   * Swap and Default Colors are commands and record themselves.
   */
  onColorChanged({ fg, bg }) {
    const rec = this.recording;
    if (!rec) return;
    const before = rec.colors;
    rec.colors = { fg, bg };
    if (this.playing || this.frames.some((f) => !/^tool:pick-(fg|bg)$/.test(f.id))) return;
    const steps = rec.action.steps;
    for (const [key, command, label] of [['fg', 'tool:fg-color', 'Set Foreground Color'], ['bg', 'tool:bg-color', 'Set Background Color']]) {
      const value = key === 'fg' ? fg : bg;
      if (!value || value === before[key]) continue;
      // dragging in a colour field fires many changes: the step keeps the last one
      const last = steps[steps.length - 1];
      if (last?.command === command && rec.marks.get(last.id)?.color) {
        last.arg = value;
        this.changed('recorded');
      } else this.appendRecorded(M.makeStep(command, value, label), { color: true });
    }
  }

  /** A transform session committed (lib/image-ops.js): recorded unless a command did it as part of its own work. */
  onTransformCommitted(t) {
    if (!this.recording || this.playing) return;
    const top = this.frames.find((f) => !f.nested);
    if (top && !top.hadTransform) return; // Flip / Rotate 90° / Transform Again: the command itself is the step
    if (t.warp) return this.warnOnce('u:warp', 'Warp could not be recorded: it has no replayable form');
    const round = (v) => Math.round(v * 1e6) / 1e6;
    let arg;
    if (t.matrix) arg = { matrix: t.matrix.map(round), shift: (t.shift ?? [0, 0]).map(round) };
    else if (t.quad && t.box?.width && t.box?.height) arg = { quad: t.quad.map(([x, y]) => [round((x - t.box.x) / t.box.width), round((y - t.box.y) / t.box.height)]) };
    else return;
    if (t.selectionOnly) arg.selectionOnly = true;
    if (t.exact) arg.exact = true;
    const d = this.app.doc;
    const entry = d?.history?.entries[d.history.index];
    if (entry) this.recording.seen.add(entry);
    if (d) this.recording.lastSelection.set(d, currentSelection(d));
    this.appendRecorded(M.makeStep('actions:transform', arg, t.selectionOnly ? 'Transform Selection' : 'Free Transform'), entry ? { doc: d, entry } : null);
  }

  /**
   * A history entry appeared while no command was running: a tool did it. Selections are recorded as
   * their result (marquee, lasso, wand…); strokes and other tool edits are not, as in Photoshop.
   */
  onHistoryChanged(d) {
    const rec = this.recording;
    if (!rec || !d?.history) return;
    const entry = d.history.entries[d.history.index];
    if (!entry || rec.seen.has(entry)) return; // undo, redo, the History panel
    rec.seen.add(entry);
    if (this.playing || this.frames.length || this.app.transformTool?.committing || d !== this.app.doc) return;
    const before = rec.lastSelection.get(d) ?? null;
    const now = currentSelection(d);
    if (before === now) {
      const label = entry.label ?? '';
      if (label && !/transform/i.test(label)) this.warnOnce('tool', `“${label}” was not recorded: actions record commands and selections, not tool strokes`);
      return;
    }
    rec.lastSelection.set(d, now);
    const arg = encodeSelection(now, { width: d.width, height: d.height, units: this.app.settings.rulerUnit === 'percent' ? 'percent' : 'px' });
    if (arg === undefined) return this.warnOnce('u:selection', 'This selection is too detailed to be recorded');
    const steps = rec.action.steps;
    const last = steps[steps.length - 1];
    // the step stores the resulting selection, so consecutive tool selections collapse into the last one
    if (last?.command === 'actions:set-selection' && rec.marks.get(last.id)?.tool) steps.pop();
    this.appendRecorded(M.makeStep('actions:set-selection', arg, now ? 'Set Selection' : 'Deselect'), { doc: d, entry, tool: true });
  }

  // ---- playback -----------------------------------------------------------------------------------------------
  resolve(target) {
    if (!target) return this.selectedAction ? M.findAction(this.sets, this.selectedAction.id) : null;
    if (typeof target === 'string') return M.findAction(this.sets, target) ?? M.findActionByName(this.sets, target);
    if (target.steps) return M.findAction(this.sets, target.id) ?? { set: null, action: target };
    if (target.id) return M.findAction(this.sets, target.id);
    if (target.action) {
      const set = target.set ? this.sets.find((s) => s.name === target.set || s.id === target.set) : null;
      return M.findActionByName(this.sets, target.action, set) ?? M.findAction(this.sets, target.action);
    }
    return null;
  }

  /**
   * Plays an action. Resolves { ok: true } when every enabled step ran, otherwise { ok: false, reason,
   * message?, index?, step?, stopped? } ('stop' = a Stop step or the Stop button, 'cancelled' = a dialog
   * was cancelled, 'unavailable' / 'error' = a command could not run).
   * @param {object|string} target  an action, its id or name, or { set, action } names (default: the selected action)
   * @param {{ from?: number|string, quiet?: boolean }} opts  from: first step (index or step id); quiet: no prompts or toasts for failures (Batch)
   */
  async play(target, { from = 0, quiet = false, depth = 0 } = {}) {
    const app = this.app;
    const found = this.resolve(target);
    if (!found) {
      if (!quiet) app.dialogs.toast('Select an action to play', { kind: 'error' });
      return { ok: false, reason: 'missing', message: 'The action was not found' };
    }
    const { set, action } = found;
    if (this.recording?.action === action) {
      app.dialogs.toast('Stop recording before playing this action', { kind: 'error' });
      return { ok: false, reason: 'recording', message: 'The action is being recorded' };
    }
    if (depth > MAX_DEPTH) return { ok: false, reason: 'error', message: `Actions play each other more than ${MAX_DEPTH} levels deep` };
    if (depth === 0) {
      if (this.playing) return { ok: false, reason: 'busy', message: 'Another action is playing' };
      this.playing = { action, step: null, cancelled: false };
      this.changed('play', { save: false });
    }
    let start = 0;
    if (typeof from === 'string') start = Math.max(0, action.steps.findIndex((s) => s.id === from));
    else if (Number.isFinite(from)) start = Math.max(0, from);
    let outcome = { ok: true };
    try {
      for (let i = start; i < action.steps.length; i++) {
        const step = action.steps[i];
        if (!step.enabled) continue;
        if (this.playing?.cancelled) {
          outcome = { ok: false, reason: 'stop', stopped: true, index: i, step };
          break;
        }
        if (depth === 0 && this.playing) {
          this.playing.step = step;
          app.emit('actions:changed', { reason: 'playing' });
        }
        const r = await this.playStep(step, { set, action, quiet, depth });
        if (!r.ok) {
          outcome = { ...r, index: i, step };
          break;
        }
        if (i < action.steps.length - 1) await this.pace();
      }
    } catch (err) {
      outcome = { ok: false, reason: 'error', message: err?.message ?? String(err) };
    } finally {
      if (depth === 0) {
        this.playing = null;
        if (!outcome.ok && outcome.reason === 'stop' && outcome.step?.stop && M.findAction(this.sets, action.id)) {
          // Play continues after the Stop step
          const next = action.steps[outcome.index + 1];
          if (next) this.selection = { set: set?.id ?? null, action: action.id, step: next.id };
        }
        this.changed('play-end', { save: false });
      }
    }
    if (!outcome.ok && depth === 0 && !quiet && (outcome.reason === 'error' || outcome.reason === 'unavailable')) {
      app.dialogs.toast(`“${action.name}” stopped at “${outcome.step?.label ?? 'a step'}”: ${outcome.message}`, { kind: 'error', timeout: 6000 });
    }
    return outcome;
  }

  async pace() {
    if (this.playback.mode === 'step') {
      await frame();
      await frame();
    } else if (this.playback.mode === 'pause') {
      const until = performance.now() + Math.max(0.1, this.playback.pauseSeconds) * 1000;
      while (performance.now() < until && !this.playing?.cancelled) await new Promise((r) => setTimeout(r, 50));
    }
  }

  async playStep(step, { set, action, quiet, depth }) {
    const app = this.app;
    const kind = M.stepKind(step);
    if (kind === 'stop') {
      const go = await D.stopMessage(app, step, action.name);
      return go ? { ok: true } : { ok: false, reason: 'stop', stopped: true };
    }
    if (kind === 'conditional') {
      const name = M.conditionalBranch(step.conditional, this.documentState());
      if (!name) return { ok: true };
      const found = M.findActionByName(this.sets, name, set);
      if (!found) return { ok: false, reason: 'error', message: `The action “${name}” does not exist` };
      if (found.action === action) return { ok: false, reason: 'error', message: 'A conditional cannot play its own action' };
      return this.play(found.action, { quiet, depth: depth + 1 });
    }
    const id = step.command;
    if (id === 'actions:play' && kind === 'command') {
      // a recorded "Play action" step: played here, as part of this playback (the command itself only starts one)
      const found = step.arg && typeof step.arg === 'object' ? this.resolve(step.arg) : null;
      if (!found) return { ok: false, reason: 'unavailable', message: `the action “${step.arg?.action ?? step.label}” does not exist` };
      if (found.action === action) return { ok: false, reason: 'error', message: 'An action cannot play itself' };
      return this.play(found.action, { quiet, depth: depth + 1 });
    }
    if (this.batch?.overrideOpen && /^file:open(-paths)?$/.test(id)) return { ok: true }; // Batch: Override Action "Open" Commands
    if (!app.commands.has(id) || app.stubbed?.includes(id)) return { ok: false, reason: 'unavailable', message: `the command “${step.label}” does not exist in this version of Pigment` };
    // a running transform is applied first, as it would be when the command ran from the menu
    if (app.transformTool?.session && !app.transformTool.committing) app.transformTool.commit();
    if (!app.commands.isEnabled(id)) {
      if (step.optional) return { ok: true };
      const message = `the command “${step.label}” is not currently available`;
      if (quiet) return { ok: false, reason: 'unavailable', message };
      return (await D.unavailableDialog(app, step.label)) ? { ok: true } : { ok: false, reason: 'stop', stopped: true };
    }
    const r = await this.runCommand(id, kind === 'dialog' ? undefined : step.arg);
    if (r.error) return { ok: false, reason: 'error', message: r.error };
    if (r.cancelled) return { ok: false, reason: 'cancelled', stopped: true, message: `“${step.label}” was cancelled` };
    // the engine's own step commands say when they could not do their work (a layer that does not exist
    // in this document, a file that could not be saved)
    if (id.startsWith('actions:') && r.result && typeof r.result === 'object' && r.result.ok === false) {
      return { ok: false, reason: 'unavailable', message: r.result.message ?? `“${step.label}” could not run` };
    }
    return { ok: true };
  }

  /** Runs one command as a step and reports how it ended: {} | { cancelled: true } | { error }. */
  async runCommand(id, arg) {
    const app = this.app;
    let event = null;
    const off = app.on('command:done', (e) => {
      if (!event && e.source === 'action' && e.id === id) event = e;
    });
    try {
      app.commands.lastRun.delete(id); // the de-duplication of menu + key presses must not swallow a step
      const result = app.commands.run(id, arg, 'action');
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      return { error: err?.message ?? String(err) };
    } finally {
      off();
    }
    if (!event) return { error: 'the command failed' };
    return event.cancelled ? { cancelled: true } : { result: event.result };
  }

  // ---- command bookkeeping ------------------------------------------------------------------------------------
  /** Wraps commands.run so the engine knows which commands are running (see the header). */
  wrapCommands() {
    const registry = this.app.commands;
    const base = registry.run.bind(registry);
    const frames = this.frames;
    let sync = 0; // commands whose run() is on the call stack right now
    registry.run = (id, arg, source = 'api') => {
      if (TRANSPARENT.test(id) || !registry.commands.has(id)) return base(id, arg, source);
      const d = this.app.doc;
      // A command is part of another one when it starts inside that command's run(), or from code ('api')
      // while that command still waits (Fit Image runs Image Size after its dialog). A key, menu or panel
      // gesture made while a slow command is pending (an AI request) is the user's own next step.
      const nested = sync > 0 || (frames.length > 0 && PROGRAMMATIC.test(source));
      const parent = nested ? frames[frames.length - 1] ?? null : null;
      const fr = { id, source, nested, parent, children: [], hadTransform: !!this.app.transformTool?.session, doc: d, histEntry: d?.history?.entries[d.history.index] ?? null, guides: d?.guides?.length ?? 0, done: false };
      frames.push(fr);
      const release = () => {
        const i = frames.indexOf(fr);
        if (i >= 0) frames.splice(i, 1);
      };
      let result;
      sync++;
      try {
        result = base(id, arg, source);
      } catch (err) {
        release();
        throw err;
      } finally {
        sync--;
      }
      if (result && typeof result.then === 'function') result.then(release, release);
      else release();
      return result;
    };
    this.app.on('command:done', (e) => {
      let fr = null;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].id === e.id && !frames[i].done) {
          fr = frames[i];
          break;
        }
      }
      if (fr) fr.done = true;
      if (this.recording) this.onCommandDone(e, fr);
    });
  }
}

// ---- helper commands recorded in place of ones that cannot replay ---------------------------------------------

/** Applies a recorded Free Transform to the current target: the same linear part about the new centre plus the recorded shift. */
function applyTransform(app, arg) {
  const tt = app.transformTool;
  if (!tt || !arg) return false;
  tt.start({ mode: 'free', selectionOnly: !!arg.selectionOnly });
  const s = tt.session;
  if (!s) return false;
  const { x, y, width, height } = s.box;
  const corners = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
  if (Array.isArray(arg.matrix)) {
    const m = arg.matrix, shift = arg.shift ?? [0, 0];
    const cx = x + width / 2, cy = y + height / 2;
    const px = m[0] * cx + m[2] * cy, py = m[1] * cx + m[3] * cy;
    // relShift (built-in actions): a shift in fractions of the box, x and y each as [of its width, of its height]
    const rel = arg.relShift ?? {};
    const tx = cx - px + shift[0] + (rel.x?.[0] ?? 0) * width + (rel.x?.[1] ?? 0) * height;
    const ty = cy - py + shift[1] + (rel.y?.[0] ?? 0) * width + (rel.y?.[1] ?? 0) * height;
    s.quad = corners.map(([qx, qy]) => [m[0] * qx + m[2] * qy + tx, m[1] * qx + m[3] * qy + ty]);
  } else if (Array.isArray(arg.quad) && arg.quad.length === 4) {
    s.quad = arg.quad.map(([u, v]) => [x + u * width, y + v * height]);
  } else {
    tt.cancel();
    return false;
  }
  if (arg.exact) s.exact = true;
  return tt.commit();
}

function selectLayerByName(app, arg) {
  const d = app.doc;
  if (!d || !arg) return false;
  const layers = d.layers();
  const named = layers.filter((l) => l.name === arg.name);
  // the name decides; the recorded position only chooses between layers that share it
  const layer = named.length > 1 && layers[arg.index]?.name === arg.name ? layers[arg.index] : named[0] ?? (arg.name === undefined ? layers[arg.index] : null);
  if (!layer) return { ok: false, message: `there is no layer named “${arg.name}” in this document` };
  d.setActive(layer);
  return { ok: true };
}

async function saveAs(app, engine, arg) {
  const d = app.doc;
  if (!d) return false;
  if (!arg?.path) return app.docs.saveAs(d);
  if (engine.batch?.overrideSave) return (await engine.batch.overrideSave(d, arg)) ? { ok: true } : { ok: false, message: `${String(arg.path).split(/[\\/]/).pop()} could not be saved` };
  const ext = extOf(arg.path);
  if (arg.quality && ['jpg', 'jpeg', 'webp'].includes(ext)) d.saveOpts = { format: ext, quality: arg.quality };
  const ok = await app.docs.writeTo(d, arg.path);
  if (ok) {
    d.path = arg.path;
    d.name = baseName(arg.path);
    d.format = ext;
    d.flattenOk = !isLayeredPath(arg.path);
    app.docs.renderTabs();
    app.syncUiState();
  }
  return ok ? { ok: true } : { ok: false, message: `${String(arg.path).split(/[\\/]/).pop()} could not be saved` };
}

/** Function keys that built-in shortcuts already use, for the note in Action Options. */
function builtinKeyOwner(fk) {
  const n = M.normalizeFunctionKey(fk);
  if (!n) return null;
  const same = (accel) => {
    try {
      const d = parseAccelerator(accel);
      return String(d.key).toUpperCase() === n.key && !!d.shift === n.shift && !!(d.ctrl || d.cmdOrCtrl || d.meta) === n.ctrl && !d.alt;
    } catch {
      return false;
    }
  };
  for (const [cmd, accel] of Object.entries(MENU_KEYS)) if (same(accel)) return M.commandLabel(cmd, undefined, COMMAND_LABELS[cmd]);
  for (const [cmd, accels] of Object.entries(RENDERER_KEYS)) if (accels.some(same)) return M.commandLabel(cmd, undefined, COMMAND_LABELS[cmd]);
  return null;
}

export function install(app) {
  const engine = new ActionsEngine(app);
  app.actions = engine;
  engine.wrapCommands();
  app.on('transform:committed', (t) => engine.onTransformCommitted(t));
  app.on('history:changed', (d) => engine.onHistoryChanged(d));
  app.on('color:changed', (c) => engine.onColorChanged(c ?? {}));
  app.on('layer:activated', (e) => engine.onLayerActivated(e));
  app.on('doc:opened', (d) => {
    engine.recording?.lastSelection.set(d, currentSelection(d));
    engine.noteLayers(d);
  });
  app.on('doc:closed', () => {
    // marks hold documents: drop those of closed ones so Undo tracking never touches a dead history
    const rec = engine.recording;
    if (rec) for (const [id, mark] of rec.marks) if (!app.docs.docs.includes(mark.doc)) rec.marks.delete(id);
  });

  const hasAction = () => !!engine.selectedAction;
  const idle = () => !engine.playing;
  const target = () => engine.selectedStep ?? engine.selectedAction ?? engine.selectedSet;

  async function newActionCommand(arg, ctx) {
    let o = arg && typeof arg === 'object' ? arg : null;
    if (!o) {
      if (!engine.sets.length) engine.newSet('Set 1');
      const set = engine.selectedSet ?? engine.sets[0];
      o = await D.actionDialog(app, {
        title: 'New Action',
        okLabel: 'Record',
        name: M.uniqueName('Action 1', set.actions.map((a) => a.name)),
        sets: engine.sets,
        setId: set.id,
        keyOwner: (fk) => M.functionKeyOwner(engine.sets, fk)?.name ?? null,
        builtinFor: builtinKeyOwner,
        mac: isMac,
      });
      if (!o) return ctx?.cancel();
      o.record = true;
    }
    const action = engine.newAction(o);
    if (o.record) engine.record(action);
    return action.id;
  }

  async function actionOptionsCommand() {
    const action = engine.selectedAction;
    if (!action) return engine.needAction();
    const o = await D.actionDialog(app, {
      title: 'Action Options',
      name: action.name,
      functionKey: action.functionKey ?? null,
      color: action.color ?? 'none',
      keyOwner: (fk) => M.functionKeyOwner(engine.sets, fk, action)?.name ?? null,
      builtinFor: builtinKeyOwner,
      mac: isMac,
    });
    if (o) engine.setActionOptions(action, o);
  }

  async function editStepCommand(id) {
    const found = M.findStep(engine.sets, typeof id === 'string' ? id : engine.selection.step);
    if (!found) return;
    const { step, set } = found;
    if (step.stop) {
      const stop = await D.stopStepDialog(app, step.stop);
      if (stop) step.stop = stop;
    } else if (step.conditional) {
      const c = await D.conditionalDialog(app, set, step.conditional);
      if (c) {
        step.conditional = c;
        step.label = `If ${M.conditionLabel(c.test)}`;
      }
    } else {
      const o = await D.stepArgDialog(app, step);
      if (!o) return;
      step.label = o.label;
      if (o.arg === undefined) delete step.arg;
      else step.arg = o.arg;
    }
    engine.changed('edit');
  }

  async function deleteCommand(arg) {
    const t = arg?.id ? (M.findStep(engine.sets, arg.id)?.step ?? M.findAction(engine.sets, arg.id)?.action ?? engine.sets.find((s) => s.id === arg.id)) : target();
    if (!t) return;
    const what = 'actions' in t ? `the set “${t.name}” and its ${t.actions.length} action${t.actions.length === 1 ? '' : 's'}` : 'steps' in t ? `the action “${t.name}”` : null;
    // steps go without a question (they are quick to record again), as in Photoshop with Alt held
    if (what && !arg?.force && !(await app.dialogs.confirm(`Delete ${what}?`, { title: 'Actions', okLabel: 'Delete', danger: true }))) return;
    engine.delete(t);
  }

  app.commands.registerAll({
    'actions:record': { label: 'Start Recording', enabled: () => idle() && !engine.recording, run: () => (engine.selectedAction ? engine.record() : app.commands.run('actions:new-action', undefined, 'api')) },
    'actions:stop': { label: 'Stop Playing/Recording', enabled: () => !!engine.recording || !!engine.playing, run: () => engine.stop() },
    'actions:play': {
      label: 'Play',
      enabled: idle,
      run: async (arg, ctx) => {
        const found = engine.resolve(arg && typeof arg === 'object' && !arg.steps ? (arg.id ? { id: arg.id } : arg.action ? arg : null) : arg);
        if (!found) {
          ctx?.cancel();
          app.dialogs.toast(arg ? 'The action was not found' : 'Select an action to play', { kind: 'error' });
          return { ok: false, reason: 'missing' };
        }
        if (engine.recording?.action === found.action) {
          // an action cannot play (or record a step that plays) itself
          ctx?.cancel();
          app.dialogs.toast('Stop recording before playing this action', { kind: 'error' });
          return { ok: false, reason: 'recording' };
        }
        // recorded (while another action is being recorded) by names, so the step survives saving and loading
        ctx?.setReplayArg({ set: found.set?.name ?? null, action: found.action.name });
        const from = arg?.from ?? (!arg && engine.selectedStep && found.action.steps.includes(engine.selectedStep) ? engine.selectedStep.id : 0);
        return engine.play(found.action, { from });
      },
    },
    'actions:play-step': { label: 'Play Step', enabled: () => idle() && !!engine.selectedStep, run: async () => {
      const f = M.findStep(engine.sets, engine.selection.step);
      if (!f) return;
      const r = await engine.playStep(f.step, { set: f.set, action: f.action, quiet: false, depth: 0 });
      if (!r.ok && r.message && r.reason !== 'cancelled') app.dialogs.toast(r.message, { kind: 'error' });
      return r;
    } },
    'actions:new-set': {
      label: 'New Set…',
      run: async (arg) => {
        const name = typeof arg === 'string' ? arg : arg?.name ?? (await app.dialogs.prompt('Name', { title: 'New Set', value: M.uniqueName('Set 1', engine.sets.map((s) => s.name)), okLabel: 'Create' }));
        if (!name) return null;
        return engine.newSet(name).id;
      },
    },
    'actions:new-action': { label: 'New Action…', enabled: idle, run: newActionCommand },
    'actions:delete': { label: 'Delete', enabled: () => idle() && !!target(), run: deleteCommand },
    'actions:duplicate': { label: 'Duplicate', enabled: () => idle() && !!target(), run: () => engine.duplicate(target())?.id },
    'actions:rename': {
      label: 'Rename…',
      enabled: () => !!(engine.selectedAction ?? engine.selectedSet),
      run: async (arg) => {
        const t = engine.selectedStep && arg?.step ? engine.selectedStep : engine.selectedAction ?? engine.selectedSet;
        if (!t) return;
        const name = arg?.name ?? (await app.dialogs.prompt('Name', { title: 'actions' in t ? 'Set Options' : 'Rename Action', value: t.name ?? t.label }));
        if (name) engine.rename(t, name);
      },
    },
    'actions:insert-stop': { label: 'Insert Stop…', enabled: () => idle() && hasAction(), run: (arg) => engine.insertStop(arg).then((s) => s?.id) },
    'actions:insert-menu-item': { label: 'Insert Menu Item…', enabled: () => idle() && hasAction(), run: (arg) => engine.insertMenuItem(arg).then((s) => s?.id) },
    'actions:insert-conditional': { label: 'Insert Conditional…', enabled: () => idle() && hasAction(), run: (arg) => engine.insertConditional(arg).then((s) => s?.id) },
    'actions:edit-step': { label: 'Edit Step…', enabled: () => idle() && !!engine.selectedStep, run: editStepCommand },
    'actions:toggle-step': {
      label: 'Toggle Step',
      run: (id) => {
        const f = M.findStep(engine.sets, id ?? engine.selection.step);
        if (!f) return;
        f.step.enabled = !f.step.enabled;
        engine.changed('toggle');
      },
    },
    'actions:toggle-dialog': {
      label: 'Toggle Dialog',
      run: (id) => {
        const f = M.findStep(engine.sets, id ?? engine.selection.step);
        if (!f || f.step.menuItem || !f.step.command) return;
        f.step.dialog = !f.step.dialog;
        engine.changed('toggle');
      },
    },
    'actions:playback-options': {
      label: 'Playback Options…',
      run: async (arg) => {
        const o = arg && typeof arg === 'object' ? { ...engine.playback, ...arg } : await D.playbackDialog(app, engine.playback);
        if (!o || !M.PLAYBACK_MODES.includes(o.mode)) return;
        engine.playback = { mode: o.mode, pauseSeconds: Math.max(0.1, Math.min(60, Number(o.pauseSeconds) || 1)) };
        engine.changed('options');
      },
    },
    'actions:action-options': { label: 'Action Options…', enabled: () => idle() && hasAction(), run: actionOptionsCommand },
    'actions:button-mode': {
      label: 'Button Mode',
      checked: () => engine.buttonMode,
      run: (arg) => {
        if (engine.recording) engine.stopRecording();
        engine.buttonMode = typeof arg === 'boolean' ? arg : !engine.buttonMode;
        engine.changed('mode');
      },
    },
    'actions:load': { label: 'Load Actions…', enabled: idle, run: (path) => engine.loadFile(path).then((s) => !!s) },
    'actions:save': { label: 'Save Actions…', enabled: () => !!engine.selectedSet, run: (path) => engine.saveFile(engine.selectedSet, path) },
    'actions:reset': {
      label: 'Reset Actions',
      enabled: idle,
      run: async (arg) => {
        if (!arg?.force && !(await app.dialogs.confirm('Replace the current actions with the default actions?', { title: 'Reset Actions', okLabel: 'Reset', detail: 'Sets you recorded are removed. Save them first with Save Actions… to keep them.' }))) return false;
        engine.reset();
        return true;
      },
    },
    'actions:clear': {
      label: 'Clear All Actions',
      enabled: () => idle() && engine.sets.length > 0,
      run: async (arg) => {
        if (!arg?.force && !(await app.dialogs.confirm('Delete all actions?', { title: 'Clear All Actions', okLabel: 'Delete', danger: true, detail: 'Reset Actions brings the default actions back.' }))) return false;
        engine.clearAll();
        return true;
      },
    },

    // steps recorded in place of commands whose own form cannot replay (see substitute / onTransformCommitted)
    'actions:transform': { label: 'Free Transform', enabled: () => !!app.transformTool?.canStart(), run: (arg) => applyTransform(app, arg) },
    'actions:select-layer': { label: 'Select Layer', enabled: () => !!app.doc, run: (arg) => selectLayerByName(app, arg) },
    'actions:save-as': { label: 'Save As', enabled: () => !!app.doc, run: (arg) => saveAs(app, engine, arg) },
    'actions:set-selection': {
      label: 'Set Selection',
      enabled: () => !!app.doc,
      run: (arg) => {
        const d = app.doc;
        const mask = selectionMask(arg, d.width, d.height);
        const sel = mask ? Selection.fromMask(d.width, d.height, mask) : null;
        app.applySelection(sel && !sel.isEmpty ? sel : null, 'replace', sel ? 'Set selection' : 'Deselect');
      },
    },
  });

  // function keys: before the shortcut table sees the key, never while typing or in a dialog
  window.addEventListener(
    'keydown',
    (event) => {
      if (!/^F\d{1,2}$/.test(event.key) || event.repeat || event.defaultPrevented) return;
      const el = event.target;
      const typing = !!el && ((el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'range'].includes(el.type)) || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (typing || app.dialogs.isOpen || engine.recording) return;
      const hit = M.actionForKey(engine.sets, event, isMac);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      if (!engine.playing) app.commands.run('actions:play', { id: hit.action.id }, 'key');
    },
    true,
  );
}
