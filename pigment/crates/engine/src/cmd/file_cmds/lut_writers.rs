//! Pigment: File › Export › Color Lookup Tables in Photoshop's four formats (F2, rows 31 and 32).
//!
//! Upstream writes one `.cube`. Photoshop writes `.cube`, `.3dl`, `.csp` and an ICC profile at once,
//! one file each with the same base name, with a Description (the title), a Copyright and "Use
//! lowercase file extensions"; the JavaScript Pigment wrote `.cube` and `.3dl`
//! (`shared/pixels/lut.js` `writeCube`, `write3dl`). The table is baked once
//! ([`super::export::bake_table`]) and each writer reads it:
//! - `.cube`: upstream's writer (`craft_cms::lutfile::write_cube_export`), with a `#Copyright:`
//!   comment under `#Created by:` when there is a copyright;
//! - `.3dl`: the JavaScript writer's layout (a 10-bit input ramp, 12-bit output, blue fastest),
//!   with the `3DMESH` / `Mesh <bits> 12` header Lustre and Photoshop write when the grid is
//!   2^k + 1 points, so `craft_cms::lutfile::parse_3dl` reads it back on the 12-bit scale;
//! - `.csp`: Rising Sun's `CSPLUTV100` 3D layout with identity pre-LUTs, the description and
//!   copyright in its metadata block, red fastest;
//! - ICC: an RGB → RGB DeviceLink (class `link`) whose A2B0 is identity curves, the table as a
//!   CLUT and identity curves (`mAB`), with `desc` and `cprt`. craft-cms writes a profile's PCS
//!   field as XYZ or Lab only, so the header's connection space is set to RGB after encoding and
//!   the profile ID stamped again. A CMYK or Lab document is refused (Photoshop writes an abstract
//!   Lab profile there; not built). craft-cms holds at most 16 Mi CLUT values, so the ICC grid is
//!   at most [`MAX_ICC_SIZE`] points; a larger table is resampled to it and the result says so.

use base64::Engine as _;
use craft_cms::Curve;
use craft_cms::clut::Clut;
use craft_cms::pipeline::Stage;
use craft_cms::profile::{Lut, LutKind, Pcs, Profile, ProfileClass};

use super::paths::write_file;
use super::{ColorMode, Document, EngineError, Layer, Result, Value, json};

/// The most grid points per side a table is written with: Photoshop's Quality "Maximum".
pub(crate) const MAX_EXPORT_SIZE: usize = 256;

/// The most ICC grid points per side: `n³ × 3` CLUT values within craft-cms's 16 Mi limit.
pub(crate) const MAX_ICC_SIZE: usize = 177;

/// The four formats, in Photoshop's order of its check boxes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LutFormat {
    ThreeDl,
    Cube,
    Csp,
    Icc,
}

impl LutFormat {
    pub(crate) const ALL: [LutFormat; 4] = [LutFormat::ThreeDl, LutFormat::Cube, LutFormat::Csp, LutFormat::Icc];

    /// The id in the command's `formats` list, which is also the lowercase extension.
    pub(crate) fn id(self) -> &'static str {
        match self {
            LutFormat::ThreeDl => "3dl",
            LutFormat::Cube => "cube",
            LutFormat::Csp => "csp",
            LutFormat::Icc => "icc",
        }
    }

    /// The key of this format's text in a result without `path`.
    fn result_key(self) -> &'static str {
        match self {
            LutFormat::ThreeDl => "threeDl",
            LutFormat::Cube => "cube",
            LutFormat::Csp => "csp",
            LutFormat::Icc => "icc",
        }
    }
}

/// The params this file adds to `file.export.colorLookupTables`.
struct Options {
    formats: Vec<LutFormat>,
    copyright: String,
    lowercase: bool,
}

fn bad(cmd: &str, msg: impl Into<String>) -> EngineError {
    EngineError::BadParams { cmd: cmd.into(), msg: msg.into() }
}

