// Appearance-stream builders for annotations created by the engine. Each builder returns the
// content stream text (PDF graphics operators) plus the resources it needs; makeAppearance() turns
// that into a Form XObject so every viewer (not only pdf.js) renders the annotation the same way.

const KAPPA = 0.5522847498;

export function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
}

/** '#rrggbb' (or '#rgb', 'rgb(...)') -> [r, g, b] in 0..1. Returns null for no colour / transparent. */
export function parseColor(input) {
  if (input === null || input === undefined || input === '' || input === 'none' || input === 'transparent') return null;
  if (Array.isArray(input)) return input.length >= 3 ? input.slice(0, 3).map((v) => clamp01(v)) : null;
  let s = String(input).trim().toLowerCase();
  const named = { red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', black: '#000000', white: '#ffffff', orange: '#ffa500', purple: '#800080' };
  if (named[s]) s = named[s];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16) / 255);
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (m) return [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)].map((h) => parseInt(h, 16) / 255);
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) return [m[1], m[2], m[3]].map((v) => clamp01(Number(v) / 255));
  return null;
}

export function colorToHex(rgb) {
  if (!rgb || rgb.length < 3) return null;
  return '#' + rgb.slice(0, 3).map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

const rgbOp = (c, op) => `${fmt(c[0])} ${fmt(c[1])} ${fmt(c[2])} ${op}`;

/** Normalizes a rect [x1 y1 x2 y2] so x1<=x2, y1<=y2. */
export function normRect(rect) {
  const [a, b, c, d] = rect;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}

/** Union rect of quads given as [x1 y1 x2 y2 x3 y3 x4 y4]* */
export function quadsBounds(quads) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      x1 = Math.min(x1, q[i]);
      x2 = Math.max(x2, q[i]);
      y1 = Math.min(y1, q[i + 1]);
      y2 = Math.max(y2, q[i + 1]);
    }
  }
  return [x1, y1, x2, y2];
}

/** Each quad -> {x, y, w, h} (axis-aligned bounds of the 4 points). */
function quadBoxes(quads) {
  return quads.map((q) => {
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  });
}

function gsResources(opacity, blend) {
  const gs = { Type: 'ExtGState', CA: opacity, ca: opacity };
  if (blend) gs.BM = blend;
  return { ExtGState: { GS0: gs } };
}

// ---- text markup ----------------------------------------------------------------------------------

export function highlightAppearance({ quads, color, opacity = 1 }) {
  const c = parseColor(color) ?? [1, 1, 0];
  const parts = [`/GS0 gs ${rgbOp(c, 'rg')}`];
  for (const b of quadBoxes(quads)) parts.push(`${fmt(b.x)} ${fmt(b.y)} ${fmt(b.w)} ${fmt(b.h)} re f`);
  return { content: parts.join('\n'), resources: gsResources(opacity, 'Multiply'), bbox: quadsBounds(quads) };
}

export function underlineAppearance({ quads, color, opacity = 1 }) {
  const c = parseColor(color) ?? [0, 0, 0];
  const parts = [`/GS0 gs ${rgbOp(c, 'RG')} 0 J`];
  for (const b of quadBoxes(quads)) {
    const w = Math.max(0.5, b.h * 0.07);
    const y = b.y + w;
    parts.push(`${fmt(w)} w ${fmt(b.x)} ${fmt(y)} m ${fmt(b.x + b.w)} ${fmt(y)} l S`);
  }
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox: quadsBounds(quads) };
}

export function strikeoutAppearance({ quads, color, opacity = 1 }) {
  const c = parseColor(color) ?? [1, 0, 0];
  const parts = [`/GS0 gs ${rgbOp(c, 'RG')} 0 J`];
  for (const b of quadBoxes(quads)) {
    const w = Math.max(0.5, b.h * 0.07);
    const y = b.y + b.h / 2;
    parts.push(`${fmt(w)} w ${fmt(b.x)} ${fmt(y)} m ${fmt(b.x + b.w)} ${fmt(y)} l S`);
  }
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox: quadsBounds(quads) };
}

export function squigglyAppearance({ quads, color, opacity = 1 }) {
  const c = parseColor(color) ?? [0, 0.5, 0];
  const parts = [`/GS0 gs ${rgbOp(c, 'RG')} 1 J 1 j`];
  for (const b of quadBoxes(quads)) {
    const amp = Math.max(0.8, b.h * 0.12);
    const w = Math.max(0.5, b.h * 0.06);
    const step = amp;
    const y0 = b.y + w;
    let x = b.x;
    let up = false;
    const path = [`${fmt(x)} ${fmt(y0)} m`];
    while (x < b.x + b.w) {
      x = Math.min(x + step, b.x + b.w);
      up = !up;
      path.push(`${fmt(x)} ${fmt(up ? y0 + amp : y0)} l`);
    }
    parts.push(`${fmt(w)} w ${path.join(' ')} S`);
  }
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox: quadsBounds(quads) };
}

// ---- shapes ----------------------------------------------------------------------------------------

