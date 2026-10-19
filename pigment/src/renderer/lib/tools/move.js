// Move tool: drags the active layer(s) (or the selected pixels), auto-select, alignment buttons,
// arrow-key nudging; and the crop tool.
import { Tool } from '../tools.js';
import { beginLayerMove, offsetLayers } from '../layer-move.js';
import { createCanvas, RasterLayer } from '../document.js';
import { applySelection } from './select.js';
import { Selection } from '../selection.js';

export class MoveTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'move',
      name: 'Move Tool',
      icon: 'move',
      cursor: 'default',
      hint: 'Drag to move the layer. Alt-drag duplicates. Arrow keys nudge by 1 px (Shift: 10 px). Ctrl/Cmd-click selects the layer under the cursor.',
      options: [
        { kind: 'checkbox', key: 'autoSelect', label: 'Auto-select layer', default: false },
        { kind: 'checkbox', key: 'showTransform', label: 'Show transform controls', default: true },
        { kind: 'button', key: 'alignLeft', label: '', icon: 'align-left', onClick: (t) => t.app.commands.run('layer:align', 'left') },
        { kind: 'button', key: 'alignHCenter', label: '', icon: 'align-hcenter', onClick: (t) => t.app.commands.run('layer:align', 'hcenter') },
        { kind: 'button', key: 'alignRight', label: '', icon: 'align-right', onClick: (t) => t.app.commands.run('layer:align', 'right') },
        { kind: 'button', key: 'alignTop', label: '', icon: 'align-top', onClick: (t) => t.app.commands.run('layer:align', 'top') },
        { kind: 'button', key: 'alignVCenter', label: '', icon: 'align-vcenter', onClick: (t) => t.app.commands.run('layer:align', 'vcenter') },
        { kind: 'button', key: 'alignBottom', label: '', icon: 'align-bottom', onClick: (t) => t.app.commands.run('layer:align', 'bottom') },
      ],
    });
    this.drag = null;
  }
  activate() {
    this.keyHandler = (e) => this.nudge(e);
  }
  layersToMove(p) {
    const doc = this.doc;
    if ((this.opt('autoSelect') || p?.ctrl || p?.meta) && p) {
      const hit = this.hitTest(p);
      if (hit) doc.setActive(hit);
    }
    const chosen = doc.selectedLayers().filter((l) => !l.locked.position && !l.locked.all);
    if (chosen.length) return chosen;
    if (doc.active && !doc.active.locked.position && !doc.active.locked.all) return [doc.active];
    return [];
  }
  /** Topmost visible layer with an opaque pixel under p. */
  hitTest(p) {
    const doc = this.doc;
    const layers = doc.layers().filter((l) => l.visible && !l.isGroup && l.type !== 'adjustment').reverse();
    for (const l of layers) {
      const src = l.type === 'raster' ? { canvas: l.canvas, x: l.x, y: l.y } : l.render?.();
      if (!src) continue;
      const x = Math.floor(p.x - src.x), y = Math.floor(p.y - src.y);
      if (x < 0 || y < 0 || x >= src.canvas.width || y >= src.canvas.height) continue;
      const a = src.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3];
      if (a > 8) return l;
    }
    return null;
  }
  onPointerDown(p) {
    const doc = this.doc;
    const layers = this.layersToMove(p);
    if (!layers.length) {
      this.app.dialogs.toast('Nothing to move: the layer is locked or none is selected', { kind: 'error', timeout: 1800 });
      return;
    }
    const sel = doc.selection && !doc.selection.isEmpty ? doc.selection : null;
    this.drag = { start: p, layers, duplicate: p.alt, moved: false, sel, dx: 0, dy: 0, origin: layers.map((l) => ({ l, x: l.x, y: l.y })) };
    if (sel && layers.length === 1 && layers[0].type === 'raster' && !this.app.ui.editingMask) {
      // move the selected pixels: lift them into a floating layer first
      this.liftSelection(layers[0], sel, p.alt);
    } else if (p.alt) {
      this.duplicateLayers();
    }
  }
  liftSelection(layer, sel, keepOriginal) {
    const doc = this.doc;
    const b = sel.bounds;
    doc.history.group(keepOriginal ? 'Duplicate selection' : 'Move selection', () => {
      // cut the selected pixels into a new layer above
      const cut = createCanvas(b.width, b.height);
      const cctx = cut.getContext('2d');
      cctx.drawImage(layer.canvas, layer.x - b.x, layer.y - b.y);
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(sel.toCanvas(), -b.x, -b.y);
      if (!keepOriginal) {
        doc.history.pixels('Cut', layer.canvas, { x: b.x - layer.x, y: b.y - layer.y, width: b.width, height: b.height }, (ctx) => {
          ctx.save();
          ctx.globalCompositeOperation = 'destination-out';
          ctx.drawImage(sel.toCanvas(), -layer.x, -layer.y);
          ctx.restore();
        }, { layer });
      }
      const floating = new RasterLayer({ name: keepOriginal ? `${layer.name} copy` : layer.name, canvas: cut, x: b.x, y: b.y, opacity: layer.opacity, blend: layer.blend });
      floating.floating = keepOriginal ? null : layer; // merged back on commit
      const parent = layer.parent, index = parent.children.indexOf(layer) + 1;
      doc.history.run('Lift selection', () => {
        doc.add(floating, parent, index);
        doc.setActive(floating);
        return {
          undo: () => {
            doc.remove(floating);
            doc.setActive(layer);
          },
          redo: () => {
            doc.add(floating, parent, index);
            doc.setActive(floating);
          },
        };
      });
      this.drag.layers = [floating];
      this.drag.origin = [{ l: floating, x: floating.x, y: floating.y }];
      this.drag.floating = keepOriginal ? null : { layer, floating, selection: sel };
    });
  }
  duplicateLayers() {
    const doc = this.doc;
    const copies = [];
    doc.history.group('Duplicate layer', () => {
      for (const l of this.drag.layers) {
        const copy = this.app.duplicateLayer(l, { select: false });
        if (copy) copies.push(copy);
      }
      if (copies.length) doc.setActive(copies[copies.length - 1]);
    });
    if (copies.length) {
      this.drag.layers = copies;
      this.drag.origin = copies.map((l) => ({ l, x: l.x, y: l.y }));
    }
  }
  onPointerMove(p, dragging) {
    if (!dragging || !this.drag) return;
    let dx = Math.round(p.x - this.drag.start.x), dy = Math.round(p.y - this.drag.start.y);
    if (p.shift) {
      if (Math.abs(dx) > Math.abs(dy) * 2) dy = 0;
      else if (Math.abs(dy) > Math.abs(dx) * 2) dx = 0;
      else {
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * m;
        dy = Math.sign(dy) * m;
      }
    }
    if (this.app.settings.snap) [dx, dy] = this.snapDelta(dx, dy);
    if (dx === this.drag.dx && dy === this.drag.dy) return;
    this.drag.dx = dx;
    this.drag.dy = dy;
    this.drag.moved = true;
    if (!this.drag.session) this.drag.session = beginLayerMove(this.doc, this.drag.origin.map((o) => o.l));
    this.drag.session.set(dx, dy);
  }
  snapDelta(dx, dy) {
    const doc = this.doc;
    const tol = 6 / this.view.zoom;
    const first = this.drag.origin[0];
    const b = first.l.bounds();
    if (!b) return [dx, dy];
    const targetsX = [0, doc.width / 2, doc.width, ...doc.guides.filter((g) => g.axis === 'x').map((g) => g.pos)];
    const targetsY = [0, doc.height / 2, doc.height, ...doc.guides.filter((g) => g.axis === 'y').map((g) => g.pos)];
    const edgesX = [first.x + dx, first.x + dx + b.width / 2, first.x + dx + b.width];
    const edgesY = [first.y + dy, first.y + dy + b.height / 2, first.y + dy + b.height];
    for (const e of edgesX) for (const t of targetsX) if (Math.abs(e - t) <= tol) return this.snapDelta2(dx + Math.round(t - e), dy, edgesY, targetsY, tol);
    return this.snapDelta2(dx, dy, edgesY, targetsY, tol);
  }
  snapDelta2(dx, dy, edgesY, targetsY, tol) {
    for (const e of edgesY) for (const t of targetsY) if (Math.abs(e - t) <= tol) return [dx, dy + Math.round(t - e)];
    return [dx, dy];
  }
  onPointerUp(p) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (!d.moved || p.cancelled) {
      if (d.moved && p.cancelled) d.session?.reset();
      if (d.floating) this.commitFloating(d.floating, 0, 0);
      return;
    }
    const doc = this.doc;
    const { dx, dy } = d;
    d.session?.commit(d.floating ? 'Move selection' : 'Move');
    if (d.floating) this.commitFloating(d.floating, dx, dy);
    if (d.sel && !d.floating) {
      // moving a whole layer with a selection active moves the selection too
      const moved = d.sel.resized(doc.width, doc.height, dx, dy);
      applySelection(this.app, moved, 'replace', 'Move selection');
    }
  }
  /** Merges the floating selection layer back into its source layer and moves the selection with it. */
  commitFloating({ layer, floating, selection }, dx, dy) {
    const doc = this.doc;
    doc.history.group('Move selection', () => {
      const b = { x: floating.x, y: floating.y, width: floating.canvas.width, height: floating.canvas.height };
      layer.ensureCovers(b);
      doc.history.pixels('Merge', layer.canvas, { x: b.x - layer.x, y: b.y - layer.y, width: b.width, height: b.height }, (ctx) => {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.drawImage(floating.canvas, b.x - layer.x, b.y - layer.y);
        ctx.restore();
      }, { layer });
      const parent = floating.parent, index = parent.children.indexOf(floating);
      doc.history.run('Drop floating', () => {
        doc.remove(floating);
        doc.setActive(layer);
        return {
          undo: () => {
            doc.add(floating, parent, index);
            doc.setActive(floating);
          },
          redo: () => {
            doc.remove(floating);
            doc.setActive(layer);
          },
        };
      });
      applySelection(this.app, selection.resized(doc.width, doc.height, dx, dy), 'replace', 'Move selection');
    });
  }
  /** Arrow keys: nudge by 1 (Shift 10). Returns true when handled. */
  onKeyDown(e) {
    const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const v = map[e.key];
    if (!v) return false;
    const layers = this.layersToMove(null);
    if (!layers.length) return false;
    const k = e.shiftKey ? 10 : 1;
    const dx = v[0] * k, dy = v[1] * k;
    const doc = this.doc;
    offsetLayers(doc, layers, dx, dy, 'Nudge');
    return true;
  }
  drawOverlay(ctx, view) {
    if (this.opt('showTransform') === false) return;
    const layer = this.doc?.active;
    if (!layer || layer.type === 'adjustment' || layer.type === 'fill') return;
    const b = layer.bounds();
    if (!b) return;
    const a = view.toScreen(b.x, b.y), c = view.toScreen(b.x + b.width, b.y + b.height);
    ctx.save();
    ctx.strokeStyle = 'rgba(79,129,255,0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
    ctx.fillStyle = '#fff';
    for (const [x, y] of [[a.x, a.y], [c.x, a.y], [a.x, c.y], [c.x, c.y], [(a.x + c.x) / 2, a.y], [(a.x + c.x) / 2, c.y], [a.x, (a.y + c.y) / 2], [c.x, (a.y + c.y) / 2]]) {
      ctx.fillRect(Math.round(x) - 3, Math.round(y) - 3, 6, 6);
      ctx.strokeRect(Math.round(x) - 3 + 0.5, Math.round(y) - 3 + 0.5, 6, 6);
    }
    ctx.restore();
  }
  onDoubleClick() {
    this.app.commands.run('edit:free-transform');
  }
}

