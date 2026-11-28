//! Pigment (U3): what a platform reports of the pen beside the stylus feed: Windows Ink's tilt and
//! barrel rotation, and the stylus wheel (an airbrush's finger wheel) where the platform has one.
//!
//! - **Windows Ink** delivers a pen as touch events (winit 0.30), and the framework gives a pass with
//!   touch events the touch's force as its pen reading, whatever the stylus feed holds
//!   (`craft::ui::runtime` `pointer_read`: a touch's force pairs with its moves). So a sample in
//!   the feed would never reach the canvas there; the desktop app's pointer hooks keep the pen's
//!   tilt and rotation instead (`photocraft_tablet::windows::pen_pose`), and [`merge`] adds them to
//!   a pointer reading that has none. The pressure stays winit's (the same `POINTER_PEN_INFO` field).
//! - **The stylus wheel** has no field in the framework's pointer reading at all. macOS and
//!   WinTab store it (`photocraft_tablet::wheel`); the stroke records it per point beside tilt
//!   and rotation, and `paint.stroke` gets it as each point's 8th column (`wheel`, which the
//!   engine already reads; 1 when absent, as for a mouse).
//!
//! The app installs the reader as [`crate::services::Services::pen_extras`]; the canvas reads it
//! once per frame ([`refresh`]).

use crate::PhotocraftApp;
use crate::stylus::PenSample;

/// One frame's reading.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PenExtras {
    /// Tilt X, tilt Y (degrees, W3C) and rotation (degrees clockwise) of the pen in use, where the
    /// stylus feed cannot carry them (Windows Ink). `None` otherwise.
    pub pose: Option<[f32; 3]>,
    /// The stylus wheel 0..1 of the pen in use, `None` when it has none.
    pub wheel: Option<f32>,
}

/// Reads [`PenExtras`] (desktop app; see the module docs).
pub type PenExtrasFn = Box<dyn Fn() -> PenExtras + Send + Sync>;

/// The stylus's share of Pigment's pen state: the frame's reading and the wheel of each point of
/// the current drag (parallel to `Stylus::stroke`).
#[derive(Clone, Debug, Default)]
pub struct PenState {
    pub(crate) extras: PenExtras,
    pub(crate) wheels: Vec<f32>,
}

impl PenState {
    /// The wheel a point recorded now gets: the platform's for a pen, 1 (full) for a mouse or a pen
    /// without one.
    pub(crate) fn wheel_now(&self, pen: bool) -> f32 {
        if pen { self.extras.wheel.map_or(1.0, |w| if w.is_finite() { w.clamp(0.0, 1.0) } else { 1.0 }) } else { 1.0 }
    }

    /// Point `i`'s wheel (the last known past the end, 1 with none).
    pub(crate) fn wheel_at(&self, i: usize) -> f32 {
        self.wheels.get(i).or(self.wheels.last()).copied().unwrap_or(1.0)
    }

    /// Did the drag carry a wheel other than the full one?
    pub(crate) fn has_wheel(&self) -> bool {
        self.wheels.iter().any(|w| *w != 1.0)
    }
}

/// A pointer reading with the platform's tilt and rotation added where it has none (Windows Ink:
/// the framework's touch reading is pressure only).
pub fn merge(p: PenSample, extras: &PenExtras) -> PenSample {
    match extras.pose {
        Some([tilt_x, tilt_y, rotation]) if p.tilt_x == 0.0 && p.tilt_y == 0.0 && p.rotation == 0.0 => PenSample { tilt_x, tilt_y, rotation, ..p }.sanitized(),
        _ => p,
    }
}

/// Read the platform once per frame, before the frame's tool events.
pub fn refresh(app: &mut PhotocraftApp) {
    app.stylus.pigment.extras = app.services.pen_extras.as_ref().map(|read| read()).unwrap_or_default();
}

#[cfg(test)]
mod tests;