export function squareAppearance({ rect, color, fill = null, width = 2, opacity = 1 }) {
  const [x1, y1, x2, y2] = normRect(rect);
  const stroke = parseColor(color);
  const fillC = parseColor(fill);
  const w = Math.max(0, width);
  const parts = ['/GS0 gs'];
  if (stroke) parts.push(rgbOp(stroke, 'RG'));
  if (fillC) parts.push(rgbOp(fillC, 'rg'));
  parts.push(`${fmt(w)} w ${fmt(x1 + w / 2)} ${fmt(y1 + w / 2)} ${fmt(Math.max(0, x2 - x1 - w))} ${fmt(Math.max(0, y2 - y1 - w))} re`);
  parts.push(paintOp(!!stroke && w > 0, !!fillC));
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox: [x1, y1, x2, y2] };
}

export function circleAppearance({ rect, color, fill = null, width = 2, opacity = 1 }) {
  const [x1, y1, x2, y2] = normRect(rect);
  const stroke = parseColor(color);
  const fillC = parseColor(fill);
  const w = Math.max(0, width);
  const parts = ['/GS0 gs'];
  if (stroke) parts.push(rgbOp(stroke, 'RG'));
  if (fillC) parts.push(rgbOp(fillC, 'rg'));
  parts.push(`${fmt(w)} w`);
  parts.push(ellipsePath(x1 + w / 2, y1 + w / 2, x2 - w / 2, y2 - w / 2));
  parts.push(paintOp(!!stroke && w > 0, !!fillC));
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox: [x1, y1, x2, y2] };
}

export function ellipsePath(x1, y1, x2, y2) {
  const rx = (x2 - x1) / 2, ry = (y2 - y1) / 2;
  const cx = x1 + rx, cy = y1 + ry;
  const kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    `${fmt(cx + rx)} ${fmt(cy)} m`,
    `${fmt(cx + rx)} ${fmt(cy + ky)} ${fmt(cx + kx)} ${fmt(cy + ry)} ${fmt(cx)} ${fmt(cy + ry)} c`,
    `${fmt(cx - kx)} ${fmt(cy + ry)} ${fmt(cx - rx)} ${fmt(cy + ky)} ${fmt(cx - rx)} ${fmt(cy)} c`,
    `${fmt(cx - rx)} ${fmt(cy - ky)} ${fmt(cx - kx)} ${fmt(cy - ry)} ${fmt(cx)} ${fmt(cy - ry)} c`,
    `${fmt(cx + kx)} ${fmt(cy - ry)} ${fmt(cx + rx)} ${fmt(cy - ky)} ${fmt(cx + rx)} ${fmt(cy)} c`,
    'h',
  ].join(' ');
}

function paintOp(stroke, fill) {
  if (stroke && fill) return 'B';
  if (fill) return 'f';
  if (stroke) return 'S';
  return 'n';
}

/** Arrow head length for a given line width. */
export function arrowHeadLength(width) {
  return Math.max(8, width * 4 + 4);
}

export function lineAppearance({ start, end, color, width = 2, opacity = 1, arrow = false }) {
  const c = parseColor(color) ?? [0, 0, 0];
  const w = Math.max(0.5, width);
  const [x1, y1] = start;
  const [x2, y2] = end;
  const parts = [`/GS0 gs ${rgbOp(c, 'RG')} ${rgbOp(c, 'rg')} ${fmt(w)} w 1 J 1 j`, `${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`];
  const head = arrow ? arrowHeadLength(w) : 0;
  if (arrow) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const spread = Math.PI / 7;
    const ax = x2 - head * Math.cos(angle - spread), ay = y2 - head * Math.sin(angle - spread);
    const bx = x2 - head * Math.cos(angle + spread), by = y2 - head * Math.sin(angle + spread);
    parts.push(`${fmt(ax)} ${fmt(ay)} m ${fmt(x2)} ${fmt(y2)} l ${fmt(bx)} ${fmt(by)} l S`);
  }
  const pad = w + head;
  const bbox = [Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.max(x1, x2) + pad, Math.max(y1, y2) + pad];
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox };
}

export function inkAppearance({ paths, color, width = 2, opacity = 1 }) {
  const c = parseColor(color) ?? [0, 0, 0];
  const w = Math.max(0.5, width);
  const parts = [`/GS0 gs ${rgbOp(c, 'RG')} ${fmt(w)} w 1 J 1 j`];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const path of paths) {
    if (path.length < 2) continue;
    const ops = [];
    for (let i = 0; i + 1 < path.length; i += 2) {
      const x = path[i], y = path[i + 1];
      x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
      ops.push(`${fmt(x)} ${fmt(y)} ${i === 0 ? 'm' : 'l'}`);
    }
    if (path.length === 2) ops.push(`${fmt(path[0])} ${fmt(path[1])} l`);
    parts.push(ops.join(' ') + ' S');
  }
  if (!Number.isFinite(x1)) {
    x1 = y1 = 0; x2 = y2 = 1;
  }
  return { content: parts.join('\n'), resources: gsResources(opacity), bbox: [x1 - w, y1 - w, x2 + w, y2 + w] };
}

// ---- text ------------------------------------------------------------------------------------------

