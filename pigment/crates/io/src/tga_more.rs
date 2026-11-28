//! Pigment: the Targa files the `image` crate opens wrong or not at all (F2, row 29).
//!
//! Upstream reads Targa through the `image` crate, which covers nearly every file. Two kinds it
//! does not, and the JavaScript Pigment (`shared/pixels/tga.js`) did:
//! - a 16-bit true-colour file whose descriptor says one attribute bit: that bit is alpha (TGA 2.0;
//!   the JavaScript app and Photoshop's own writer use it so), and the `image` crate drops it;
//! - a colour-mapped file whose index is wider than its map entries (a 16-bit index into 15-bit
//!   entries), which the `image` crate refuses.
//!
//! Those are decoded with craft-tga. So is any Targa the `image` crate fails on, as a fallback;
//! when craft-tga fails too, the `image` crate's error is the one reported, so no message changes.
//! Every other Targa goes the old way, which keeps upstream's Photoshop-measured rule that a
//! 32-bit file's fourth byte becomes "Alpha 1" (craft-tga would make an all-zero alpha opaque).
//!
//! The result is an RGBA8 image when a pixel is not opaque, else RGB8, so
//! `flat::apply_flat_format` turns the alpha into "Alpha 1" as it does for 32-bit files.

use photocraft_codecs::{self as codecs, ChannelLayout, CodecError, Format, Image};

/// A Targa the codecs' detector passes over: a colour-mapped file with 16-bit indices (it expects 8)
/// and no TGA 2.0 footer. craft-tga's sniff wants a Targa extension on `name` for such a file.
pub(crate) fn sniff(name: &str, bytes: &[u8]) -> Option<Format> {
    (craft_tga::sniff(name, bytes) && needs_craft_tga(bytes)).then_some(Format::Tga)
}

/// What the header says about the parts that pick the decoder.
fn needs_craft_tga(bytes: &[u8]) -> bool {
    let Some(h) = bytes.first_chunk::<18>() else { return false };
    let (map_type, kind, map_depth, depth, attr_bits) = (h[1], h[2] & 7, h[7], h[16], h[17] & 0x0F);
    let alpha_555 = kind == 2 && depth == 16 && attr_bits == 1;
    let wide_index = kind == 1 && map_type == 1 && depth > map_depth;
    alpha_555 || wide_index
}

/// Decodes `bytes` as `decode` does, except for the Targa files above. `format` is the sniffed
/// format; `limits` are the ones `decode` applies.
pub(crate) fn decode(
    format: Option<Format>,
    bytes: &[u8],
    limits: &codecs::Limits,
    decode: impl FnOnce() -> Result<Image, CodecError>,
) -> Result<Image, CodecError> {
    if format != Some(Format::Tga) {
        return decode();
    }
    if needs_craft_tga(bytes) {
        return decode_craft(bytes, limits);
    }
    match decode() {
        Ok(img) => Ok(img),
        Err(e @ CodecError::LimitExceeded(_)) => Err(e),
        Err(e) => decode_craft(bytes, limits).map_err(|_| e),
    }
}

/// craft-tga's picture as a codecs image, within `limits`.
fn decode_craft(bytes: &[u8], limits: &codecs::Limits) -> Result<Image, CodecError> {
    let mut tl = craft_tga::Limits::default();
    tl.max_pixels = tl.max_pixels.min(limits.max_pixels);
    tl.max_decoded_bytes = tl.max_decoded_bytes.min(usize::try_from(limits.max_alloc).unwrap_or(usize::MAX));
    let pic = craft_tga::decode(bytes, &tl).map_err(|e| match e {
        craft_tga::Error::LimitExceeded(what) => CodecError::LimitExceeded(format!("Targa {what}")),
        e => CodecError::Malformed { format: Format::Tga, message: e.to_string() },
    })?;
    if pic.width > limits.max_width || pic.height > limits.max_height {
        return Err(CodecError::LimitExceeded(format!("Targa {}×{}", pic.width, pic.height)));
    }
    let gray = matches!(pic.layout, craft_tga::Layout::Gray | craft_tga::Layout::GrayAlpha);
    let (layout, keep): (ChannelLayout, &[usize]) = match (gray, pic.has_alpha) {
        (false, true) => (ChannelLayout::Rgba, &[0, 1, 2, 3]),
        (false, false) => (ChannelLayout::Rgb, &[0, 1, 2]),
        (true, true) => (ChannelLayout::GrayA, &[0, 3]),
        (true, false) => (ChannelLayout::Gray, &[0]),
    };
    let data = if keep.len() == 4 { pic.rgba } else { pic.rgba.as_chunks::<4>().0.iter().flat_map(|p| keep.iter().map(move |&c| p[c])).collect() };
    Image::from_u8(pic.width, pic.height, layout, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_variants_pick_craft_tga() {
        let header = |map_type: u8, kind: u8, map_depth: u8, depth: u8, desc: u8| {
            let mut h = [0u8; 18];
            (h[1], h[2], h[7], h[16], h[17]) = (map_type, kind, map_depth, depth, desc);
            h
        };
        assert!(needs_craft_tga(&header(0, 2, 0, 16, 1)));
        assert!(needs_craft_tga(&header(0, 10, 0, 16, 0x21)));
        assert!(needs_craft_tga(&header(1, 1, 15, 16, 0)));
        assert!(needs_craft_tga(&header(1, 9, 15, 16, 0)));
        assert!(!needs_craft_tga(&header(0, 2, 0, 16, 0)));
        assert!(!needs_craft_tga(&header(0, 2, 0, 32, 8)));
        assert!(!needs_craft_tga(&header(1, 1, 24, 8, 0)));
        assert!(!needs_craft_tga(&header(1, 1, 16, 16, 0)));
        assert!(!needs_craft_tga(&[0, 0, 2]));
    }
}
