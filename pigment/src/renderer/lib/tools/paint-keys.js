// brush-painting-behaviours' MODULES entry (ARCHITECTURE.md "0.5 features", package 3; S3, S13.3–S13.4).
//
// The paint-context key commands (bound in keymap.js PAINT_KEYS; shortcuts.js tries them first while a painting tool
// is active, app.keymap.resolveKey maps the Shift+Alt keys main.js takes on Windows and Linux):
//   - tool:brush-prev / -next / -first / -last (, . Shift+, Shift+.): step through the Brushes presets;
//   - tool:opacity-digit-0 … -9 (digits) and tool:flow-digit-0 … -9 (Shift+digits): 1 → 10 %, … 0 → 100 %; two digits
//     within settings.painting.digitPairMs set the exact value (4 then 5: 45 %; 0 then 0: the least). With the airbrush
//     on the two swap (digits set the flow), as in Photoshop. Tools without an opacity set their own amount (Strength,
//     Exposure, the Sponge's Flow);
//   - tool:blend-mode-<mode> (Shift+Alt+letter): the tool's painting mode (Behind Q, Clear R); the Dodge and Burn
//     tools' Range (S Shadows, M Midtones, H Highlights), the Sponge's mode (D Desaturate, S Saturate) and the Color
//     Replacement tool's mode (C, U, T, Y).
// A command that does not apply to the active tool is disabled, so the key falls through to the global table as in
// 0.4. Each records its result as a replay argument ({ tool, key, value }), or as tool:brush-preset for the steps.
//
// Also here: the held keys painting reads (the tilde, Caps Lock, Shift for the line preview), the cursor filter
// (lib/brush-cursor.js), the Preferences section "Cursors" (settings.painting.cursors) and the platform of the HUD
// gestures (lib/tools/paint-gesture.js).
import { BLEND_MODE_KEYS } from '../../../shared/keymap.js';
import { DEFAULT_SETTINGS } from '../../../shared/defaults.js';
import { paints } from '../tool-traits.js';
import { digitPercent } from '../layer-menu-model.js';
import { supportsBrush, toolBrush } from '../brush/tool-brush.js';
import { PaintGesture, paintKeyState } from './paint-gesture.js';
import { cursorFilter } from '../brush-cursor.js';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** The 23 blend modes of BLEND_MODE_KEYS other than Pass Through, then Behind and Clear (painting modes). */
export const PAINT_BLEND_MODES = [...BLEND_MODE_KEYS.map(([id]) => id).filter((id) => id !== 'pass-through'), 'behind', 'clear'];
export const PAINT_KEY_COMMANDS = [
  'tool:brush-prev', 'tool:brush-next', 'tool:brush-first', 'tool:brush-last',
  ...DIGITS.map((d) => `tool:opacity-digit-${d}`),
  ...DIGITS.map((d) => `tool:flow-digit-${d}`),
  ...PAINT_BLEND_MODES.map((m) => `tool:blend-mode-${m}`),
];

const DEFAULT_PAIR_MS = DEFAULT_SETTINGS.painting.digitPairMs;

// ---- pure parts (Node-tested) ---------------------------------------------------------------------------------------

/** The tool's option with that key, when the tool shows it now (an option's `when` may hide it). */
export function shownOption(tool, key) {
  const o = tool?.options?.find((x) => x.key === key);
  if (!o) return null;
  try {
    if (typeof o.when === 'function' && !o.when(tool)) return null;
  } catch {
    return null;
  }
  return o;
}

/** The option an opacity digit ('opacity') or a flow digit ('flow') sets on a tool, or null. */
export function digitOption(tool, kind, { airbrush = false } = {}) {
  // the airbrush paints by flow: Photoshop swaps the two keys while it is on
  const k = airbrush ? (kind === 'opacity' ? 'flow' : 'opacity') : kind;
  const order = k === 'opacity' ? ['opacity', 'strength', 'exposure', 'flow'] : ['flow'];
  for (const key of order) {
    const o = shownOption(tool, key);
    if (o && o.kind === 'slider') return o;
  }
  return null;
}

