//! Pigment: the GPU programs of Color and Vibrance and Grain (`compose.wgsl` `adjust()` kinds 9
//! with gains, and 18), mirroring `photocraft_compose::adjust_extra`. Clarity and Dehaze has no
//! program: the planner sends a stack holding it to the CPU.

use photocraft_compose::adjust::{Transfer, VIBRANCE_BOOST};
use photocraft_compose::adjust_extra;
use photocraft_doc::Adjustment;

use super::lower::Program;

fn transfer_exponent(t: Transfer) -> f32 {
    match t {
        Transfer::Srgb => 0.0,
        Transfer::Gamma(g) => g,
    }
}

pub(super) fn program(adj: &Adjustment, transfer: Transfer, depth: photocraft_color::SampleType) -> Program {
    let mut p = [[0.0f32; 4]; 4];
    let hdr = depth == photocraft_color::SampleType::F32;
    match adj {
        Adjustment::ColorVibrance { temperature, tint, vibrance, saturation } => {
            // The Vibrance kernel (compose::adjust::vibrance_px) with the white-balance gains in
            // p3 first (p2.w set), as adjust_extra::color_vibrance_px.
            let hi = if hdr { f32::MAX } else { 1.0 };
            p[0] = [vibrance.clamp(-100.0, 100.0) / 100.0, saturation.clamp(-100.0, 100.0) / 100.0, transfer_exponent(transfer), hi];
            let b = VIBRANCE_BOOST;
            p[1] = [b[0], b[1], b[2], b[3]];
            p[2] = [b[4], b[5], b[6], 0.0];
            if let Some(g) = adjust_extra::color_vibrance_gains(*temperature, *tint) {
                p[2][3] = 1.0;
                p[3] = [g[0], g[1], g[2], 0.0];
            }
            (9, p, None)
        }
        Adjustment::Grain { amount, size, roughness, seed } => {
            let amount = amount.clamp(0.0, 100.0) / 100.0;
            if amount.is_nan() || amount <= 0.0 {
                return (0, p, None);
            }
            p[0] = [amount, adjust_extra::grain_cell(*size), roughness.clamp(0.0, 100.0) / 100.0, adjust_extra::seed_salt(*seed) as f32];
            (18, p, None)
        }
        _ => (0, p, None),
    }
}
