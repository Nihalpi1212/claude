// Actions: the small dialogs of the engine (Insert Stop / Menu Item / Conditional, Playback Options,
// Action Options, New Set, the JSON editor of a step's argument, the Stop message shown on playback).
// Every function resolves with plain values or null when cancelled; lib/actions.js applies them.
import { formDialog } from '../form.js';
import { ACTION_COLORS, FUNCTION_KEYS, CONDITIONS, functionKeyLabel, isPlainData, cloneData, MAX_ARG_BYTES, MAX_NAME_LENGTH } from './model.js';

const actionOptions = (set, none = 'None') => [['', none], ...(set?.actions ?? []).map((a) => [a.name, a.name])];

export async function stopStepDialog(app, stop = { message: '', allowContinue: false }) {
  const o = await formDialog(app, {
    title: 'Record Stop',
    intro: 'Playback pauses at this step and shows the message, for example to remind you to make a selection.',
    fields: [
      { key: 'message', label: 'Message', type: 'textarea', value: stop.message ?? '', rows: 4 },
      { key: 'allowContinue', label: 'Allow Continue', type: 'checkbox', value: !!stop.allowContinue, help: 'Adds a Continue button, so the action can go on without stopping.' },
    ],
    width: 420,
  });
  return o ? { message: String(o.message ?? '').trim(), allowContinue: !!o.allowContinue } : null;
}

/** The message of a Stop step during playback. Resolves true to continue, false to stop. */
export async function stopMessage(app, step, actionName) {
  const content = document.createElement('div');
  content.className = 'actions-stop-message';
  const p = document.createElement('p');
  p.className = 'dialog-message';
  p.textContent = step.stop?.message || 'The action stopped here.';
  content.appendChild(p);
  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.textContent = step.stop?.allowContinue ? 'Stop to work on the image (Play continues from the next step), or Continue.' : 'Press Play in the Actions panel to continue from the next step.';
  content.appendChild(hint);
  const buttons = step.stop?.allowContinue ? [{ label: 'Stop', value: false }, { label: 'Continue', value: true, primary: true }] : [{ label: 'Stop', value: false, primary: true }];
  const result = await app.dialogs.open({ title: actionName ? `Action “${actionName}”` : 'Message', content, width: 420, buttons, className: 'actions-stop-dialog' });
  return result === true;
}

/** "The command X is not currently available." Resolves true to continue with the next step. */
export async function unavailableDialog(app, label) {
  const result = await app.dialogs.open({
    title: 'Actions',
    content: Object.assign(document.createElement('p'), { className: 'dialog-message', textContent: `The command “${label}” is not currently available.` }),
    width: 420,
    buttons: [{ label: 'Stop', value: false }, { label: 'Continue', value: true, primary: true }],
  });
  return result === true;
}

export async function conditionalDialog(app, set, conditional = { test: 'document-is-landscape', thenAction: null, elseAction: null }) {
  const o = await formDialog(app, {
    title: 'Conditional Action',
    intro: 'Plays another action of this set depending on the document or the selected layer.',
    fields: [
      { key: 'test', label: 'If Current', type: 'select', value: conditional.test, options: Object.entries(CONDITIONS).map(([id, c]) => [id, c.label]) },
      { key: 'thenAction', label: 'Then Play Action', type: 'select', value: conditional.thenAction ?? '', options: actionOptions(set) },
      { key: 'elseAction', label: 'Else Play Action', type: 'select', value: conditional.elseAction ?? '', options: actionOptions(set) },
    ],
    width: 440,
    validate: (v) => {
      if (v.thenAction || v.elseAction) return true;
      app.dialogs.toast('Choose an action to play for at least one outcome', { kind: 'error' });
      return false;
    },
  });
  return o ? { test: o.test, thenAction: o.thenAction || null, elseAction: o.elseAction || null } : null;
}

/**
 * Insert Menu Item: a searchable list of every command that can be a step.
 * @param {{ id: string, label: string, group: string }[]} commands
 * @returns {Promise<string | null>} the command id
 */
export async function menuItemDialog(app, commands) {
  const content = document.createElement('div');
  content.className = 'actions-menu-item';
  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.textContent = 'The step runs the command the way the menu does: a command with a dialog shows it during playback, so you choose the settings each time.';
  const search = document.createElement('input');
  search.className = 'input';
  search.type = 'search';
  search.placeholder = 'Search commands';
  search.setAttribute('aria-label', 'Search commands');
  const list = document.createElement('select');
  list.className = 'select actions-command-list';
  list.size = 12;
  list.setAttribute('aria-label', 'Command');
  list.dataset.noEnter = '';
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const prev = list.value;
    list.replaceChildren();
    let group = null, og = null;
    for (const c of commands) {
      if (q && !`${c.group} ${c.label} ${c.id}`.toLowerCase().includes(q)) continue;
      if (c.group !== group) {
        group = c.group;
        og = document.createElement('optgroup');
        og.label = group;
        list.appendChild(og);
      }
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      opt.title = c.id;
      og.appendChild(opt);
    }
    if (prev && [...list.options].some((o) => o.value === prev)) list.value = prev;
    else if (list.options.length) list.selectedIndex = 0;
  };
  search.addEventListener('input', fill);
  fill();
  content.append(intro, search, list);
  const ok = await app.dialogs.open({
    title: 'Insert Menu Item',
    content,
    width: 440,
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: (dialog, close) => list.addEventListener('dblclick', () => list.value && close(true)),
    validate: () => {
      if (list.value) return true;
      app.dialogs.toast('Choose a command', { kind: 'error' });
      return false;
    },
  });
  return ok ? list.value : null;
}