function shiftCanvas(canvas, dx, dy) {
  const copy = createCanvas(canvas.width, canvas.height);
  copy.getContext('2d').drawImage(canvas, 0, 0);
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'copy';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(copy, dx, dy);
  ctx.restore();
}

export class CropTool extends Tool {
  constructor(app) {
    super(app, {
      id: 'crop',
      name: 'Crop Tool',
      icon: 'crop',
      cursor: 'crosshair',
      hint: 'Drag a crop box (or use the whole canvas), adjust the handles, then press Enter or double-click. Esc cancels.',
      options: [
        { kind: 'select', key: 'ratio', label: 'Ratio', options: [['free', 'Free'], ['1:1', '1 : 1'], ['4:3', '4 : 3'], ['3:2', '3 : 2'], ['16:9', '16 : 9'], ['original', 'Original ratio'], ['custom', 'Custom']], default: 'free' },
        { kind: 'number', key: 'ratioW', label: 'W', min: 1, default: 4, when: (t) => t.opt('ratio') === 'custom' },
        { kind: 'number', key: 'ratioH', label: 'H', min: 1, default: 3, when: (t) => t.opt('ratio') === 'custom' },
        { kind: 'checkbox', key: 'deletePixels', label: 'Delete cropped pixels', default: true },
        { kind: 'select', key: 'overlay', label: 'Overlay', options: [['thirds', 'Rule of thirds'], ['grid', 'Grid'], ['golden', 'Golden ratio'], ['none', 'None']], default: 'thirds' },
        { kind: 'button', key: 'reset', label: 'Reset', onClick: (t) => t.resetBox() },
        { kind: 'button', key: 'apply', label: 'Crop', onClick: (t) => t.commit() },
      ],
    });
    this.box = null;
    this.drag = null;
  }
  activate() {
    this.resetBox();
  }
  deactivate() {
    this.box = null;
  }
  resetBox() {
    if (!this.doc) return;
    this.box = { x: 0, y: 0, width: this.doc.width, height: this.doc.height };
    this.pristine = true; // dragging inside the untouched full-canvas box draws a new box
    this.view?.invalidate();
  }
  ratio() {
    const r = this.opt('ratio');
    if (r === 'free') return null;
    if (r === 'original') return this.doc.width / this.doc.height;
    if (r === 'custom') return (this.opt('ratioW') || 1) / (this.opt('ratioH') || 1);
    const [a, b] = r.split(':').map(Number);
    return a / b;
  }
  handleAt(p) {
    if (!this.box) return null;
    const b = this.box;
    const s = this.view.toScreen.bind(this.view);
    const tol = 8;
    const corners = { nw: [b.x, b.y], ne: [b.x + b.width, b.y], sw: [b.x, b.y + b.height], se: [b.x + b.width, b.y + b.height], n: [b.x + b.width / 2, b.y], s: [b.x + b.width / 2, b.y + b.height], w: [b.x, b.y + b.height / 2], e: [b.x + b.width, b.y + b.height / 2] };
    for (const [k, [x, y]] of Object.entries(corners)) {
      const q = s(x, y);
      if (Math.abs(q.x - p.screenX) <= tol && Math.abs(q.y - p.screenY) <= tol) return k;
    }
    if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return 'move';
    return null;
  }
  onPointerDown(p) {
    let h = this.handleAt(p);
    if (h === 'move' && this.pristine) h = null;
    this.pristine = false;
    if (h) this.drag = { handle: h, start: p, box: { ...this.box } };
    else this.drag = { handle: 'new', start: p, box: { x: p.x, y: p.y, width: 0, height: 0 } };
  }
  onPointerMove(p, dragging) {
    if (!dragging) {
      const h = this.handleAt(p);
      this.view.setCursor(h === 'move' ? 'move' : h ? `${h}-resize` : 'crosshair');
      return;
    }
    if (!this.drag) return;
    const d = this.drag;
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    let b = { ...d.box };
    if (d.handle === 'new') {
      b = { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), width: Math.abs(dx), height: Math.abs(dy) };
    } else if (d.handle === 'move') {
      b.x += dx;
      b.y += dy;
    } else {
      if (d.handle.includes('w')) {
        b.x += dx;
        b.width -= dx;
      }
      if (d.handle.includes('e')) b.width += dx;
      if (d.handle.includes('n')) {
        b.y += dy;
        b.height -= dy;
      }
      if (d.handle.includes('s')) b.height += dy;
    }
    const ratio = this.ratio();
    if (ratio && d.handle !== 'move') {
      if (d.handle === 'n' || d.handle === 's') b.width = b.height * ratio;
      else b.height = b.width / ratio;
    }
    if (b.width < 0) {
      b.x += b.width;
      b.width = -b.width;
    }
    if (b.height < 0) {
      b.y += b.height;
      b.height = -b.height;
    }
    this.box = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) };
    this.app.statusbar.set('hint', `Crop ${this.box.width} × ${this.box.height} px`);
  }
  onPointerUp() {
    if (this.drag?.handle === 'new' && this.box && (this.box.width < 2 || this.box.height < 2)) this.resetBox();
    this.drag = null;
  }
  onDoubleClick() {
    this.commit();
  }
  commit() {
    if (!this.box) return false;
    const b = this.box;
    if (b.width === this.doc.width && b.height === this.doc.height && b.x === 0 && b.y === 0) return true;
    this.app.cropDocument(b, { deletePixels: this.opt('deletePixels') !== false });
    this.resetBox();
    return true;
  }
  cancel() {
    this.resetBox();
    return true;
  }
  drawOverlay(ctx, view) {
    if (!this.box) return;
    const b = this.box;
    const a = view.toScreen(b.x, b.y), c = view.toScreen(b.x + b.width, b.y + b.height);
    ctx.save();
    // darken outside
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, view.cssWidth, view.cssHeight);
    ctx.rect(a.x, a.y, c.x - a.x, c.y - a.y);
    ctx.fill('evenodd');
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, Math.round(c.x - a.x), Math.round(c.y - a.y));
    const overlay = this.opt('overlay');
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    const w = c.x - a.x, h = c.y - a.y;
    const lines = overlay === 'thirds' ? [1 / 3, 2 / 3] : overlay === 'golden' ? [0.382, 0.618] : overlay === 'grid' ? [0.25, 0.5, 0.75] : [];
    for (const f of lines) {
      ctx.moveTo(a.x + w * f, a.y);
      ctx.lineTo(a.x + w * f, c.y);
      ctx.moveTo(a.x, a.y + h * f);
      ctx.lineTo(c.x, a.y + h * f);
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const [x, y] of [[a.x, a.y], [c.x, a.y], [a.x, c.y], [c.x, c.y], [(a.x + c.x) / 2, a.y], [(a.x + c.x) / 2, c.y], [a.x, (a.y + c.y) / 2], [c.x, (a.y + c.y) / 2]]) ctx.fillRect(Math.round(x) - 4, Math.round(y) - 4, 8, 8);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.font = '11px system-ui';
    const label = `${b.width} × ${b.height}`;
    ctx.fillRect(a.x, a.y - 18, ctx.measureText(label).width + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, a.x + 4, a.y - 6);
    ctx.restore();
  }
}

export function install(app) {
  app.tools.register(new MoveTool(app), 'move');
  app.tools.register(new CropTool(app), 'crop');
}

export { Selection };
