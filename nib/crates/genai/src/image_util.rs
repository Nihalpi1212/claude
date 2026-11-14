//! Pixels: decoding answers with limits, PNG encoding, and the canvas and mask Generative Expand
//! sends and puts back together.

use std::io::Cursor;

use image::{ImageFormat, ImageReader, Limits, Rgba, RgbaImage, imageops};

use crate::{AiError, Result};

/// The largest image decoded from a provider or a document (per side).
pub const MAX_SIDE: u32 = 8192;
/// The largest canvas Generative Expand makes (pixels).
pub const MAX_EXPAND_PIXELS: u64 = 4096 * 4096;

/// Decode `bytes` (PNG, JPEG, WebP, GIF, TIFF, BMP, TGA) with size limits: a hostile answer can't
/// make Nib allocate gigabytes.
pub fn decode(bytes: &[u8]) -> Result<RgbaImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| AiError::bad_response("The image could not be read."))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| AiError::bad_response(format!("The image could not be read ({e}).")))?;
    Ok(img.to_rgba8())
}

pub fn encode_png(img: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, ImageFormat::Png).map_err(|e| AiError::bad_request(format!("The image could not be encoded ({e}).")))?;
    Ok(out.into_inner())
}

/// Width and height from a PNG's header, without decoding it.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(..8)? != b"\x89PNG\r\n\x1a\n" || bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let h = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// An OpenAI-style mask (alpha 0 = may change) as a white-on-black image (white = may change),
/// the form Gemini is told about.
pub fn white_mask(mask_png: &[u8]) -> Result<Vec<u8>> {
    let mut m = decode(mask_png)?;
    for p in m.pixels_mut() {
        let v = if p.0[3] < 128 { 255 } else { 0 };
        *p = Rgba([v, v, v, 255]);
    }
    encode_png(&m)
}

/// `img` scaled to cover `w × h` and cropped to it, centred (never stretched).
pub fn cover(img: &RgbaImage, w: u32, h: u32) -> RgbaImage {
    let (w, h) = (w.max(1), h.max(1));
    if img.width() == w && img.height() == h {
        return img.clone();
    }
    let s = (f64::from(w) / f64::from(img.width().max(1))).max(f64::from(h) / f64::from(img.height().max(1)));
    let sw = ((f64::from(img.width()) * s).ceil() as u32).max(w);
    let sh = ((f64::from(img.height()) * s).ceil() as u32).max(h);
    let scaled = imageops::resize(img, sw, sh, imageops::FilterType::Triangle);
    imageops::crop_imm(&scaled, (sw - w) / 2, (sh - h) / 2, w, h).to_image()
}

/// How a Generative Expand canvas is laid out and sent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExpandPlan {
    /// The new image's size, in the original's pixels.
    pub canvas_w: u32,
    pub canvas_h: u32,
    /// Where the original's top-left lands in the canvas.
    pub ox: u32,
    pub oy: u32,
    /// The size the provider gets (one of its sizes).
    pub send_w: u32,
    pub send_h: u32,
    /// The canvas letterboxed into the send size: its scale and offset there.
    pub scale: f64,
    pub pad_x: u32,
    pub pad_y: u32,
}

impl ExpandPlan {
    /// A plan growing a `w × h` image by `left, top, right, bottom` pixels, sent at `send`.
    pub fn new(w: u32, h: u32, [left, top, right, bottom]: [u32; 4], send: (u32, u32)) -> Result<Self> {
        let canvas_w = w.checked_add(left).and_then(|v| v.checked_add(right)).ok_or_else(too_big)?;
        let canvas_h = h.checked_add(top).and_then(|v| v.checked_add(bottom)).ok_or_else(too_big)?;
        if u64::from(canvas_w) * u64::from(canvas_h) > MAX_EXPAND_PIXELS || canvas_w > MAX_SIDE || canvas_h > MAX_SIDE {
            return Err(too_big());
        }
        if canvas_w == w && canvas_h == h {
            return Err(AiError::bad_request("Make the image larger on at least one side."));
        }
        let (send_w, send_h) = (send.0.max(1), send.1.max(1));
        let scale = (f64::from(send_w) / f64::from(canvas_w)).min(f64::from(send_h) / f64::from(canvas_h));
        let fit_w = ((f64::from(canvas_w) * scale).round() as u32).clamp(1, send_w);
        let fit_h = ((f64::from(canvas_h) * scale).round() as u32).clamp(1, send_h);
        Ok(Self { canvas_w, canvas_h, ox: left, oy: top, send_w, send_h, scale, pad_x: (send_w - fit_w) / 2, pad_y: (send_h - fit_h) / 2 })
    }

