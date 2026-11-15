// Fill & Sign: draw, type or upload a signature (or initials), keep it for later, and place it on
// the page as a pdf.js stamp editor (movable and resizable; written into the PDF on save).
import { icon } from './icons.js';

const SIGN_FONTS = ['"Brush Script MT", "Segoe Script", "Snell Roundhand", "Bradley Hand", cursive', '"Lucida Handwriting", "Apple Chancery", cursive', 'Georgia, "Times New Roman", serif', '"Comic Sans MS", "Chalkboard SE", sans-serif'];
const INK_COLORS = ['#111111', '#1a3fa6', '#8b0000'];

export function install(app) {
  const s = () => app.settings;

  async function startSigning(kind) {
    if (!app.session) return;
    const result = await signatureDialog(app, kind);
    if (!result) return;
    if (result.save) {
      const entry = { id: `sig-${Date.now().toString(36)}`, kind, name: result.name ?? (kind === 'initials' ? 'Initials' : 'Signature'), dataUrl: result.dataUrl, width: result.width, height: result.height, createdAt: Date.now() };
      await app.saveSettings({ signatures: [...(s().signatures ?? []), entry].slice(-20) });
    }
    await place(result.blob, kind);
  }

  async function place(blob, kind) {
    const v = app.view;
    if (!v) return;
    app.commands.run('tool:none', undefined, 'api');
    const ok = await v.addImageStamp(blob);
    if (!ok) {
      app.dialogs.toast('Could not place the signature', { kind: 'error' });
      return;
    }
    app.setTool(kind === 'initials' ? 'initials' : 'sign');
    const bar = document.createElement('div');
    bar.className = 'tool-options';
    const hintEl = document.createElement('span');
    hintEl.className = 'tool-hint';
    hintEl.textContent = 'Drag the signature into place and resize it with the corners. It is written into the PDF when you save.';
    const done = document.createElement('button');
    done.className = 'btn quiet tool-done';
    done.innerHTML = `${icon('check')} Done`;
    done.addEventListener('click', () => app.commands.run('tool:none', undefined, 'toolbar'));
    bar.append(hintEl, done);
    app.toolbar.setSecondary(bar);
  }

  app.commands.registerAll({
    'tool:sign': { enabled: () => !!app.session, checked: () => app.tool === 'sign', run: () => startSigning('signature') },
    'tool:initials': { enabled: () => !!app.session, checked: () => app.tool === 'initials', run: () => startSigning('initials') },
    'sign:use-saved': { enabled: () => !!app.session, run: async (id) => {
      const entry = (s().signatures ?? []).find((e) => e.id === id);
      if (!entry) return;
      const blob = await (await fetch(entry.dataUrl)).blob();
      await place(blob, entry.kind);
    } },
  });

  const signMenu = () => {
    const saved = s().signatures ?? [];
    return [
      { label: 'Add signature…', icon: 'sign', onSelect: () => app.commands.run('tool:sign', undefined, 'toolbar') },
      { label: 'Add initials…', icon: 'initials', onSelect: () => app.commands.run('tool:initials', undefined, 'toolbar') },
      ...(saved.length ? [{ type: 'separator' }, { type: 'title', label: 'Saved' }] : []),
      ...saved.map((e) => ({ type: 'custom', element: savedMenuItem(e) })),
    ];
  };
  function savedMenuItem(entry) {
    const btn = document.createElement('button');
    btn.className = 'popover-item sign-menu-item';
    btn.innerHTML = `<img alt="" style="height:28px;max-width:140px;object-fit:contain"><span></span>`;
    btn.querySelector('img').src = entry.dataUrl;
    btn.querySelector('span').textContent = entry.kind === 'initials' ? 'Initials' : 'Signature';
    btn.addEventListener('click', () => {
      app.dialogs.closePopover();
      app.commands.run('sign:use-saved', entry.id, 'toolbar');
    });
    return btn;
  }
  app.toolbar.addButton({ id: 'sign', group: 'tools', icon: 'sign', title: 'Fill & Sign', menu: signMenu, enabled: () => !!app.session, pressed: () => app.tool === 'sign' || app.tool === 'initials' });
}

