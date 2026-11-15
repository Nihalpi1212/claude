//! Pixels on the wire: decoding answers with limits, PNG and base64 encoding, and the masks each
//! provider expects. Images are the engine's [`Rgba8Image`] (sRGB, straight alpha) throughout.

use std::io::Cursor;

use base64::Engine as _;
use image::{ImageFormat, ImageReader, Limits, RgbaImage};
use photocraft_raster::Rgba8Image;

use crate::{AiError, Result};

/// The largest image decoded from a provider (per side).
pub const MAX_SIDE: u32 = 8192;

/// Decode `bytes` (PNG, JPEG or WebP) with size limits: a hostile answer can't make Pigment
/// allocate gigabytes.
pub fn decode(bytes: &[u8]) -> Result<Rgba8Image> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| AiError::bad_response("The model returned an image that could not be decoded."))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| AiError::bad_response(format!("The model returned an image that could not be decoded ({e}).")))?;
    let rgba = img.to_rgba8();
    Ok(Rgba8Image { width: rgba.width(), height: rgba.height(), pixels: rgba.into_raw() })
}

/// `img` as PNG bytes.
pub fn encode_png(img: &Rgba8Image) -> Result<Vec<u8>> {
    let buf = RgbaImage::from_raw(img.width, img.height, img.pixels.clone()).ok_or_else(|| AiError::bad_request("The image to send has no pixels."))?;
    let mut out = Cursor::new(Vec::new());
    buf.write_to(&mut out, ImageFormat::Png).map_err(|e| AiError::bad_request(format!("The image could not be encoded ({e}).")))?;
    Ok(out.into_inner())
}

/// Standard base64 with padding, as both providers send and take it.
pub fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Base64 from a provider (padding optional, whitespace ignored); `None` when it isn't base64.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let clean: String = text.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(clean.as_bytes())
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(clean.trim_end_matches('=').as_bytes()))
        .ok()
}

/// Pigment's mask (alpha 255 = may change) as OpenAI's (JS `openaiMask`): black, alpha
/// `255 − a`, so alpha 0 marks what may change.
pub fn openai_mask(mask: &Rgba8Image) -> Rgba8Image {
    let mut out = mask.clone();
    for p in out.pixels.chunks_exact_mut(4) {
        let a = p.get(3).copied().unwrap_or(0);
        p.copy_from_slice(&[0, 0, 0, 255 - a]);
    }
    out
}

/// Pigment's mask as Gemini is told about it (JS `whiteMask`): opaque, grey = the mask's alpha,
/// so white may change and black is kept.
pub fn white_mask(mask: &Rgba8Image) -> Rgba8Image {
    let mut out = mask.clone();
    for p in out.pixels.chunks_exact_mut(4) {
        let a = p.get(3).copied().unwrap_or(0);
        p.copy_from_slice(&[a, a, a, 255]);
    }
    out
}

/// `w × h` (`"1536x1024"`).
pub fn parse_size(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}