    fn fit(&self) -> (u32, u32) {
        (self.send_w - 2 * self.pad_x, self.send_h - 2 * self.pad_y)
    }

    /// The image and mask PNGs to send: the original scaled into place on a transparent canvas;
    /// the mask opaque over the original and transparent (may change) everywhere else.
    pub fn inputs(&self, original: &RgbaImage) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut canvas = RgbaImage::from_pixel(self.canvas_w, self.canvas_h, Rgba([0, 0, 0, 0]));
        imageops::replace(&mut canvas, original, i64::from(self.ox), i64::from(self.oy));
        let (fw, fh) = self.fit();
        let small = imageops::resize(&canvas, fw, fh, imageops::FilterType::Triangle);
        let mut image = RgbaImage::from_pixel(self.send_w, self.send_h, Rgba([0, 0, 0, 0]));
        imageops::replace(&mut image, &small, i64::from(self.pad_x), i64::from(self.pad_y));
        // The mask keeps a 2-pixel margin inside the original's edge so the model blends the seam;
        // the original's own pixels are put back exactly afterwards ([`Self::compose`]).
        let mut mask = RgbaImage::from_pixel(self.send_w, self.send_h, Rgba([0, 0, 0, 0]));
        let x0 = f64::from(self.pad_x) + f64::from(self.ox) * self.scale;
        let y0 = f64::from(self.pad_y) + f64::from(self.oy) * self.scale;
        let x1 = x0 + f64::from(original.width()) * self.scale;
        let y1 = y0 + f64::from(original.height()) * self.scale;
        for (x, y, p) in mask.enumerate_pixels_mut() {
            let (fx, fy) = (f64::from(x) + 0.5, f64::from(y) + 0.5);
            if fx > x0 + 2.0 && fx < x1 - 2.0 && fy > y0 + 2.0 && fy < y1 - 2.0 {
                *p = Rgba([0, 0, 0, 255]);
            }
        }
        Ok((encode_png(&image)?, encode_png(&mask)?))
    }

    /// The new image: the answer's letterboxed canvas scaled back to the canvas size, with the
    /// original's pixels exactly where they were.
    pub fn compose(&self, original: &RgbaImage, answer: &RgbaImage) -> RgbaImage {
        let answer = if answer.width() == self.send_w && answer.height() == self.send_h {
            answer.clone()
        } else {
            imageops::resize(answer, self.send_w, self.send_h, imageops::FilterType::Triangle)
        };
        let (fw, fh) = self.fit();
        let inner = imageops::crop_imm(&answer, self.pad_x, self.pad_y, fw, fh).to_image();
        let mut out = imageops::resize(&inner, self.canvas_w, self.canvas_h, imageops::FilterType::CatmullRom);
        imageops::replace(&mut out, original, i64::from(self.ox), i64::from(self.oy));
        out
    }
}

fn too_big() -> AiError {
    AiError::bad_request(format!("The expanded image would be over {} megapixels.", MAX_EXPAND_PIXELS / 1_000_000))
}

/// `"1536x1024"` → (1536, 1024).
pub fn parse_size(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

/// A `"16:9"` ratio as a size whose long side is `long`.
pub fn ratio_size(ratio: &str, long: u32) -> (u32, u32) {
    let mut it = ratio.split(':').map(|n| n.parse::<f64>().unwrap_or(1.0).max(1.0));
    let (a, b) = (it.next().unwrap_or(1.0), it.next().unwrap_or(1.0));
    let l = f64::from(long);
    if a >= b { (long, ((l * b / a).round() as u32).max(1)) } else { (((l * a / b).round() as u32).max(1), long) }
}
