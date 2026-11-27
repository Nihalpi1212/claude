//! Pigment: the adjustments Photoshop has no PSD block for (Color and Vibrance, Clarity and
//! Dehaze, Grain) in a private `pcAd` block, after PhotoCraft's `pc**` convention
//! (`vector_preview.rs` `pcVP`): the header `PCAD\0\0\0\x01`, then the [`Adjustment`] as JSON.
//!
//! The layer has no pixels, so Photoshop and other readers, which skip a block they don't know,
//! see an empty layer: the merged image Pigment writes already holds the adjustment's effect.
//! When Adobe's own blocks for these kinds become known, they are mapped in `parse_any` and
//! `pcAd` stays the fallback.

use photocraft_doc::Adjustment;

/// The block key.
pub const KEY: [u8; 4] = *b"pcAd";
/// The block's header: a name and a version.
pub const HEADER: [u8; 8] = *b"PCAD\0\0\0\x01";
/// Largest block read (the JSON of one of these adjustments is under 200 bytes).
const MAX_LEN: usize = 64 * 1024;

/// Whether `adj` is written as a `pcAd` block (a layer other apps show empty).
pub fn is_pigment_only(adj: &Adjustment) -> bool {
    matches!(adj, Adjustment::ColorVibrance { .. } | Adjustment::ClarityDehaze { .. } | Adjustment::Grain { .. })
}

/// The block data of `adj` (only the three kinds are written; the PSD writer asks for no other).
pub fn write(adj: &Adjustment) -> Vec<u8> {
    let mut data = HEADER.to_vec();
    if is_pigment_only(adj) {
        data.extend(serde_json::to_vec(adj).unwrap_or_default());
    }
    // Photoshop requires every additional layer information block to end on four bytes.
    data.resize(data.len().next_multiple_of(4), b' ');
    data
}

/// The adjustment of a `pcAd` block; `None` for a damaged block, another version or a kind it may
/// not hold (kept raw then, as any unreadable block).
pub fn parse(data: &[u8]) -> Option<Adjustment> {
    if data.len() > MAX_LEN {
        return None;
    }
    let body = data.strip_prefix(&HEADER[..])?;
    let adj: Adjustment = serde_json::from_slice(body.trim_ascii_end()).ok()?;
    let finite = |v: &[f32]| v.iter().all(|x| x.is_finite());
    let ok = match &adj {
        Adjustment::ColorVibrance { temperature, tint, vibrance, saturation } => finite(&[*temperature, *tint, *vibrance, *saturation]),
        Adjustment::ClarityDehaze { clarity, dehaze } => finite(&[*clarity, *dehaze]),
        Adjustment::Grain { amount, size, roughness, .. } => finite(&[*amount, *size, *roughness]),
        _ => false,
    };
    ok.then(|| clamped(adj))
}

