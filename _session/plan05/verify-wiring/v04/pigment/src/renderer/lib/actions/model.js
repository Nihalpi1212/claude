// Actions: the pure part (no DOM, no app): the shape of sets / actions / steps, the rules that decide
// what a finished command records, conditional tests, the JSON file format and function keys.
// lib/actions.js (the engine) and lib/panels/actions.js (the panel) build on this; Node unit tests
// (tests/unit/actions.test.mjs) import it directly.

export const FILE_FORMAT = 'pigment-actions';
export const FILE_VERSION = 1;
export const FILE_EXTENSION = 'pigment-actions';

/** Function keys an action may be bound to (F1 is Help, as in Photoshop). */
export const FUNCTION_KEYS = ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];

/** Button-mode colours (Photoshop's list). */
export const ACTION_COLORS = [
  ['none', 'None', null], ['red', 'Red', '#e5484d'], ['orange', 'Orange', '#f08c2e'], ['yellow', 'Yellow', '#e6c229'], ['green', 'Green', '#46a758'],
  ['blue', 'Blue', '#3b82f6'], ['violet', 'Violet', '#8e4ec6'], ['gray', 'Gray', '#8b8d98'],
];
export const colorOf = (id) => ACTION_COLORS.find((c) => c[0] === id)?.[2] ?? null;

export const PLAYBACK_MODES = ['accelerated', 'step', 'pause'];
export const DEFAULT_PLAYBACK = Object.freeze({ mode: 'accelerated', pauseSeconds: 1 });

let counter = 0;
/** Ids only have to be unique inside one settings object; time + counter survives reloads. */
export const newId = (prefix = 'a') => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

// ---- recording rules ----------------------------------------------------------------------------------------

/** Command groups that never change an image: viewing, panels, help, tool switching, the actions' own commands. */
const IGNORED_GROUPS = /^(view|window|help|tool|app|actions):/;
/**
 * ...except these, which Photoshop records too (guides, the colour swatches), and the engine's own step
 * commands: playing another action, and the replayable forms recorded in place of Save As, a layer
 * picked by id, a tool-made selection and Free Transform.
 */
const RECORDED_ANYWAY = new Set([
  'view:new-guide', 'view:clear-guides', 'tool:fg-color', 'tool:bg-color', 'tool:swap-colors', 'tool:default-colors',
  'actions:play', 'actions:save-as', 'actions:select-layer', 'actions:set-selection', 'actions:transform', 'actions:make-layer',
]);
/** Commands outside those groups that are about the application, not the image. */
const IGNORED_COMMANDS = new Set([
  'edit:undo', 'edit:redo', 'edit:step-backward', 'edit:step-forward', 'edit:preferences', 'edit:purge',
  'file:print', 'file:quit', 'file:reveal', 'file:clear-recent', 'file:open-recent', 'file:properties',
  'ai:accounts', 'ai:describe', 'select:find-layers', 'layer:edit-text', 'file:automate-batch', 'file:script-image-processor',
]);
/**
 * Commands that only open an on-canvas session (Free Transform, the warps): what the session finally
 * does is recorded when it commits (the engine listens to 'transform:committed'), never the opening.
 */
const SESSION_COMMANDS = /^(edit:free-transform|edit:transform-(scale|rotate|skew|distort|perspective|warp)|edit:perspective-warp|edit:puppet-warp|select:transform|select:quick-mask)$/;
const SESSION_TRANSFORM_KINDS = new Set(['free', 'scale', 'rotate', 'skew', 'distort', 'perspective', 'warp']);

/**
 * Commands that cannot replay: they work on one particular layer or smart filter by id (a drag in the
 * Layers panel, editing an adjustment or fill layer in place), or their dialog does not report what it did
 * (Fade lives in lib/adjust-ui.js and has no replay argument yet). Recording says so instead of storing a
 * step that would do nothing, or ask again, on another document.
 */
