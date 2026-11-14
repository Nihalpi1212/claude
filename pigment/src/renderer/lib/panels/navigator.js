// Navigator panel (bottom group): a thumbnail of the composite with the visible area outlined in
// red. Drag in the thumbnail to pan; the slider, buttons and field set the zoom.
import { icon } from '../icons.js';
import { createCanvas } from '../document.js';
import { MIN_ZOOM, MAX_ZOOM } from '../canvas-view.js';

const MAX_H = 200;
const LMIN = Math.log(MIN_ZOOM), LMAX = Math.log(MAX_ZOOM);
const zoomToT = (z) => Math.round(((Math.log(z) - LMIN) / (LMAX - LMIN)) * 1000);
const tToZoom = (t) => Math.exp(LMIN + (t / 1000) * (LMAX - LMIN));

export function install(app) {
  const el = document.createElement('div');
  el.className = 'navigator';
  el.innerHTML = `
    <div class="nav-stage"><canvas class="nav-canvas" aria-label="Navigator: drag to move the view"></canvas><div class="panel-empty nav-empty">No document open</div></div>
    <div class="nav-zoom">
      <button class="pbtn" data-act="out" title="Zoom out">${icon('zoom-out')}</button>
      <input type="range" min="0" max="1000" step="1" aria-label="Zoom">
      <button class="pbtn" data-act="in" title="Zoom in">${icon('zoom-in')}</button>
      <span class="nav-pct"><input class="input num" type="text" aria-label="Zoom percentage">%</span>
    </div>
    <div class="nav-actions">
      <button class="btn small" data-act="fit" title="Fit on screen">Fit</button>
      <button class="btn small" data-act="100" title="Actual pixels">100%</button>
      <button class="btn small" data-act="fill" title="Fill the window">Fill</button>
    </div>`;
  const stage = el.querySelector('.nav-stage');
  const canvas = el.querySelector('.nav-canvas');
  const emptyMsg = el.querySelector('.nav-empty');
  const range = el.querySelector('input[type="range"]');
  const pct = el.querySelector('.nav-pct input');
  const thumb = { canvas: null, key: '', scale: 1, w: 1, h: 1 };
  let timer = 0;
  let raf = 0;
  let dragging = null;

  const visible = () => app.panels.isVisible('navigator');

  function layout(doc) {
    const avail = Math.max(60, (stage.clientWidth || el.clientWidth || 280) - 2);
    const s = Math.min(avail / doc.width, MAX_H / doc.height);
    return { w: Math.max(1, Math.round(doc.width * s)), h: Math.max(1, Math.round(doc.height * s)), scale: s };
  }

  function refreshThumb() {
    timer = 0;
    const doc = app.doc;
    if (!doc || !visible()) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h, scale } = layout(doc);
    const key = `${doc.id}:${doc.version}:${w}x${h}:${dpr}`;
    if (thumb.key !== key) {
      const c = thumb.canvas && thumb.canvas.width === Math.round(w * dpr) && thumb.canvas.height === Math.round(h * dpr) ? thumb.canvas : createCanvas(Math.round(w * dpr), Math.round(h * dpr));
      const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.imageSmoothingQuality = 'medium';
      try {
        ctx.drawImage(doc.view.compositor.composite(doc), 0, 0, c.width, c.height);
      } catch (err) {
        console.warn('navigator thumbnail', err);
      }
      Object.assign(thumb, { canvas: c, key, scale, w, h });
    }
    drawOverlay();
  }

  function drawOverlay() {
    raf = 0;
    const doc = app.doc;
    const view = app.view;
    canvas.hidden = !doc;
    emptyMsg.hidden = !!doc;
    if (!doc || !view || !thumb.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== thumb.canvas.width || canvas.height !== thumb.canvas.height) {
      canvas.width = thumb.canvas.width;
      canvas.height = thumb.canvas.height;
    }
    canvas.style.width = `${thumb.w}px`;
    canvas.style.height = `${thumb.h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(thumb.canvas, 0, 0);
    // visible area (a rotated view gives a rotated quad)
    const kx = canvas.width / doc.width, ky = canvas.height / doc.height;
    const corners = [view.toDoc(0, 0), view.toDoc(view.cssWidth, 0), view.toDoc(view.cssWidth, view.cssHeight), view.toDoc(0, view.cssHeight)].map((p) => [p.x * kx, p.y * ky]);
    const quad = new Path2D();
    corners.forEach(([x, y], i) => (i ? quad.lineTo(x, y) : quad.moveTo(x, y)));
    quad.closePath();
    const outside = new Path2D();
    outside.rect(0, 0, canvas.width, canvas.height);
    outside.addPath(quad);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fill(outside, 'evenodd');
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.strokeStyle = '#ff2a2a';
    ctx.stroke(quad);
  }

  function syncZoom() {
    const view = app.view;
    const on = !!view;
    for (const c of el.querySelectorAll('.nav-zoom button, .nav-zoom input, .nav-actions button')) c.disabled = !on;
    if (!view) {
      pct.value = '';
      return;
    }
    if (document.activeElement !== range) range.value = String(zoomToT(view.zoom));
    if (document.activeElement !== pct) pct.value = String(Math.round(view.zoom * 1000) / 10);
  }

  const scheduleThumb = (delay = 150) => {
    if (!visible()) return;
    clearTimeout(timer);
    timer = setTimeout(refreshThumb, delay);
  };
  const scheduleOverlay = () => {
    if (raf || !visible()) return;
    raf = requestAnimationFrame(drawOverlay);
  };

  // ---- panning by dragging in the thumbnail --------------------------------------------------------------------
  function docPoint(e) {
    const r = canvas.getBoundingClientRect();
    const doc = app.doc;
    return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * doc.width, y: ((e.clientY - r.top) / Math.max(1, r.height)) * doc.height };
  }
  function centerOn(p) {
    const view = app.view;
    const s = view.toScreen(p.x, p.y);
    view.panBy(view.cssWidth / 2 - s.x, view.cssHeight / 2 - s.y);
  }
  canvas.addEventListener('pointerdown', (e) => {
    const view = app.view;
    if (!view || e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = docPoint(e);
    const center = view.toDoc(view.cssWidth / 2, view.cssHeight / 2);
    const vis = view.visibleRect();
    const inside = vis && p.x >= vis.x && p.y >= vis.y && p.x <= vis.x + vis.width && p.y <= vis.y + vis.height;
    dragging = { dx: inside ? p.x - center.x : 0, dy: inside ? p.y - center.y : 0 };
    if (!inside) centerOn(p);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging || !app.view) return;
    const p = docPoint(e);
    centerOn({ x: p.x - dragging.dx, y: p.y - dragging.dy });
  });
  const end = () => (dragging = null);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    if (!app.view) return;
    e.preventDefault();
    app.view.setZoom(app.view.zoom * Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  // ---- zoom controls ---------------------------------------------------------------------------------------------
  range.addEventListener('input', () => app.view?.setZoom(tToZoom(Number(range.value))));
  pct.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const v = parseFloat(pct.value);
      if (Number.isFinite(v) && v > 0) app.view?.setZoom(v / 100);
      pct.blur();
    } else if (e.key === 'Escape') {
      syncZoom();
      pct.blur();
    }
  });
  pct.addEventListener('blur', syncZoom);
  const act = (a, fn) => el.querySelector(`[data-act="${a}"]`).addEventListener('click', fn);
  act('out', () => app.view?.zoomStep(-1));
  act('in', () => app.view?.zoomStep(1));
  act('fit', () => app.commands.run('view:zoom-fit', undefined, 'panel'));
  act('100', () => app.commands.run('view:zoom-100', undefined, 'panel'));
  act('fill', () => app.commands.run('view:zoom-fill', undefined, 'panel'));

  // ---- events --------------------------------------------------------------------------------------------------
  app.on('view:changed', () => {
    syncZoom();
    scheduleOverlay();
  });
  app.on('doc:activated', () => {
    syncZoom();
    thumb.key = '';
    if (!app.doc) drawOverlay();
    scheduleThumb(0);
  });
  app.on('doc:change', (e) => {
    if (e.doc !== app.doc || ['selection', 'guides', 'active', 'mask-edit'].includes(e.kind)) return;
    scheduleThumb(e.kind === 'pixels' || e.kind === 'mask' ? 250 : 120);
  });
  new ResizeObserver(() => {
    if (app.doc && visible()) scheduleThumb(60);
  }).observe(stage);

  app.panels.register({
    id: 'navigator',
    title: 'Navigator',
    icon: 'navigator',
    element: el,
    group: 'bottom',
    onShow: () => {
      syncZoom();
      requestAnimationFrame(refreshThumb);
    },
  });
  syncZoom();
  drawOverlay();
}
