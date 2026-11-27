//! Pigment: Match Color's Load Statistics… and Save Statistics…, as the JavaScript Pigment 0.4 had them
//! (`renderer/lib/adjust-more-ui.js` `matchColorEditor`).
//!
//! * `image.adjustments.matchColor` takes `"sourceStatistics":{"mean":[L,a,b],"std":[L,a,b]}` in place of a
//!   `source` document ([`given`]): an action records the statistics, so it plays back with no source open.
//! * `image.adjustments.matchColor.statistics` computes a source's statistics, turns given ones into the
//!   file, or reads a file.
//!
//! The file is the JavaScript app's: `{"format":"pigment-match-color-statistics","version":1,"name",
//! "mean","std"}`, so its files load here and Pigment's load there. The two apps' L\*a\*b\* differ: the
//! JavaScript app's is D65 (sRGB's XYZ over the D65 white), PhotoCraft's is D50 (Bradford-adapted, the ICC
//! PCS, `photocraft_color::convert`). The file keeps the JavaScript app's D65 values; the parameter and
//! the command's answers are PhotoCraft's D50, converted through linear sRGB, the space both apps start
//! from (the means exactly, the deviations through the conversion's slope at the mean). Photoshop's `.sta`
//! files have no public layout; the JavaScript app did not read them either.

use photocraft_algo::tone::{self, LabStats};
use photocraft_color::convert::{D50, SRGB_TO_XYZ_D50, XYZ_D50_TO_SRGB};
use serde_json::{Value, json};

use super::{bad, stats_pixels};
use crate::commands::CommandSpec;
use crate::{Result, Session};

/// The command id.
pub const STATISTICS: &str = "image.adjustments.matchColor.statistics";
/// The `format` of the statistics file, the JavaScript app's.
pub const FORMAT: &str = "pigment-match-color-statistics";
/// The largest statistics file read (a real one is a few hundred bytes).
const MAX_FILE: usize = 64 * 1024;

/// The JavaScript app's sRGB → XYZ (D65) matrix (`shared/pixels/adjust-more.js` `toLab`).
const SRGB_TO_XYZ_D65: [[f64; 3]; 3] = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]];
/// The JavaScript app's D65 white.
const D65: [f64; 3] = [0.95047, 1.0, 1.08883];

fn mul(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}

fn wide(m: &[[f32; 3]; 3]) -> [[f64; 3]; 3] {
    m.map(|r| r.map(f64::from))
}