const UNREPLAYABLE = new Set(['layer:move-to', 'layer:smart-filter', 'layer:smart-edit', 'layer:edit-adjustment', 'layer:edit-fill', 'edit:fade']);
export const isUnreplayableCommand = (id) => UNREPLAYABLE.has(id);

/**
 * True when actions never record (or run) the command. A definition (optional: the lists below decide alone without
 * one) may say so itself (0.4, E31): `record: false` never, `record: true` always, `undoLike` never (it is followed
 * like Edit > Undo), `changesDocument` always (a view: command that edits the document, as the guide commands).
 */
export function isIgnoredCommand(id, def = null) {
  if (def) {
    if (def.record === false) return true;
    if (def.record === true) return false;
    if (def.undoLike) return true;
    if (def.changesDocument) return false;
  }
  if (RECORDED_ANYWAY.has(id)) return false;
  return IGNORED_GROUPS.test(id) || IGNORED_COMMANDS.has(id);
}

export function isSessionCommand(id, arg) {
  if (SESSION_COMMANDS.test(id)) return true;
  return id === 'edit:transform' && (arg === undefined || arg === null || SESSION_TRANSFORM_KINDS.has(arg));
}

/** True when a value survives JSON (what a step's arg must do to live in settings and action files). */
export function isPlainData(value, depth = 0) {
  if (value === undefined || value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object' || depth > 24) return false;
  if (Array.isArray(value)) return value.every((v) => isPlainData(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((v) => isPlainData(v, depth + 1));
}

/**
 * Keys no step argument needs and no command may receive: JSON.parse makes "__proto__" an own property, and a
 * command that copies its argument onto live state (Object.assign) would swap that object's prototype with it.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const dropUnsafeKeys = (key, value) => (UNSAFE_KEYS.has(key) ? undefined : value);

/** Deep copy of plain data, without the keys above (a step argument from a file, the settings or the JSON editor). */
export const cloneData = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value), dropUnsafeKeys));

/** Largest serialised argument a step may carry: actions live in the settings file ("a few KB"). */
export const MAX_ARG_BYTES = 256 * 1024;
/**
 * Limits of stored and imported actions. The whole panel is written into the settings on every change, and the
 * panel draws every step: an action file must not be able to make either of them unusable.
 */
export const MAX_NAME_LENGTH = 200; // set and action names, step labels, command ids
export const MAX_MESSAGE_LENGTH = 2000; // the text of a Stop step
export const MAX_ITEMS = 5000; // sets + actions + steps in the panel
export const MAX_SETS_BYTES = 1024 * 1024; // all sets, serialised
export const MAX_FILE_BYTES = 4 * MAX_SETS_BYTES; // an actions file as read (serializeSets keeps what it writes below)

/** Why these sets are more than the panel holds (the end of a sentence), or null when they fit. */
export function limitError(sets) {
  let items = 0;
  for (const set of sets ?? []) {
    items += 1 + (set.actions?.length ?? 0);
    for (const action of set.actions ?? []) items += action.steps?.length ?? 0;
  }
  if (items > MAX_ITEMS) return `more than ${MAX_ITEMS} actions and steps`;
  if (JSON.stringify(sets ?? []).length > MAX_SETS_BYTES) return `more than ${MAX_SETS_BYTES / 1024 / 1024} MB of actions`;
  return null;
}

/**
 * Decides what a finished command (a 'command:done' event) adds to the action being recorded.
 * @param {{ id: string, arg: any, source: string, cancelled: boolean, replayable: boolean, nested?: boolean }} event
 * @returns {{ record: true, step: object } | { record: false, reason: 'cancelled'|'playback'|'nested'|'ignored'|'session'|'unreplayable'|'data', label?: string }}
 */
