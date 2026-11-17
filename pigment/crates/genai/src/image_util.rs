//! Pixels on the wire: decoding answers with limits, PNG and base64 encoding, and the masks each
//! provider expects. Images are the engine's [`Rgba8Image`] (sRGB, straight alpha) throughout.

use std::io::Cursor;

use base64::Engine as _;
use image::{ImageFormat, ImageReader, Limits, RgbaImage};
use photocraft_raster::Rgba8Image;

use crate::{AiError, Result};

/// The largest image decoded from a provider (per side).
pub const MAX_SIDE: u32 = 8192;
/// The most pixels decoded from a provider: 24 megapixels. Requests ask for at most 2048 px a
/// side, and the largest answer a provider gives to those is under 5 megapixels (Gemini's 2K);
/// an answer is resampled as premultiplied floats (16 bytes a pixel), so an 8192 × 8192 one, a
/// few hundred kilobytes as a flat PNG, would take over a gigabyte.
pub const MAX_PIXELS: u64 = 24_000_000;

/// Decode `bytes` (PNG, JPEG or WebP) with size limits: a hostile answer can't make Pigment
/// allocate gigabytes. The size is read from the header and refused before any pixel is decoded.
pub fn decode(bytes: &[u8]) -> Result<Rgba8Image> {
    let undecodable = || AiError::bad_response("The model returned an image that could not be decoded.");
    let (w, h) = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| undecodable())?.into_dimensions().map_err(|_| undecodable())?;
    if w == 0 || h == 0 || w > MAX_SIDE || h > MAX_SIDE || u64::from(w) * u64::from(h) > MAX_PIXELS {
        return Err(AiError::bad_response(format!("The model returned an image of a size Pigment can't use ({w} × {h} px).")));
    }
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|_| undecodable())?;
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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for b in bytes {
            crc ^= u32::from(*b);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }

    /// A PNG that is only its signature, its header and the start of its (empty) pixel data:
    /// enough to read the size it claims.
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend(w.to_be_bytes());
        ihdr.extend(h.to_be_bytes());
        ihdr.extend([8, 6, 0, 0, 0]);
        let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
        for chunk in [ihdr.as_slice(), b"IDAT"] {
            out.extend((chunk.len() as u32 - 4).to_be_bytes());
            out.extend(chunk);
            out.extend(crc32(chunk).to_be_bytes());
        }
        out
    }

    /// An answer that claims a huge size is refused from its header, before anything is
    /// allocated for its pixels: 8192 × 8192 fits the per-side limit but not the pixel budget.
    #[test]
    fn an_answer_too_large_to_resample_is_refused_before_it_is_decoded() {
        for (w, h) in [(8192, 8192), (6000, 5000), (20_000, 16), (16, 20_000)] {
            let e = decode(&png_header(w, h)).unwrap_err();
            assert_eq!(e.kind, crate::ErrorKind::BadResponse);
            assert!(e.message.contains(&format!("{w} × {h} px")), "{}", e.message);
        }
        // A size a provider really answers with is decoded (here it fails later: no pixel data).
        let e = decode(&png_header(2752, 1536)).unwrap_err();
        assert!(e.message.contains("could not be decoded"), "{}", e.message);
    }

    /// Real images of ordinary sizes still decode, whatever their format.
    #[test]
    fn ordinary_answers_decode() {
        let img = Rgba8Image { width: 3, height: 2, pixels: vec![200; 24] };
        let back = decode(&encode_png(&img).unwrap()).unwrap();
        assert_eq!((back.width, back.height, back.pixels), (3, 2, vec![200; 24]));
        assert!(decode(b"not an image").is_err());
        assert!(decode(&[]).is_err());
    }
}
