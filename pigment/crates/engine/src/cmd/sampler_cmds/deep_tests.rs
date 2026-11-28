//! Pigment (U1): the Color Sampler list's `float`, the unrounded RGBA the Info panel's 16-bit and 32-bit readouts
//! read.

use super::*;
use photocraft_geom::Rect;

/// A `depth`-bit RGB document whose pixel 3,3 is `rgba`.
fn session_with(depth: u32, rgba: [f32; 4]) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 8, "height": 8, "depth": depth, "background": "white"})).unwrap();
    s.edit("paint", |doc, _| {
        let surf = doc.layers[0].surface_mut().unwrap();
        let px = photocraft_raster::from_rgba(&surf.format(), rgba);
        surf.fill_rect(Rect::new(3, 3, 1, 1), &px);
        Ok(())
    })
    .unwrap();
    s
}

fn float(v: &Value) -> Vec<f64> {
    v["float"].as_array().unwrap().iter().map(|c| c.as_f64().unwrap()).collect()
}

#[test]
fn a_16_bit_value_reads_back_unrounded() {
    // 0.3 is no 8-bit level (76.5/255): the 8-bit `rgb` rounds it, `float` keeps the 16-bit value.
    let mut s = session_with(16, [0.3, 0.5, 0.7, 1.0]);
    let r = s.execute("view.colorSamplers.add", json!({"x": 3, "y": 3})).unwrap();
    let f = float(&r["point"]);
    assert_eq!(f.len(), 4);
    for (got, want) in f.iter().zip([0.3, 0.5, 0.7, 1.0]) {
        assert!((got - want).abs() < 1.0 / 32768.0, "{f:?}");
    }
    assert_eq!(r["point"]["rgb"], json!([77, 128, 179]), "the 8-bit readout is unchanged");
    let listed = &s.execute("view.colorSamplers.list", json!({})).unwrap()["samplers"][0];
    assert_eq!(float(listed), f, "the list reports the same");
}

#[test]
fn a_32_bit_value_over_white_is_not_clamped() {
    let mut s = session_with(32, [1.5, 0.25, 0.0, 1.0]);
    let r = s.execute("view.colorSamplers.add", json!({"x": 3, "y": 3})).unwrap();
    let f = float(&r["point"]);
    assert!((f[0] - 1.5).abs() < 1e-6 && (f[1] - 0.25).abs() < 1e-6 && f[2].abs() < 1e-6, "{f:?}");
    assert_eq!(r["point"]["rgb"], json!([255, 64, 0]));
}

#[test]
fn an_8_bit_value_is_its_level() {
    let mut s = session_with(8, [0.0, 0.0, 0.0, 1.0]);
    s.execute("edit.fill", json!({"color": "#336699"})).unwrap();
    let r = s.execute("view.colorSamplers.add", json!({"x": 3, "y": 3})).unwrap();
    let f = float(&r["point"]);
    for (got, level) in f.iter().zip([0x33, 0x66, 0x99, 255]) {
        assert!((got - f64::from(level) / 255.0).abs() < 1e-6, "{f:?}");
    }
}