/** Greedy word wrap using a pdf-lib font. */
export function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const para of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line && safeWidth(font, candidate, size) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
      // very long single words: hard break
      while (safeWidth(font, line, size) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && safeWidth(font, line.slice(0, cut), size) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function safeWidth(font, text, size) {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return text.length * size * 0.5;
  }
}

/** Encodes text for a content stream with the given pdf-lib font (hex string), dropping glyphs the font lacks. */
export function encodeForFont(font, text) {
  try {
    return font.encodeText(text).toString();
  } catch {
    const cleaned = [...text].filter((ch) => ch.charCodeAt(0) < 256).join('');
    try {
      return font.encodeText(cleaned).toString();
    } catch {
      return '()';
    }
  }
}

export function freeTextAppearance({ rect, text, font, fontRef, fontSize = 12, color, padding = 2, border = 0, borderColor = null, background = null }) {
  const [x1, y1, x2, y2] = normRect(rect);
  const w = x2 - x1, h = y2 - y1;
  const c = parseColor(color) ?? [0, 0, 0];
  const parts = ['q'];
  const bg = parseColor(background);
  const bc = parseColor(borderColor);
  if (bg) parts.push(`${rgbOp(bg, 'rg')} 0 0 ${fmt(w)} ${fmt(h)} re f`);
  if (border > 0 && bc) parts.push(`${rgbOp(bc, 'RG')} ${fmt(border)} w ${fmt(border / 2)} ${fmt(border / 2)} ${fmt(w - border)} ${fmt(h - border)} re S`);
  const lines = wrapText(text, font, fontSize, Math.max(1, w - padding * 2));
  const leading = fontSize * 1.2;
  parts.push(`BT ${rgbOp(c, 'rg')} /Helv ${fmt(fontSize)} Tf ${fmt(leading)} TL ${fmt(padding)} ${fmt(h - padding - fontSize * 0.95)} Td`);
  lines.forEach((line, i) => parts.push(`${encodeForFont(font, line)} Tj${i < lines.length - 1 ? ' T*' : ''}`));
  parts.push('ET Q');
  return { content: parts.join('\n'), resources: { Font: { Helv: fontRef } }, bbox: [0, 0, w, h], da: `${rgbOp(c, 'rg')} /Helv ${fmt(fontSize)} Tf` };
}

export function imageStampAppearance({ rect, imageRef, imageWidth, imageHeight }) {
  const [x1, y1, x2, y2] = normRect(rect);
  const w = x2 - x1, h = y2 - y1;
  return { content: `q ${fmt(w)} 0 0 ${fmt(h)} 0 0 cm /Im0 Do Q`, resources: { XObject: { Im0: imageRef } }, bbox: [0, 0, w, h], imageWidth, imageHeight };
}

export function textStampAppearance({ rect, text, font, fontRef, color }) {
  const [x1, y1, x2, y2] = normRect(rect);
  const w = x2 - x1, h = y2 - y1;
  const c = parseColor(color) ?? [0.8, 0.1, 0.1];
  const label = String(text ?? '').toUpperCase();
  let size = Math.min(h * 0.6, 72);
  while (size > 4 && safeWidth(font, label, size) > w * 0.85) size -= 1;
  const tw = safeWidth(font, label, size);
  const bw = Math.max(1, h * 0.06);
  const r = Math.min(w, h) * 0.12;
  const parts = [
    `q /GS0 gs ${rgbOp(c, 'RG')} ${rgbOp(c, 'rg')} ${fmt(bw)} w`,
    roundedRectPath(bw / 2, bw / 2, w - bw, h - bw, r) + ' S',
    `BT /Helv ${fmt(size)} Tf ${fmt((w - tw) / 2)} ${fmt((h - size * 0.72) / 2)} Td ${encodeForFont(font, label)} Tj ET Q`,
  ];
  return { content: parts.join('\n'), resources: { Font: { Helv: fontRef }, ...gsResources(1) }, bbox: [0, 0, w, h] };
}

export function roundedRectPath(x, y, w, h, r) {
  const k = KAPPA * r;
  return [
    `${fmt(x + r)} ${fmt(y)} m`,
    `${fmt(x + w - r)} ${fmt(y)} l`,
    `${fmt(x + w - r + k)} ${fmt(y)} ${fmt(x + w)} ${fmt(y + r - k)} ${fmt(x + w)} ${fmt(y + r)} c`,
    `${fmt(x + w)} ${fmt(y + h - r)} l`,
    `${fmt(x + w)} ${fmt(y + h - r + k)} ${fmt(x + w - r + k)} ${fmt(y + h)} ${fmt(x + w - r)} ${fmt(y + h)} c`,
    `${fmt(x + r)} ${fmt(y + h)} l`,
    `${fmt(x + r - k)} ${fmt(y + h)} ${fmt(x)} ${fmt(y + h - r + k)} ${fmt(x)} ${fmt(y + h - r)} c`,
    `${fmt(x)} ${fmt(y + r)} l`,
    `${fmt(x)} ${fmt(y + r - k)} ${fmt(x + r - k)} ${fmt(y)} ${fmt(x + r)} ${fmt(y)} c h`,
  ].join(' ');
}
