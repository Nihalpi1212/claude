// Crop and Straighten Photos: finds the rectangular photos on a scanner background (pure, typed
// arrays, no DOM). The border colour is flooded inwards with a tolerance; what the flood does not
// reach is foreground; each connected foreground component gets the minimum-area rectangle of its
// convex hull (rotating calipers), which gives the photo's size and the angle to straighten it by.

/** The colour most border pixels share (quantised to 16 levels per channel, then averaged inside the winning bin). */
export function borderColor(img) {
  const { width: w, height: h, data } = img;
  const bins = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    const a = data[i + 3];
    const key = a < 8 ? -1 : ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    let b = bins.get(key);
    if (!b) bins.set(key, (b = [0, 0, 0, 0, 0]));
    b[0] += data[i];
    b[1] += data[i + 1];
    b[2] += data[i + 2];
    b[3] += a;
    b[4]++;
  };
  for (let x = 0; x < w; x++) {
    add(x, 0);
    if (h > 1) add(x, h - 1);
  }
  for (let y = 1; y < h - 1; y++) {
    add(0, y);
    if (w > 1) add(w - 1, y);
  }
  let best = null;
  for (const b of bins.values()) if (!best || b[4] > best[4]) best = b;
  return [Math.round(best[0] / best[4]), Math.round(best[1] / best[4]), Math.round(best[2] / best[4]), Math.round(best[3] / best[4])];
}

/**
 * 1 where a pixel belongs to the background: within `tolerance` of the border colour AND connected
 * to the image border through such pixels (a white shirt inside a photo is not background).
 */