export function recordDecision(event, { label, def = null } = {}) {
  const { id, arg } = event;
  if (event.cancelled) return { record: false, reason: 'cancelled' };
  if (event.source === 'action') return { record: false, reason: 'playback' };
  if (event.nested) return { record: false, reason: 'nested' };
  if (isIgnoredCommand(id, def)) return { record: false, reason: 'ignored' };
  if (isSessionCommand(id, arg)) return { record: false, reason: 'session' };
  const name = label ?? commandLabel(id, arg);
  if (event.replayable === false || UNREPLAYABLE.has(id)) return { record: false, reason: 'unreplayable', label: name };
  if (!isPlainData(arg)) return { record: false, reason: 'data', label: name };
  const copy = cloneData(arg);
  if (copy !== undefined && JSON.stringify(copy).length > MAX_ARG_BYTES) return { record: false, reason: 'data', label: name };
  return { record: true, step: makeStep(id, copy, name) };
}

export function makeStep(command, arg, label) {
  const step = { id: newId('s'), command, label: label ?? commandLabel(command, arg), enabled: true, dialog: false };
  if (arg !== undefined) step.arg = arg;
  return step;
}

/** Name of a Close step that carries the answer to "Save changes?" (recording and loading use it), else null. */
export function closeStepLabel(step) {
  // with its dialog toggle on the step asks instead, but the panel can turn that off again: named by the answer anyway
  if (step?.command !== 'file:close' || typeof step.arg?.save !== 'boolean') return null;
  return step.arg.save ? 'Close: save changes' : 'Close: don’t save';
}

export const makeStopStep = (message, allowContinue = false) => ({ id: newId('s'), command: null, label: 'Stop', enabled: true, dialog: false, stop: { message: String(message ?? ''), allowContinue: !!allowContinue } });

export const makeMenuItemStep = (command, label) => ({ id: newId('s'), command, label: label ?? commandLabel(command), enabled: true, dialog: true, menuItem: command });

export const makeConditionalStep = (test, thenAction, elseAction) => ({
  id: newId('s'), command: null, label: `If ${conditionLabel(test)}`, enabled: true, dialog: false,
  conditional: { test, thenAction: thenAction || null, elseAction: elseAction || null },
});

/** What playing a step means: 'stop' | 'conditional' | 'dialog' (run without arg, the dialog opens) | 'command'. */
export function stepKind(step) {
  if (step.stop) return 'stop';
  if (step.conditional) return 'conditional';
  if (step.menuItem || step.dialog) return 'dialog';
  return 'command';
}

