use super::*;
use crate::adjust_map::Channels;
use photocraft_doc::effects::{Effect, FxCommon, Gradient};
use photocraft_doc::{Fill, GradientStyle};

/// Settings every file keeps exactly: roughness in 4096ths, ranges in whole percent (descriptors)
/// and 32768ths (`grdm`).
fn sample(model: NoiseModel) -> NoiseGradient {
    NoiseGradient { roughness: 0.75, model, min: [0.25, 0.0, 0.5, 0.0], max: [0.75, 1.0, 1.0, 0.5], restrict: true, transparency: true, seed: 3_000_000_000 }
}

#[test]
fn descriptor_settings_round_trip_in_every_model() {
    for model in [NoiseModel::Rgb, NoiseModel::Hsb, NoiseModel::Lab] {
        let n = sample(model);
        let d = noise_grad_desc(&n, "Noisy");
        assert_eq!(noise_from_grad(&d), Some(n.clone()));
        // Written as Photoshop writes it: longs, the seed's bits, roughness in 4096ths.
        assert_eq!(d.get("Smth"), Some(&Value::Integer(3072)));
        assert_eq!(d.get("RndS"), Some(&Value::Integer(3_000_000_000u32 as i32)));
        assert_eq!(d.get("Mnm "), Some(&Value::List([25, 0, 50, 0].map(Value::Integer).to_vec())));
    }
    // Missing settings take the defaults; unknown models and broken ranges are not read.
    let bare = Descriptor::new("Grdn").with("GrdF", Value::Enumerated { type_id: Id::new("GrdF"), value: Id::new("ClNs") });
    let n = noise_from_grad(&bare).unwrap();
    assert_eq!((n.model, n.min, n.max, n.seed), (NoiseModel::Rgb, [0.0; 4], [1.0; 4], 0));
    let hsl = bare.clone().with("ClrS", Value::Enumerated { type_id: Id::new("ClrS"), value: Id::new("HSLC") });
    assert_eq!(noise_from_grad(&hsl), None);
    let short = bare.clone().with("Mnm ", Value::List(vec![Value::Integer(1)]));
    assert_eq!(noise_from_grad(&short), None);
    let solid = Descriptor::new("Grdn").with("GrdF", Value::Enumerated { type_id: Id::new("GrdF"), value: Id::new("CstS") });
    assert_eq!(noise_from_grad(&solid), None);
    let wild = bare.with("Smth", Value::Double(f64::INFINITY)).with("RndS", Value::Double(-1e300)).with("Mxm ", Value::List(vec![Value::Double(1e9); 4]));
    let n = noise_from_grad(&wild).unwrap();
    assert!(n.roughness == 0.5 && n.max == [1.0; 4]);
}

#[test]
fn a_noise_gradient_fill_round_trips_its_gdfl() {
    let n = sample(NoiseModel::Hsb);
    let (stops, opacity_stops) = n.fill_stops();
    let mut fill = Fill::gradient(stops, 30.0, 1.0, GradientStyle::Radial, true);
    if let Fill::Gradient { opacity_stops: o, noise, .. } = &mut fill {
        *o = opacity_stops;
        *noise = Some(n.clone());
    }
    let (key, data) = crate::blocks::write_fill(&fill);
    assert_eq!(&key, b"GdFl");
    let back = crate::blocks::parse_fill(&key, &data).unwrap();
    assert_eq!(back, fill, "every noise key and the baked stops come back");
    // What a Photoshop reader sees: GrdF = ClNs and no stops.
    let d = craft_psd::descriptor::VersionedDescriptor::from_bytes(&data).unwrap().descriptor;
    let Some(Value::Descriptor(g)) = d.get("Grad") else { panic!("Grad") };
    assert_eq!(enum_of(g, "GrdF"), Some(&b"ClNs"[..]));
    assert!(g.get("Clrs").is_none());
}