fn inverse(m: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let [[a, b, c], [d, e, f], [g, h, i]] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    [
        [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ]
}

/// CIE L\*a\*b\* over `white` → XYZ (the CIE formulas both apps use).
fn lab_to_xyz(lab: [f64; 3], white: [f64; 3]) -> [f64; 3] {
    let fy = (lab[0] + 16.0) / 116.0;
    let f = [fy + lab[1] / 500.0, fy, fy - lab[2] / 200.0];
    let e = 6.0 / 29.0;
    let inv = |t: f64| if t > e { t * t * t } else { 3.0 * e * e * (t - 4.0 / 29.0) };
    [inv(f[0]) * white[0], inv(f[1]) * white[1], inv(f[2]) * white[2]]
}

fn xyz_to_lab(xyz: [f64; 3], white: [f64; 3]) -> [f64; 3] {
    let e = 6.0f64 / 29.0;
    let f = |t: f64| if t > e * e * e { t.cbrt() } else { t / (3.0 * e * e) + 4.0 / 29.0 };
    let (fx, fy, fz) = (f(xyz[0] / white[0]), f(xyz[1] / white[1]), f(xyz[2] / white[2]));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

/// PhotoCraft's D50 L\*a\*b\* of a colour → the JavaScript app's D65 one, through linear sRGB.
pub fn d50_to_d65(lab: [f64; 3]) -> [f64; 3] {
    let d50 = D50.map(f64::from);
    let linear = mul(&wide(&XYZ_D50_TO_SRGB), lab_to_xyz(lab, d50));
    xyz_to_lab(mul(&SRGB_TO_XYZ_D65, linear), D65)
}

/// The JavaScript app's D65 L\*a\*b\* → PhotoCraft's D50 one: [`d50_to_d65`]'s inverse.
pub fn d65_to_d50(lab: [f64; 3]) -> [f64; 3] {
    let d50 = D50.map(f64::from);
    let linear = mul(&inverse(&SRGB_TO_XYZ_D65), lab_to_xyz(lab, D65));
    xyz_to_lab(mul(&wide(&SRGB_TO_XYZ_D50), linear), d50)
}

/// `stats` through the colour conversion `f`: the mean exactly, each deviation through the slope of `f` at
/// the mean (the channels taken as independent, as the statistics are).
fn convert(stats: &LabStats, f: fn([f64; 3]) -> [f64; 3]) -> LabStats {
    let mean = stats.mean.map(f64::from);
    let std = stats.std.map(f64::from);
    let out = f(mean);
    let mut var = [0f64; 3];
    for (j, s) in std.iter().enumerate() {
        const H: f64 = 0.01;
        let (mut lo, mut hi) = (mean, mean);
        lo[j] -= H;
        hi[j] += H;
        let (a, b) = (f(lo), f(hi));
        for k in 0..3 {
            let slope = (b[k] - a[k]) / (2.0 * H);
            var[k] += (slope * s).powi(2);
        }
    }
    LabStats { mean: out.map(|v| v as f32), std: var.map(|v| v.sqrt() as f32) }
}

/// Three decimals, as the JavaScript app's `roundStats`.
fn round3(v: f32) -> f64 {
    (f64::from(v) * 1000.0).round() / 1000.0
}

fn rounded(stats: &LabStats) -> LabStats {
    LabStats { mean: stats.mean.map(|v| round3(v) as f32), std: stats.std.map(|v| round3(v) as f32) }
}

fn to_json(stats: &LabStats) -> (Value, Value) {
    (json!(stats.mean.map(round3)), json!(stats.std.map(round3)))
}

/// Statistics `{"mean":[3],"std":[3]}` read from `v`: finite numbers, deviations not below zero (the JavaScript
/// app's `validStats` and `stats`).
fn read(v: &Value) -> Option<LabStats> {
    let three = |key: &str| -> Option<[f32; 3]> {
        let a = v.get(key)?.as_array().filter(|a| a.len() == 3)?;
        let mut out = [0f32; 3];
        for (o, x) in out.iter_mut().zip(a) {
            *o = x.as_f64().filter(|x| x.is_finite() && x.abs() < 1e6)? as f32;
        }
        Some(out)
    };
    let (mean, std) = (three("mean")?, three("std")?);
    std.iter().all(|s| *s >= 0.0).then_some(LabStats { mean, std })
}

/// The `sourceStatistics` of Match Color's params (D50), when given; an error when they are malformed or a
/// `source` document is given too.
pub(super) fn given(p: &Value, cmd: &str) -> Result<Option<LabStats>> {
    let Some(v) = p.get("sourceStatistics").filter(|v| !v.is_null()) else { return Ok(None) };
    if p.get("source").and_then(Value::as_i64).is_some_and(|i| i >= 0) {
        return Err(bad(cmd, "give a `source` document or `sourceStatistics`, not both"));
    }
    read(v).map(Some).ok_or_else(|| bad(cmd, "`sourceStatistics` must be {\"mean\":[L,a,b],\"std\":[L,a,b]} (finite numbers, std ≥ 0)"))
}

/// The statistics file's text for `stats` (D50), as the JavaScript app's Save Statistics… writes it.
pub fn file_text(name: &str, stats: &LabStats) -> String {
    let (mean, std) = to_json(&convert(stats, d50_to_d65));
    let body = json!({"format": FORMAT, "version": 1, "name": name, "mean": mean, "std": std});
    serde_json::to_string_pretty(&body).unwrap_or_default()
}

/// The name and D50 statistics a file's `text` holds; `file_name` names them when the file does not.
pub fn read_file(text: &str, file_name: Option<&str>) -> std::result::Result<(String, LabStats), String> {
    if text.len() > MAX_FILE {
        return Err("the file is too large for Match Color statistics".into());
    }
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("the file is not JSON: {e}"))?;
    let stats = read(&v).ok_or("the file holds no Match Color statistics")?;
    let stem = file_name.map(|f| {
        let base = f.rsplit(['/', '\\']).next().unwrap_or(f);
        base.rsplit_once('.').map_or(base, |(stem, _)| stem).to_owned()
    });
    let name = v.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).map(str::to_owned).or(stem).unwrap_or_else(|| "Statistics".into());
    Ok((name.chars().take(255).collect(), rounded(&convert(&stats, d65_to_d50))))
}

