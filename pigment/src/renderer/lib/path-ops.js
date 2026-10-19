// Shape rendering and path operations (see ARCHITECTURE.md "0.2 features: path operations").
// Every subpath of a PathData may carry `op`: 'combine' (default) | 'subtract' | 'intersect' | 'exclude'.
// The operations apply in subpath order, Photoshop style: the shape's area is built up as a mask
// (combine = union, subtract = remove, intersect = keep the overlap, exclude = XOR) and the fill paint
// is drawn through that mask; the stroke follows every subpath outline.
import { createCanvas, pathToPath2D, makePaint } from './document.js';

/** Renders a ShapeLayer into `canvas` whose top-left is the document point (b.x, b.y). */
export function renderShapeLayer(layer, canvas, b) {
  const ctx = canvas.getContext('2d');
  const p = pathToPath2D(layer.path, -b.x, -b.y);
  const rect = { x: 0, y: 0, width: b.width, height: b.height };
  if (layer.fill) {
    ctx.fillStyle = makePaint(ctx, layer.fill, rect);
    ctx.fill(p, 'nonzero');
  }
  const stroke = layer.stroke;
  if (stroke && stroke.width > 0) {
    ctx.lineWidth = stroke.width * (stroke.align === 'center' || !stroke.align ? 1 : 2);
    ctx.strokeStyle = makePaint(ctx, stroke.paint ?? { type: 'solid', color: stroke.color ?? '#000' }, rect);
    ctx.lineJoin = stroke.join ?? 'miter';
    ctx.lineCap = stroke.cap ?? 'butt';
    ctx.setLineDash(stroke.dash ?? []);
    if (stroke.align === 'inside') {
      ctx.save();
      ctx.clip(p);
      ctx.stroke(p);
      ctx.restore();
    } else if (stroke.align === 'outside') {
      ctx.save();
      ctx.globalCompositeOperation = 'destination-over';
      ctx.stroke(p);
      ctx.restore();
      // keep fill on top: redraw fill
      if (layer.fill) {
        ctx.fillStyle = makePaint(ctx, layer.fill, rect);
        ctx.fill(p, 'nonzero');
      }
    } else ctx.stroke(p);
  }
  return canvas;
}

export { createCanvas };