// ---- the dialog ---------------------------------------------------------------------------------------
async function signatureDialog(app, kind) {
  const isInitials = kind === 'initials';
  const content = document.createElement('div');
  content.className = 'sign-dialog';
  content.innerHTML = `
    <div class="dialog-tabs" role="tablist">
      <button class="dialog-tab" role="tab" data-tab="draw" aria-selected="true">Draw</button>
      <button class="dialog-tab" role="tab" data-tab="type" aria-selected="false">Type</button>
      <button class="dialog-tab" role="tab" data-tab="upload" aria-selected="false">Image</button>
      <button class="dialog-tab" role="tab" data-tab="saved" aria-selected="false">Saved</button>
    </div>
    <div data-pane="draw">
      <canvas class="sign-pad" width="900" height="360" aria-label="Signature drawing area"></canvas>
      <div class="sign-row">
        <span class="muted">Draw with the mouse, pen or finger.</span>
        <span class="tool-swatches" data-colors></span>
        <button class="btn quiet" type="button" data-clear>Clear</button>
      </div>
    </div>
    <div data-pane="type" hidden>
      <input class="input" type="text" data-typed placeholder="${isInitials ? 'Your initials' : 'Your name'}" autocomplete="off">
      <div class="sign-type-preview" data-preview></div>
      <div class="sign-fonts" data-fonts></div>
    </div>
    <div data-pane="upload" hidden>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-file>
      <img class="sign-upload-preview" alt="" data-upload-preview hidden>
      <label class="checkbox"><input type="checkbox" data-whitebg checked> Make white background transparent</label>
    </div>
    <div data-pane="saved" hidden><div class="sign-saved" data-saved></div></div>
    <label class="checkbox" style="margin-top:12px"><input type="checkbox" data-save checked> Save this ${isInitials ? 'initials' : 'signature'} for later</label>`;

  const panes = Object.fromEntries([...content.querySelectorAll('[data-pane]')].map((p) => [p.dataset.pane, p]));
  let active = 'draw';
  for (const tab of content.querySelectorAll('.dialog-tab')) {
    tab.addEventListener('click', () => {
      active = tab.dataset.tab;
      for (const t of content.querySelectorAll('.dialog-tab')) t.setAttribute('aria-selected', String(t === tab));
      for (const [name, pane] of Object.entries(panes)) pane.hidden = name !== active;
      if (active === 'type') content.querySelector('[data-typed]').focus();
    });
  }

  // draw pane
  const pad = content.querySelector('.sign-pad');
  const ctx = pad.getContext('2d');
  let inkColor = INK_COLORS[0];
  let strokes = [];
  let currentStroke = null;
  const colorsEl = content.querySelector('[data-colors]');
  for (const c of INK_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tool-swatch';
    b.style.background = c;
    b.setAttribute('aria-pressed', String(c === inkColor));
    b.addEventListener('click', () => {
      inkColor = c;
      for (const o of colorsEl.children) o.setAttribute('aria-pressed', String(o === b));
      redraw();
    });
    colorsEl.appendChild(b);
  }
  const padPoint = (event) => {
    const r = pad.getBoundingClientRect();
    return { x: ((event.clientX - r.left) / r.width) * pad.width, y: ((event.clientY - r.top) / r.height) * pad.height, p: event.pressure || 0.5 };
  };
  function redraw() {
    ctx.clearRect(0, 0, pad.width, pad.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = inkColor;
    for (const stroke of strokes) drawStroke(ctx, stroke, 5);
  }
  pad.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    pad.setPointerCapture(event.pointerId);
    currentStroke = [padPoint(event)];
    strokes.push(currentStroke);
  });
  pad.addEventListener('pointermove', (event) => {
    if (!currentStroke) return;
    currentStroke.push(padPoint(event));
    redraw();
  });
  const endStroke = () => {
    currentStroke = null;
  };
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);
  content.querySelector('[data-clear]').addEventListener('click', () => {
    strokes = [];
    redraw();
  });

  // type pane
  const typed = content.querySelector('[data-typed]');
  const preview = content.querySelector('[data-preview]');
  const fontsEl = content.querySelector('[data-fonts]');
  let font = SIGN_FONTS[0];
  SIGN_FONTS.forEach((f, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.fontFamily = f;
    b.textContent = isInitials ? 'AB' : 'Signature';
    b.setAttribute('aria-pressed', String(i === 0));
    b.addEventListener('click', () => {
      font = f;
      for (const o of fontsEl.children) o.setAttribute('aria-pressed', String(o === b));
      updatePreview();
    });
    fontsEl.appendChild(b);
  });
  const updatePreview = () => {
    preview.style.fontFamily = font;
    preview.textContent = typed.value || (isInitials ? 'AB' : 'Your name');
  };
  typed.value = isInitials ? initialsOf(app.settings.authorName) : app.settings.authorName ?? '';
  typed.addEventListener('input', updatePreview);
  updatePreview();

  // upload pane
  const fileInput = content.querySelector('[data-file]');
  const uploadPreview = content.querySelector('[data-upload-preview]');
  let uploaded = null;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    uploaded = await loadImage(URL.createObjectURL(file));
    uploadPreview.src = uploaded.src;
    uploadPreview.hidden = false;
  });

  // saved pane
  const savedEl = content.querySelector('[data-saved]');
  let chosenSaved = null;
  const renderSaved = () => {
    savedEl.replaceChildren();
    const list = (app.settings.signatures ?? []).filter((e) => e.kind === kind);
    if (!list.length) {
      savedEl.innerHTML = '<div class="muted">Nothing saved yet.</div>';
      return;
    }
    for (const entry of list) {
      const item = document.createElement('div');
      item.className = 'sign-saved-item';
      item.innerHTML = `<img alt=""><button class="sign-delete" type="button" title="Delete">${icon('close')}</button>`;
      item.querySelector('img').src = entry.dataUrl;
      item.addEventListener('click', () => {
        chosenSaved = entry;
        closeDialog?.('saved');
      });
      item.querySelector('.sign-delete').addEventListener('click', async (event) => {
        event.stopPropagation();
        await app.saveSettings({ signatures: (app.settings.signatures ?? []).filter((e) => e.id !== entry.id) });
        renderSaved();
      });
      savedEl.appendChild(item);
    }
  };
  renderSaved();

  let closeDialog = null;
  const result = await app.dialogs.open({
    title: isInitials ? 'Add initials' : 'Add signature',
    content,
    width: 640,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Place', value: true, primary: true }],
    onOpen: (_d, close) => {
      closeDialog = close;
    },
  });
  if (!result) return null;
  const save = content.querySelector('[data-save]').checked;
  if (result === 'saved' && chosenSaved) {
    const blob = await (await fetch(chosenSaved.dataUrl)).blob();
    return { blob, dataUrl: chosenSaved.dataUrl, width: chosenSaved.width, height: chosenSaved.height, save: false };
  }
  let canvas;
  if (active === 'draw') {
    if (!strokes.some((st) => st.length > 1)) {
      app.dialogs.toast('Draw your signature first', { timeout: 1500 });
      return signatureDialog(app, kind);
    }
    canvas = strokesToCanvas(strokes, inkColor);
  } else if (active === 'type') {
    if (!typed.value.trim()) {
      app.dialogs.toast('Type your name first', { timeout: 1500 });
      return signatureDialog(app, kind);
    }
    canvas = textToCanvas(typed.value.trim(), font, inkColor);
  } else if (active === 'upload') {
    if (!uploaded) {
      app.dialogs.toast('Choose an image first', { timeout: 1500 });
      return signatureDialog(app, kind);
    }
    canvas = imageToCanvas(uploaded, content.querySelector('[data-whitebg]').checked);
  } else {
    return null;
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return { blob, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height, save };
}