/** A value clamped to an option's range, to hundredths. */
export function clampTo(option, v) {
  const lo = Number.isFinite(option?.min) ? option.min : 0, hi = Number.isFinite(option?.max) ? option.max : 1;
  return Math.round(Math.min(hi, Math.max(lo, v)) * 100) / 100;
}

/** A digit's value for an option (a fraction for 0..1 sliders, percent for 0..100 ones), clamped to it. */
export function digitValue(option, percent) {
  const hi = Number.isFinite(option?.max) ? option.max : 1;
  return clampTo(option, hi <= 1 ? percent / 100 : percent);
}

/**
 * Two digits within `pairMs` give one value (Photoshop reads two digits at most): press(key, digit, now) returns
 * { percent, paired }. A digit for another key (opacity vs flow, another tool) starts afresh.
 */
export class DigitPair {
  constructor(pairMs = DEFAULT_PAIR_MS) {
    this.pairMs = pairMs;
    this.last = null;
  }
  press(key, digit, now, pairMs = this.pairMs) {
    const paired = !!this.last && this.last.key === key && now - this.last.at < pairMs;
    const percent = digitPercent(paired ? this.last.digit : null, digit);
    this.last = paired ? null : { key, digit, at: now };
    return { percent, paired };
  }
}

/** Photoshop's Shift+Alt letters for the DabTools whose mode is not a blend mode: [mode id, option key, value]. */
const TOOL_MODE_KEYS = {
  dodge: [['screen', 'range', 'shadows'], ['multiply', 'range', 'midtones'], ['hard-light', 'range', 'highlights']],
  burn: [['screen', 'range', 'shadows'], ['multiply', 'range', 'midtones'], ['hard-light', 'range', 'highlights']],
  sponge: [['color-dodge', 'mode', 'desaturate'], ['screen', 'mode', 'saturate']],
};

const optionValues = (o) => (o?.options ?? []).map((v) => (Array.isArray(v) ? v[0] : v?.value ?? v));

/** What tool:blend-mode-<mode> sets on a tool: { key, value }, or null when the mode means nothing to it. */
export function blendTarget(tool, mode) {
  if (!tool) return null;
  const special = TOOL_MODE_KEYS[tool.id];
  if (special) {
    const hit = special.find(([m]) => m === mode);
    return hit && shownOption(tool, hit[1]) ? { key: hit[1], value: hit[2] } : null;
  }
  for (const key of ['blend', 'mode']) {
    const o = shownOption(tool, key);
    if (o && optionValues(o).includes(mode)) return { key, value: mode };
  }
  return null;
}

/** The preset a step lands on: index of the current one in `ids` (-1: none), by 'prev' | 'next' | 'first' | 'last'. */
export function stepPreset(ids, current, step) {
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  if (step === 'first') return ids[0];
  if (step === 'last') return ids[ids.length - 1];
  if (i < 0) return step === 'prev' ? ids[ids.length - 1] : ids[0];
  const n = ids.length;
  return ids[(i + (step === 'prev' ? -1 : 1) + n) % n];
}

// ---- the commands ---------------------------------------------------------------------------------------------------

function activeTool(app, arg) {
  const id = arg && typeof arg === 'object' && typeof arg.tool === 'string' ? arg.tool : null;
  return id ? app.tools?.get(id) ?? null : app.tools?.active ?? null;
}

function setToolValue(app, tool, key, value) {
  if (app.tools.opt(tool.id, key) !== value) app.tools.setOpt(tool.id, key, value);
  // the options bar of an inactive tool (an action step naming it) shows the value when it is next active
  return true;
}

