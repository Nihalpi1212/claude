//! Pixel helpers for the generative commands, ported from JavaScript Pigment's `features.js` and
//! `providers.js`: the fill region, masks, compositing through a mask, keying a white
//! background, cover-fit, padding to an aspect ratio and resampling. Pure functions on
//! [`Rgba8Image`]s and coverage arrays, so the engine commands and the provider backend share
//! them.
//!
//! Masks are coverage in `0..=1` (or an image's alpha), **1 = may change**.

use photocraft_geom::Rect;
use photocraft_raster::Rgba8Image;

/// The area sent for a selection whose bounds are `sel` (JS `fillRegion`): the bounds padded by
/// 25 % on each side, made square-ish, clamped to the `doc_w` × `doc_h` canvas, at most `max`
/// pixels a side unless the selection itself is larger. The padding shrinks first.
pub fn fill_region(sel: Rect, doc_w: u32, doc_h: u32, max: u32) -> Rect {
    let sel = sel.intersect(&Rect::new(0, 0, doc_w as i32, doc_h as i32));
    let (bx, by, bw, bh) = (f64::from(sel.x0), f64::from(sel.y0), f64::from(sel.width()), f64::from(sel.height()));
    let (dw, dh, max) = (f64::from(doc_w), f64::from(doc_h), f64::from(max));
    let side = bw.max(bh);
    let mut size = (side * 1.5).ceil();
    if size > max {
        size = side.max(max);
    }
    let mut w = bw.max(size.min(dw));
    let mut h = bh.max(size.min(dh));
    w = dw.min(w.max(h.min(dw)));
    h = dh.min(h.max(w.min(dh)));
    // Math.round: halves go up.
    let x = (bx + bw / 2.0 - w / 2.0 + 0.5).floor().clamp(0.0, (dw - w).max(0.0));
    let y = (by + bh / 2.0 - h / 2.0 + 0.5).floor().clamp(0.0, (dh - h).max(0.0));
    Rect::from_xywh(x as i32, y as i32, w as u32, h as u32)
}