export async function playbackDialog(app, options) {
  const o = await formDialog(app, {
    title: 'Playback Options',
    fields: [
      { key: 'mode', label: 'Performance', type: 'select', value: options.mode, options: [['accelerated', 'Accelerated'], ['step', 'Step by Step'], ['pause', 'Pause For']] },
      { key: 'pauseSeconds', label: 'Pause', type: 'number', value: options.pauseSeconds ?? 1, min: 0.1, max: 60, step: 0.1, unit: 'seconds', when: (v) => v.mode === 'pause' },
      { type: 'section', label: '' },
      { key: 'info', type: 'custom', render: () => Object.assign(document.createElement('span'), { className: 'muted', textContent: 'Accelerated plays at full speed. Step by Step redraws the image after every step. Pause For waits between steps.' }) },
    ],
    width: 400,
  });
  return o ? { mode: o.mode, pauseSeconds: Number(o.pauseSeconds) || 1 } : null;
}

/**
 * New Action / Action Options: name, set (new actions only), function key and colour.
 * keyOwner(fk) returns the name of another action that already uses a function key (or null);
 * builtinFor(fk) the name of a built-in shortcut on the same key (or null).
 */
export async function actionDialog(app, { title, okLabel = 'OK', name, sets = null, setId = null, functionKey = null, color = 'none', keyOwner, builtinFor, mac = false }) {
  const fields = [{ key: 'name', label: 'Name', type: 'text', value: name, autofocus: true }];
  if (sets) fields.push({ key: 'set', label: 'Set', type: 'select', value: setId ?? sets[0]?.id, options: sets.map((s) => [s.id, s.name]) });
  fields.push(
    { key: 'key', label: 'Function Key', type: 'select', value: functionKey?.key ?? '', options: [['', 'None'], ...FUNCTION_KEYS.map((k) => [k, k])] },
    { key: 'shift', label: 'Shift', type: 'checkbox', value: !!functionKey?.shift, disabled: (v) => !v.key },
    { key: 'ctrl', label: mac ? 'Command' : 'Control', type: 'checkbox', value: !!functionKey?.ctrl, disabled: (v) => !v.key },
    { key: 'color', label: 'Color', type: 'select', value: color ?? 'none', options: ACTION_COLORS.map((c) => [c[0], c[1]]) },
    { key: 'note', type: 'custom', render: () => note },
  );
  const note = document.createElement('span');
  note.className = 'muted actions-key-note';
  const fkOf = (v) => (v.key ? { key: v.key, shift: !!v.shift, ctrl: !!v.ctrl } : null);
  const updateNote = (v) => {
    const fk = fkOf(v);
    const owner = fk ? keyOwner?.(fk) : null;
    const builtin = fk ? builtinFor?.(fk) : null;
    note.textContent = owner ? `${functionKeyLabel(fk, mac)} already plays “${owner}”.` : builtin ? `${functionKeyLabel(fk, mac)} is also the shortcut of “${builtin}”; the action takes precedence.` : '';
  };
  updateNote({ key: functionKey?.key ?? '', shift: functionKey?.shift, ctrl: functionKey?.ctrl });
  const o = await formDialog(app, {
    title,
    okLabel,
    fields,
    width: 400,
    onChange: (v) => updateNote(v),
    validate: (v) => {
      if (!String(v.name ?? '').trim()) {
        app.dialogs.toast('Give the action a name', { kind: 'error' });
        return false;
      }
      const fk = fkOf(v);
      if (fk && keyOwner?.(fk)) {
        app.dialogs.toast(`${functionKeyLabel(fk, mac)} already plays “${keyOwner(fk)}”`, { kind: 'error' });
        return false;
      }
      return true;
    },
  });
  if (!o) return null;
  return { name: String(o.name).trim(), set: o.set ?? setId, functionKey: fkOf(o), color: o.color && o.color !== 'none' ? o.color : null };
}

/** Double-click on a step: its argument as JSON. Resolves { arg } (arg may be undefined) or null. */
export async function stepArgDialog(app, step) {
  const o = await formDialog(app, {
    title: `Step: ${step.label}`,
    intro: `Command ${step.command}. The argument is what the command runs with during playback; an empty box runs it the way the menu does.`,
    fields: [
      { key: 'label', label: 'Name', type: 'text', value: step.label },
      { key: 'json', label: 'Argument (JSON)', type: 'textarea', value: step.arg === undefined ? '' : JSON.stringify(step.arg, null, 2), rows: 10, className: 'actions-json' },
    ],
    width: 480,
    validate: (v) => {
      const text = String(v.json ?? '').trim();
      if (!text) return true;
      try {
        if (!isPlainData(JSON.parse(text))) throw new Error('not plain data');
        if (JSON.stringify(JSON.parse(text)).length > MAX_ARG_BYTES) throw new Error(`a step holds at most ${MAX_ARG_BYTES / 1024} KB`);
        return true;
      } catch (err) {
        app.dialogs.toast(`The argument is not valid JSON: ${err.message}`, { kind: 'error', timeout: 5000 });
        return false;
      }
    },
  });
  if (!o) return null;
  const text = String(o.json ?? '').trim();
  // cloneData: "__proto__" and "constructor" keys typed into the box never reach a command
  return { label: (String(o.label ?? '').trim() || step.label).slice(0, MAX_NAME_LENGTH), arg: text ? cloneData(JSON.parse(text)) : undefined };
}
