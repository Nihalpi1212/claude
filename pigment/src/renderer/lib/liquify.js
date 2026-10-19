// Filter › Liquify: push, twirl, pucker and bloat pixels with a brush in a full-window dialog.
// The edit is a backward displacement field (each output pixel samples the source at p + d(p))
// kept on a coarse grid, previewed at screen resolution and applied at full resolution on OK
// through a pixel-edit session (so the selection limits it and it is one undo step).
import { icon } from './icons.js';
import { beginPixelEdit } from './adjust-ui.js';

const TOOLS = [
  ['warp', 'Forward Warp', 'smudge', 'W'],
  ['reconstruct', 'Reconstruct', 'history', 'R'],
  ['twirl', 'Twirl Clockwise', 'rotate-cw', 'C'],
  ['pucker', 'Pucker', 'zoom-out', 'S'],
  ['bloat', 'Bloat', 'zoom-in', 'B'],
];

/** Bilinear sample of a straight-alpha RGBA image (edge-clamped, transparent outside). */
function sample(src, w, h, x, y, out, o) {
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  x = Math.min(w - 1, Math.max(0, x - 0.5));
  y = Math.min(h - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  // premultiplied interpolation so transparent pixels do not darken edges
  const a00 = src[i00 + 3] * w00, a10 = src[i10 + 3] * w10, a01 = src[i01 + 3] * w01, a11 = src[i11 + 3] * w11;
  const a = a00 + a10 + a01 + a11;
  if (a <= 0) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) out[o + c] = (src[i00 + c] * a00 + src[i10 + c] * a10 + src[i01 + c] * a01 + src[i11 + c] * a11) / a;
  out[o + 3] = a;
}

export class DisplacementField {
  constructor(width, height, cell) {
    this.w = width;
    this.h = height;
    this.cell = cell;
    this.gw = Math.ceil(width / cell) + 1;
    this.gh = Math.ceil(height / cell) + 1;
    this.dx = new Float32Array(this.gw * this.gh);
    this.dy = new Float32Array(this.gw * this.gh);
  }
  /** Displacement at an image point (bilinear on the grid). */
  at(x, y, out) {
    const gx = Math.min(this.gw - 1.001, Math.max(0, x / this.cell)), gy = Math.min(this.gh - 1.001, Math.max(0, y / this.cell));
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = gx - x0, fy = gy - y0;
    const i = y0 * this.gw + x0;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = this.dx[i] * w00 + this.dx[i + 1] * w10 + this.dx[i + this.gw] * w01 + this.dx[i + this.gw + 1] * w11;
    out[1] = this.dy[i] * w00 + this.dy[i + 1] * w10 + this.dy[i + this.gw] * w01 + this.dy[i + this.gw + 1] * w11;
    return out;
  }
  isIdentity() {
    for (let i = 0; i < this.dx.length; i++) if (Math.abs(this.dx[i]) > 1e-3 || Math.abs(this.dy[i]) > 1e-3) return false;
    return true;
  }
  clone() {
    const f = new DisplacementField(this.w, this.h, this.cell);
    f.dx.set(this.dx);
    f.dy.set(this.dy);
    return f;
  }
  /**
   * Applies a brush dab centred at (cx, cy) with radius r (image px).
   * tool: warp (needs mx, my: the pointer movement), reconstruct, twirl, pucker, bloat.
   */
  brush(tool, cx, cy, r, strength, mx = 0, my = 0) {
    const { cell, gw, gh } = this;
    const gx0 = Math.max(0, Math.floor((cx - r) / cell)), gx1 = Math.min(gw - 1, Math.ceil((cx + r) / cell));
    const gy0 = Math.max(0, Math.floor((cy - r) / cell)), gy1 = Math.min(gh - 1, Math.ceil((cy + r) / cell));
    const tmp = [0, 0];
    const old = tool === 'warp' ? this.clone() : null;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const px = gx * cell, py = gy * cell;
        const ddx = px - cx, ddy = py - cy;
        const d2 = (ddx * ddx + ddy * ddy) / (r * r);
        if (d2 >= 1) continue;
        const f = (1 - d2) * (1 - d2) * strength;
        const i = gy * gw + gx;
        if (tool === 'warp') {
          // the content under the brush follows the pointer: sample where the point came from
          const k = Math.min(1, f * 2);
          old.at(px - mx * k, py - my * k, tmp);
          this.dx[i] = tmp[0] - mx * k;
          this.dy[i] = tmp[1] - my * k;
        } else if (tool === 'reconstruct') {
          this.dx[i] *= 1 - f * 0.5;
          this.dy[i] *= 1 - f * 0.5;
        } else if (tool === 'twirl') {
          // content turns clockwise: sample from the point rotated counter-clockwise (y points down)
          const a = 0.15 * f;
          const ca = Math.cos(a), sa = Math.sin(a);
          const sx = px + this.dx[i] - cx, sy = py + this.dy[i] - cy;
          this.dx[i] = cx + sx * ca + sy * sa - px;
          this.dy[i] = cy - sx * sa + sy * ca - py;
        } else if (tool === 'pucker' || tool === 'bloat') {
          // pucker samples farther out (content shrinks toward the centre), bloat samples closer in
          const k = (tool === 'pucker' ? 0.06 : -0.06) * f;
          this.dx[i] += ddx * k;
          this.dy[i] += ddy * k;
        }
      }
    }
  }
  /** Renders src (w×h RGBA) through the field into out (ow×oh), out pixel (x, y) ↔ image (x·sx, y·sy). */
  render(src, out, ow, oh, scaleX = 1, scaleY = 1) {
    const d = [0, 0];
    for (let y = 0; y < oh; y++) {
      const iy = (y + 0.5) * scaleY;
      for (let x = 0; x < ow; x++) {
        const ix = (x + 0.5) * scaleX;
        this.at(ix, iy, d);
        sample(src, this.w, this.h, ix + d[0], iy + d[1], out, (y * ow + x) * 4);
      }
    }
  }
}