/// `v` (`w` × `h` coverage) blurred with a Gaussian of sigma `radius / 2`, as if the image went on
/// beyond its border (JS `featherKeepingBorder`: the edge pixels are repeated), so coverage that
/// touches the border stays full there.
pub fn feather_keeping_border(v: &[f32], w: usize, h: usize, radius: f32) -> Vec<f32> {
    if v.len() != w * h || w == 0 || h == 0 || radius <= 0.0 {
        return v.to_vec();
    }
    let sigma = radius / 2.0;
    let r = (sigma * 3.0).ceil() as isize;
    let kernel: Vec<f32> = (-r..=r).map(|i| (-((i * i) as f32) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = kernel.iter().sum();
    let kernel: Vec<f32> = kernel.iter().map(|k| k / sum).collect();
    let pass = |src: &[f32], horizontal: bool| -> Vec<f32> {
        let mut out = vec![0.0; src.len()];
        for y in 0..h {
            for x in 0..w {
                let mut acc = 0.0;
                for (k, weight) in kernel.iter().enumerate() {
                    let d = k as isize - r;
                    let (sx, sy) = if horizontal {
                        ((x as isize + d).clamp(0, w as isize - 1) as usize, y)
                    } else {
                        (x, (y as isize + d).clamp(0, h as isize - 1) as usize)
                    };
                    acc += weight * src.get(sy * w + sx).copied().unwrap_or(0.0);
                }
                if let Some(o) = out.get_mut(y * w + x) {
                    *o = acc.clamp(0.0, 1.0);
                }
            }
        }
        out
    };
    pass(&pass(v, true), false)
}

/// `answer` blended over `original` by `mask`'s alpha (JS `compositeThroughMask`): alpha 0 keeps
/// the original pixel exactly, 255 takes the answer's, in between is a premultiplied blend. All
/// three images have the same size (otherwise the original is returned).
pub fn composite_through_mask(original: &Rgba8Image, answer: &Rgba8Image, mask: &Rgba8Image) -> Rgba8Image {
    let same = |i: &Rgba8Image| i.width == original.width && i.height == original.height && i.pixels.len() == original.pixels.len();
    if !same(answer) || !same(mask) {
        return original.clone();
    }
    let mut out = original.clone();
    for ((o, q), m) in out.pixels.chunks_exact_mut(4).zip(answer.pixels.chunks_exact(4)).zip(mask.pixels.chunks_exact(4)) {
        let t = f32::from(m[3]) / 255.0;
        if m[3] == 0 {
            continue;
        }
        if m[3] == 255 {
            o.copy_from_slice(q);
            continue;
        }
        let (pa, qa) = (f32::from(o[3]) / 255.0, f32::from(q[3]) / 255.0);
        let oa = pa + (qa - pa) * t;
        for c in 0..3 {
            let v = if oa > 0.0 { (f32::from(o[c]) * pa * (1.0 - t) + f32::from(q[c]) * qa * t) / oa } else { 0.0 };
            o[c] = to_u8(v / 255.0);
        }
        o[3] = to_u8(oa);
    }
    out
}

/// The pixels a new layer holds for `answer` over a coverage `cov` of the same size: the answer's
/// colour with its alpha multiplied by the coverage (JS destination-in with the mask). Over the
/// untouched document this shows the original where the coverage is 0, exactly, and the answer
/// where it is 1.
pub fn masked_layer(answer: &Rgba8Image, cov: &[f32]) -> Rgba8Image {
    let mut out = answer.clone();
    for (p, c) in out.pixels.chunks_exact_mut(4).zip(cov) {
        p[3] = to_u8(f32::from(p[3]) / 255.0 * c.clamp(0.0, 1.0));
        if p[3] == 0 {
            p.copy_from_slice(&[0, 0, 0, 0]);
        }
    }
    out
}

/// An image's alpha as coverage (JS `alphaToMask`).
pub fn alpha_to_mask(img: &Rgba8Image) -> Vec<f32> {
    img.pixels.chunks_exact(4).map(|p| f32::from(p[3]) / 255.0).collect()
}

/// `1 - v` (JS `invertMask`).
pub fn invert_mask(v: &[f32]) -> Vec<f32> {
    v.iter().map(|a| 1.0 - a.clamp(0.0, 1.0)).collect()
}

/// Where an image is transparent, as coverage: `1 - alpha` (JS `transparentAreaMask`).
pub fn transparent_area_mask(img: &Rgba8Image) -> Vec<f32> {
    invert_mask(&alpha_to_mask(img))
}

/// Coverage as a mask image of Pigment's convention: white, alpha = coverage.
pub fn mask_image(cov: &[f32], w: u32, h: u32) -> Rgba8Image {
    let mut img = Rgba8Image::new(w, h);
    for (p, c) in img.pixels.chunks_exact_mut(4).zip(cov) {
        p.copy_from_slice(&[255, 255, 255, to_u8(*c)]);
    }
    img
}

/// Every pixel is opaque.
pub fn is_opaque(img: &Rgba8Image) -> bool {
    img.pixels.chunks_exact(4).all(|p| p[3] == 255)
}

/// Make the near-white background around a subject transparent (JS `keyWhiteBorder`): a flood
/// fill from all four borders over pixels whose R, G and B are all at least `threshold`
/// (4-connected) sets their alpha to 0; then each pixel left that touches a keyed one and is
/// light (`min(R, G, B) > 200`) keeps `alpha × (255 − min) / 55`, softening the white fringe.
pub fn key_white_border(img: &mut Rgba8Image, threshold: u8) {
    let (w, h) = (img.width as usize, img.height as usize);
    if w == 0 || h == 0 || img.pixels.len() != w * h * 4 {
        return;
    }
    let white = |px: &[u8]| px.iter().take(3).all(|c| *c >= threshold);
    let mut keyed = vec![false; w * h];
    let mut stack: Vec<usize> = Vec::new();
    for x in 0..w {
        stack.push(x);
        stack.push((h - 1) * w + x);
    }
    for y in 0..h {
        stack.push(y * w);
        stack.push(y * w + w - 1);
    }
    while let Some(i) = stack.pop() {
        if keyed.get(i).copied().unwrap_or(true) || !img.pixels.get(i * 4..i * 4 + 4).is_some_and(white) {
            continue;
        }
        if let Some(k) = keyed.get_mut(i) {
            *k = true;
        }
        let (x, y) = (i % w, i / w);
        if x > 0 {
            stack.push(i - 1);
        }
        if x + 1 < w {
            stack.push(i + 1);
        }
        if y > 0 {
            stack.push(i - w);
        }
        if y + 1 < h {
            stack.push(i + w);
        }
    }
    let original = img.pixels.clone();
    for i in 0..w * h {
        let Some(px) = img.pixels.get_mut(i * 4..i * 4 + 4) else { continue };
        if keyed.get(i).copied().unwrap_or(false) {
            px[3] = 0;
            continue;
        }
        let (x, y) = (i % w, i / w);
        let touches = (x > 0 && keyed[i - 1]) || (x + 1 < w && keyed[i + 1]) || (y > 0 && keyed[i - w]) || (y + 1 < h && keyed[i + w]);
        let Some(src) = original.get(i * 4..i * 4 + 4) else { continue };
        let min = src[0].min(src[1]).min(src[2]);
        if touches && min > 200 {
            px[3] = (u32::from(src[3]) * u32::from(255 - min) / 55).min(255) as u8;
        }
    }
}

/// `(w, h)` scaled down to fit `max_edge` on its long side (never up), at least 1 × 1.
pub fn fit_within(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    let long = w.max(h).max(1);
    if long <= max_edge {
        return (w.max(1), h.max(1));
    }
    let k = f64::from(max_edge) / f64::from(long);
    (((f64::from(w) * k).round() as u32).max(1), ((f64::from(h) * k).round() as u32).max(1))
}

/// `img` scaled to cover `w` × `h` and centre-cropped: never stretched (JS `coverTo`).
pub fn cover_to(img: &Rgba8Image, w: u32, h: u32) -> Rgba8Image {
    if img.width == w && img.height == h {
        return img.clone();
    }
    if img.width == 0 || img.height == 0 || w == 0 || h == 0 {
        return Rgba8Image::new(w, h);
    }
    let k = (f64::from(w) / f64::from(img.width)).max(f64::from(h) / f64::from(img.height));
    let sw = ((f64::from(img.width) * k).round() as u32).max(w);
    let sh = ((f64::from(img.height) * k).round() as u32).max(h);
    let scaled = resize_rgba8(img, sw, sh);
    crop(&scaled, Rect::from_xywh(((sw - w) / 2) as i32, ((sh - h) / 2) as i32, w, h))
}

/// The part of `img` inside `r` (in image coordinates); pixels outside the image are transparent.
pub fn crop(img: &Rgba8Image, r: Rect) -> Rgba8Image {
    let mut out = Rgba8Image::new(r.width(), r.height());
    let (iw, ih) = (img.width as i32, img.height as i32);
    for y in 0..r.height() as i32 {
        let sy = r.y0 + y;
        if sy < 0 || sy >= ih {
            continue;
        }
        let x0 = r.x0.max(0);
        let x1 = r.x1.min(iw);
        if x0 >= x1 {
            continue;
        }
        let src = (sy as usize * iw as usize + x0 as usize) * 4..(sy as usize * iw as usize + x1 as usize) * 4;
        let dst_start = (y as usize * r.width() as usize + (x0 - r.x0) as usize) * 4;
        let len = src.len();
        if let (Some(s), Some(d)) = (img.pixels.get(src), out.pixels.get_mut(dst_start..dst_start + len)) {
            d.copy_from_slice(s);
        }
    }
    out
}

/// `image` (and `mask`) padded, centred, to the aspect ratio `aspect` (width / height) (JS
/// `padToAspect`): the image's padding is `fill`, the mask's is transparent (keep). Returns the
/// padded image, the padded mask and where the original sits in them.
pub fn pad_to_aspect(image: &Rgba8Image, mask: Option<&Rgba8Image>, aspect: f64, fill: [u8; 4]) -> (Rgba8Image, Option<Rgba8Image>, Rect) {
    let (w, h) = (image.width.max(1), image.height.max(1));
    let current = f64::from(w) / f64::from(h);
    let (pw, ph) = if !aspect.is_finite() || aspect <= 0.0 || (current - aspect).abs() < 1e-9 {
        (w, h)
    } else if current < aspect {
        (((f64::from(h) * aspect).round() as u32).max(w), h)
    } else {
        (w, ((f64::from(w) / aspect).round() as u32).max(h))
    };
    let at = Rect::from_xywh(((pw - w) / 2) as i32, ((ph - h) / 2) as i32, w, h);
    let place = |src: &Rgba8Image, pad: [u8; 4]| {
        let mut out = Rgba8Image { width: pw, height: ph, pixels: pad.repeat(pw as usize * ph as usize) };
        for y in 0..h as usize {
            let s = y * w as usize * 4;
            let d = ((y + at.y0 as usize) * pw as usize + at.x0 as usize) * 4;
            let n = w as usize * 4;
            if let (Some(s), Some(d)) = (src.pixels.get(s..s + n), out.pixels.get_mut(d..d + n)) {
                d.copy_from_slice(s);
            }
        }
        out
    };
    (place(image, fill), mask.map(|m| place(m, [0, 0, 0, 0])), at)
}

/// `img` resampled to `w` × `h` on premultiplied colour: area averaging along an axis that
/// shrinks, bilinear along one that grows.
pub fn resize_rgba8(img: &Rgba8Image, w: u32, h: u32) -> Rgba8Image {
    if img.width == w && img.height == h {
        return img.clone();
    }
    let (sw, sh) = (img.width as usize, img.height as usize);
    if sw == 0 || sh == 0 || w == 0 || h == 0 || img.pixels.len() != sw * sh * 4 {
        return Rgba8Image::new(w, h);
    }
    let pre: Vec<[f32; 4]> = img
        .pixels
        .chunks_exact(4)
        .map(|p| {
            let a = f32::from(p[3]) / 255.0;
            [f32::from(p[0]) / 255.0 * a, f32::from(p[1]) / 255.0 * a, f32::from(p[2]) / 255.0 * a, a]
        })
        .collect();
    let (w, h) = (w as usize, h as usize);
    // Rows first, then columns.
    let mut rows = vec![[0.0f32; 4]; w * sh];
    for y in 0..sh {
        let src: Vec<[f32; 4]> = pre.get(y * sw..(y + 1) * sw).map(<[_]>::to_vec).unwrap_or_default();
        if let Some(dst) = rows.get_mut(y * w..(y + 1) * w) {
            resample_line(&src, dst);
        }
    }
    let mut out = vec![[0.0f32; 4]; w * h];
    let mut col = vec![[0.0f32; 4]; sh];
    let mut res = vec![[0.0f32; 4]; h];
    for x in 0..w {
        for (y, c) in col.iter_mut().enumerate() {
            *c = rows.get(y * w + x).copied().unwrap_or_default();
        }
        resample_line(&col, &mut res);
        for (y, v) in res.iter().enumerate() {
            if let Some(o) = out.get_mut(y * w + x) {
                *o = *v;
            }
        }
    }
    let mut img = Rgba8Image::new(w as u32, h as u32);
    for (p, v) in img.pixels.chunks_exact_mut(4).zip(&out) {
        let a = v[3].clamp(0.0, 1.0);
        let un = |c: f32| if a > 0.0 { to_u8(c / a) } else { 0 };
        p.copy_from_slice(&[un(v[0]), un(v[1]), un(v[2]), to_u8(a)]);
    }
    img
}

/// One line of [`resize_rgba8`]: `src` resampled into `dst`.
fn resample_line(src: &[[f32; 4]], dst: &mut [[f32; 4]]) {
    let (n, m) = (src.len(), dst.len());
    if n == 0 || m == 0 {
        return;
    }
    let at = |i: usize| src.get(i.min(n - 1)).copied().unwrap_or_default();
    if m == n {
        dst.copy_from_slice(src);
    } else if m < n {
        // Area: output pixel i covers source [i·s, (i + 1)·s).
        let s = n as f64 / m as f64;
        for (i, d) in dst.iter_mut().enumerate() {
            let (a, b) = (i as f64 * s, (i as f64 + 1.0) * s);
            let mut acc = [0.0f64; 4];
            let mut j = a.floor() as usize;
            while (j as f64) < b && j < n {
                let overlap = (b.min(j as f64 + 1.0) - a.max(j as f64)).max(0.0);
                let p = at(j);
                for c in 0..4 {
                    acc[c] += f64::from(p[c]) * overlap;
                }
                j += 1;
            }
            *d = acc.map(|v| (v / s) as f32);
        }
    } else {
        let s = n as f64 / m as f64;
        for (i, d) in dst.iter_mut().enumerate() {
            let x = ((i as f64 + 0.5) * s - 0.5).clamp(0.0, (n - 1) as f64);
            let j = x.floor() as usize;
            let t = (x - j as f64) as f32;
            let (p, q) = (at(j), at(j + 1));
            *d = [0, 1, 2, 3].map(|c| p[c] + (q[c] - p[c]) * t);
        }
    }
}

fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Rgba8Image {
        let mut i = Rgba8Image::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let o = ((y * w + x) * 4) as usize;
                i.pixels[o..o + 4].copy_from_slice(&f(x, y));
            }
        }
        i
    }

    #[test]
    fn fill_region_pads_squares_and_clamps() {
        // A 100 × 40 selection in the middle of a large canvas: 150 × 150 around its centre.
        assert_eq!(fill_region(Rect::from_xywh(500, 500, 100, 40), 2000, 2000, 1536), Rect::from_xywh(475, 445, 150, 150));
        // Near the corner it is pushed inside the canvas.
        assert_eq!(fill_region(Rect::from_xywh(0, 0, 100, 100), 2000, 2000, 1536), Rect::from_xywh(0, 0, 150, 150));
        // A small canvas caps it.
        assert_eq!(fill_region(Rect::from_xywh(10, 10, 80, 80), 100, 60, 1536), Rect::from_xywh(0, 0, 100, 60));
        // A large selection drops the padding first, then exceeds the cap.
        assert_eq!(fill_region(Rect::from_xywh(0, 0, 1200, 300), 4000, 4000, 1536), Rect::from_xywh(0, 0, 1536, 1536));
        assert_eq!(fill_region(Rect::from_xywh(100, 100, 2000, 100), 4000, 4000, 1536).width(), 2000);
        // Always contains the selection.
        let s = Rect::from_xywh(37, 81, 211, 19);
        assert!(fill_region(s, 300, 120, 1536).contains_rect(&s));
    }

    #[test]
    fn feathering_keeps_full_coverage_at_the_border() {
        let (w, h) = (8, 6);
        let mut v = vec![0.0; w * h];
        for y in 0..h {
            for x in 0..4 {
                v[y * w + x] = 1.0;
            }
        }
        let f = feather_keeping_border(&v, w, h, 1.0);
        assert!((f[0] - 1.0).abs() < 1e-6, "the border pixel stays fully covered: {}", f[0]);
        assert!(f[3] < 1.0 && f[3] > 0.5 && f[4] > 0.0 && f[4] < 0.5, "a soft edge: {} {}", f[3], f[4]);
        assert!(f[7] < 1e-3);
    }

    #[test]
    fn compositing_through_a_mask_keeps_unmasked_pixels_exact() {
        let orig = img(4, 1, |x, _| [10 * x as u8, 20, 30, 255]);
        let answer = img(4, 1, |_, _| [200, 100, 50, 255]);
        let mask = img(4, 1, |x, _| [255, 255, 255, [0, 255, 128, 0][x as usize]]);
        let out = composite_through_mask(&orig, &answer, &mask);
        assert_eq!(&out.pixels[0..4], &orig.pixels[0..4]);
        assert_eq!(&out.pixels[4..8], &answer.pixels[4..8]);
        assert_eq!(&out.pixels[12..16], &orig.pixels[12..16]);
        let mid = &out.pixels[8..12];
        assert!(mid[0] > 20 && mid[0] < 200 && mid[3] == 255, "{mid:?}");
    }

    #[test]
    fn a_masked_layer_holds_only_the_covered_pixels() {
        let answer = img(3, 1, |_, _| [9, 8, 7, 255]);
        let out = masked_layer(&answer, &[0.0, 0.5, 1.0]);
        assert_eq!(out.pixels, vec![0, 0, 0, 0, 9, 8, 7, 128, 9, 8, 7, 255]);
    }

    #[test]
    fn masks_invert_and_read_transparency() {
        let i = img(2, 1, |x, _| [0, 0, 0, if x == 0 { 0 } else { 255 }]);
        assert_eq!(transparent_area_mask(&i), vec![1.0, 0.0]);
        assert_eq!(invert_mask(&alpha_to_mask(&i)), vec![1.0, 0.0]);
        assert!(!is_opaque(&i));
        assert_eq!(mask_image(&[0.0, 1.0], 2, 1).pixels, vec![255, 255, 255, 0, 255, 255, 255, 255]);
    }

    #[test]
    fn keying_removes_the_white_border_but_not_white_inside_the_subject() {
        // White around a dark ring that encloses a white centre.
        let ring = |x: u32, y: u32| (1..=5).contains(&x) && (1..=5).contains(&y) && !((2..=4).contains(&x) && (2..=4).contains(&y));
        let mut i = img(7, 7, |x, y| if ring(x, y) { [20, 20, 20, 255] } else { [250, 250, 250, 255] });
        key_white_border(&mut i, 232);
        let a = |x: usize, y: usize| i.pixels[(y * 7 + x) * 4 + 3];
        assert_eq!(a(0, 0), 0);
        assert_eq!(a(6, 3), 0);
        assert_eq!(a(1, 1), 255, "the subject stays");
        assert_eq!(a(3, 3), 255, "white enclosed by the subject stays");
    }

    #[test]
    fn keying_softens_a_light_fringe() {
        let mut i = img(3, 1, |x, _| {
            let v = [255, 220, 10][x as usize];
            [v, v, v, 255]
        });
        key_white_border(&mut i, 232);
        assert_eq!(i.pixels[3], 0);
        assert_eq!(i.pixels[7], (255 * (255 - 220) / 55) as u8);
        assert_eq!(i.pixels[11], 255);
    }

    #[test]
    fn cover_never_stretches() {
        // A 4 × 2 image with a left half red and right half blue, covered to 2 × 2: the middle.
        let i = img(4, 2, |x, _| if x < 2 { [255, 0, 0, 255] } else { [0, 0, 255, 255] });
        let c = cover_to(&i, 2, 2);
        assert_eq!((c.width, c.height), (2, 2));
        assert_eq!(&c.pixels[0..4], &[255, 0, 0, 255]);
        assert_eq!(&c.pixels[4..8], &[0, 0, 255, 255]);
        let wide = cover_to(&i, 8, 2);
        assert_eq!((wide.width, wide.height), (8, 2));
    }

    #[test]
    fn padding_to_an_aspect_centres_the_image() {
        let i = img(2, 2, |_, _| [1, 2, 3, 255]);
        let m = img(2, 2, |_, _| [255, 255, 255, 255]);
        let (p, pm, at) = pad_to_aspect(&i, Some(&m), 2.0, [255, 255, 255, 255]);
        assert_eq!((p.width, p.height), (4, 2));
        assert_eq!(at, Rect::from_xywh(1, 0, 2, 2));
        assert_eq!(&p.pixels[0..4], &[255, 255, 255, 255]);
        assert_eq!(&p.pixels[4..8], &[1, 2, 3, 255]);
        let pm = pm.unwrap();
        assert_eq!(pm.pixels[3], 0, "mask padding is keep");
        assert_eq!(pm.pixels[7], 255);
        let (tall, _, at) = pad_to_aspect(&i, None, 0.5, [0; 4]);
        assert_eq!((tall.width, tall.height, at), (2, 4, Rect::from_xywh(0, 1, 2, 2)));
    }

    #[test]
    fn resizing_keeps_flat_colour_and_averages_down() {
        let flat = img(5, 3, |_, _| [40, 80, 120, 255]);
        for (w, h) in [(10, 6), (2, 1), (7, 7)] {
            let r = resize_rgba8(&flat, w, h);
            assert_eq!((r.width, r.height), (w, h));
            assert!(r.pixels.chunks_exact(4).all(|p| p == [40, 80, 120, 255]), "{w}x{h}");
        }
        let checker = img(2, 2, |x, y| if (x + y) % 2 == 0 { [0, 0, 0, 255] } else { [255, 255, 255, 255] });
        let one = resize_rgba8(&checker, 1, 1);
        assert!((126..=129).contains(&one.pixels[0]), "{:?}", one.pixels);
        // Transparent pixels don't darken their neighbours (premultiplied).
        let half = img(2, 1, |x, _| if x == 0 { [255, 255, 255, 255] } else { [0, 0, 0, 0] });
        let p = resize_rgba8(&half, 1, 1);
        assert_eq!(&p.pixels, &[255, 255, 255, 128]);
        assert_eq!(fit_within(4000, 1000, 2048), (2048, 512));
        assert_eq!(fit_within(100, 50, 2048), (100, 50));
    }
}