/// `adj` with its values in the commands' ranges.
fn clamped(adj: Adjustment) -> Adjustment {
    let c = |v: f32| v.clamp(-100.0, 100.0);
    let p = |v: f32| v.clamp(0.0, 100.0);
    match adj {
        Adjustment::ColorVibrance { temperature, tint, vibrance, saturation } => {
            Adjustment::ColorVibrance { temperature: c(temperature), tint: c(tint), vibrance: c(vibrance), saturation: c(saturation) }
        }
        Adjustment::ClarityDehaze { clarity, dehaze } => Adjustment::ClarityDehaze { clarity: c(clarity), dehaze: c(dehaze) },
        Adjustment::Grain { amount, size, roughness, seed } => Adjustment::Grain { amount: p(amount), size: p(size), roughness: p(roughness), seed: seed.clamp(1, 99_999) },
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_round_trip_and_refuse_what_they_may_not_hold() {
        for adj in [
            Adjustment::ColorVibrance { temperature: 18.0, tint: -4.5, vibrance: 10.0, saturation: 0.0 },
            Adjustment::ClarityDehaze { clarity: -30.0, dehaze: 35.0 },
            Adjustment::Grain { amount: 35.0, size: 25.0, roughness: 60.0, seed: 42 },
        ] {
            let data = write(&adj);
            assert!(data.starts_with(&HEADER) && data.len().is_multiple_of(4));
            assert_eq!(parse(&data), Some(adj));
        }
        assert_eq!(parse(b"PCAD\0\0\0\x02{}"), None, "another version");
        assert_eq!(parse(&[&HEADER[..], br#""Invert""#].concat()), None, "a kind PSD has a block for");
        assert_eq!(parse(&[&HEADER[..], br#"{"Grain":{"amount":1e30,"size":-5,"roughness":3,"seed":0}}"#].concat()), Some(Adjustment::Grain { amount: 100.0, size: 0.0, roughness: 3.0, seed: 1 }));
        // Truncated and flipped bytes never panic.
        let data = write(&Adjustment::Grain { amount: 1.0, size: 2.0, roughness: 3.0, seed: 4 });
        for n in 0..data.len() {
            let _ = parse(&data[..n]);
            let mut d = data.clone();
            d[n] ^= 0x5a;
            let _ = parse(&d);
        }
    }
}

#[cfg(test)]
mod file_tests {
    use super::*;
    use photocraft_color::{ColorMode, SampleType};
    use photocraft_doc::{Document, Layer, LayerContent};
    use photocraft_geom::Size;

    fn doc(adjs: &[Adjustment]) -> Document {
        let mut d = Document::with_background("a", Size::new(24, 16), ColorMode::Rgb, SampleType::U8, photocraft_color::Color::rgb(0.6, 0.4, 0.3));
        for a in adjs {
            d.layers.push(Layer::new(a.label(), LayerContent::Adjustment(a.clone())));
        }
        d
    }

    fn adjustments(d: &Document) -> Vec<Adjustment> {
        d.layers.iter().filter_map(|l| if let LayerContent::Adjustment(a) = &l.content { Some(a.clone()) } else { None }).collect()
    }

    const NEWER: [Adjustment; 3] = [
        Adjustment::ColorVibrance { temperature: 18.0, tint: 0.0, vibrance: 10.0, saturation: 0.0 },
        Adjustment::ClarityDehaze { clarity: 25.0, dehaze: 10.0 },
        Adjustment::Grain { amount: 35.0, size: 25.0, roughness: 60.0, seed: 1 },
    ];

    /// A PSD keeps the three through `pcAd` (with the export notice); a reader that skips the
    /// block sees layers with no pixels and no adjustment of Photoshop's, so it draws nothing for
    /// them, while the merged image holds their effect.
    #[test]
    fn psd_keeps_them_and_other_readers_see_empty_layers() {
        let d = doc(&NEWER);
        let r = crate::export(&d, "a.psd", &crate::ExportOptions::default()).unwrap();
        for a in &NEWER {
            let notice = format!("layer \"{}\": {} layers open in Pigment; other apps show them as empty layers", a.label(), a.label());
            assert!(r.warnings.contains(&notice), "{:?}", r.warnings);
        }
        let back = crate::import("a.psd", &r.bytes).unwrap();
        assert_eq!(adjustments(&back.document), NEWER.to_vec());
        assert!(back.warnings.is_empty(), "{:?}", back.warnings);
        let file = craft_psd::PsdFile::from_bytes(&r.bytes).unwrap();
        let photoshop_keys = &super::super::ADJUSTMENT_KEYS[..16];
        let records: Vec<_> = file.layers().iter().filter(|l| l.blocks.iter().any(|b| b.key == KEY)).collect();
        assert_eq!(records.len(), 3);
        for rec in records {
            assert!(rec.rect.is_empty(), "no pixels");
            assert!(!rec.blocks.iter().any(|b| photoshop_keys.contains(&&b.key)), "no block Photoshop reads as an adjustment");
        }
        // The merged image is the composite with the adjustments.
        let merged = crate::merged_composite(&file).unwrap();
        let flat = photocraft_compose::flatten(&d);
        let worst = merged.iter().zip(&flat.px).flat_map(|(a, b)| (0..3).map(move |c| (a[c] - b[c]).abs())).fold(0.0, f32::max);
        assert!(worst <= 1.0 / 255.0 + 1e-5, "{worst}");
        // A second save writes one `pcAd` per layer, not a stale copy beside a new one.
        let again = crate::export(&back.document, "a.psd", &crate::ExportOptions::default()).unwrap();
        let file = craft_psd::PsdFile::from_bytes(&again.bytes).unwrap();
        assert!(file.layers().iter().all(|l| l.blocks.iter().filter(|b| b.key == KEY).count() <= 1));
    }

    /// A Pigment 0.5 build kept these kinds as `Unsupported` `pcJS` blocks; such a document saved
    /// as PSD or `.pcraft` opens with live adjustments, and a PSD saved again holds no `pcJS`.
    #[test]
    fn pcjs_blocks_saved_by_pigment_0_5_open_live() {
        let pcjs = |kind: &str, params: &str| Adjustment::Unsupported {
            psd_key: "pcJS".into(),
            raw: format!(r#"{{"kind":"{kind}","params":{params}}}"#).into_bytes().into(),
        };
        let old = doc(&[pcjs("grain", r#"{"amount":35,"size":25,"roughness":60}"#), pcjs("clarity-dehaze", r#"{"clarity":25,"dehaze":10}"#), pcjs("shadows-highlights", "{}")]);
        let want = [NEWER[2].clone(), NEWER[1].clone()];
        let check = |got: Vec<Adjustment>, what: &str| {
            assert_eq!(got[..2], want, "{what}");
            // The kind nobody knows stays its block (a PSD pads it).
            assert!(matches!(&got[2], Adjustment::Unsupported { psd_key, raw } if psd_key == "pcJS" && raw.starts_with(br#"{"kind":"shadows-highlights""#)), "{what}");
        };
        for name in ["a.psd", "a.pcraft"] {
            let saved = crate::export(&old, name, &crate::ExportOptions::default()).unwrap();
            let back = crate::import(name, &saved.bytes).unwrap();
            check(adjustments(&back.document), name);
            if name == "a.psd" {
                let again = crate::export(&back.document, name, &crate::ExportOptions::default()).unwrap();
                let file = craft_psd::PsdFile::from_bytes(&again.bytes).unwrap();
                let pcjs_blocks = file.layers().iter().flat_map(|l| &l.blocks).filter(|b| &b.key == b"pcJS").count();
                assert_eq!(pcjs_blocks, 1, "only the kind nobody knows keeps its block");
                check(adjustments(&crate::import(name, &again.bytes).unwrap().document), "second save");
            }
        }
    }
}
