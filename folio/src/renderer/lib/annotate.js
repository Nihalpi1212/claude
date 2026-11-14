// Commenting and markup tools. Text highlight, free text and freehand drawing use pdf.js' own
// annotation editors (undoable, saved through saveDocument). Underline/strikeout/squiggly, sticky
// notes, shapes, lines/arrows, text stamps and the eraser go through the engine (pdf-lib) with the
// flush → operate → reload rule from ARCHITECTURE.md.
import * as engine from '../../shared/engine.js';
import { AnnotationEditorType, AnnotationEditorParamsType } from './viewer.js';
import { icon } from './icons.js';
import { MENU_KEYS, RENDERER_KEYS } from '../../shared/keymap.js';

const SELECTION_TOOLS = { underline: 'Underline', strikeout: 'Strikethrough', squiggly: 'Squiggly underline' };
const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'line', 'arrow']);
const HIGHLIGHT_SWATCHES = ['#ffff98', '#53ffbc', '#80ebff', '#ffcbe6', '#ff4f5f'];
const INK_SWATCHES = ['#e53935', '#1e88e5', '#43a047', '#000000', '#fb8c00', '#8e24aa'];
const TEXT_SWATCHES = ['#1e1e1e', '#e53935', '#1e88e5', '#43a047', '#ffffff'];
const NOTE_SWATCHES = ['#ffd54f', '#ff8a65', '#81c784', '#64b5f6', '#ba68c8'];