export function backgroundMask(img, { tolerance = 24, color = borderColor(img) } = {}) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const like = new Uint8Array(n);
  const transparentBg = color[3] < 8;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (transparentBg) like[i] = data[p + 3] < 8 + tolerance ? 1 : 0;
    else if (data[p + 3] < 8) like[i] = 1; // transparent pixels around a scan are background too
    else like[i] = Math.abs(data[p] - color[0]) <= tolerance && Math.abs(data[p + 1] - color[1]) <= tolerance && Math.abs(data[p + 2] - color[2]) <= tolerance ? 1 : 0;
  }
  const mask = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const push = (i) => {
    if (like[i] && !mask[i]) {
      mask[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  return mask;
}

/** Connected components (8-neighbours) of the zero pixels of `bg`. Returns { labels: Int32Array (0 = background), count, areas, bounds }. */
export function components(bg, w, h) {
  const n = w * h;
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const areas = [0];
  const bounds = [null];
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (bg[start] || labels[start]) continue;
    const id = ++count;
    let top = 0, area = 0, x1 = w, y1 = h, x2 = -1, y2 = -1;
    labels[start] = id;
    stack[top++] = start;
    while (top > 0) {
      const i = stack[--top];
      const x = i % w, y = (i - x) / w;
      area++;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (!dx && !dy)) continue;
          const j = yy * w + xx;
          if (!bg[j] && !labels[j]) {
            labels[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    areas.push(area);
    bounds.push({ x: x1, y: y1, width: x2 - x1 + 1, height: y2 - y1 + 1 });
  }
  return { labels, count, areas, bounds };
}

/** Convex hull (Andrew's monotone chain) of [x, y] points, counter-clockwise, without the closing point. */
export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Minimum-area enclosing rectangle of a convex polygon: one side of the optimum lies on a hull edge,
 * so every edge direction is tried (rotating calipers; the hull of a scanned photo has few edges).
 * @returns {{ center: [x, y], width, height, angle }} angle in degrees, clockwise on screen (y down),
 *   normalised to (-45, 45] so width/height stay the photo's horizontal/vertical extent after straightening.
 */
export function minAreaRect(hull) {
  if (!hull.length) return null;
  if (hull.length < 3) {
    const xs = hull.map((p) => p[0]), ys = hull.map((p) => p[1]);
    const x1 = Math.min(...xs), x2 = Math.max(...xs), y1 = Math.min(...ys), y2 = Math.max(...ys);
    return { center: [(x1 + x2) / 2, (y1 + y2) / 2], width: x2 - x1, height: y2 - y1, angle: 0 };
  }
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const ux = (b[0] - a[0]) / len, uy = (b[1] - a[1]) / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area - 1e-9) best = { area, ux, uy, minU, maxU, minV, maxV };
  }
  const cu = (best.minU + best.maxU) / 2, cv = (best.minV + best.maxV) / 2;
  const center = [cu * best.ux - cv * best.uy, cu * best.uy + cv * best.ux];
  let width = best.maxU - best.minU, height = best.maxV - best.minV;
  let angle = (Math.atan2(best.uy, best.ux) * 180) / Math.PI;
  // the u axis may be any of the rectangle's four directions: fold into (-45, 45], swapping the sides on quarter turns
  while (angle > 45) {
    angle -= 90;
    [width, height] = [height, width];
  }
  while (angle <= -45) {
    angle += 90;
    [width, height] = [height, width];
  }
  return { center, width, height, angle };
}

/**
 * Finds the photos of a scan.
 * @param {{ width, height, data }} img   RGBA
 * @param {{ tolerance?: number, minArea?: number (fraction of the image, default 0.01), minSide?: number (px), maxPhotos?: number, snapAngle?: number }} opts
 * @returns {{ center: [x, y], width, height, angle, area, bounds }[]} top-to-bottom, left-to-right;
 *   angles below `snapAngle` degrees are treated as 0 (a straight scan is cropped without resampling).
 */
export function findPhotos(img, { tolerance = 24, minArea = 0.01, minSide = 12, maxPhotos = 64, snapAngle = 0.15 } = {}) {
  const { width: w, height: h } = img;
  const bg = backgroundMask(img, { tolerance });
  const { labels, count, areas, bounds } = components(bg, w, h);
  const minPixels = Math.max(16, minArea * w * h);
  // boundary pixels per component: the first and last foreground pixel of every row and column are enough for the hull
  const edge = Array.from({ length: count + 1 }, () => null);
  for (let id = 1; id <= count; id++) if (areas[id] >= minPixels) edge[id] = [];
  for (let y = 0; y < h; y++) {
    let prev = 0;
    for (let x = 0; x < w; x++) {
      const id = labels[y * w + x];
      if (id !== prev) {
        if (prev && edge[prev]) edge[prev].push([x, y], [x, y + 1]); // right edge of the run that ended
        if (id && edge[id]) edge[id].push([x, y], [x, y + 1]); // left edge of the run that starts
        prev = id;
      }
    }
    if (prev && edge[prev]) edge[prev].push([w, y], [w, y + 1]);
  }
  const out = [];
  for (let id = 1; id <= count; id++) {
    if (!edge[id]) continue;
    const rect = minAreaRect(convexHull(edge[id]));
    if (!rect || rect.width < minSide || rect.height < minSide) continue;
    if (Math.abs(rect.angle) < snapAngle) {
      // straight: use the exact pixel bounds
      const b = bounds[id];
      out.push({ center: [b.x + b.width / 2, b.y + b.height / 2], width: b.width, height: b.height, angle: 0, area: areas[id], bounds: b });
    } else out.push({ ...rect, area: areas[id], bounds: bounds[id] });
  }
  // reading order: rows of photos (centres within half a photo height count as one row), then left to right
  out.sort((a, b) => (Math.abs(a.center[1] - b.center[1]) > Math.min(a.height, b.height) / 2 ? a.center[1] - b.center[1] : a.center[0] - b.center[0]));
  return out.slice(0, maxPhotos);
}

/** True when the only "photo" found is the whole image (nothing to separate). */
export function isWholeImage(photos, w, h) {
  return photos.length === 1 && Math.abs(photos[0].angle) < 0.5 && photos[0].width >= w - 2 && photos[0].height >= h - 2;
}