fn options(cmd: &str, p: &Value) -> Result<Options> {
    let formats = match p.get("formats") {
        None | Some(Value::Null) => vec![LutFormat::Cube],
        Some(Value::Array(list)) => {
            let mut formats = Vec::new();
            for v in list {
                let id = v.as_str().ok_or_else(|| bad(cmd, "formats must be a list of 3dl, cube, csp and icc"))?;
                let f = LutFormat::ALL
                    .into_iter()
                    .find(|f| f.id() == id)
                    .ok_or_else(|| bad(cmd, format!("unknown LUT format {id:?}: use 3dl, cube, csp or icc")))?;
                if !formats.contains(&f) {
                    formats.push(f);
                }
            }
            if formats.is_empty() {
                return Err(bad(cmd, "choose at least one format"));
            }
            // Photoshop's order, whatever order the caller listed them in.
            formats.sort_by_key(|f| LutFormat::ALL.iter().position(|g| g == f));
            formats
        }
        Some(_) => return Err(bad(cmd, "formats must be a list of 3dl, cube, csp and icc")),
    };
    let copyright = match p.get("copyright") {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(_) => return Err(bad(cmd, "copyright must be text")),
    };
    let lowercase = match p.get("lowercase") {
        None | Some(Value::Null) => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(bad(cmd, "lowercase must be true or false")),
    };
    Ok(Options { formats, copyright, lowercase })
}

/// One line of text in a file's header: line breaks become spaces.
fn one_line(s: &str) -> String {
    s.split(['\r', '\n']).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" ")
}

/// The rest of `file.export.colorLookupTables` after the size and the layers are known: the
/// params this file adds, then one bake and every chosen writer. `size` is 2..=256.
pub(super) fn export(cmd: &str, p: &Value, size: usize, title: &str, layers: &[&Layer], doc: &Document) -> Result<Value> {
    let opts = options(cmd, p)?;
    if opts.formats.contains(&LutFormat::Icc) && matches!(doc.mode, ColorMode::Cmyk | ColorMode::Lab) {
        return Err(bad(cmd, "an ICC profile can be exported from an RGB document only: clear ICC Profile, or convert the document to RGB first"));
    }
    let path = p.get("path").and_then(Value::as_str);
    let names = path.map(|path| file_paths(path, &opts.formats, opts.lowercase));
    let table = super::export::bake_table(size, layers);
    let integer_depth = !matches!(doc.depth, photocraft_color::SampleType::F32);
    let mut out = json!({"size": size, "layerCount": layers.len()});
    if opts.formats.contains(&LutFormat::Icc) {
        out["iccSize"] = json!(size.min(MAX_ICC_SIZE));
    }
    let mut files = Vec::new();
    for (i, f) in opts.formats.iter().enumerate() {
        let bytes = match f {
            LutFormat::Cube => write_cube(&table, size, title, &opts.copyright, integer_depth).into_bytes(),
            LutFormat::ThreeDl => write_3dl(&table, size, title, &opts.copyright).into_bytes(),
            LutFormat::Csp => write_csp(&table, size, title, &opts.copyright).into_bytes(),
            LutFormat::Icc => write_icc(&table, size, title, &opts.copyright).map_err(|e| bad(cmd, e))?,
        };
        match &names {
            Some(names) => {
                write_file(&names[i], &bytes)?;
                files.push(names[i].clone());
            }
            None if *f == LutFormat::Icc => out[f.result_key()] = json!(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            None => out[f.result_key()] = json!(String::from_utf8_lossy(&bytes)),
        }
    }
    if let Some(first) = files.first() {
        out["path"] = json!(first);
        out["files"] = json!(files);
    }
    Ok(out)
}

/// The file of each format: `path` itself when it is the one format's file (and lowercase is on),
/// else `path` without a LUT extension plus each format's, in lowercase or uppercase.
fn file_paths(path: &str, formats: &[LutFormat], lowercase: bool) -> Vec<String> {
    let ext = |f: LutFormat| if lowercase { f.id().to_owned() } else { f.id().to_ascii_uppercase() };
    let name_start = path.rfind(['/', '\\']).map_or(0, |i| i + 1);
    let (base, current) = match path[name_start..].rfind('.') {
        Some(dot) if dot > 0 => {
            let at = name_start + dot;
            let e = &path[at + 1..];
            if ["cube", "3dl", "csp", "icc", "icm"].iter().any(|k| k.eq_ignore_ascii_case(e)) { (&path[..at], Some(e)) } else { (path, None) }
        }
        _ => (path, None),
    };
    // One format and a path with its extension: the path as given (upstream's behaviour), unless
    // Use lowercase file extensions is off, which asks for the uppercase one.
    if let ([only], Some(current)) = (formats, current)
        && only.id().eq_ignore_ascii_case(current)
        && lowercase
    {
        return vec![path.to_owned()];
    }
    formats.iter().map(|f| format!("{base}.{}", ext(*f))).collect()
}

/// The table's value at node `(r, g, b)` (red fastest), clamped to 0..1.
fn node(table: &[[f32; 3]], n: usize, r: usize, g: usize, b: usize) -> [f32; 3] {
    table.get((b * n + g) * n + r).copied().unwrap_or_default().map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 })
}

