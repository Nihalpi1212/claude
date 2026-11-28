//! Pigment (U3): Windows Ink's `POINTER_PEN_INFO` → [`Sample`]. Pure (no Win32 calls), so it is
//! tested on every platform; `windows.rs` reads the struct in its pointer message hooks and keeps
//! the last reading here for the UI.
//!
//! winit 0.30 turns a Windows Ink pen into touch events with only the pressure (`pressure / 1024`),
//! so the pen's tilt and barrel rotation never reach the canvas. `GetPointerPenInfo`, which the
//! hooks already call for the barrel button and the eraser end, has them:
//!
//! - `penMask` says which of `pressure`, `rotation`, `tiltX`, `tiltY` the pen reports;
//! - `pressure` is 0..1024;
//! - `tiltX` and `tiltY` are degrees -90..90, +x tilting to the right and +y towards the user,
//!   the W3C convention [`Sample`] uses;
//! - `rotation` is the pen's clockwise twist, 0..359 degrees, as [`Sample`] wants it.
//!
//! The UI keeps winit's pressure (the same value) and takes tilt and rotation from here; see
//! `photocraft_ui_egui::pen_extras`. The reading lives only while the last pointer message was
//! the pen's: a finger or the pen leaving range clears it, so a touch never paints with a pen's
//! tilt.

use crate::Sample;

/// `PEN_MASK_PRESSURE` (winuser.h): `pressure` is valid.
pub const PEN_MASK_PRESSURE: u32 = 0x0000_0001;
/// `PEN_MASK_ROTATION` (winuser.h): `rotation` is valid.
pub const PEN_MASK_ROTATION: u32 = 0x0000_0002;
/// `PEN_MASK_TILT_X` (winuser.h): `tiltX` is valid.
pub const PEN_MASK_TILT_X: u32 = 0x0000_0004;
/// `PEN_MASK_TILT_Y` (winuser.h): `tiltY` is valid.
pub const PEN_MASK_TILT_Y: u32 = 0x0000_0008;

/// The pen fields of `POINTER_PEN_INFO`, as plain values.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PenInfo {
    /// `penFlags` (`PEN_FLAG_BARREL`, `PEN_FLAG_INVERTED`, `PEN_FLAG_ERASER`).
    pub flags: u32,
    /// `penMask`: which of the fields below the pen reports.
    pub mask: u32,
    /// 0..1024.
    pub pressure: u32,
    /// Clockwise, 0..359 degrees.
    pub rotation: u32,
    /// Degrees -90..90, positive to the right.
    pub tilt_x: i32,
    /// Degrees -90..90, positive towards the user.
    pub tilt_y: i32,
}

impl PenInfo {
    /// The pen reports its pressure (else the UI keeps winit's, which reads the same field).
    pub fn has_pressure(&self) -> bool {
        self.mask & PEN_MASK_PRESSURE != 0
    }
}

/// One Windows Ink reading as a [`Sample`]: pressure `/ 1024`, tilt in degrees, rotation
/// clockwise 0..360, fields the pen does not report (its `penMask` bit clear) at their neutral
/// value (pressure 1, as a mouse paints; tilt and rotation 0). `eraser` is the pen end the hooks
/// track. `None` when the pen reports none of the four fields.
pub fn sample_from_pen_info(info: &PenInfo, eraser: bool) -> Option<Sample> {
    let has = |bit: u32| info.mask & bit != 0;
    if !has(PEN_MASK_PRESSURE | PEN_MASK_ROTATION | PEN_MASK_TILT_X | PEN_MASK_TILT_Y) {
        return None;
    }
    let degrees = |bit: u32, v: i32| if has(bit) { v as f32 } else { 0.0 };
    Some(
        Sample {
            pressure: if has(PEN_MASK_PRESSURE) { info.pressure as f32 / 1024.0 } else { 1.0 },
            tilt_x: degrees(PEN_MASK_TILT_X, info.tilt_x),
            tilt_y: degrees(PEN_MASK_TILT_Y, info.tilt_y),
            rotation: if has(PEN_MASK_ROTATION) { info.rotation as f32 } else { 0.0 },
            eraser,
        }
        .sanitized(),
    )
}

/// What one pointer message means for the kept reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PoseInput {
    /// A down, update or enter read `GetPointerPenInfo`: `None` when the pointer is not a pen.
    Reading { info: Option<PenInfo>, eraser: bool },
    /// The pen itself left range.
    PenLeft,
    /// Any other message (an up, another pointer leaving).
    Keep,
}