/** Readable name of a command id when nothing better is known: 'layer:via-copy' -> 'Layer Via Copy'. */
export function humanizeCommand(id) {
  const words = String(id).replace(/^[a-z]+:/, '').replace(/^(adjust|automate|script|style)-/, '').replace(/[:_-]+/g, ' ').trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

const cleanLabel = (s) => String(s).replace(/…$/, '').replace(/\.\.\.$/, '').trim();

/**
 * Label of a recorded step. `known` is the command's own label (COMMAND_LABELS or def.label), a string
 * argument that picks a variant is appended ("Layer Mask: apply").
 */
export function commandLabel(id, arg, known) {
  let label = known ? cleanLabel(known) : humanizeCommand(id);
  if (typeof arg === 'string' && arg.length <= 40 && !/[\\/]/.test(arg)) label += `: ${arg.replace(/-/g, ' ')}`;
  else if (typeof arg === 'number') label += `: ${arg}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** One line describing a step's argument in the panel (the value for scalars, "key: value" pairs for objects). */
export function describeArg(arg, max = 64) {
  if (arg === undefined || arg === null) return '';
  let text;
  if (typeof arg !== 'object') text = String(arg);
  else if (Array.isArray(arg)) text = arg.length > 4 ? `${arg.length} items` : arg.map((v) => (typeof v === 'object' ? '…' : String(v))).join(', ');
  else {
    text = Object.entries(arg)
      .filter(([, v]) => v !== null && typeof v !== 'object')
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`)
      .join(', ');
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---- conditionals -------------------------------------------------------------------------------------------

/**
 * Insert Conditional tests. Each takes the plain document state the engine builds (documentState in
 * lib/actions.js): { open, width, height, mode, depth, layers, hasSelection, channels, layer: { type,
 * background, mask, visible, locked, styles, group, clip, empty } | null }.
 */
export const CONDITIONS = {
  'document-is-open': { label: 'Document Is Open', test: (s) => !!s.open },
  'document-is-landscape': { label: 'Document Is Landscape', test: (s) => !!s.open && s.width > s.height },
  'document-is-portrait': { label: 'Document Is Portrait', test: (s) => !!s.open && s.height > s.width },
  'document-is-square': { label: 'Document Is Square', test: (s) => !!s.open && s.width === s.height },
  'document-mode-is-rgb': { label: 'Document Mode Is RGB', test: (s) => !!s.open && (s.mode ?? 'rgb') === 'rgb' },
  'document-mode-is-cmyk': { label: 'Document Mode Is CMYK', test: (s) => !!s.open && s.mode === 'cmyk' },
  'document-mode-is-grayscale': { label: 'Document Mode Is Grayscale', test: (s) => !!s.open && s.mode === 'grayscale' },
  'document-depth-is-8': { label: 'Document Depth Is 8 Bits/Channel', test: (s) => !!s.open && (s.depth ?? 8) === 8 },
  'document-has-layers': { label: 'Document Has Layers', test: (s) => !!s.open && (s.layers ?? 0) > 1 },
  'document-has-alpha-channels': { label: 'Document Has Alpha Channels', test: (s) => !!s.open && (s.channels ?? 0) > 0 },
  'selection-exists': { label: 'Document Has A Selection', test: (s) => !!s.open && !!s.hasSelection },
  'layer-is-background': { label: 'Layer Is Background', test: (s) => !!s.layer?.background },
  'layer-is-pixel': { label: 'Layer Is Pixel Layer', test: (s) => s.layer?.type === 'raster' },
  'layer-is-adjustment': { label: 'Layer Is Adjustment Layer', test: (s) => s.layer?.type === 'adjustment' },
  'layer-is-shape': { label: 'Layer Is Shape Layer', test: (s) => s.layer?.type === 'shape' },
  'layer-is-text': { label: 'Layer Is Type Layer', test: (s) => s.layer?.type === 'text' },
  'layer-is-smart': { label: 'Layer Is Smart Object', test: (s) => s.layer?.type === 'smart' },
  'layer-is-group': { label: 'Layer Is Layer Group', test: (s) => !!s.layer?.group },
  'layer-is-locked': { label: 'Layer Is Locked', test: (s) => !!s.layer?.locked },
  'layer-is-visible': { label: 'Layer Is Visible', test: (s) => !!s.layer?.visible },
  'layer-has-mask': { label: 'Layer Has Pixel Mask', test: (s) => !!s.layer?.mask },
  'layer-has-effects': { label: 'Layer Has Effects', test: (s) => !!s.layer?.styles },
  'layer-is-empty': { label: 'Layer Is Empty', test: (s) => !!s.layer?.empty },
};
export const CONDITION_IDS = Object.keys(CONDITIONS);
export const conditionLabel = (id) => CONDITIONS[id]?.label ?? String(id);

/** Unknown tests are false (an action file from a newer version must not run the wrong branch as "true"). */
export function evaluateCondition(test, state) {
  const def = CONDITIONS[test];
  if (!def) return false;
  try {
    return !!def.test(state ?? {});
  } catch {
    return false;
  }
}

/** The action a conditional step plays for a document state, or null (None). */
export function conditionalBranch(conditional, state) {
  return (evaluateCondition(conditional?.test, state) ? conditional?.thenAction : conditional?.elseAction) || null;
}

// ---- function keys ------------------------------------------------------------------------------------------

export function normalizeFunctionKey(fk) {
  if (!fk || typeof fk !== 'object') return null;
  const key = String(fk.key ?? '').toUpperCase();
  if (!FUNCTION_KEYS.includes(key)) return null;
  return { key, shift: !!fk.shift, ctrl: !!fk.ctrl };
}

export function functionKeyLabel(fk, mac = false) {
  const n = normalizeFunctionKey(fk);
  if (!n) return '';
  return `${n.shift ? (mac ? '⇧' : 'Shift+') : ''}${n.ctrl ? (mac ? '⌘' : 'Ctrl+') : ''}${n.key}`;
}

const sameKey = (a, b) => !!a && !!b && a.key === b.key && a.shift === b.shift && a.ctrl === b.ctrl;

/** Does a keydown event press this function key? Ctrl means Cmd on macOS; Alt never matches. */
export function matchesFunctionKey(event, fk, mac = false) {
  const n = normalizeFunctionKey(fk);
  if (!n || event.altKey) return false;
  const ctrl = mac ? !!event.metaKey : !!event.ctrlKey;
  if (mac ? !!event.ctrlKey : !!event.metaKey) return false;
  return String(event.key).toUpperCase() === n.key && !!event.shiftKey === n.shift && ctrl === n.ctrl;
}

/** The action bound to a function key (first match in panel order), or null. */
export function actionForKey(sets, event, mac = false) {
  for (const set of sets ?? []) for (const action of set.actions ?? []) if (matchesFunctionKey(event, action.functionKey, mac)) return { set, action };
  return null;
}

/** The other action that already uses a function key, or null. */
export function functionKeyOwner(sets, fk, except = null) {
  const n = normalizeFunctionKey(fk);
  if (!n) return null;
  for (const set of sets ?? []) for (const action of set.actions ?? []) if (action !== except && action.id !== except?.id && sameKey(normalizeFunctionKey(action.functionKey), n)) return action;
  return null;
}

// ---- sets, actions, files -----------------------------------------------------------------------------------

export const makeSet = (name, actions = []) => ({ id: newId('set'), name: String(name || 'Set'), actions });
export const makeAction = (name, steps = [], extra = {}) => ({ id: newId('act'), name: String(name || 'Action'), steps, ...extra });

const clip = (text, max = MAX_NAME_LENGTH) => {
  const s = String(text);
  return s.length > max ? s.slice(0, max) : s;
};
const commandId = (value) => (typeof value === 'string' && value && value.length <= MAX_NAME_LENGTH ? value : null);

/**
 * `report` counts what was left out: `refused` steps run a command that recording never records (Purge, Quit,
 * Undo, Preferences, the panels…: an action only does what a user could have recorded), `oversized` steps carry
 * an argument above MAX_ARG_BYTES.
 */
function normalizeStep(raw, report = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const step = { id: typeof raw.id === 'string' && raw.id ? clip(raw.id) : newId('s'), command: commandId(raw.command), label: '', enabled: raw.enabled !== false, dialog: !!raw.dialog };
  if (raw.stop && typeof raw.stop === 'object') step.stop = { message: clip(raw.stop.message ?? '', MAX_MESSAGE_LENGTH), allowContinue: !!raw.stop.allowContinue };
  else if (raw.conditional && typeof raw.conditional === 'object') {
    step.conditional = { test: clip(raw.conditional.test ?? ''), thenAction: raw.conditional.thenAction ? clip(raw.conditional.thenAction) : null, elseAction: raw.conditional.elseAction ? clip(raw.conditional.elseAction) : null };
  } else if (!step.command) return null; // a step that does nothing is dropped
  if (commandId(raw.menuItem)) {
    step.menuItem = raw.menuItem;
    step.command = raw.menuItem;
    step.dialog = true;
  }
  if (step.command && isIgnoredCommand(step.command)) {
    report.refused = (report.refused ?? 0) + 1;
    return null;
  }
  if (raw.arg !== undefined && raw.arg !== null && isPlainData(raw.arg)) {
    const arg = cloneData(raw.arg);
    if (JSON.stringify(arg).length > MAX_ARG_BYTES) {
      report.oversized = (report.oversized ?? 0) + 1;
      return null;
    }
    step.arg = arg;
  }
  // optional: skipped without a question when its command is not available (Rasterize on a pixel layer)
  if (raw.optional && step.command) step.optional = true;
  step.label = typeof raw.label === 'string' && raw.label ? clip(raw.label) : step.stop ? 'Stop' : step.conditional ? `If ${conditionLabel(step.conditional.test)}` : commandLabel(step.command, step.arg);
  // a Close step that answers "Save changes?" by itself is always named by its answer, whatever a file calls it:
  // "Don't save" drops the document's changes unasked, and the panel must not show that step as "Sharpen"
  const closeLabel = closeStepLabel(step);
  if (closeLabel) step.label = closeLabel;
  return step;
}

function normalizeAction(raw, report) {
  if (!raw || typeof raw !== 'object') return null;
  const action = { id: typeof raw.id === 'string' && raw.id ? clip(raw.id) : newId('act'), name: clip(raw.name || 'Action'), steps: (Array.isArray(raw.steps) ? raw.steps : []).map((s) => normalizeStep(s, report)).filter(Boolean) };
  const fk = normalizeFunctionKey(raw.functionKey);
  if (fk) action.functionKey = fk;
  if (typeof raw.color === 'string' && colorOf(raw.color)) action.color = raw.color;
  if (raw.collapsed) action.collapsed = true;
  return action;
}

/** Cleans stored or imported sets: every set, action and step gets an id, a name / label and only known fields. */
export function normalizeSets(raw, report = {}) {
  const seen = new Set();
  const unique = (obj) => {
    if (seen.has(obj.id)) obj.id = newId('n');
    seen.add(obj.id);
    return obj;
  };
  const out = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s !== 'object') continue;
    const set = unique({ id: typeof s.id === 'string' && s.id ? clip(s.id) : newId('set'), name: clip(s.name || 'Set'), actions: (Array.isArray(s.actions) ? s.actions : []).map((a) => normalizeAction(a, report)).filter(Boolean) });
    if (s.collapsed) set.collapsed = true;
    if (s.builtin) set.builtin = true;
    for (const a of set.actions) {
      unique(a);
      a.steps.forEach(unique);
    }
    out.push(set);
  }
  return out;
}