/// `.cube`: upstream's export writer, with the copyright under the creator line.
pub(crate) fn write_cube(table: &[[f32; 3]], n: usize, title: &str, copyright: &str, integer_depth: bool) -> String {
    let text = craft_cms::lutfile::write_cube_export("Pigment", &one_line(title), n, integer_depth, table.iter().copied());
    let copyright = one_line(copyright);
    if copyright.is_empty() {
        return text;
    }
    match text.split_once('\n') {
        Some((creator, rest)) => format!("{creator}\n#Copyright: {copyright}\n{rest}"),
        None => text,
    }
}

/// The `Mesh` input bits of an `n`-point grid when `n` is 2^k + 1 (k 1 to 7, what Lustre's
/// header and `parse_3dl` take).
fn mesh_bits(n: usize) -> Option<u32> {
    (1..=7).find(|&k| (1usize << k) + 1 == n)
}

/// `.3dl`: a 10-bit input ramp and 12-bit output codes, blue fastest.
pub(crate) fn write_3dl(table: &[[f32; 3]], n: usize, title: &str, copyright: &str) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(n * n * n * 16 + 256);
    if let Some(bits) = mesh_bits(n) {
        let _ = writeln!(s, "3DMESH\nMesh {bits} 12");
    }
    for (label, text) in [("Title", title), ("Copyright", copyright)] {
        let text = one_line(text);
        if !text.is_empty() {
            let _ = writeln!(s, "# {label}: {text}");
        }
    }
    let ramp: Vec<String> = (0..n).map(|i| ((i * 1023) as f64 / (n - 1) as f64).round().to_string()).collect();
    s.push_str(&ramp.join(" "));
    s.push('\n');
    let q = |v: f32| (f64::from(v) * 4095.0).round() as u32;
    for r in 0..n {
        for g in 0..n {
            for b in 0..n {
                let c = node(table, n, r, g, b);
                let _ = writeln!(s, "{} {} {}", q(c[0]), q(c[1]), q(c[2]));
            }
        }
    }
    s
}

/// `.csp`: `CSPLUTV100`, `3D`, the metadata, three identity pre-LUTs, the grid size and the
/// values, red fastest.
pub(crate) fn write_csp(table: &[[f32; 3]], n: usize, title: &str, copyright: &str) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(n * n * n * 27 + 256);
    s.push_str("CSPLUTV100\n3D\n\nBEGIN METADATA\n");
    let (title, copyright) = (one_line(title), one_line(copyright));
    if !title.is_empty() {
        let _ = writeln!(s, "{title}");
    }
    if !copyright.is_empty() {
        let _ = writeln!(s, "Copyright: {copyright}");
    }
    s.push_str("END METADATA\n\n");
    for _ in 0..3 {
        s.push_str("2\n0.0 1.0\n0.0 1.0\n");
    }
    let _ = writeln!(s, "\n{n} {n} {n}");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let c = node(table, n, r, g, b);
                let _ = writeln!(s, "{:.6} {:.6} {:.6}", c[0], c[1], c[2]);
            }
        }
    }
    s
}

/// Trilinear value of the `n`-point table at `rgb` (0..1).
fn sample(table: &[[f32; 3]], n: usize, rgb: [f32; 3]) -> [f32; 3] {
    let loc = |v: f32| {
        let p = v.clamp(0.0, 1.0) * (n - 1) as f32;
        let i = (p as usize).min(n - 2);
        (i, p - i as f32)
    };
    let ((r0, fr), (g0, fg), (b0, fb)) = (loc(rgb[0]), loc(rgb[1]), loc(rgb[2]));
    std::array::from_fn(|k| {
        let c = |r, g, b| node(table, n, r, g, b)[k];
        let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
        let y0 = lerp(lerp(c(r0, g0, b0), c(r0 + 1, g0, b0), fr), lerp(c(r0, g0 + 1, b0), c(r0 + 1, g0 + 1, b0), fr), fg);
        let y1 = lerp(lerp(c(r0, g0, b0 + 1), c(r0 + 1, g0, b0 + 1), fr), lerp(c(r0, g0 + 1, b0 + 1), c(r0 + 1, g0 + 1, b0 + 1), fr), fg);
        lerp(y0, y1, fb)
    })
}