function registerCommands(app) {
  const pair = new DigitPair();
  const pairMs = () => {
    const v = Number(app.settings?.painting?.digitPairMs);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_PAIR_MS;
  };
  const airbrushOn = (tool) => supportsBrush(tool) === 'full' && !!toolBrush(app, tool.id).preset.buildUp;
  const paintsNow = () => !!app.tools?.active && paints(app.tools.active);
  const defs = {};

  // brush presets
  const presetIds = () => (app.presets?.list?.('brushes') ?? []).map((p) => p.id);
  for (const step of ['prev', 'next', 'first', 'last']) {
    defs[`tool:brush-${step}`] = {
      enabled: () => paintsNow() && !!supportsBrush(app.tools.active) && presetIds().length > 0,
      run: async (arg, ctx) => {
        const tool = activeTool(app, arg);
        if (!tool || !supportsBrush(tool)) return false;
        await app.presets.ready?.('brushes');
        const id = stepPreset(presetIds(), app.settings.tools?.[tool.id]?.brushPresetId ?? null, step);
        if (!id) return false;
        // recorded as the preset it picked, so a replay picks the same brush wherever the list stands
        ctx?.setReplayCommand?.('tool:brush-preset', { id, tool: tool.id });
        return app.commands.run('tool:brush-preset', { id, tool: tool.id }, 'api');
      },
    };
  }

  // digits
  for (const kind of ['opacity', 'flow']) {
    for (const d of DIGITS) {
      defs[`tool:${kind}-digit-${d}`] = {
        enabled: () => paintsNow() && !!digitOption(app.tools.active, kind, { airbrush: airbrushOn(app.tools.active) }),
        run: (arg, ctx) => {
          const tool = activeTool(app, arg);
          if (!tool) return false;
          // a replayed step names its option and value
          if (arg && typeof arg === 'object' && typeof arg.key === 'string' && Number.isFinite(arg.value)) {
            const o = shownOption(tool, arg.key);
            if (!o) return false;
            const value = clampTo(o, arg.value);
            ctx?.setReplayArg?.({ tool: tool.id, key: o.key, value });
            return setToolValue(app, tool, o.key, value);
          }
          const o = digitOption(tool, kind, { airbrush: airbrushOn(tool) });
          if (!o) return false;
          const { percent } = pair.press(`${tool.id}|${o.key}`, d, performance.now(), pairMs());
          const value = digitValue(o, percent);
          ctx?.setReplayArg?.({ tool: tool.id, key: o.key, value });
          return setToolValue(app, tool, o.key, value);
        },
      };
    }
  }

  // painting modes
  for (const mode of PAINT_BLEND_MODES) {
    defs[`tool:blend-mode-${mode}`] = {
      enabled: () => paintsNow() && !!blendTarget(app.tools.active, mode),
      run: (arg, ctx) => {
        const tool = activeTool(app, arg);
        const t = blendTarget(tool, mode);
        if (!t) return false;
        ctx?.setReplayArg?.({ tool: tool.id });
        return setToolValue(app, tool, t.key, t.value);
      },
    };
  }
  for (const [id, def] of Object.entries(defs)) app.commands.register(id, def);
}

// ---- held keys --------------------------------------------------------------------------------------------------

function trackKeys(app) {
  const typing = (e) => !!app.isTextTarget?.(e.target) || !!app.dialogs?.isOpen || !!e.target?.closest?.('.dialog-backdrop');
  const repaint = () => {
    app.tools?.updateCursor?.();
    app.view?.invalidate?.();
  };
  const caps = (e) => {
    const on = !!e.getModifierState?.('CapsLock');
    if (on === paintKeyState.capsLock) return;
    paintKeyState.capsLock = on;
    repaint();
  };
  const isTilde = (e) => e.code === 'Backquote' || e.key === '`' || e.key === '~';
  document.addEventListener('keydown', (e) => {
    caps(e);
    if (e.key === 'Shift' && !paintKeyState.shift) {
      paintKeyState.shift = true;
      if (paints(app.tools?.active)) app.view?.invalidate?.();
    }
    if (isTilde(e) && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e)) {
      paintKeyState.tilde = true;
      if (paints(app.tools?.active)) e.preventDefault();
    }
  });
  document.addEventListener('keyup', (e) => {
    caps(e);
    if (e.key === 'Shift') {
      paintKeyState.shift = false;
      if (paints(app.tools?.active)) app.view?.invalidate?.();
    }
    if (isTilde(e)) paintKeyState.tilde = false;
  });
  document.addEventListener('pointermove', caps, true);
  document.addEventListener('pointerdown', caps, true);
  window.addEventListener('blur', () => {
    paintKeyState.tilde = false;
    paintKeyState.shift = false;
  });
}