/// The reading the hooks keep after one pointer message.
pub fn next_pose(prev: Option<Sample>, input: PoseInput) -> Option<Sample> {
    match input {
        PoseInput::Reading { info, eraser } => info.and_then(|info| sample_from_pen_info(&info, eraser)),
        PoseInput::PenLeft => None,
        PoseInput::Keep => prev,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: u32 = PEN_MASK_PRESSURE | PEN_MASK_ROTATION | PEN_MASK_TILT_X | PEN_MASK_TILT_Y;

    fn info(mask: u32, pressure: u32, rotation: u32, tilt_x: i32, tilt_y: i32) -> PenInfo {
        PenInfo { flags: 0, mask, pressure, rotation, tilt_x, tilt_y }
    }

    #[test]
    fn every_field_maps_in_degrees_and_the_w3c_sense() {
        let s = sample_from_pen_info(&info(ALL, 512, 45, 30, -20), false).unwrap();
        assert_eq!(s, Sample { pressure: 0.5, tilt_x: 30.0, tilt_y: -20.0, rotation: 45.0, eraser: false });
        let s = sample_from_pen_info(&info(ALL, 1024, 359, -90, 90), true).unwrap();
        assert_eq!(s, Sample { pressure: 1.0, tilt_x: -90.0, tilt_y: 90.0, rotation: 359.0, eraser: true });
        let s = sample_from_pen_info(&info(ALL, 0, 0, 0, 0), false).unwrap();
        assert_eq!((s.pressure, s.tilt_x, s.tilt_y, s.rotation), (0.0, 0.0, 0.0, 0.0), "a hovering pen");
    }

    #[test]
    fn mask_bits_say_which_fields_are_real() {
        // Garbage in the fields the pen does not report is never read.
        let s = sample_from_pen_info(&info(PEN_MASK_PRESSURE, 256, 200, 77, -77), false).unwrap();
        assert_eq!(s, Sample { pressure: 0.25, tilt_x: 0.0, tilt_y: 0.0, rotation: 0.0, eraser: false });
        assert!(info(PEN_MASK_PRESSURE, 0, 0, 0, 0).has_pressure());
        let s = sample_from_pen_info(&info(PEN_MASK_TILT_X | PEN_MASK_TILT_Y, 999, 200, 40, 10), false).unwrap();
        assert_eq!(s, Sample { pressure: 1.0, tilt_x: 40.0, tilt_y: 10.0, rotation: 0.0, eraser: false }, "no pressure: neutral");
        assert!(!info(PEN_MASK_TILT_X, 0, 0, 0, 0).has_pressure());
        let s = sample_from_pen_info(&info(PEN_MASK_ROTATION, 0, 90, 40, 10), false).unwrap();
        assert_eq!((s.tilt_x, s.tilt_y, s.rotation), (0.0, 0.0, 90.0));
        let s = sample_from_pen_info(&info(PEN_MASK_TILT_Y, 0, 0, 40, -60), false).unwrap();
        assert_eq!((s.tilt_x, s.tilt_y), (0.0, -60.0));
        assert_eq!(sample_from_pen_info(&info(0, 512, 45, 30, 30), false), None, "nothing reported");
        // Bits other pens set (none defined today) don't count.
        assert_eq!(sample_from_pen_info(&info(0xF0, 512, 45, 30, 30), false), None);
    }

    #[test]
    fn out_of_range_values_are_clamped() {
        let s = sample_from_pen_info(&info(ALL, 5000, 720, 400, i32::MIN), false).unwrap();
        assert_eq!(s, Sample { pressure: 1.0, tilt_x: 90.0, tilt_y: -90.0, rotation: 0.0, eraser: false });
        let s = sample_from_pen_info(&info(ALL, u32::MAX, u32::MAX, i32::MAX, -91), false).unwrap();
        assert!(s.pressure == 1.0 && s.tilt_x == 90.0 && s.tilt_y == -90.0 && (0.0..360.0).contains(&s.rotation), "{s:?}");
        let s = sample_from_pen_info(&info(ALL, 1, 361, 0, 0), false).unwrap();
        assert!((s.rotation - 1.0).abs() < 1e-4 && s.pressure > 0.0);
    }

    #[test]
    fn the_reading_lives_while_the_pen_is_the_last_pointer() {
        let pen = PoseInput::Reading { info: Some(info(ALL, 512, 30, 10, 0)), eraser: false };
        let s = next_pose(None, pen);
        assert_eq!(s.map(|s| (s.tilt_x, s.rotation)), Some((10.0, 30.0)));
        assert_eq!(next_pose(s, PoseInput::Keep), s, "the tip lifting or a finger leaving");
        assert_eq!(next_pose(s, PoseInput::Reading { info: None, eraser: false }), None, "a finger touches");
        assert_eq!(next_pose(s, PoseInput::PenLeft), None);
        let eraser = next_pose(None, PoseInput::Reading { info: Some(info(ALL, 0, 0, 0, 0)), eraser: true });
        assert!(eraser.is_some_and(|s| s.eraser));
        assert_eq!(next_pose(s, PoseInput::Reading { info: Some(info(0, 0, 0, 0, 0)), eraser: false }), None, "a pen with no axes");
    }
}