/// An RGB → RGB DeviceLink profile of the table (at most [`MAX_ICC_SIZE`] points a side).
pub(crate) fn write_icc(table: &[[f32; 3]], n: usize, title: &str, copyright: &str) -> std::result::Result<Vec<u8>, String> {
    let m = n.min(MAX_ICC_SIZE);
    // ICC grids vary the first input (red) slowest.
    let clut = if m == n {
        let mut data = Vec::with_capacity(n * n * n * 3);
        for r in 0..n {
            for g in 0..n {
                for b in 0..n {
                    data.extend_from_slice(&node(table, n, r, g, b));
                }
            }
        }
        Clut::new(vec![n; 3], 3, data)
    } else {
        Clut::sample(vec![m; 3], 3, |input, out| out.copy_from_slice(&sample(table, n, [input[0], input[1], input[2]])))
    }
    .map_err(|e| e.to_string())?;
    let identity = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut profile = Profile::matrix_shaper(craft_cms::math::D50, identity, [Curve::Identity, Curve::Identity, Curve::Identity]).map_err(|e| e.to_string())?;
    profile.class = ProfileClass::DeviceLink;
    profile.pcs = Pcs::Xyz;
    profile.matrix = None;
    profile.trc = None;
    profile.description = one_line(title);
    profile.copyright = one_line(copyright);
    let curves = || Stage::Curves(vec![Curve::Identity; 3]);
    profile.a2b = [Some(Lut { kind: LutKind::Ab, inputs: 3, outputs: 3, stages: vec![curves(), Stage::Clut(clut), curves()] }), None, None];
    // A DeviceLink must carry a profile sequence (ICC.1:2010 §8.2.6); craft-cms writes none.
    let mut bytes = with_empty_sequence(&profile.to_bytes()).ok_or("the ICC tag table is malformed")?;
    // A DeviceLink's PCS field names its output space (ICC.1:2010 §7.2.7).
    let pcs = bytes.get_mut(20..24).ok_or("the ICC header is short")?;
    pcs.copy_from_slice(b"RGB ");
    let id = craft_cms::profile_id(&bytes).map_err(|e| e.to_string())?;
    bytes.get_mut(84..100).ok_or("the ICC header is short")?.copy_from_slice(&id);
    Ok(bytes)
}

/// Profile `bytes` with an empty `pseq` (profile sequence description) tag added: its tag table
/// grows by one entry, so every tag moves 12 bytes, and the tag's 12 bytes go at the end. `None`
/// when the tag table does not fit the profile. The profile ID is left for the caller to stamp.
fn with_empty_sequence(bytes: &[u8]) -> Option<Vec<u8>> {
    let be = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let count = usize::try_from(be(128)?).ok()?;
    let table_end = 132usize.checked_add(count.checked_mul(12)?)?;
    let size = usize::try_from(be(0)?).ok()?.min(bytes.len());
    if table_end > size {
        return None;
    }
    let mut out = Vec::with_capacity(size + 28);
    out.extend_from_slice(bytes.get(..128)?);
    out.extend_from_slice(&u32::try_from(count + 1).ok()?.to_be_bytes());
    for i in 0..count {
        let at = 132 + i * 12;
        out.extend_from_slice(bytes.get(at..at + 4)?);
        out.extend_from_slice(&be(at + 4)?.checked_add(12)?.to_be_bytes());
        out.extend_from_slice(bytes.get(at + 8..at + 12)?);
    }
    // The data starts 12 bytes later and stays 4-byte aligned; the new tag goes at the aligned end.
    let data_end = (size + 12).div_ceil(4) * 4;
    out.extend_from_slice(b"pseq");
    out.extend_from_slice(&u32::try_from(data_end).ok()?.to_be_bytes());
    out.extend_from_slice(&12u32.to_be_bytes());
    out.extend_from_slice(bytes.get(table_end..size)?);
    out.resize(data_end, 0);
    // `pseq`, reserved, no profile descriptions.
    out.extend_from_slice(b"pseq\0\0\0\0\0\0\0\0");
    let total = u32::try_from(out.len()).ok()?;
    out.get_mut(..4)?.copy_from_slice(&total.to_be_bytes());
    Some(out)
}

#[cfg(test)]
#[path = "lut_writers_tests.rs"]
mod tests;
