//! Pigment: the newer adjustments against the CPU compositor. Color and Vibrance and Grain have
//! GPU programs; Clarity and Dehaze is refused by the planner, so its stack composites on the CPU.

use super::{base_doc, check, gpu, mask, noise_layer};
use photocraft_color::{BlendMode, ColorMode, PixelFormat, SampleType};
use photocraft_doc::{Adjustment, Document, Layer, LayerContent};
use photocraft_geom::{Rect, Size};

fn newer() -> Vec<Adjustment> {
    vec![
        Adjustment::ColorVibrance { temperature: 45.0, tint: -20.0, vibrance: 30.0, saturation: 10.0 },
        Adjustment::ColorVibrance { temperature: -60.0, tint: 35.0, vibrance: 0.0, saturation: 0.0 },
        Adjustment::ColorVibrance { temperature: 0.0, tint: 0.0, vibrance: -50.0, saturation: -30.0 },
        Adjustment::Grain { amount: 60.0, size: 25.0, roughness: 50.0, seed: 1 },
        Adjustment::Grain { amount: 100.0, size: 0.0, roughness: 0.0, seed: 77 },
        Adjustment::Grain { amount: 35.0, size: 100.0, roughness: 100.0, seed: 99_999 },
    ]
}

#[test]
fn color_vibrance_and_grain_match_the_cpu() {
    let Some(mut g) = gpu() else { return };
    for adj in newer() {
        for (mode, opacity, masked) in [(BlendMode::Normal, 1.0, false), (BlendMode::Multiply, 0.7, true)] {
            let mut d = base_doc(48, 40);
            d.layers.push(noise_layer("mid", PixelFormat::RGBA8, Rect::new(8, 8, 40, 32), 3, 0.5));
            let mut a = Layer::new("adj", LayerContent::Adjustment(adj.clone()));
            a.blend = mode;
            a.opacity = opacity;
            if masked {
                a.mask = Some(mask(Rect::new(0, 0, 48, 20), 9, 0.3));
            }
            d.layers.push(a);
            check(&mut g, &d, &format!("{} {mode:?}", adj.label()));
        }
    }
    // 16-bit and 32-bit documents.
    for depth in [SampleType::U16, SampleType::F32] {
        let mut d = Document::new("t", Size::new(40, 30), ColorMode::Rgb, depth);
        let fmt = d.pixel_format();
        d.layers.push(noise_layer("bg", fmt, Rect::from_xywh(0, 0, 40, 30), 71, 0.5));
        for adj in newer() {
            d.layers.push(Layer::new("adj", LayerContent::Adjustment(adj)));
        }
        check(&mut g, &d, &format!("newer adjustments {depth:?}"));
    }
}

/// Clarity and Dehaze has no GPU program: the plan is refused (the canvas composites the document
/// on the CPU, the reference), and refused only while such a layer is visible and set.
#[test]
fn clarity_dehaze_falls_back_to_the_cpu() {
    let mut d = base_doc(32, 32);
    d.layers.push(Layer::new("cd", LayerContent::Adjustment(Adjustment::ClarityDehaze { clarity: 50.0, dehaze: 20.0 })));
    let refused = photocraft_gpu::plan(&d).err().map(|e| e.0).unwrap_or_default();
    assert!(refused.contains("Clarity and Dehaze"), "{refused}");
    d.layers[1].visible = false;
    assert!(photocraft_gpu::plan(&d).is_ok());
    d.layers[1].visible = true;
    d.layers[1].content = LayerContent::Adjustment(Adjustment::ClarityDehaze { clarity: 0.0, dehaze: 0.0 });
    assert!(photocraft_gpu::plan(&d).is_ok(), "at rest it changes nothing and needs no neighbourhood");
    d.layers[1].content = LayerContent::Adjustment(Adjustment::Grain { amount: 50.0, size: 10.0, roughness: 20.0, seed: 3 });
    assert!(photocraft_gpu::plan(&d).is_ok());
    if let Some(mut g) = gpu() {
        d.layers[1].content = LayerContent::Adjustment(Adjustment::ClarityDehaze { clarity: 50.0, dehaze: 20.0 });
        let out = photocraft_gpu::render_to_vec(&mut g.comp, &g.device, &g.queue, &d, d.bounds());
        assert!(out.is_err(), "the GPU refuses it rather than drawing something else");
    }
}