export function install(app) {
  async function liquify() {
    const session = beginPixelEdit(app, { label: 'Liquify' });
    if (!session) return;
    const base = session.base;
    const w = base.width, h = base.height;
    const cell = Math.max(2, Math.ceil(Math.max(w, h) / 512));
    let field = new DisplacementField(w, h, cell);
    const undo = [];
    let tool = 'warp';
    let size = Math.round(Math.min(200, Math.max(20, Math.min(w, h) / 6)));
    let pressure = 0.5;

    const root = document.createElement('div');
    root.className = 'liquify';
    root.innerHTML = `
      <div class="liquify-tools"></div>
      <div class="liquify-stage"><canvas class="liquify-canvas"></canvas></div>
      <div class="liquify-options dialog-form">
        <div class="field span-all"><label>Brush size</label><div class="slider-field"><input type="range" min="2" max="1500" data-opt="size"><input class="input" type="number" min="2" max="1500" data-opt="size-num"></div></div>
        <div class="field span-all"><label>Brush pressure</label><div class="slider-field"><input type="range" min="1" max="100" data-opt="pressure"><input class="input" type="number" min="1" max="100" data-opt="pressure-num"></div></div>
        <div class="span-all" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
          <button type="button" class="btn small" data-act="undo">Undo stroke</button>
          <button type="button" class="btn small" data-act="restore">Restore All</button>
        </div>
        <p class="muted span-all" style="font-size:11px;margin:8px 0 0">[ and ] change the brush size. Alt+drag in Forward Warp reconstructs.</p>
      </div>`;
    const toolsEl = root.querySelector('.liquify-tools');
    for (const [id, name, ic, key] of TOOLS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tool-button';
      b.dataset.tool = id;
      b.title = `${name} (${key})`;
      b.innerHTML = icon(ic);
      b.addEventListener('click', () => setTool(id));
      toolsEl.appendChild(b);
    }
    const setTool = (id) => {
      tool = id;
      for (const b of toolsEl.children) b.setAttribute('aria-pressed', String(b.dataset.tool === id));
    };
    setTool('warp');
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const sizeRange = root.querySelector('[data-opt="size"]'), sizeNum = root.querySelector('[data-opt="size-num"]');
    const presRange = root.querySelector('[data-opt="pressure"]'), presNum = root.querySelector('[data-opt="pressure-num"]');
    const syncOpts = () => {
      sizeRange.value = sizeNum.value = String(size);
      presRange.value = presNum.value = String(Math.round(pressure * 100));
    };
    syncOpts();
    for (const el of [sizeRange, sizeNum]) el.addEventListener('input', () => {
      size = Math.max(2, Math.min(1500, Number(el.value) || size));
      syncOpts();
    });
    for (const el of [presRange, presNum]) el.addEventListener('input', () => {
      pressure = Math.max(0.01, Math.min(1, (Number(el.value) || 50) / 100));
      syncOpts();
    });

    // preview geometry: fit the image in the stage
    let scale = 1, pw = 1, ph = 1, img = null, pointer = null;
    const layout = () => {
      const stage = root.querySelector('.liquify-stage').getBoundingClientRect();
      scale = Math.min(8, (stage.width - 16) / w, (stage.height - 16) / h);
      pw = Math.max(1, Math.round(w * scale));
      ph = Math.max(1, Math.round(h * scale));
      canvas.width = pw;
      canvas.height = ph;
      img = ctx.createImageData(pw, ph);
      draw();
    };
    let raf = 0;
    const draw = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!img) return;
        field.render(base.data, img.data, pw, ph, w / pw, h / ph);
        ctx.putImageData(img, 0, 0);
        if (pointer) {
          ctx.beginPath();
          ctx.arc(pointer.x, pointer.y, (size / 2) * scale, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(0,0,0,0.8)';
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(pointer.x, pointer.y, (size / 2) * scale + 1, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.stroke();
        }
      });
    };

    let drag = null;
    let timer = 0;
    const toImage = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: ((e.clientX - r.left) / r.width) * w, y: ((e.clientY - r.top) / r.height) * h, cx: ((e.clientX - r.left) / r.width) * pw, cy: ((e.clientY - r.top) / r.height) * ph };
    };
    const dab = (p, mx = 0, my = 0, alt = false) => {
      const t = alt && tool === 'warp' ? 'reconstruct' : tool;
      field.brush(t, p.x, p.y, size / 2, pressure, mx, my);
      draw();
    };
    canvas.tabIndex = 0; // keeps Ctrl+Z, [ ] and the tool letters inside the dialog after a stroke
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(e.pointerId);
      undo.push(field.clone());
      if (undo.length > 30) undo.shift();
      const p = toImage(e);
      drag = { last: p, alt: e.altKey };
      if (tool !== 'warp') {
        dab(p, 0, 0, e.altKey);
        // twirl / pucker / bloat / reconstruct keep working while the button is held
        clearInterval(timer);
        timer = setInterval(() => drag && dab(drag.last, 0, 0, drag.alt), 40);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = toImage(e);
      pointer = { x: p.cx, y: p.cy };
      if (drag) {
        const mx = p.x - drag.last.x, my = p.y - drag.last.y;
        const dist = Math.hypot(mx, my);
        if (tool === 'warp') {
          // split long moves so fast drags stay smooth
          const steps = Math.max(1, Math.ceil(dist / Math.max(2, size / 8)));
          for (let i = 1; i <= steps; i++) dab({ x: drag.last.x + (mx * i) / steps, y: drag.last.y + (my * i) / steps }, mx / steps, my / steps, e.altKey);
        } else if (dist > 0) dab(p, 0, 0, e.altKey);
        drag.last = p;
        drag.alt = e.altKey;
      }
      draw();
    });
    const end = () => {
      drag = null;
      clearInterval(timer);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      pointer = null;
      draw();
    });
    root.querySelector('[data-act="undo"]').addEventListener('click', () => {
      if (undo.length) field = undo.pop();
      draw();
    });
    root.querySelector('[data-act="restore"]').addEventListener('click', () => {
      undo.push(field);
      field = new DisplacementField(w, h, cell);
      draw();
    });
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '[' || e.key === ']') {
        size = Math.max(2, Math.min(1500, Math.round(size * (e.key === ']' ? 1.15 : 1 / 1.15))));
        syncOpts();
        draw();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (undo.length) field = undo.pop();
        draw();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const t = TOOLS.find((x) => x[3].toLowerCase() === e.key.toLowerCase() && !e.ctrlKey && !e.metaKey);
      if (t) {
        setTool(t[0]);
        e.preventDefault();
      }
    };
    root.addEventListener('keydown', onKey);

    const ok = await app.dialogs.open({
      title: 'Liquify',
      content: root,
      className: 'full liquify-dialog',
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
      onOpen: () => requestAnimationFrame(layout),
    });
    clearInterval(timer);
    if (!ok || field.isIdentity()) {
      session.cancel();
      return;
    }
    try {
      const out = await app.busy('Liquify…', async () => {
        const result = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        field.render(base.data, result.data, w, h, 1, 1);
        return result;
      });
      session.commit('Liquify', out);
    } catch (err) {
      session.cancel();
      app.reportError(err, 'Liquify failed');
    }
  }

  app.commands.register('filter:liquify', { enabled: () => !!app.doc?.active, run: liquify, label: 'Liquify…' });
}