/** Text of a *.pigment-actions file. */
export function serializeSets(sets) {
  const clean = normalizeSets(sets).map((set) => ({
    name: set.name,
    actions: set.actions.map((a) => ({
      name: a.name,
      ...(a.functionKey ? { functionKey: a.functionKey } : {}),
      ...(a.color ? { color: a.color } : {}),
      steps: a.steps.map((s) => {
        const o = { label: s.label };
        if (s.command) o.command = s.command;
        if (s.arg !== undefined) o.arg = s.arg;
        if (!s.enabled) o.enabled = false;
        if (s.dialog && !s.menuItem) o.dialog = true;
        if (s.stop) o.stop = s.stop;
        if (s.conditional) o.conditional = s.conditional;
        if (s.menuItem) o.menuItem = s.menuItem;
        if (s.optional) o.optional = true;
        return o;
      }),
    })),
  }));
  const data = { format: FILE_FORMAT, version: FILE_VERSION, sets: clean };
  // indented for people who read it, unless that takes the file past what Load Actions accepts: a recorded
  // selection's runs take one indented line per number, many times their compact size. Written compact, sets
  // within the panel's limits (MAX_SETS_BYTES, measured compact) always load again
  const text = JSON.stringify(data, null, 2);
  return new TextEncoder().encode(text).length <= MAX_FILE_BYTES ? text : JSON.stringify(data);
}

