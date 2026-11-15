// The Curves editor (adjust-tonal; registered with app.adjustEditors by lib/adjust/tonal.js, I.2): Photoshop's
// dialog body. Channels by document mode (J.9 `space`); the point mode (click to add, drag, drag off the graph or
// Delete to remove, arrows to nudge) and the pencil mode (draw the curve, Smooth; J.9 `{ table }`); the black and
// white point sliders under the graph (Alt-drag or Show Clipping shows the clipping display); Input / Output fields;
// the Curve Display Options (Light or Pigment/Ink, grid size, channel overlays, histogram, baseline, intersection
// line; kept in settings.adjust.curvesDisplay); and as capabilities the eyedroppers, the on-image tool (click a tone
// in the image, drag up or down), Auto with its options, and setParams.
import { TONAL_SPACES, tonalSpace, remapTonalSpace, autoTonalParams, curveChannelLut, curveLut, isTable, pointsFromTable, tableFromPoints, smoothTable, drawTable, normalisePoints, sampleInSpace } from '../../../shared/pixels/adjust-tonal.js';
import { sourceHistogram, drawHistogram, histKey, editorSpace, channelOptions, sliderTrack, selectRow } from './tonal-ui.js';
import { tonalEyedroppers } from './eyedroppers.js';
import { openAutoOptions, savedAutoOptions } from './auto-options.js';

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const MAX_POINTS = 16;
const DISPLAY_DEFAULTS = { pigment: false, detailed: false, overlays: true, histogram: true, baseline: true, intersection: true };
const CHANNEL_COLORS = { r: '#e04040', g: '#30b040', b: '#3070f0', c: '#00a0d8', m: '#d0208a', y: '#c8b400', k: '#555', l: '#888', a: '#c04080', b_lab: '#3080c0' };

/** The curve display options (settings.adjust.curvesDisplay over the defaults). */
export function curvesDisplay(app) {
  return { ...DISPLAY_DEFAULTS, ...(app?.settings?.adjust?.curvesDisplay ?? {}) };
}

/**
 * curvesEditor(kind, params, onChange, { source, app, clip }) -> editor (I.2). `clip(which | null)` (optional, the
 * dialog's) shows the clipping display while a black or white point slider moves with Show Clipping on or Alt held.
 */
