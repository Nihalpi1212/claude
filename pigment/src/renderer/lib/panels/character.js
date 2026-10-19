// Character panel: font family, style, size, leading, tracking, colour, underline, alignment, stroke
// and point/paragraph text for the text being edited or the selected text layers (undoable, slider
// drags merge into one entry). Every change also becomes the Type tools' default for new text.
// With no text layer selected the panel edits those defaults only.
import { icon } from '../icons.js';
import { DEFAULT_TEXT_STYLE } from '../document.js';
import { setLayerProps } from '../layer-ops.js';
import { fontFamilies, onFontsChanged, loadSystemFonts, STYLES, styleOf, styleToFont, textTargets, typeSession, applyTypeStyle } from '../tools/text.js';
import { parseColor, rgbaToHex } from '../../../shared/pixels/color.js';

const TYPE_TOOLS = ['type-horizontal', 'type-vertical'];
const hex6 = (c) => rgbaToHex(parseColor(c ?? '#000000')).slice(0, 7);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function install(app) {
  const el = document.createElement('div');
  el.className = 'char-panel';
  el.innerHTML = `
    <div class="panel-empty char-empty" hidden>No text layer selected. These settings apply to new text.</div>
    <div class="panel-section">
      <div class="prop-row"><span>Font</span><select class="select" data-k="family" aria-label="Font family"></select></div>
      <div class="prop-row"><span>Style</span><select class="select" data-k="style" aria-label="Font style"></select></div>
      <div class="char-grid">
        <label class="prop-inline" title="Font size">${icon('text')}<input class="input num" type="number" min="1" max="1296" step="1" data-k="size" aria-label="Size"> px</label>
        <label class="prop-inline" title="Leading (distance between lines)">↕<input class="input num" type="number" min="1" max="5000" step="1" data-k="leading" aria-label="Leading"> px</label>
        <label class="prop-inline" title="Tracking (space between letters)">↔<input class="input num" type="number" min="-100" max="1000" step="0.5" data-k="tracking" aria-label="Tracking"> px</label>
        <label class="prop-inline" title="Text colour">Color <input type="color" data-k="color" aria-label="Text colour"></label>
      </div>
    </div>
    <div class="panel-section">
      <div class="prop-row"><span>Align</span><span class="opt-segment" data-k="align" role="radiogroup" aria-label="Alignment">
        <button type="button" class="seg-button" data-value="left" title="Left align text">${icon('align-left')}</button>
        <button type="button" class="seg-button" data-value="center" title="Center text">${icon('align-hcenter')}</button>
        <button type="button" class="seg-button" data-value="right" title="Right align text">${icon('align-right')}</button>
      </span></div>
      <div class="prop-row"><span>Decoration</span><label class="checkbox"><input type="checkbox" data-k="underline"> Underline</label></div>
      <div class="prop-row"><span>Stroke</span><input type="color" data-k="strokeColor" aria-label="Stroke colour"><input class="input num" type="number" min="0" max="200" step="0.5" data-k="strokeWidth" aria-label="Stroke width"><span class="muted">px</span></div>
      <div class="prop-row" data-row="box"><span>Text</span><select class="select" data-k="box" aria-label="Point or paragraph text"><option value="point">Point text</option><option value="paragraph">Paragraph box</option></select><input class="input num" type="number" min="1" max="30000" step="1" data-k="boxWidth" aria-label="Box width" title="Paragraph box width (px)"></div>
    </div>`;
  const q = (k) => el.querySelector(`[data-k="${k}"]`);
  const empty = el.querySelector('.char-empty');
  const family = q('family'), style = q('style'), size = q('size'), leading = q('leading'), tracking = q('tracking'), color = q('color');
  const align = q('align'), underline = q('underline'), strokeColor = q('strokeColor'), strokeWidth = q('strokeWidth'), box = q('box'), boxWidth = q('boxWidth');
  const boxRow = el.querySelector('[data-row="box"]');
  for (const [v, label] of STYLES) style.add(new Option(label, v));

  function fillFamilies(current) {
    const list = fontFamilies();
    const names = current && !list.includes(current) ? [current, ...list] : list;
    if (family.options.length === names.length && family.options[0]?.value === names[0] && family.options[names.length - 1]?.value === names[names.length - 1]) return;
    family.replaceChildren(...names.map((f) => new Option(f, f)));
  }

  /** What the panel shows: the text being edited, else the first targeted text layer, else the Type tool defaults. */
  function subject() {
    const tool = typeSession(app);
    if (tool) return { layer: tool.session.layer, font: tool.session.layer.font };
    const t = textTargets(app.doc)[0];
    if (t) return { layer: t, font: t.font };
    const def = app.tools.get('type-horizontal');
    return { layer: null, font: def ? def.fontFromOptions() : { ...DEFAULT_TEXT_STYLE } };
  }

  /** Stores a change as the Type tools' defaults for new text (options bar included). */
  function writeDefaults(patch, font) {
    const opts = {};
    if ('family' in patch) opts.family = patch.family;
    if ('weight' in patch || 'italic' in patch) opts.style = styleOf({ ...font, ...patch });
    if ('size' in patch) opts.size = patch.size;
    if ('align' in patch) opts.align = patch.align;
    if ('lineHeight' in patch) opts.lineHeight = patch.lineHeight;
    if ('letterSpacing' in patch) opts.letterSpacing = patch.letterSpacing;
    if ('underline' in patch) opts.underline = patch.underline;
    if ('stroke' in patch) opts.stroke = patch.stroke;
    if ('color' in patch) opts.color = hex6(patch.color);
    for (const id of TYPE_TOOLS) for (const [k, v] of Object.entries(opts)) app.tools.setOpt(id, k, v, { silent: true });
    if (TYPE_TOOLS.includes(app.tools.active?.id)) for (const [k, v] of Object.entries(opts)) app.tools.updateControl(k, v);
  }

  function apply(patch, { merge = true } = {}) {
    const sub = subject();
    if (sub.layer) applyTypeStyle(app, patch, { label: 'Character', merge });
    else if ('color' in patch) app.setColors({ foreground: patch.color }); // new text uses the foreground colour
    writeDefaults(patch, sub.font);
    refresh();
  }

  family.addEventListener('pointerdown', () => loadSystemFonts());
  family.addEventListener('change', () => apply({ family: family.value }, { merge: false }));
  style.addEventListener('change', () => apply(styleToFont(style.value), { merge: false }));
  size.addEventListener('change', () => {
    const v = Number(size.value);
    if (v > 0) apply({ size: v });
  });
  leading.addEventListener('change', () => {
    const v = Number(leading.value);
    const s = subject().font.size;
    if (v > 0 && s > 0) apply({ lineHeight: round(v / s, 4) });
  });
  tracking.addEventListener('change', () => {
    const v = Number(tracking.value);
    if (Number.isFinite(v)) apply({ letterSpacing: v });
  });
  color.addEventListener('input', () => apply({ color: color.value }));
  for (const b of align.querySelectorAll('button')) b.addEventListener('click', () => apply({ align: b.dataset.value }, { merge: false }));
  underline.addEventListener('change', () => apply({ underline: underline.checked }, { merge: false }));
  const strokePatch = () => {
    const w = Number(strokeWidth.value);
    return { stroke: w > 0 ? { color: strokeColor.value, width: w } : null };
  };
  strokeColor.addEventListener('input', () => {
    if (!(Number(strokeWidth.value) > 0)) strokeWidth.value = '2';
    apply(strokePatch());
  });
  strokeWidth.addEventListener('change', () => apply(strokePatch()));

  // point <-> paragraph text (and the paragraph box width) for the targeted layers
  function setBox(width) {
    const tool = typeSession(app);
    const layers = tool ? [tool.session.layer] : textTargets(app.doc);
    if (!layers.length) return;
    if (tool) {
      const l = layers[0];
      l.width = width === 'fit' ? Math.ceil(l.layout().width) : width;
      l.touch();
      app.doc.changed('props', { layer: l });
      return refresh();
    }
    const run = () => {
      for (const l of layers) {
        const w = width === 'fit' ? Math.max(1, Math.ceil(l.layout().width)) : width;
        if (w !== l.width) setLayerProps(app, l, { width: w }, 'Text Box');
      }
    };
    if (layers.length > 1) app.doc.history.group('Text Box', run);
    else run();
    refresh();
  }
  box.addEventListener('change', () => setBox(box.value === 'point' ? null : 'fit'));
  boxWidth.addEventListener('change', () => {
    const v = Number(boxWidth.value);
    if (v > 0) setBox(v);
  });

  let pending = 0;
  function refresh() {
    pending = 0;
    const { layer, font } = subject();
    empty.hidden = !!layer;
    fillFamilies(font.family);
    const set = (input, value) => {
      if (document.activeElement === input) return;
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = String(value);
    };
    set(family, font.family);
    set(style, styleOf(font));
    set(size, round(font.size));
    set(leading, round(font.size * (font.lineHeight ?? 1.2), 1));
    set(tracking, round(font.letterSpacing ?? 0));
    set(color, hex6(font.color));
    for (const b of align.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === (font.align ?? 'left')));
    set(underline, !!font.underline);
    set(strokeColor, hex6(font.stroke?.color ?? '#000000'));
    set(strokeWidth, font.stroke?.width ?? 0);
    boxRow.hidden = !layer;
    if (layer) {
      set(box, layer.width === null ? 'point' : 'paragraph');
      boxWidth.hidden = layer.width === null;
      if (layer.width !== null) set(boxWidth, Math.round(layer.width));
    }
  }
  const schedule = () => {
    if (!pending) pending = requestAnimationFrame(refresh);
  };
  app.on('doc:activated', schedule);
  app.on('doc:change', (e) => {
    if (['props', 'active', 'tree', 'history', 'canvas'].includes(e.kind)) schedule();
  });
  app.on('type:session', schedule);
  app.on('tool:options', (e) => {
    if (TYPE_TOOLS.includes(e.tool)) schedule();
  });
  app.on('color:changed', schedule);
  onFontsChanged(() => {
    if (document.activeElement !== family) fillFamilies(subject().font.family);
    schedule();
  });

  app.panels.register({ id: 'character', title: 'Character', icon: 'character', element: el, group: 'middle', onShow: refresh });
  refresh();
  return { refresh };
}