export function install(app) {
  const state = {
    tool: 'none',
    stampText: null,
  };
  const s = () => app.settings;
  const view = () => app.view;
  const author = () => s().authorName || 'Folio user';

  // ---- tool activation -------------------------------------------------------------------------------
  const containerClasses = ['tool-shape', 'tool-note', 'tool-eraser', 'tool-stamp', 'tool-measure', 'tool-snapshot'];
  function resetContainer(v) {
    if (!v) return;
    v.container.classList.remove(...containerClasses);
  }

  function activate(tool) {
    const v = view();
    if (!v) return;
    app.commands.run('tool:none', undefined, 'api');
    state.tool = tool;
    resetContainer(v);
    switch (tool) {
      case 'highlight':
      case 'highlight-free':
        v.editorMode = AnnotationEditorType.HIGHLIGHT;
        v.setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_COLOR, s().highlightColor);
        v.setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, 12);
        if (v.getSelection()) v.uiManager?.highlightSelection('folio_toolbar');
        break;
      case 'text':
        v.editorMode = AnnotationEditorType.FREETEXT;
        v.setEditorParam(AnnotationEditorParamsType.FREETEXT_COLOR, s().freeTextColor);
        v.setEditorParam(AnnotationEditorParamsType.FREETEXT_SIZE, s().freeTextSize);
        break;
      case 'ink':
        v.editorMode = AnnotationEditorType.INK;
        v.setEditorParam(AnnotationEditorParamsType.INK_COLOR, s().inkColor);
        v.setEditorParam(AnnotationEditorParamsType.INK_THICKNESS, s().inkThickness);
        v.setEditorParam(AnnotationEditorParamsType.INK_OPACITY, Math.round((s().inkOpacity ?? 1) * 100));
        break;
      case 'image':
        v.editorMode = AnnotationEditorType.STAMP;
        pickImage().then((blob) => {
          if (blob) v.addImageStamp(blob);
          else app.commands.run('tool:none', undefined, 'api');
        });
        break;
      case 'underline':
      case 'strikeout':
      case 'squiggly':
        if (v.getSelection()) applySelectionMarkup(tool);
        break;
      case 'note':
        v.container.classList.add('tool-note');
        break;
      case 'stamp':
        v.container.classList.add('tool-stamp');
        break;
      case 'eraser':
        v.container.classList.add('tool-eraser');
        break;
      default:
        if (SHAPE_TOOLS.has(tool)) v.container.classList.add('tool-shape');
    }
    app.setTool(tool);
    app.toolbar.setSecondary(buildSecondary(tool));
    v.focus();
  }

  // When tool:none runs (Escape, select button), clear our state too.
  const baseNone = app.commands.commands.get('tool:none');
  app.commands.register('tool:none', {
    checked: baseNone.checked,
    run: (arg) => {
      baseNone.run(arg);
      state.tool = 'none';
      resetContainer(view());
    },
  });
  app.on('tab:activated', () => {
    state.tool = 'none';
    app.setTool('none');
    app.toolbar.setSecondary(null);
  });
  // pdf.js switched mode by itself (floating highlight button, double-click on an editable annotation)
  app.on('editor:mode', ({ session, mode }) => {
    if (session !== app.session) return;
    const map = { [AnnotationEditorType.HIGHLIGHT]: 'highlight', [AnnotationEditorType.FREETEXT]: 'text', [AnnotationEditorType.INK]: 'ink', [AnnotationEditorType.STAMP]: 'image' };
    const tool = map[mode];
    if (mode === AnnotationEditorType.NONE && ['highlight', 'highlight-free', 'text', 'ink', 'image'].includes(state.tool)) {
      state.tool = 'none';
      app.setTool('none');
      app.toolbar.setSecondary(null);
    } else if (tool === 'image' && ['sign', 'initials', 'image'].includes(app.tool)) {
      // signatures and initials are placed as stamp editors: keep their tool name
    } else if (tool && state.tool !== tool && !(tool === 'highlight' && state.tool === 'highlight-free')) {
      state.tool = tool;
      app.setTool(tool);
      app.toolbar.setSecondary(buildSecondary(tool));
    }
  });

  // ---- commands --------------------------------------------------------------------------------------
  const toolCmd = (tool) => ({ enabled: () => !!app.session, checked: () => app.tool === tool, run: () => (app.tool === tool ? app.commands.run('tool:none', undefined, 'api') : activate(tool)) });
  app.commands.registerAll({
    'tool:highlight': toolCmd('highlight'),
    'tool:highlight-free': toolCmd('highlight-free'),
    'tool:underline': toolCmd('underline'),
    'tool:strikeout': toolCmd('strikeout'),
    'tool:squiggly': toolCmd('squiggly'),
    'tool:note': toolCmd('note'),
    'tool:text': toolCmd('text'),
    'tool:ink': toolCmd('ink'),
    'tool:rect': toolCmd('rect'),
    'tool:ellipse': toolCmd('ellipse'),
    'tool:line': toolCmd('line'),
    'tool:arrow': toolCmd('arrow'),
    'tool:image': toolCmd('image'),
    'tool:eraser': toolCmd('eraser'),
    'tool:stamp': {
      enabled: () => !!app.session,
      checked: () => app.tool === 'stamp',
      run: async (text) => {
        if (typeof text === 'string') state.stampText = text;
        if (!state.stampText) {
          const chosen = await chooseStamp();
          if (!chosen) return;
          state.stampText = chosen;
        }
        activate('stamp');
      },
    },
    'annot:markup-selection': { enabled: () => !!view()?.getSelection(), run: (kind) => (kind === 'highlight' ? view().uiManager?.highlightSelection('context_menu') : applySelectionMarkup(kind)) },
    'annot:delete-at': { run: ({ pageIndex, x, y }) => eraseAt(pageIndex, x, y) },
  });

  // ---- toolbar ----------------------------------------------------------------------------------------
  const tb = app.toolbar;
  const markupMenu = () => [
    { label: 'Highlight text', icon: 'highlight', checked: app.tool === 'highlight', shortcut: RENDERER_KEYS['tool:highlight'][0], onSelect: () => app.commands.run('tool:highlight', undefined, 'toolbar') },
    { label: 'Underline', icon: 'underline', checked: app.tool === 'underline', onSelect: () => app.commands.run('tool:underline', undefined, 'toolbar') },
    { label: 'Strikethrough', icon: 'strikeout', checked: app.tool === 'strikeout', onSelect: () => app.commands.run('tool:strikeout', undefined, 'toolbar') },
    { label: 'Squiggly underline', icon: 'squiggly', checked: app.tool === 'squiggly', onSelect: () => app.commands.run('tool:squiggly', undefined, 'toolbar') },
    { type: 'separator' },
    { label: 'Free highlight (draw over anything)', icon: 'pen', checked: app.tool === 'highlight-free', onSelect: () => app.commands.run('tool:highlight-free', undefined, 'toolbar') },
  ];
  tb.addButton({ id: 'highlight', group: 'tools', icon: 'highlight', title: 'Highlight, underline, strikethrough', menu: markupMenu, enabled: () => !!app.session, pressed: () => ['highlight', 'highlight-free', 'underline', 'strikeout', 'squiggly'].includes(app.tool) });
  tb.addButton({ id: 'note', group: 'tools', icon: 'note', title: 'Sticky note', command: 'tool:note', toggle: true });
  tb.addButton({ id: 'text', group: 'tools', icon: 'text', title: 'Text box', command: 'tool:text', toggle: true });
  tb.addButton({ id: 'ink', group: 'tools', icon: 'pen', title: 'Draw freehand', command: 'tool:ink', toggle: true });
  const shapesMenu = () => [
    { label: 'Rectangle', icon: 'rect', checked: app.tool === 'rect', onSelect: () => app.commands.run('tool:rect', undefined, 'toolbar') },
    { label: 'Ellipse', icon: 'ellipse', checked: app.tool === 'ellipse', onSelect: () => app.commands.run('tool:ellipse', undefined, 'toolbar') },
    { label: 'Line', icon: 'line', checked: app.tool === 'line', onSelect: () => app.commands.run('tool:line', undefined, 'toolbar') },
    { label: 'Arrow', icon: 'arrow', checked: app.tool === 'arrow', onSelect: () => app.commands.run('tool:arrow', undefined, 'toolbar') },
  ];
  tb.addButton({ id: 'shapes', group: 'tools', icon: 'shapes', title: 'Shapes', menu: shapesMenu, enabled: () => !!app.session, pressed: () => SHAPE_TOOLS.has(app.tool) });
  const stampMenu = () => [
    { type: 'title', label: 'Stamps' },
    ...(s().stampPresets ?? []).map((text) => ({ label: text, icon: 'stamp', checked: app.tool === 'stamp' && state.stampText === text, onSelect: () => app.commands.run('tool:stamp', text, 'toolbar') })),
    { label: 'Custom text stamp…', icon: 'edit', onSelect: async () => {
      const text = await app.dialogs.prompt('Stamp text', { title: 'Custom stamp', value: state.stampText ?? '', okLabel: 'Use stamp' });
      if (text) app.commands.run('tool:stamp', text, 'toolbar');
    } },
    { type: 'separator' },
    { label: 'Add image…', icon: 'image', onSelect: () => app.commands.run('tool:image', undefined, 'toolbar') },
  ];
  tb.addButton({ id: 'stamp', group: 'tools', icon: 'stamp', title: 'Stamps and images', menu: stampMenu, enabled: () => !!app.session, pressed: () => app.tool === 'stamp' || app.tool === 'image' });
  tb.addButton({ id: 'eraser', group: 'tools', icon: 'eraser', title: 'Delete annotations (click one)', command: 'tool:eraser', toggle: true });

  // ---- secondary (tool options) bar --------------------------------------------------------------------
  function swatches(colors, current, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'tool-swatches';
    for (const c of colors) {
      const b = document.createElement('button');
      b.className = 'tool-swatch';
      b.type = 'button';
      b.style.background = c;
      b.title = c;
      b.setAttribute('aria-pressed', String(c.toLowerCase() === String(current).toLowerCase()));
      b.addEventListener('click', () => {
        for (const o of wrap.querySelectorAll('.tool-swatch')) o.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        onPick(c);
      });
      wrap.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color';
    custom.className = 'tb-color';
    custom.title = 'Custom colour';
    custom.value = /^#[0-9a-f]{6}$/i.test(current) ? current : '#000000';
    custom.addEventListener('input', () => {
      for (const o of wrap.querySelectorAll('.tool-swatch')) o.setAttribute('aria-pressed', 'false');
      onPick(custom.value);
    });
    wrap.appendChild(custom);
    return wrap;
  }
  function slider(label, min, max, value, step, onChange, format = (v) => v) {
    const wrap = document.createElement('label');
    wrap.className = 'tool-slider';
    const text = document.createElement('span');
    text.className = 'tb-text';
    text.textContent = `${label} ${format(value)}`;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'tb-range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener('input', () => {
      text.textContent = `${label} ${format(Number(input.value))}`;
      onChange(Number(input.value));
    });
    wrap.append(text, input);
    return wrap;
  }
  function doneButton() {
    const b = document.createElement('button');
    b.className = 'btn quiet tool-done';
    b.innerHTML = `${icon('check')} Done`;
    b.title = 'Finish (Esc)';
    b.addEventListener('click', () => app.commands.run('tool:none', undefined, 'toolbar'));
    return b;
  }
  function hint(text) {
    const span = document.createElement('span');
    span.className = 'tool-hint';
    span.textContent = text;
    return span;
  }

  function buildSecondary(tool) {
    const v = view();
    const bar = document.createElement('div');
    bar.className = 'tool-options';
    const save = (patch) => app.saveSettings(patch);
    switch (tool) {
      case 'highlight':
      case 'highlight-free':
        bar.append(hint(tool === 'highlight' ? 'Select text to highlight it' : 'Drag over the page to highlight freely'), swatches(HIGHLIGHT_SWATCHES, s().highlightColor, (c) => {
          save({ highlightColor: c });
          v.setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_COLOR, c);
        }));
        if (tool === 'highlight-free') bar.append(slider('Thickness', 4, 40, 12, 1, (n) => v.setEditorParam(AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, n)));
        break;
      case 'underline':
      case 'strikeout':
      case 'squiggly':
        bar.append(hint(`Select text to ${SELECTION_TOOLS[tool].toLowerCase()} it`), swatches(INK_SWATCHES, s().shapeColor, (c) => save({ shapeColor: c })));
        break;
      case 'text':
        bar.append(hint('Click on the page to add a text box'), swatches(TEXT_SWATCHES, s().freeTextColor, (c) => {
          save({ freeTextColor: c });
          v.setEditorParam(AnnotationEditorParamsType.FREETEXT_COLOR, c);
        }), slider('Size', 6, 48, s().freeTextSize, 1, (n) => {
          save({ freeTextSize: n });
          v.setEditorParam(AnnotationEditorParamsType.FREETEXT_SIZE, n);
        }));
        break;
      case 'ink':
        bar.append(hint('Draw on the page'), swatches(INK_SWATCHES, s().inkColor, (c) => {
          save({ inkColor: c });
          v.setEditorParam(AnnotationEditorParamsType.INK_COLOR, c);
        }), slider('Thickness', 1, 20, s().inkThickness, 1, (n) => {
          save({ inkThickness: n });
          v.setEditorParam(AnnotationEditorParamsType.INK_THICKNESS, n);
        }), slider('Opacity', 10, 100, Math.round((s().inkOpacity ?? 1) * 100), 5, (n) => {
          save({ inkOpacity: n / 100 });
          v.setEditorParam(AnnotationEditorParamsType.INK_OPACITY, n);
        }, (val) => `${val}%`));
        break;
      case 'note':
        bar.append(hint('Click on the page to place a note'), swatches(NOTE_SWATCHES, s().noteColor, (c) => save({ noteColor: c })));
        break;
      case 'rect':
      case 'ellipse':
      case 'line':
      case 'arrow':
        bar.append(hint('Drag on the page to draw'), swatches(INK_SWATCHES, s().shapeColor, (c) => save({ shapeColor: c })), slider('Width', 1, 12, s().shapeWidth, 1, (n) => save({ shapeWidth: n })), slider('Opacity', 10, 100, Math.round((s().shapeOpacity ?? 1) * 100), 5, (n) => save({ shapeOpacity: n / 100 }), (val) => `${val}%`));
        break;
      case 'stamp':
        bar.append(hint(`Click on the page to place "${state.stampText}"`), swatches(['#c62828', '#1565c0', '#2e7d32', '#000000'], s().shapeColor, (c) => save({ shapeColor: c })));
        break;
      case 'image':
        bar.append(hint('Drag the image to move it; use the corners to resize'));
        break;
      case 'eraser':
        bar.append(hint('Click an annotation to delete it'));
        break;
      default:
        return null;
    }
    bar.appendChild(doneButton());
    return bar;
  }

  // ---- selection markup through the engine -------------------------------------------------------------
  async function applySelectionMarkup(kind) {
    const v = view();
    const selection = v?.getSelection();
    if (!selection) return;
    const type = kind === 'highlight' ? 'highlight' : kind;
    const color = kind === 'highlight' ? s().highlightColor : s().shapeColor;
    const label = SELECTION_TOOLS[kind] ?? 'Highlight';
    v.clearSelection();
    await app.edit.apply(async (bytes) => {
      let out = bytes;
      for (const part of selection) {
        const result = await engine.addAnnotation(out, part.pageIndex, { type, quads: part.quads, color, author: author(), opacity: 1, contents: '' });
        out = result.bytes;
      }
      return out;
    }, { label });
  }

  // apply selection tools when the user finishes selecting text
  document.addEventListener('mouseup', (event) => {
    if (!SELECTION_TOOLS[state.tool] || !view()?.container.contains(event.target)) return;
    setTimeout(() => {
      if (view()?.getSelection()) applySelectionMarkup(state.tool);
    }, 30);
  });

  // ---- click tools: note, stamp, eraser -----------------------------------------------------------------
  function onContainerClick(event) {
    const v = view();
    if (!v || event.button !== 0) return;
    if (!['note', 'stamp', 'eraser'].includes(state.tool)) return;
    const pageIndex = v.pageIndexAt(event.clientX, event.clientY);
    if (pageIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const pt = v.clientToPdf(pageIndex, event.clientX, event.clientY);
    if (!pt) return;
    if (state.tool === 'note') placeNote(pageIndex, pt);
    else if (state.tool === 'stamp') placeStamp(pageIndex, pt);
    else if (state.tool === 'eraser') eraseAt(pageIndex, pt.x, pt.y);
  }
  const bindContainer = (session) => {
    if (!session || session.__annotateBound) return;
    session.__annotateBound = true;
    session.view.container.addEventListener('click', onContainerClick, true);
    session.view.container.addEventListener('pointerdown', onShapePointerDown, true);
    session.view.container.addEventListener('contextmenu', onContextMenu);
    session.view.container.addEventListener('dblclick', onDoubleClick);
  };
  app.on('tab:opened', bindContainer);
  app.on('tab:activated', bindContainer);

  async function placeNote(pageIndex, pt) {
    const text = await app.dialogs.prompt('Note text', { title: 'Sticky note', multiline: true, okLabel: 'Add note' });
    if (text === null) return;
    const rect = [pt.x, pt.y - 20, pt.x + 20, pt.y];
    await app.edit.apply((bytes) => engine.addAnnotation(bytes, pageIndex, { type: 'note', rect, contents: text, author: author(), color: s().noteColor, open: false }), { label: 'Sticky note' });
    app.commands.run('tool:none', undefined, 'api');
  }

  async function placeStamp(pageIndex, pt) {
    const text = state.stampText ?? 'DRAFT';
    const w = Math.max(90, Math.min(300, text.length * 16 + 40));
    const h = 44;
    const rect = [pt.x - w / 2, pt.y - h / 2, pt.x + w / 2, pt.y + h / 2];
    await app.edit.apply((bytes) => engine.addAnnotation(bytes, pageIndex, { type: 'stamp-text', rect, text, color: s().shapeColor, author: author() }), { label: 'Stamp' });
    app.commands.run('tool:none', undefined, 'api');
  }

  async function annotationAt(pageIndex, x, y) {
    const v = view();
    const page = await v.pdfDocument.getPage(pageIndex + 1);
    const annots = await page.getAnnotations();
    const hits = annots.filter((a) => a.subtype !== 'Widget' && a.subtype !== 'Link' && a.subtype !== 'Popup' && a.rect && x >= a.rect[0] - 2 && x <= a.rect[2] + 2 && y >= a.rect[1] - 2 && y <= a.rect[3] + 2);
    hits.sort((a, b) => (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]) - (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]));
    return hits[0] ?? null;
  }

  async function eraseAt(pageIndex, x, y) {
    const v = view();
    // pdf.js editors (unsaved) are deleted by pdf.js itself
    const hit = await annotationAt(pageIndex, x, y);
    if (!hit) {
      app.dialogs.toast('No annotation here', { timeout: 1200 });
      return;
    }
    await app.edit.apply((bytes) => engine.deleteAnnotation(bytes, hit.id), { label: `Delete ${hit.subtype}` });
    v.focus();
  }

  // double-click a note/markup in select mode to edit its text
  async function onDoubleClick(event) {
    if (state.tool !== 'none' || event.target.closest('.annotationEditorLayer, input, textarea, select, a')) return;
    const v = view();
    const pageIndex = v?.pageIndexAt(event.clientX, event.clientY);
    if (pageIndex === undefined || pageIndex < 0) return;
    const pt = v.clientToPdf(pageIndex, event.clientX, event.clientY);
    const hit = await annotationAt(pageIndex, pt.x, pt.y);
    if (!hit || ['FreeText', 'Ink', 'Highlight', 'Stamp'].includes(hit.subtype)) return; // pdf.js handles its editable types
    editAnnotationText(hit);
  }

  async function editAnnotationText(annot) {
    const text = await app.dialogs.prompt(`${annot.subtype} comment`, { title: 'Edit comment', value: annot.contentsObj?.str ?? '', multiline: true, okLabel: 'Save' });
    if (text === null) return;
    await app.edit.apply((bytes) => engine.updateAnnotation(bytes, annot.id, { contents: text }), { label: 'Edit comment' });
  }

  // ---- shape drawing ------------------------------------------------------------------------------------
  let drawing = null;
  function onShapePointerDown(event) {
    const v = view();
    if (!v || !SHAPE_TOOLS.has(state.tool) || event.button !== 0) return;
    const pageEl = event.target.closest('.page');
    if (!pageEl) return;
    const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
    event.preventDefault();
    event.stopPropagation();
    const overlay = document.createElement('div');
    overlay.className = 'folio-overlay active';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.appendChild(svg);
    pageEl.appendChild(overlay);
    const rect = pageEl.getBoundingClientRect();
    drawing = { pageIndex, pageEl, overlay, svg, rect, x0: event.clientX - rect.left, y0: event.clientY - rect.top, x1: event.clientX - rect.left, y1: event.clientY - rect.top, pointerId: event.pointerId };
    overlay.setPointerCapture?.(event.pointerId);
    const move = (e) => {
      if (!drawing) return;
      drawing.x1 = e.clientX - drawing.rect.left;
      drawing.y1 = e.clientY - drawing.rect.top;
      renderPreview();
    };
    const up = async (e) => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (!drawing) return;
      const d = drawing;
      drawing = null;
      d.overlay.remove();
      const dx = Math.abs(d.x1 - d.x0), dy = Math.abs(d.y1 - d.y0);
      if (dx < 3 && dy < 3) return;
      await commitShape(d, e);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function renderPreview() {
    const d = drawing;
    const color = s().shapeColor;
    const w = Math.max(1, s().shapeWidth * (view()?.scale ?? 1));
    const ns = 'http://www.w3.org/2000/svg';
    d.svg.replaceChildren();
    let el;
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), width = Math.abs(d.x1 - d.x0), height = Math.abs(d.y1 - d.y0);
    if (state.tool === 'rect') {
      el = document.createElementNS(ns, 'rect');
      el.setAttribute('x', x);
      el.setAttribute('y', y);
      el.setAttribute('width', width);
      el.setAttribute('height', height);
    } else if (state.tool === 'ellipse') {
      el = document.createElementNS(ns, 'ellipse');
      el.setAttribute('cx', x + width / 2);
      el.setAttribute('cy', y + height / 2);
      el.setAttribute('rx', width / 2);
      el.setAttribute('ry', height / 2);
    } else {
      el = document.createElementNS(ns, 'line');
      el.setAttribute('x1', d.x0);
      el.setAttribute('y1', d.y0);
      el.setAttribute('x2', d.x1);
      el.setAttribute('y2', d.y1);
      if (state.tool === 'arrow') {
        const marker = document.createElementNS(ns, 'path');
        const angle = Math.atan2(d.y1 - d.y0, d.x1 - d.x0);
        const len = 10 + w * 2;
        const a = [d.x1 - len * Math.cos(angle - Math.PI / 7), d.y1 - len * Math.sin(angle - Math.PI / 7)];
        const b = [d.x1 - len * Math.cos(angle + Math.PI / 7), d.y1 - len * Math.sin(angle + Math.PI / 7)];
        marker.setAttribute('d', `M${a[0]} ${a[1]} L${d.x1} ${d.y1} L${b[0]} ${b[1]}`);
        marker.setAttribute('fill', 'none');
        marker.setAttribute('stroke', color);
        marker.setAttribute('stroke-width', w);
        marker.setAttribute('stroke-linecap', 'round');
        d.svg.appendChild(marker);
      }
    }
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', w);
    el.setAttribute('opacity', s().shapeOpacity ?? 1);
    d.svg.appendChild(el);
  }

  async function commitShape(d, e) {
    const v = view();
    const p0 = v.clientToPdf(d.pageIndex, d.rect.left + d.x0, d.rect.top + d.y0);
    const p1 = v.clientToPdf(d.pageIndex, d.rect.left + d.x1, d.rect.top + d.y1);
    if (!p0 || !p1) return;
    const common = { color: s().shapeColor, width: s().shapeWidth, opacity: s().shapeOpacity ?? 1, author: author() };
    let spec;
    if (state.tool === 'rect' || state.tool === 'ellipse') spec = { type: state.tool === 'rect' ? 'square' : 'circle', rect: [p0.x, p0.y, p1.x, p1.y], fill: null, ...common };
    else spec = { type: state.tool, start: [p0.x, p0.y], end: [p1.x, p1.y], ...common };
    const label = { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow' }[state.tool];
    await app.edit.apply((bytes) => engine.addAnnotation(bytes, d.pageIndex, spec), { label });
    if (!e?.shiftKey) app.commands.run('tool:none', undefined, 'api');
  }

  // ---- context menu -------------------------------------------------------------------------------------
  function onContextMenu(event) {
    const v = view();
    if (!v) return;
    const selection = v.getSelection();
    const pageIndex = v.pageIndexAt(event.clientX, event.clientY);
    if (!selection && pageIndex < 0) return;
    event.preventDefault();
    const anchor = { getBoundingClientRect: () => ({ left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY, width: 0, height: 0 }), focus() {}, contains: () => false, setAttribute() {}, removeAttribute() {} };
    const items = [];
    if (selection) {
      items.push(
        { label: 'Copy', icon: 'copy', shortcut: MENU_KEYS['edit:copy'], onSelect: () => app.commands.run('edit:copy', undefined, 'api') },
        { type: 'separator' },
        { label: 'Highlight', icon: 'highlight', onSelect: () => app.commands.run('annot:markup-selection', 'highlight', 'api') },
        { label: 'Underline', icon: 'underline', onSelect: () => app.commands.run('annot:markup-selection', 'underline', 'api') },
        { label: 'Strikethrough', icon: 'strikeout', onSelect: () => app.commands.run('annot:markup-selection', 'strikeout', 'api') },
        { label: 'Squiggly', icon: 'squiggly', onSelect: () => app.commands.run('annot:markup-selection', 'squiggly', 'api') }
      );
      if (app.commands.has('view:read-aloud')) items.push({ type: 'separator' }, { label: 'Read selection out loud', icon: 'speaker', onSelect: () => app.commands.run('view:read-aloud', 'selection', 'api') });
    } else {
      const pt = v.clientToPdf(pageIndex, event.clientX, event.clientY);
      items.push(
        { label: 'Add sticky note here', icon: 'note', onSelect: () => placeNote(pageIndex, pt) },
        { label: 'Add text box', icon: 'text', onSelect: () => app.commands.run('tool:text', undefined, 'api') },
        { type: 'separator' },
        { label: 'Delete annotation here', icon: 'trash', onSelect: () => eraseAt(pageIndex, pt.x, pt.y) },
        { label: 'Edit comment here…', icon: 'edit', onSelect: async () => {
          const hit = await annotationAt(pageIndex, pt.x, pt.y);
          if (hit) editAnnotationText(hit);
          else app.dialogs.toast('No annotation here', { timeout: 1200 });
        } },
        { type: 'separator' },
        { label: 'Select all text', icon: 'text-select', onSelect: () => app.commands.run('edit:select-all', undefined, 'api') }
      );
    }
    app.dialogs.popover(anchor, items);
  }

  // ---- helpers -----------------------------------------------------------------------------------------
  function pickImage() {
    return new Promise((resolve) => {
      if (window.__folioTest?.nextImageBlob) {
        const blob = window.__folioTest.nextImageBlob;
        window.__folioTest.nextImageBlob = null;
        resolve(blob);
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const file = input.files?.[0] ?? null;
        input.remove();
        resolve(file);
      });
      input.addEventListener('cancel', () => {
        input.remove();
        resolve(null);
      });
      input.click();
    });
  }

  async function chooseStamp() {
    return new Promise((resolve) => {
      const content = document.createElement('div');
      content.className = 'stamp-picker';
      for (const text of s().stampPresets ?? []) {
        const b = document.createElement('button');
        b.className = 'stamp-preset';
        b.type = 'button';
        b.textContent = text;
        b.addEventListener('click', () => {
          close(text);
        });
        content.appendChild(b);
      }
      const custom = document.createElement('input');
      custom.className = 'input';
      custom.placeholder = 'Custom text…';
      content.appendChild(custom);
      let closeFn = null;
      const close = (value) => {
        closeFn?.(value);
      };
      app.dialogs
        .open({
          title: 'Choose a stamp',
          content,
          buttons: [{ label: 'Cancel', value: null }, { label: 'Use custom text', value: 'custom', primary: true }],
          onOpen: (_dialog, closeDialog) => {
            closeFn = closeDialog;
          },
        })
        .then((result) => resolve(result === 'custom' ? custom.value.trim() || null : result));
    });
  }
}
