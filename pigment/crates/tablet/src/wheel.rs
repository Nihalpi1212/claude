//! Pigment (U3): the stylus wheel (an airbrush's finger wheel, "tangential pressure"), kept beside
//! the samples.
//!
//! [`crate::Sample`] has no wheel, and neither has the UI framework's pointer reading the samples
//! travel through, so the platform readers store the wheel here and the UI reads the latest value
//! once per frame (`photocraft_ui_egui::pen_extras`) for Shape Dynamics, Transfer and the other
//! sections' Stylus Wheel control.
//!
//! - **macOS**: `NSEvent.tangentialPressure` of tablet point events (-1..1; an airbrush wheel
//!   reports 0..1), through [`AppKitWheel`].
//! - **Windows WinTab**: `pkTangentPressure` where the device has the axis (`DVC_TPRESSURE`).
//! - Windows Ink, X11 and the web report none: the wheel stays `None`, and the brush reads a full
//!   wheel (1), as for a mouse.

use std::sync::atomic::{AtomicU32, Ordering};

use crate::appkit::{RawEvent, event_type, subtype};

/// No wheel (a NaN bit pattern no finite value has).
const NONE: u32 = u32::MAX;

static WHEEL: AtomicU32 = AtomicU32::new(NONE);

/// Store the wheel: `Some(0..1)` while a pen with a wheel is in use, `None` otherwise. A value
/// out of range is clamped; one that is not a number is no wheel.
pub fn set(wheel: Option<f32>) {
    let bits = match wheel {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0).to_bits(),
        _ => NONE,
    };
    WHEEL.store(bits, Ordering::Relaxed);
}

/// The latest wheel, `None` when the pen in use has none (or no pen is in use).
pub fn get() -> Option<f32> {
    match WHEEL.load(Ordering::Relaxed) {
        NONE => None,
        bits => Some(f32::from_bits(bits)),
    }
}

/// The wheel of AppKit tablet events. Every pen's events carry `tangentialPressure`, 0 when the
/// pen has no wheel, so a pen counts as having one once it reported a non-zero value since it
/// entered proximity (an airbrush whose wheel sits at 0 paints at full wheel until it is turned).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AppKitWheel {
    seen: bool,
}

impl AppKitWheel {
    /// What one event means for the wheel: `Some(value)` to store, `None` to keep the last one.
    pub fn handle(&mut self, e: &RawEvent) -> Option<Option<f32>> {
        let mouse = matches!(
            e.kind,
            event_type::LEFT_MOUSE_DOWN
                | event_type::LEFT_MOUSE_UP
                | event_type::RIGHT_MOUSE_DOWN
                | event_type::RIGHT_MOUSE_UP
                | event_type::MOUSE_MOVED
                | event_type::LEFT_MOUSE_DRAGGED
                | event_type::RIGHT_MOUSE_DRAGGED
                | event_type::OTHER_MOUSE_DOWN
                | event_type::OTHER_MOUSE_UP
                | event_type::OTHER_MOUSE_DRAGGED
        );
        if e.kind == event_type::TABLET_PROXIMITY || (mouse && e.subtype == subtype::TABLET_PROXIMITY) {
            // A tool entering or leaving: a new pen has shown no wheel yet.
            self.seen = false;
            return Some(None);
        }
        if e.kind == event_type::TABLET_POINT || (mouse && e.subtype == subtype::TABLET_POINT) {
            let v = if e.tangential.is_finite() { e.tangential } else { 0.0 };
            self.seen |= v != 0.0;
            return Some(self.seen.then_some(v.clamp(0.0, 1.0)));
        }
        if mouse {
            self.seen = false;
            return Some(None);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stored_wheel_is_clamped_and_nan_is_none() {
        // One test owns the global (tests run in parallel).
        set(Some(0.25));
        assert_eq!(get(), Some(0.25));
        set(Some(3.0));
        assert_eq!(get(), Some(1.0));
        set(Some(-0.5));
        assert_eq!(get(), Some(0.0));
        set(Some(f32::NAN));
        assert_eq!(get(), None);
        set(Some(f32::INFINITY));
        assert_eq!(get(), None);
        set(Some(0.5));
        set(None);
        assert_eq!(get(), None);
    }

    fn point(tangential: f32) -> RawEvent {
        RawEvent { kind: event_type::LEFT_MOUSE_DRAGGED, subtype: subtype::TABLET_POINT, tangential, ..Default::default() }
    }

    #[test]
    fn appkit_reports_a_wheel_once_the_pen_shows_one() {
        let mut w = AppKitWheel::default();
        assert_eq!(w.handle(&point(0.0)), Some(None), "a plain pen: no wheel");
        assert_eq!(w.handle(&point(0.6)), Some(Some(0.6)), "an airbrush turned");
        assert_eq!(w.handle(&point(0.0)), Some(Some(0.0)), "then turned back to 0");
        assert_eq!(w.handle(&point(-0.4)), Some(Some(0.0)), "negative is clamped");
        assert_eq!(w.handle(&point(f32::NAN)), Some(Some(0.0)));
        let tablet_point = RawEvent { kind: event_type::TABLET_POINT, tangential: 0.3, ..Default::default() };
        assert_eq!(w.handle(&tablet_point), Some(Some(0.3)));
        // Unrelated events keep it; a mouse or proximity resets it.
        assert_eq!(w.handle(&RawEvent { kind: 10, ..Default::default() }), None);
        assert_eq!(w.handle(&RawEvent { kind: event_type::TABLET_PROXIMITY, entering: true, ..Default::default() }), Some(None));
        assert_eq!(w.handle(&point(0.0)), Some(None), "a new pen starts with no wheel");
        w.handle(&point(0.5));
        assert_eq!(w.handle(&RawEvent { kind: event_type::MOUSE_MOVED, subtype: subtype::MOUSE, ..Default::default() }), Some(None));
        assert_eq!(w.handle(&point(0.0)), Some(None));
    }
}