// ---- Preferences > Cursors ----------------------------------------------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/i;
export const cursorsPreferences = {
  id: 'cursors',
  title: 'Cursors',
  order: 21,
  fields: [
    { key: 'paintingCrosshairInTip', label: 'Show crosshair in brush tip', type: 'checkbox', span: true },
    { key: 'paintingCrosshairWhilePainting', label: 'Show only crosshair while painting', type: 'checkbox', span: true },
    { key: 'paintingOtherCursors', label: 'Other cursors', type: 'select', options: [['standard', 'Standard'], ['precise', 'Precise']] },
    { key: 'paintingPreviewColor', label: 'Brush preview colour', type: 'color' },
    { key: 'paintingLeashColor', label: 'Brush leash colour', type: 'color' },
    { key: 'paintingHudVertical', label: 'Resize HUD, vertical drag', type: 'select', options: [['hardness', 'Hardness'], ['opacity', 'Opacity']] },
  ],
  read(s) {
    const p = { ...DEFAULT_SETTINGS.painting, ...(s.painting ?? {}) };
    const c = { ...DEFAULT_SETTINGS.painting.cursors, ...(p.cursors ?? {}) };
    return {
      paintingCrosshairInTip: !!c.crosshairInTip,
      paintingCrosshairWhilePainting: !!c.crosshairWhilePainting,
      paintingOtherCursors: c.other === 'precise' ? 'precise' : 'standard',
      paintingPreviewColor: HEX.test(c.previewColor) ? c.previewColor.toLowerCase() : DEFAULT_SETTINGS.painting.cursors.previewColor,
      paintingLeashColor: HEX.test(c.leashColor) ? c.leashColor.toLowerCase() : DEFAULT_SETTINGS.painting.cursors.leashColor,
      paintingHudVertical: p.hud?.vertical === 'opacity' ? 'opacity' : 'hardness',
    };
  },
  write(v, s) {
    const p = { ...DEFAULT_SETTINGS.painting, ...(s.painting ?? {}) };
    const c = { ...DEFAULT_SETTINGS.painting.cursors, ...(p.cursors ?? {}) };
    const hex = (x, d) => (typeof x === 'string' && HEX.test(x) ? x.toLowerCase() : d);
    const cursors = {
      ...c,
      crosshairInTip: !!v.paintingCrosshairInTip,
      crosshairWhilePainting: !!v.paintingCrosshairWhilePainting,
      other: v.paintingOtherCursors === 'precise' ? 'precise' : 'standard',
      previewColor: hex(v.paintingPreviewColor, c.previewColor),
      leashColor: hex(v.paintingLeashColor, c.leashColor),
    };
    const hud = { ...(p.hud ?? {}), vertical: v.paintingHudVertical === 'opacity' ? 'opacity' : 'hardness' };
    const changed = Object.keys(cursors).some((k) => cursors[k] !== c[k]) || hud.vertical !== (p.hud?.vertical ?? 'hardness');
    return changed ? { painting: { ...p, cursors, hud } } : {};
  },
};

export function install(app) {
  // the HUD gestures follow the host: Ctrl+Alt on macOS (the browser build answers like Windows and Linux)
  PaintGesture.mac = globalThis.window?.pigment?.platform === 'darwin';
  registerCommands(app);
  trackKeys(app);
  app.tools?.setCursorFilter?.((css, info) => cursorFilter(app, css, info));
  app.preferences?.registerSection(cursorsPreferences);
  // a cursor preference takes effect at once
  app.on?.('settings:changed', (patch) => {
    if (!patch || !('painting' in patch || 'cursorStyle' in patch)) return;
    app.tools?.updateCursor?.();
    app.view?.invalidate?.();
  });
}