/** Photoshop .atn files start with a 4-byte version (16) and a set name in UTF-16: recognised only to say why they fail. */
export function looksLikeAtn(bytes) {
  return !!bytes && bytes.length > 8 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0x10;
}

/**
 * Parses a *.pigment-actions file (text or bytes). Throws an Error with a readable message for anything
 * else; ids are regenerated so loading a file twice gives two independent copies. Files above the limits
 * (MAX_FILE_BYTES, MAX_ITEMS, MAX_SETS_BYTES, a step argument above MAX_ARG_BYTES) are refused; `report.refused`
 * counts the steps that were left out because actions may not run their command (see normalizeStep).
 */
export function parseActionsFile(input, report = {}) {
  let text = input;
  if ((input?.length ?? 0) > MAX_FILE_BYTES) throw new Error(`This actions file is too large (${(input.length / 1024 / 1024).toFixed(1)} MB; action files hold at most ${MAX_FILE_BYTES / 1024 / 1024} MB).`);
  if (typeof input !== 'string') {
    if (looksLikeAtn(input)) throw new Error('Photoshop .atn action files cannot be read. Pigment loads its own .pigment-actions files (JSON).');
    text = new TextDecoder('utf-8', { fatal: false }).decode(input);
  }
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch {
    throw new Error('This is not a Pigment actions file (it is not valid JSON).');
  }
  if (!data || typeof data !== 'object' || data.format !== FILE_FORMAT || !Array.isArray(data.sets)) throw new Error('This is not a Pigment actions file.');
  if (Number(data.version) > FILE_VERSION) throw new Error(`This actions file was written by a newer version of Pigment (format ${data.version}).`);
  const strip = (sets) => sets.map((s) => ({ ...s, id: undefined, actions: (Array.isArray(s?.actions) ? s.actions : []).map((a) => ({ ...a, id: undefined, steps: (Array.isArray(a?.steps) ? a.steps : []).map((st) => ({ ...st, id: undefined })) })) }));
  const sets = normalizeSets(strip(data.sets.filter((s) => s && typeof s === 'object')), report);
  if (!sets.length) throw new Error('The actions file holds no action sets.');
  // a file is loaded whole or not at all: an action that lost its largest steps would do something else
  if (report.oversized) throw new Error(`The actions file cannot be loaded: ${report.oversized === 1 ? 'a step carries' : `${report.oversized} steps carry`} more than ${MAX_ARG_BYTES / 1024} KB of settings.`);
  const over = limitError(sets);
  if (over) throw new Error(`The actions file cannot be loaded: it holds ${over}.`);
  return sets;
}

