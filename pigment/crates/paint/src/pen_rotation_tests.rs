//! Pigment (U3, #1301): barrel rotation turns the tip the way the pen turns.
//!
//! The pen's rotation in [`StrokePoint::rotation`] is clockwise on screen, as every platform
//! reports it (W3C `twist`, Windows Ink, WinTab, `photocraft_tablet::Sample`), and a tip's angle
//! is counter-clockwise (Photoshop's Angle). These paint real dabs and read their orientation
//! from the pixels, so a sign slip anywhere between the point and the raster shows.

use photocraft_color::PixelFormat;
use photocraft_raster::Surface;

use crate::brush::{BrushSettings, Control, Dynamic, ShapeDynamics};
use crate::render::render_stroke;
use crate::{Stroke, StrokePoint, dabs};

/// A 40 px, 4:1 elliptical hard tip whose Angle Jitter control is Rotation (or Brush Projection).
fn tip(projection: bool) -> BrushSettings {
    BrushSettings {
        size: 40.0,
        roundness: 0.25,
        hardness: 1.0,
        pressure_size: false,
        pressure_opacity: false,
        spacing: 0.25,
        shape_dynamics: ShapeDynamics {
            enabled: true,
            angle: if projection { Dynamic::default() } else { Dynamic::controlled(Control::Rotation) },
            brush_projection: projection,
            ..Default::default()
        },
        ..Default::default()
    }
}

fn at(x: f64, y: f64, rotation: f32) -> StrokePoint {
    StrokePoint { rotation, ..StrokePoint::new(x, y, 1.0) }
}

/// The alpha the one dab at (50, 50) paints 9 px along each screen diagonal: (down-right,
/// up-right). y grows downwards, so a tip turned clockwise by 45° lies along down-right.
fn diagonals(b: &BrushSettings, rotation: f32) -> (f32, f32) {
    let mut s = Surface::new(PixelFormat::RGBA32F);
    render_stroke(&mut s, b, &[at(50.0, 50.0, rotation)], None, false, 1.0);
    (s.rgba(59, 59)[3], s.rgba(59, 41)[3])
}

#[test]
fn a_pen_turned_clockwise_turns_the_tip_clockwise() {
    for projection in [false, true] {
        let b = tip(projection);
        let (down_right, up_right) = diagonals(&b, 45.0);
        assert!(down_right > 0.9 && up_right < 0.1, "projection {projection}: 45° clockwise lies down-right: {down_right} / {up_right}");
        let (down_right, up_right) = diagonals(&b, 315.0);
        assert!(up_right > 0.9 && down_right < 0.1, "projection {projection}: 315° (45° anticlockwise) lies up-right: {down_right} / {up_right}");
        // No rotation: the tip lies along x, neither diagonal.
        let (down_right, up_right) = diagonals(&b, 0.0);
        assert!(down_right < 0.1 && up_right < 0.1, "projection {projection}: {down_right} / {up_right}");
    }
}

#[test]
fn rotation_between_points_takes_the_shorter_way_round() {
    // 350° to 10° along a stroke passes 0°: every dab stays within 10° of horizontal, none turns
    // through 180° (a 4:1 tip at 90° in between would show as a vertical bar).
    let b = tip(false);
    let d = dabs(&Stroke { brush: b, points: vec![at(0.0, 0.0, 350.0), at(100.0, 0.0, 10.0)] });
    assert!(d.len() > 4);
    for dab in &d {
        let deg = dab.angle.to_degrees().rem_euclid(360.0);
        let off = deg.min(360.0 - deg);
        assert!(off <= 10.0 + 1e-3, "{deg}");
    }
    // Halfway is horizontal.
    let mid = d[d.len() / 2].angle.to_degrees().rem_euclid(360.0);
    assert!(mid.min(360.0 - mid) < 3.0, "{mid}");
}

#[test]
fn the_rotation_control_value_is_unchanged() {
    // Size, opacity and the other scalar controls on Rotation still read the pen's own
    // clockwise turn as 0..1 (a quarter turn = 0.25).
    use crate::dynamics::{StepInput, control_value};
    let s = StepInput { point: at(0.0, 0.0, 90.0), direction: 0.0, initial_direction: 0.0, step: 0 };
    assert!((control_value(Control::Rotation, 25, &s) - 0.25).abs() < 1e-6);
}