function initialsOf(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('')
    .slice(0, 3);
}

function drawStroke(ctx, stroke, width) {
  if (stroke.length < 2) {
    ctx.beginPath();
    ctx.arc(stroke[0].x, stroke[0].y, width / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    return;
  }
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(stroke[0].x, stroke[0].y);
  for (let i = 1; i < stroke.length - 1; i++) {
    const mx = (stroke[i].x + stroke[i + 1].x) / 2;
    const my = (stroke[i].y + stroke[i + 1].y) / 2;
    ctx.quadraticCurveTo(stroke[i].x, stroke[i].y, mx, my);
  }
  const last = stroke[stroke.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/** Renders strokes to a tightly cropped transparent canvas. */
function strokesToCanvas(strokes, color) {
  const pad = 12;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const st of strokes) for (const p of st) {
    x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(10, Math.ceil(x2 - x1 + pad * 2));
  canvas.height = Math.max(10, Math.ceil(y2 - y1 + pad * 2));
  const ctx = canvas.getContext('2d');
  ctx.translate(pad - x1, pad - y1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  for (const st of strokes) drawStroke(ctx, st, 5);
  return canvas;
}

function textToCanvas(text, font, color) {
  const size = 96;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${size}px ${font}`;
  const metrics = probe.measureText(text);
  const ascent = metrics.actualBoundingBoxAscent || size * 0.8;
  const descent = metrics.actualBoundingBoxDescent || size * 0.3;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(metrics.width + 40);
  canvas.height = Math.ceil(ascent + descent + 40);
  const ctx = canvas.getContext('2d');
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 20, 20 + ascent);
  return canvas;
}

function imageToCanvas(img, removeWhite) {
  const max = 1200;
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (removeWhite) {
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
      if (lum > 235) px[i + 3] = 0;
      else if (lum > 200) px[i + 3] = Math.round(px[i + 3] * ((235 - lum) / 35));
    }
    ctx.putImageData(data, 0, 0);
  }
  return canvas;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the image'));
    img.src = src;
  });
}