#[test]
fn a_noise_gradient_overlay_round_trips() {
    let n = sample(NoiseModel::Lab);
    let (stops, opacity_stops) = n.fill_stops();
    let gradient = Gradient { stops, opacity_stops, noise: Some(n), reverse: true, ..Gradient::default() };
    let fx = Effect::GradientOverlay {
        common: FxCommon { enabled: true, blend: photocraft_color::BlendMode::Normal, opacity: 1.0 },
        gradient: gradient.clone(),
        dither: false,
        interpolation: None,
    };
    let data = crate::effects_map::write_lfx2(true, &[fx]);
    let (_, back) = crate::effects_map::parse_lfx2(&data).unwrap();
    let Some(Effect::GradientOverlay { gradient: g, .. }) = back.first() else { panic!("{back:?}") };
    assert_eq!(g.noise, gradient.noise);
    assert_eq!((g.stops.clone(), g.opacity_stops.clone(), g.reverse), (gradient.stops, gradient.opacity_stops, true));
}

#[test]
fn a_noise_gradient_map_round_trips_its_grdm() {
    for model in [NoiseModel::Rgb, NoiseModel::Hsb, NoiseModel::Lab] {
        let mut n = sample(model);
        // 32768ths: 0.25, 0.5, 0.75 and 1 are exact.
        n.max[3] = 1.0;
        let adj = noise_map(n.clone(), true, false);
        let blocks = crate::adjust_map::write(&adj);
        let (key, data) = blocks.first().unwrap();
        assert_eq!(key, b"grdm");
        assert_eq!(grdm_noise(data), Some(n.clone()));
        let back = crate::adjust_map::parse(key, data, None, Channels::Rgb);
        assert_eq!(back, adj);
        let Adjustment::GradientMap { stops, source: Some(src), .. } = &back else { panic!("{back:?}") };
        assert_eq!(*stops, crate::gradient_bake::bake_source(src), "renders its bake");
        assert_eq!(src.stops.len(), 3 + (0.75f32 * 61.0).round() as usize, "the knots are the editable stops");
    }
    // A solid gradient map is unchanged: mode 0.
    let solid = Adjustment::GradientMap { stops: vec![(0.0, [0.0; 3]), (1.0, [1.0; 3])], reverse: false, dither: false, source: None };
    let (_, data) = crate::adjust_map::write(&solid).remove(0);
    assert_eq!(grdm_noise(&data), None);
    // Every prefix of a noise block, and flipped bytes, read without a panic.
    let (_, data) = crate::adjust_map::write(&noise_map(sample(NoiseModel::Rgb), false, false)).remove(0);
    for i in 0..data.len() {
        let _ = grdm_noise(&data[..i]);
        let _ = crate::adjust_map::parse(b"grdm", &data[..i], None, Channels::Rgb);
        let mut bad = data.clone();
        bad[i] ^= 0xff;
        let _ = grdm_noise(&bad);
        let _ = crate::adjust_map::parse(b"grdm", &bad, None, Channels::Rgb);
    }
}

#[test]
fn grd_files_carry_noise_settings() {
    let solid = GrdGradient {
        name: "Solid".into(),
        noise: false,
        stops: vec![
            craft_psd::grd::GrdStop { location: 0.0, midpoint: 0.5, color: craft_psd::grd::GrdColor::Rgb([1.0, 0.0, 0.0]) },
            craft_psd::grd::GrdStop { location: 1.0, midpoint: 0.5, color: craft_psd::grd::GrdColor::Rgb([0.0, 0.0, 1.0]) },
        ],
        opacity: vec![(0.0, 1.0, 0.5), (1.0, 1.0, 0.5)],
    };
    let noisy = GrdGradient { name: "Noisy".into(), noise: true, ..GrdGradient::default() };
    let n = sample(NoiseModel::Rgb);
    let bytes = write_grd(&[solid.clone(), noisy], &[None, Some(n.clone())]);
    let parsed = craft_psd::grd::parse(&bytes).unwrap();
    assert_eq!((parsed[0].clone(), parsed[1].name.as_str(), parsed[1].noise), (solid.clone(), "Noisy", true));
    assert_eq!(grd_noise(&bytes), vec![None, Some(n)]);
    // Without noise the file is craft-psd's own.
    assert_eq!(write_grd(std::slice::from_ref(&solid), &[None]), craft_psd::grd::write(&[solid]));
    for bad in [&b""[..], b"8BGR", b"8BGR\x00\x05junk", &bytes[..bytes.len() / 2]] {
        assert!(grd_noise(bad).iter().all(Option::is_none));
    }
}