fn answer(name: &str, stats: &LabStats) -> Value {
    let (mean, std) = to_json(stats);
    json!({"name": name, "mean": mean, "std": std})
}

/// `image.adjustments.matchColor.statistics`: see the spec's params.
fn statistics(s: &mut Session, p: &Value) -> Result<Value> {
    let path = p.get("path").and_then(Value::as_str);
    let named = p.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty());
    let given = p.get("statistics").filter(|v| !v.is_null());
    // With nothing to read or compute from, the active document is the source (Save Statistics… of the image open),
    // so the command runs on `{}` as every `image.adjustments.*` command does.
    let reads = p.get("data").and_then(Value::as_str).is_some() || path.is_some();
    let source = match p.get("source").and_then(Value::as_i64).filter(|i| *i >= 0) {
        None if given.is_none() && !reads => s.active_index().map(|i| i as i64),
        source => source,
    };
    let (name, stats) = match (source, given) {
        (Some(_), Some(_)) => return Err(bad(STATISTICS, "give a `source` document or `statistics`, not both")),
        (Some(i), None) => {
            let d = s.documents().get(i as usize).ok_or_else(|| bad(STATISTICS, format!("no document {i}")))?;
            let layer = p.get("sourceLayer").and_then(Value::as_u64);
            let (px, mask) = stats_pixels(&d.doc, layer, p.get("useSelectionInSource").and_then(Value::as_bool).unwrap_or(false))?;
            let stats = tone::lab_stats(&px, mask.as_deref()).ok_or_else(|| bad(STATISTICS, "the source has no opaque pixels"))?;
            (named.map_or_else(|| d.doc.name.clone(), str::to_owned), rounded(&stats))
        }
        (None, Some(v)) => {
            (named.unwrap_or("Statistics").to_owned(), read(v).ok_or_else(|| bad(STATISTICS, "`statistics` must be {\"mean\":[L,a,b],\"std\":[L,a,b]}"))?)
        }
        (None, None) => {
            // Load Statistics…: the file's text, or the file at `path`.
            let (text, file) = match (p.get("data").and_then(Value::as_str), path) {
                (Some(text), _) => (text.to_owned(), p.get("fileName").and_then(Value::as_str).map(str::to_owned)),
                (None, Some(path)) => {
                    let len = std::fs::metadata(path).map_err(|e| bad(STATISTICS, format!("{path}: {e}")))?.len();
                    if len > MAX_FILE as u64 {
                        return Err(bad(STATISTICS, "the file is too large for Match Color statistics"));
                    }
                    (std::fs::read_to_string(path).map_err(|e| bad(STATISTICS, format!("{path}: {e}")))?, Some(path.to_owned()))
                }
                (None, None) => return Err(bad(STATISTICS, "no document is open: give a `source` document, `statistics`, or a file's `data` or `path`")),
            };
            let (name, stats) = read_file(&text, file.as_deref()).map_err(|e| bad(STATISTICS, e))?;
            return Ok(answer(&name, &stats));
        }
    };
    let text = file_text(&name, &stats);
    if let Some(path) = path {
        std::fs::write(path, &text).map_err(|e| bad(STATISTICS, format!("{path}: {e}")))?;
    }
    let mut out = answer(&name, &stats);
    out["file"] = json!(text);
    Ok(out)
}

pub(super) fn specs() -> Vec<CommandSpec> {
    vec![CommandSpec {
        id: STATISTICS,
        label: "Match Color Statistics",
        menu: &[],
        shortcut: None,
        params: r##"{"source":doc?,"sourceLayer":id?,"useSelectionInSource":bool=false,"statistics":{"mean","std"}?,"name":text?,"path":path?,"data":text?,"fileName":text?} → {"name","mean":[L,a,b],"std":[L,a,b],"file"?} (Save Statistics…: a source document's statistics (the active document's when nothing else is given), or the given `statistics`, with the file's text as `file`, written to `path` when given. Load Statistics…: without either, reads the file's `data` text or the file at `path`. Statistics are Pigment's D50 L*a*b*, as `image.adjustments.matchColor` takes them in `sourceStatistics`; the file is the JavaScript Pigment's ("format":"pigment-match-color-statistics", D65).)"##,
        enabled: |_| Ok(()),
        run: statistics,
        journal: false,
    }]
}

#[cfg(test)]
mod tests;