/** "Name", "Name 2", "Name 3"… not in `taken`. */
export function uniqueName(base, taken) {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  const m = /^(.*?)(?: (\d+))?$/.exec(base);
  let n = Number(m[2] ?? 1) + 1;
  while (names.has(`${m[1]} ${n}`)) n++;
  return `${m[1]} ${n}`;
}

export function findAction(sets, id) {
  for (const set of sets ?? []) for (const action of set.actions) if (action.id === id) return { set, action };
  return null;
}

/** The action a conditional names: the same set first (Photoshop's rule), then any set. */
export function findActionByName(sets, name, preferSet = null) {
  if (!name) return null;
  const inSet = preferSet?.actions.find((a) => a.name === name);
  if (inSet) return { set: preferSet, action: inSet };
  for (const set of sets ?? []) {
    const action = set.actions.find((a) => a.name === name);
    if (action) return { set, action };
  }
  return null;
}

export function findStep(sets, id) {
  for (const set of sets ?? []) for (const action of set.actions) {
    const index = action.steps.findIndex((s) => s.id === id);
    if (index >= 0) return { set, action, step: action.steps[index], index };
  }
  return null;
}

/** Deep copy with fresh ids (Duplicate). */
export function duplicateAction(action, name) {
  const copy = cloneData(action);
  copy.id = newId('act');
  copy.name = name ?? `${action.name} copy`;
  delete copy.functionKey; // a key plays one action
  for (const s of copy.steps) s.id = newId('s');
  return copy;
}

export function duplicateSet(set, name) {
  const copy = cloneData(set);
  copy.id = newId('set');
  copy.name = name ?? `${set.name} copy`;
  delete copy.builtin;
  copy.actions = set.actions.map((a) => duplicateAction(a, a.name));
  return copy;
}
