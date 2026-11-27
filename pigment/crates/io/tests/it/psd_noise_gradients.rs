//! Pigment (P3): noise gradients in a whole document through PSD and back: a Gradient Fill
//! layer, a Gradient Map and a Gradient Overlay keep every noise setting and render the same.

use photocraft_color::{BlendMode, Color, ColorMode, PixelFormat, SampleType};
use photocraft_doc::*;
use photocraft_geom::{Rect, Size};
use photocraft_io::{ExportOptions, export, import};

fn noise(model: NoiseModel, seed: u32) -> NoiseGradient {
    NoiseGradient { roughness: 0.5, model, min: [0.0, 0.25, 0.5, 0.0], max: [1.0, 0.75, 1.0, 1.0], restrict: seed.is_multiple_of(2), transparency: true, seed }
}

fn noisy_fill(n: NoiseGradient) -> Fill {
    let (stops, opacity) = n.fill_stops();
    let mut f = Fill::gradient(stops, 45.0, 1.0, GradientStyle::Linear, false);
    if let Fill::Gradient { opacity_stops, noise, .. } = &mut f {
        *opacity_stops = opacity;
        *noise = Some(n);
    }
    f
}

#[test]
fn noise_fill_map_and_overlay_keep_their_settings() {
    let mut d = Document::with_background("noise", Size::new(48, 32), ColorMode::Rgb, SampleType::U8, Color::WHITE);
    d.layers.push(Layer::new("fill", LayerContent::Fill(noisy_fill(noise(NoiseModel::Rgb, 11)))));
    let mut l = Layer::raster("blob", PixelFormat::RGBA8);
    l.surface_mut().unwrap().fill_rect(Rect::new(4, 4, 40, 28), &[0.8, 0.2, 0.1, 1.0]);
    let on = noise(NoiseModel::Lab, 12);
    let (stops, opacity_stops) = on.fill_stops();
    let overlay = effects::Gradient { stops, opacity_stops, noise: Some(on.clone()), ..effects::Gradient::default() };
    l.effects.items = vec![Effect::GradientOverlay { common: FxCommon::new(BlendMode::Normal, 0.8), gradient: overlay, dither: false, interpolation: None }];
    d.layers.push(l);
    let map = photocraft_io::grd_noise::noise_map(noise(NoiseModel::Hsb, 13), false, false);
    let mut adj = Layer::new("map", LayerContent::Adjustment(map.clone()));
    adj.opacity = 0.5;
    d.layers.push(adj);

    let saved = export(&d, "n.psd", &ExportOptions::default()).expect("export").bytes;
    let back = import("n.psd", &saved).expect("import").document;
    let find = |name: &str| back.layers.iter().find(|l| l.name == name).unwrap_or_else(|| panic!("{name}"));
    assert_eq!(find("fill").content, d.layers[1].content, "the fill keeps its noise and bake");
    let LayerContent::Adjustment(m) = &find("map").content else { panic!("map") };
    assert_eq!(*m, map, "the gradient map keeps its noise");
    let Some(Effect::GradientOverlay { gradient, .. }) = find("blob").effects.items.first() else { panic!("overlay") };
    assert_eq!(gradient.noise, Some(on));

    // A second save writes the same noise settings (the raw blocks are kept or rewritten alike).
    let again = export(&back, "n.psd", &ExportOptions::default()).expect("export").bytes;
    let back2 = import("n.psd", &again).expect("import").document;
    assert_eq!(back2.layers.iter().find(|l| l.name == "fill").unwrap().content, d.layers[1].content);
}

#[test]
fn a_noise_gradient_overlay_renders_non_uniformly() {
    let mut d = Document::with_background("o", Size::new(64, 8), ColorMode::Rgb, SampleType::U8, Color::WHITE);
    let mut l = Layer::raster("blob", PixelFormat::RGBA8);
    l.surface_mut().unwrap().fill_rect(Rect::new(0, 0, 64, 8), &[0.5, 0.5, 0.5, 1.0]);
    let n = NoiseGradient { roughness: 1.0, seed: 5, ..NoiseGradient::default() };
    let (stops, opacity_stops) = n.fill_stops();
    let g = effects::Gradient { stops, opacity_stops, noise: Some(n), angle: 0.0, ..effects::Gradient::default() };
    l.effects.items = vec![Effect::GradientOverlay { common: FxCommon::new(BlendMode::Normal, 1.0), gradient: g, dither: false, interpolation: None }];
    d.layers.push(l);
    let px = photocraft_compose::flatten(&d).into_px();
    let row: Vec<[f32; 4]> = px.iter().take(64).copied().collect();
    let distinct = row.windows(2).filter(|w| (0..3).any(|c| (w[0][c] - w[1][c]).abs() > 0.02)).count();
    assert!(distinct > 20, "a rough noise gradient changes colour along the row ({distinct} changes)");
}
