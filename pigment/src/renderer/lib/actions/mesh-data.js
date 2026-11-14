// Actions: a Liquify displacement mesh as step data. The mesh is a grid of (dx, dy) in image pixels;
// brushes touch a small part of it, so the two arrays are stored sparsely (runs of zeros are skipped)
// and quantised to 1/16 pixel. Playback on an image of another size resamples the mesh and scales the
// displacements with the image. Pure: lib/liquify.js passes its DisplacementField class in.

const Q = 16;

/** [skip, count, v1 … vcount, skip, count, …]: `skip` zeros, then `count` values (quantised integers). */
export function encodeSparse(values) {
  const out = [];
  const n = values.length;
  let i = 0;
  while (i < n) {
    let skip = 0;
    while (i < n && Math.round(values[i] * Q) === 0) {
      i++;
      skip++;
    }
    if (i >= n) break;
    const start = i;
    // a run ends at four zeros in a row (shorter gaps cost less inline than as a new run)
    let end = i, zeros = 0;
    while (end < n && zeros < 4) {
      zeros = Math.round(values[end] * Q) === 0 ? zeros + 1 : 0;
      end++;
    }
    end -= zeros;
    out.push(skip, end - start);
    for (let k = start; k < end; k++) out.push(Math.round(values[k] * Q));
    i = end;
  }
  return out;
}

export function decodeSparse(data, length) {
  const out = new Float32Array(length);
  let at = 0;
  for (let i = 0; i + 1 < data.length; ) {
    at += data[i];
    const count = data[i + 1];
    i += 2;
    for (let k = 0; k < count && at < length; k++, at++) out[at] = (data[i + k] ?? 0) / Q;
    i += count;
  }
  return out;
}

/** Step data of a displacement field: { w, h, cell, gw, gh, dx, dy } (dx / dy sparse). */
export function encodeField(field) {
  return { w: field.w, h: field.h, cell: field.cell, gw: field.gw, gh: field.gh, dx: encodeSparse(field.dx), dy: encodeSparse(field.dy) };
}

/**
 * Rebuilds a field for an image of width × height whose grid cell is `cell`.
 * @param {object} data   encodeField() output
 * @param {new (w: number, h: number, cell: number) => { gw, gh, dx: Float32Array, dy: Float32Array }} Field
 */
export function decodeField(data, Field, width, height, cell) {
  const field = new Field(width, height, cell);
  if (!data || !(data.gw > 0) || !(data.gh > 0)) return field;
  const sdx = decodeSparse(data.dx ?? [], data.gw * data.gh), sdy = decodeSparse(data.dy ?? [], data.gw * data.gh);
  if (data.w === width && data.h === height && data.cell === cell && data.gw === field.gw && data.gh === field.gh) {
    field.dx.set(sdx);
    field.dy.set(sdy);
    return field;
  }
  // another image size: sample the recorded grid at the matching relative position, scale the displacement
  const kx = width / data.w, ky = height / data.h;
  for (let gy = 0; gy < field.gh; gy++) {
    for (let gx = 0; gx < field.gw; gx++) {
      const sx = Math.min(data.gw - 1, Math.max(0, (gx * cell) / kx / data.cell)), sy = Math.min(data.gh - 1, Math.max(0, (gy * cell) / ky / data.cell));
      const x0 = Math.min(data.gw - 2, Math.floor(sx)), y0 = Math.min(data.gh - 2, Math.floor(sy));
      const xa = Math.max(0, x0), ya = Math.max(0, y0);
      const xb = Math.min(data.gw - 1, xa + 1), yb = Math.min(data.gh - 1, ya + 1);
      const fx = sx - xa, fy = sy - ya;
      const at = (arr) => arr[ya * data.gw + xa] * (1 - fx) * (1 - fy) + arr[ya * data.gw + xb] * fx * (1 - fy) + arr[yb * data.gw + xa] * (1 - fx) * fy + arr[yb * data.gw + xb] * fx * fy;
      const i = gy * field.gw + gx;
      field.dx[i] = at(sdx) * kx;
      field.dy[i] = at(sdy) * ky;
    }
  }
  return field;
}