export function curvesEditor(kind, params, onChange, { source = null, app = null, clip = null } = {}) {
  const space = editorSpace('curves', params, app);
  let p = tonalSpace(params) === space ? clone(params) : remapTonalSpace('curves', params ?? {}, space);
  p.space = space;
  const s = TONAL_SPACES[space];
  let channel = s.composite ?? s.channels[0];
  let selected = -1;
  let pencil = isTable(p[channel]);
  let showClipping = false;
  const display = curvesDisplay(app);
  const hist = sourceHistogram(source);

  const el = document.createElement('div');
  el.className = 'curves-editor tonal-editor';
  el.dataset.space = space;

  // ---- top row: channel, mode, Smooth
  const top = document.createElement('div');
  top.className = 'tonal-row curves-top';
  const chanRow = selectRow('Channel', channelOptions(space), channel, (v) => {
    channel = v;
    selected = -1;
    pencil = isTable(p[channel]);
    sync();
  }, { dataKey: '__channel' });
  const modeWrap = document.createElement('div');
  modeWrap.className = 'opt-segment curves-mode';
  const modeBtn = (mode, title, glyph) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-button';
    b.dataset.mode = mode;
    b.title = title;
    b.textContent = glyph;
    b.addEventListener('click', () => setMode(mode === 'pencil'));
    modeWrap.appendChild(b);
    return b;
  };
  const pointsBtn = modeBtn('points', 'Edit points to modify the curve', 'Points');
  const pencilBtn = modeBtn('pencil', 'Draw to modify the curve', 'Pencil');
  const smoothBtn = document.createElement('button');
  smoothBtn.type = 'button';
  smoothBtn.className = 'btn small';
  smoothBtn.dataset.act = 'smooth';
  smoothBtn.textContent = 'Smooth';
  smoothBtn.title = 'Smooth the drawn curve';
  smoothBtn.addEventListener('click', () => {
    if (!pencil) return;
    p[channel] = smoothTable(p[channel]);
    sync();
    emit();
  });
  top.append(chanRow.element, modeWrap, smoothBtn);
  el.appendChild(top);

  // ---- the graph
  const canvas = document.createElement('canvas');
  canvas.className = 'curve-editor';
  canvas.width = 256;
  canvas.height = 256;
  canvas.tabIndex = 0;
  el.appendChild(canvas);

  // black and white point sliders under the graph (they move the first and last point's input)
  const ends = sliderTrack(
    [{ key: 'black', value: 0, color: 'black' }, { key: 'white', value: 255, color: 'white' }],
    (key, value, { altKey, phase }) => {
      if (pencil) setMode(false);
      const list = pts();
      const i = key === 'black' ? 0 : list.length - 1;
      const other = key === 'black' ? list[1] : list[list.length - 2];
      let x = Math.round(value);
      if (other) x = key === 'black' ? Math.min(x, other[0] - 1) : Math.max(x, other[0] + 1);
      list[i] = [x, list[i][1]];
      setClip(phase !== 'end' && (altKey || showClipping) ? (key === 'black' ? 'shadows' : 'highlights') : null);
      sync();
      emit();
    },
    { className: 'tonal-track-curve' },
  );
  el.appendChild(ends.element);

  // ---- Input / Output and the options
  const io = document.createElement('div');
  io.className = 'tonal-fields';
  const field = (key, label) => {
    const i = document.createElement('input');
    i.type = 'number';
    i.className = 'input num';
    i.dataset.key = key;
    i.min = '0';
    i.max = '255';
    i.title = label;
    i.setAttribute('aria-label', label);
    i.addEventListener('change', numEdit);
    return i;
  };
  const inLabel = document.createElement('span');
  inLabel.className = 'tonal-fields-label';
  inLabel.textContent = 'Input';
  const fIn = field('curveIn', 'Input');
  const outLabel = document.createElement('span');
  outLabel.className = 'tonal-fields-label';
  outLabel.textContent = 'Output';
  const fOut = field('curveOut', 'Output');
  io.append(inLabel, fIn, outLabel, fOut);
  el.appendChild(io);

  const check = (key, text, checked, fn) => {
    const l = document.createElement('label');
    l.className = 'checkbox';
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.dataset.key = key;
    i.checked = checked;
    i.addEventListener('change', () => fn(i.checked));
    l.append(i, document.createTextNode(text));
    return l;
  };
  el.appendChild(check('__showClipping', 'Show Clipping', false, (on) => {
    showClipping = on;
  }));
  const opts = document.createElement('details');
  opts.className = 'curves-display';
  const sum = document.createElement('summary');
  sum.textContent = 'Curve Display Options';
  opts.appendChild(sum);
  const setDisplay = (key, v) => {
    display[key] = v;
    draw();
    if (app?.saveSettings) app.saveSettings({ adjust: { ...(app.settings.adjust ?? {}), curvesDisplay: { ...display } } });
  };
  const amount = selectRow('Show Amount of', [['light', 'Light (0–255)'], ['pigment', 'Pigment/Ink %']], display.pigment ? 'pigment' : 'light', (v) => setDisplay('pigment', v === 'pigment'), { dataKey: '__amount' });
  const grid = selectRow('Grid', [['simple', 'Simple (4 × 4)'], ['detailed', 'Detailed (10 × 10)']], display.detailed ? 'detailed' : 'simple', (v) => setDisplay('detailed', v === 'detailed'), { dataKey: '__grid' });
  opts.append(amount.element, grid.element,
    check('__overlays', 'Channel Overlays', display.overlays, (v) => setDisplay('overlays', v)),
    check('__histogram', 'Histogram', display.histogram, (v) => setDisplay('histogram', v)),
    check('__baseline', 'Baseline', display.baseline, (v) => setDisplay('baseline', v)),
    check('__intersection', 'Intersection Line', display.intersection, (v) => setDisplay('intersection', v)));
  el.appendChild(opts);

  // ---- state helpers
  const emit = () => onChange(clone(p));
  let clipping = null;
  const setClip = (which) => {
    if (clipping === which) return;
    clipping = which;
    clip?.(which);
  };
  const identity = () => [[0, 0], [255, 255]];
  function pts() {
    if (isTable(p[channel])) p[channel] = pointsFromTable(p[channel]);
    if (!Array.isArray(p[channel]) || p[channel].length < 2) p[channel] = identity();
    return p[channel];
  }
  function setMode(toPencil) {
    if (toPencil === pencil) return;
    pencil = toPencil;
    const ch = p[channel];
    // switching keeps the curve: points become a drawn table, a drawn table becomes points (Photoshop's)
    if (pencil) p[channel] = tableFromPoints(isTable(ch) ? pointsFromTable(ch) : Array.isArray(ch) ? ch : identity());
    else if (isTable(ch)) p[channel] = pointsFromTable(ch);
    selected = -1;
    sync();
    emit();
  }

  // display coordinates: Light (0 bottom-left) or Pigment/Ink (both axes reversed)
  const toView = (x, y) => (display.pigment ? [255 - x, y] : [x, 255 - y]);
  const fromEvent = (e) => {
    const r = canvas.getBoundingClientRect();
    const vx = Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 256));
    const vy = Math.max(0, Math.min(255, ((e.clientY - r.top) / r.height) * 256));
    return display.pigment ? [255 - vx, vy] : [vx, 255 - vy];
  };

  function draw() {
    const ctx = canvas.getContext('2d');
    const fg = getComputedStyle(canvas).color || '#ddd';
    ctx.clearRect(0, 0, 256, 256);
    if (display.histogram && hist) {
      const tmp = document.createElement('canvas');
      tmp.width = 256;
      tmp.height = 256;
      drawHistogram(tmp, hist, histKey(space, channel));
      ctx.save();
      if (display.pigment) {
        ctx.translate(256, 0);
        ctx.scale(-1, 1);
      }
      ctx.globalAlpha = 0.35;
      ctx.drawImage(tmp, 0, 0);
      ctx.restore();
    }
    ctx.strokeStyle = 'rgba(128,128,128,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = display.detailed ? 10 : 4;
    for (let i = 1; i < n; i++) {
      const v = Math.round((i * 256) / n) + 0.5;
      ctx.moveTo(v, 0);
      ctx.lineTo(v, 256);
      ctx.moveTo(0, v);
      ctx.lineTo(256, v);
    }
    ctx.stroke();
    if (display.baseline) {
      ctx.beginPath();
      const [ax, ay] = toView(0, 0), [bx, by] = toView(255, 255);
      ctx.moveTo(ax + 0.5, ay + 0.5);
      ctx.lineTo(bx + 0.5, by + 0.5);
      ctx.stroke();
    }
    const curveOf = (key) => curveChannelLut(p[key] ?? null);
    const line = (lut, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = 0; x < 256; x++) {
        const [vx, vy] = toView(x, lut[x]);
        if (x) ctx.lineTo(vx + 0.5, vy + 0.5);
        else ctx.moveTo(vx + 0.5, vy + 0.5);
      }
      ctx.stroke();
    };
    // the other channels' curves in their colours (Channel Overlays)
    if (display.overlays) {
      for (const k of s.channels) {
        if (k === channel || !p[k]) continue;
        line(curveOf(k), colorOf(k, space), 1);
      }
    }
    const lut = curveOf(channel);
    const color = channel === s.composite ? fg : colorOf(channel, space);
    line(lut, color, 1.5);
    if (!pencil) {
      pts().forEach(([x, y], i) => {
        const [vx, vy] = toView(x, y);
        ctx.fillStyle = i === selected ? color : '#ffffff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.fillRect(vx - 3.5, vy - 3.5, 7, 7);
        ctx.strokeRect(vx - 3.5, vy - 3.5, 7, 7);
      });
      const sel = pts()[selected];
      if (sel && display.intersection) {
        const [vx, vy] = toView(sel[0], sel[1]);
        ctx.strokeStyle = 'rgba(128,128,128,0.7)';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(vx + 0.5, 0);
        ctx.lineTo(vx + 0.5, 256);
        ctx.moveTo(0, vy + 0.5);
        ctx.lineTo(256, vy + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function sync() {
    chanRow.select.value = channel;
    pointsBtn.setAttribute('aria-pressed', String(!pencil));
    pencilBtn.setAttribute('aria-pressed', String(pencil));
    smoothBtn.disabled = !pencil;
    el.classList.toggle('pencil', pencil);
    const list = pencil ? null : pts();
    if (list) ends.set({ black: list[0][0], white: list[list.length - 1][0] });
    const sel = list?.[selected];
    fIn.value = sel ? String(Math.round(sel[0])) : '';
    fOut.value = sel ? String(Math.round(sel[1])) : '';
    fIn.disabled = fOut.disabled = !sel;
    draw();
  }

  function numEdit() {
    const list = pts();
    if (selected < 0 || !list[selected]) return;
    const x = Math.max(0, Math.min(255, Number(fIn.value))), y = Math.max(0, Math.min(255, Number(fOut.value)));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    list[selected] = [x, y];
    p[channel] = normalisePoints(list);
    selected = p[channel].findIndex((q) => q[0] === x && q[1] === y);
    sync();
    emit();
  }

  // ---- pointer editing on the graph
  let dragging = false, last = null;
  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = fromEvent(e);
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
    dragging = true;
    if (pencil) {
      p[channel] = drawTable(p[channel], x, y, x, y);
      last = [x, y];
      draw();
      emit();
      return;
    }
    const list = pts();
    let idx = list.findIndex(([px, py]) => Math.hypot(px - x, py - y) < 8);
    if (idx < 0) {
      if (list.length >= MAX_POINTS) {
        dragging = false;
        return;
      }
      // a click on the curve's line keeps its height (Photoshop adds the point on the curve, then follows the drag)
      const onCurve = Math.abs(curveLut(list)[Math.round(x)] - y) < 8;
      const pt = [Math.round(x), Math.round(onCurve ? curveLut(list)[Math.round(x)] : y)];
      list.push(pt);
      p[channel] = normalisePoints(list);
      idx = p[channel].findIndex(([px]) => px === pt[0]);
      emit();
    }
    selected = idx;
    sync();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const [x, y] = fromEvent(e);
    if (pencil) {
      p[channel] = drawTable(p[channel], last[0], last[1], x, y);
      last = [x, y];
      draw();
      emit();
      return;
    }
    if (selected < 0) return;
    const list = pts();
    const r = canvas.getBoundingClientRect();
    const outside = e.clientY < r.top - 20 || e.clientY > r.bottom + 20 || e.clientX < r.left - 20 || e.clientX > r.right + 20;
    if (outside && list.length > 2) {
      list.splice(selected, 1);
      selected = -1;
      dragging = false;
      sync();
      emit();
      return;
    }
    const prev = list[selected - 1], next = list[selected + 1];
    let nx = x;
    if (prev) nx = Math.max(prev[0] + 1, nx);
    if (next) nx = Math.min(next[0] - 1, nx);
    list[selected] = [Math.round(nx), Math.round(y)];
    const endPoint = selected === 0 || selected === list.length - 1;
    setClip(endPoint && (e.altKey || showClipping) ? (selected === 0 ? 'shadows' : 'highlights') : null);
    sync();
    emit();
  });
  const up = () => {
    dragging = false;
    last = null;
    setClip(null);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('keydown', (e) => {
    if (pencil) return;
    const list = pts();
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected >= 0 && list.length > 2) {
      list.splice(selected, 1);
      selected = -1;
    } else if (e.key.startsWith('Arrow') && selected >= 0) {
      const step = e.shiftKey ? 10 : 1;
      const [x, y] = list[selected];
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
      const prev = list[selected - 1], next = list[selected + 1];
      let nx = Math.max(0, Math.min(255, x + dx));
      if (prev) nx = Math.max(prev[0] + 1, nx);
      if (next) nx = Math.min(next[0] - 1, nx);
      list[selected] = [nx, Math.max(0, Math.min(255, y + dy))];
    } else return;
    e.preventDefault();
    e.stopPropagation();
    sync();
    emit();
  });
  const onWinUp = () => setClip(null);
  window.addEventListener('pointerup', onWinUp);

  requestAnimationFrame(draw);
  sync();

  const setParams = (next) => {
    const n = next ?? {};
    p = tonalSpace(n) === space ? clone(n) : remapTonalSpace('curves', n, space);
    p.space = space;
    selected = -1;
    pencil = isTable(p[channel]);
    sync();
  };

  // on-image tool: the tone under the pointer becomes a point, a vertical drag moves it
  let onImage = null;
  const toneOf = (rgba) => {
    const v = sampleInSpace(space, rgba);
    if (channel === s.composite) {
      if (space === 'rgb') return Math.round(0.299 * rgba[0] + 0.587 * rgba[1] + 0.114 * rgba[2]);
      return Math.round(v.reduce((a, b) => a + b, 0) / v.length);
    }
    return v[s.channels.indexOf(channel)];
  };
  return {
    element: el,
    setParams,
    eyedroppers: tonalEyedroppers(app, 'curves', {
      getParams: () => clone(p),
      setParams: (next) => {
        setParams(next);
        emit();
      },
      gray: space !== 'gray',
    }),
    onImage: {
      label: 'Click and drag in the image to modify the curve',
      icon: 'on-image',
      cursor: 'ns-resize',
      down(rgba, pt) {
        if (!rgba) return;
        if (pencil) setMode(false);
        const x = toneOf(rgba);
        const list = pts();
        let idx = list.findIndex(([px]) => Math.abs(px - x) <= 3);
        if (idx < 0) {
          if (list.length >= MAX_POINTS) return;
          list.push([x, curveLut(list)[x]]);
          p[channel] = normalisePoints(list);
          idx = p[channel].findIndex(([px]) => px === x);
        }
        selected = idx;
        onImage = { y0: p[channel][idx][1], screenY: pt?.screenY ?? 0 };
        sync();
        emit();
      },
      move(_rgba, pt) {
        if (!onImage || selected < 0) return;
        const list = pts();
        const y = Math.max(0, Math.min(255, Math.round(onImage.y0 - ((pt?.screenY ?? onImage.screenY) - onImage.screenY))));
        list[selected] = [list[selected][0], y];
        sync();
        emit();
      },
      up() {
        onImage = null;
      },
    },
    auto: {
      run: (src) => autoTonalParams('curves', src, savedAutoOptions(app), space),
      options: async () => {
        const before = clone(p);
        const opts = await openAutoOptions(app, {
          preview: source ? (o) => {
            setParams(autoTonalParams('curves', source, o, space));
            emit();
          } : null,
          revert: () => {
            setParams(before);
            emit();
          },
        });
        if (opts && source) {
          setParams(autoTonalParams('curves', source, opts, space));
          emit();
        }
        return !!opts;
      },
    },
    dispose() {
      window.removeEventListener('pointerup', onWinUp);
      setClip(null);
    },
  };
}

function colorOf(key, space) {
  if (space === 'lab' && key === 'b') return CHANNEL_COLORS.b_lab;
  return CHANNEL_COLORS[key] ?? '#888';
}
