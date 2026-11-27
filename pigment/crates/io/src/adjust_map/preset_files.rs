//! Photoshop's adjustment preset files (Pigment): `.alv` Levels, `.acv` Curves, `.ahu`
//! Hue/Saturation, `.cha` Channel Mixer, `.asv` Selective Color and `.blw` Black & White.
//!
//! Each file holds one setting, laid out as the PSD adjustment block of its kind, so this module
//! is a thin wrapper over [`super::parse`] and [`super::write`]:
//!
//! - `.alv` is a `levl` block: version (1 or 2), then 29 records of five 16-bit values (input
//!   floor, input ceiling, output floor, output ceiling, gamma × 100), the composite first.
//! - `.acv` differs from `curv` only in its header: version (1 or 4) and the number of curves,
//!   then each curve's point count and its (output, input) pairs in 0..=255. It holds points only:
//!   a drawn (pencil) curve, or one with more points than Photoshop's 19, is written as 17 points
//!   sampled from it, as the JavaScript Pigment did.
//! - `.ahu` is a `hue2` block (100 bytes), `.cha` a `mixr` block (44 bytes), `.asv` a `selc`
//!   block (84 bytes).
//! - `.blw` is a 2-byte version (1) followed by the `blwh` block (descriptor version 16 and the
//!   descriptor).
//!
//! A file does not say which document mode it was made in: Levels and Curves records are read as
//! RGB (the composite, then red, green and blue); further records are reported, not applied.
//! Reading never panics on damaged input; it returns the reason instead.

use photocraft_doc::Adjustment;
use photocraft_doc::adjust::{CurvePoint, LevelsChannel, ToneSpace, curve_map_outputs};

use super::{BW_KEYS, Channels, be16, bei16, parse, write as write_blocks};

/// The kinds with a Photoshop preset file: `(kind, extension, what the file dialog calls it)`.
/// `kind` is the engine's adjustment kind (`image.adjustments.<kind>`).
pub const KINDS: [(&str, &str, &str); 6] = [
    ("levels", "alv", "Levels presets"),
    ("curves", "acv", "Curves presets"),
    ("hueSaturation", "ahu", "Hue/Saturation presets"),
    ("channelMixer", "cha", "Channel Mixer presets"),
    ("selectiveColor", "asv", "Selective Color presets"),
    ("blackWhite", "blw", "Black & White presets"),
];

/// The file extension (without the dot) of `kind`'s preset files, if Photoshop has one.
pub fn extension(kind: &str) -> Option<&'static str> {
    KINDS.iter().find(|k| k.0 == kind).map(|k| k.1)
}

/// The adjustment kind whose preset files have extension `ext` (any case, without the dot).
pub fn kind_for_extension(ext: &str) -> Option<&'static str> {
    KINDS.iter().find(|k| k.1.eq_ignore_ascii_case(ext)).map(|k| k.0)
}

/// Most points a Curves record holds (Photoshop's limit, and the model's).
const MAX_POINTS: usize = 19;
/// Most points a curve read from a file may claim (the JavaScript Pigment accepted 64).
const MAX_FILE_POINTS: usize = 64;
/// Points sampled from a drawn curve, or from one with too many points.
const SAMPLED_POINTS: usize = 17;
/// Records of a Levels file.
const ALV_RECORDS: usize = 29;

/// Reads a preset file of `kind` (one of [`KINDS`]): the setting, and notes on what was not
/// applied (records for channels an RGB document lacks, an old version read with the later
/// layout). An error says why the bytes are not such a file.
pub fn read(kind: &str, bytes: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    match kind {
        "levels" => read_alv(bytes),
        "curves" => read_acv(bytes),
        "hueSaturation" => read_ahu(bytes),
        "channelMixer" => read_cha(bytes),
        "selectiveColor" => read_asv(bytes),
        "blackWhite" => read_blw(bytes),
        _ => Err(format!("{kind} has no Photoshop preset file")),
    }
}

/// Writes `adj` as its Photoshop preset file (the extension is [`extension`] of its kind).
pub fn write(adj: &Adjustment) -> Result<Vec<u8>, String> {
    let block =
        |key: &[u8; 4]| write_blocks(adj).into_iter().find(|(k, _)| k == key).map(|(_, d)| d).ok_or_else(|| "the setting could not be written".to_string());
    match adj {
        Adjustment::Levels { .. } => block(b"levl"),
        Adjustment::Curves { master, per_channel, space, black, pencil } => Ok(write_acv(master, per_channel, *space, black, *pencil)),
        Adjustment::HueSaturation { .. } => block(b"hue2"),
        Adjustment::ChannelMixer { .. } => block(b"mixr"),
        Adjustment::SelectiveColor { .. } => block(b"selc"),
        Adjustment::BlackWhite { .. } => {
            let mut v = vec![0, 1];
            v.extend(block(b"blwh")?);
            Ok(v)
        }
        other => Err(format!("{} has no Photoshop preset file", super::label(&kind_key(other)))),
    }
}

/// The PSD key of an adjustment, for messages.
fn kind_key(adj: &Adjustment) -> [u8; 4] {
    write_blocks(adj).first().map_or(*b"    ", |(k, _)| *k)
}

/// `n` and the noun, plural unless `n` is 1.
fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ------------------------------------------------------------------ Levels

fn read_alv(d: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    let not = || "This is not a Levels file".to_string();
    if d.len() < 2 + 10 {
        return Err(not());
    }
    if !matches!(be16(d, 0), Some(1 | 2)) {
        return Err(not());
    }
    let n = ALV_RECORDS.min((d.len() - 2) / 10);
    let mut records = Vec::with_capacity(n);
    for r in 0..n {
        let at = 2 + r * 10;
        let v: Vec<i16> = (0..5).filter_map(|k| bei16(d, at + k * 2)).collect();
        let [in_black, in_white, out_black, out_white, gamma] = v[..] else { return Err(not()) };
        if [in_black, in_white, out_black, out_white].iter().any(|x| !(0..=255).contains(x)) || !(1..=999).contains(&gamma) {
            return Err("The Levels file is damaged".into());
        }
        records.push(d[at..at + 10].to_vec());
    }
    // The block `parse` reads: the file's records, then identity records up to 29.
    let mut block = vec![0, 2];
    let mut ident = Vec::new();
    super::levels_write(&mut ident, &LevelsChannel::default());
    for r in 0..ALV_RECORDS {
        block.extend_from_slice(records.get(r).unwrap_or(&ident));
    }
    let adj = parse(b"levl", &block, None, Channels::Rgb);
    if matches!(adj, Adjustment::Unsupported { .. }) {
        return Err(not());
    }
    let extra = records.iter().skip(4).filter(|r| **r != ident).count();
    let report = if extra > 0 { vec![format!("{} skipped", count(extra, "more channel setting", "more channel settings"))] } else { Vec::new() };
    Ok((adj, report))
}

// ------------------------------------------------------------------ Curves

fn line() -> Vec<CurvePoint> {
    vec![CurvePoint { input: 0.0, output: 0.0 }, CurvePoint { input: 1.0, output: 1.0 }]
}

/// [`SAMPLED_POINTS`] points of `c` at evenly spaced input levels.
fn sampled(c: &[CurvePoint]) -> Vec<CurvePoint> {
    let outs = curve_map_outputs(c);
    let last = (SAMPLED_POINTS - 1) as f32;
    (0..SAMPLED_POINTS)
        .map(|k| {
            let level = (k as f32 * 255.0 / last).round();
            let out = outs.get(level as usize).copied().unwrap_or(level / 255.0);
            CurvePoint { input: level / 255.0, output: out }
        })
        .collect()
}

/// Points sorted by input with one point per input level (the later wins), at least the
/// identity line, at most [`MAX_POINTS`] (sampled when there are more).
fn tidy(mut pts: Vec<CurvePoint>) -> Vec<CurvePoint> {
    pts.sort_by(|a, b| a.input.total_cmp(&b.input));
    let mut out: Vec<CurvePoint> = Vec::with_capacity(pts.len());
    for p in pts {
        match out.last_mut() {
            Some(q) if q.input == p.input => *q = p,
            _ => out.push(p),
        }
    }
    match out.len() {
        0 | 1 => line(),
        n if n > MAX_POINTS => sampled(&out),
        _ => out,
    }
}

fn read_acv(d: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    let not = || "This is not a Curves file".to_string();
    let (Some(version), Some(n)) = (bei16(d, 0), bei16(d, 2)) else { return Err(not()) };
    if !matches!(version, 1 | 4) || !(1..=32).contains(&n) {
        return Err(not());
    }
    let mut at = 4;
    let mut curves = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let k = bei16(d, at).ok_or("The Curves file is cut short")?;
        at += 2;
        let k = usize::try_from(k).ok().filter(|k| *k <= MAX_FILE_POINTS).ok_or("The Curves file is damaged")?;
        let mut pts = Vec::with_capacity(k);
        for _ in 0..k {
            let (Some(out), Some(inp)) = (bei16(d, at), bei16(d, at + 2)) else { return Err("The Curves file is damaged".into()) };
            at += 4;
            let level = |v: i16| f32::from(v.clamp(0, 255)) / 255.0;
            pts.push(CurvePoint { input: level(inp), output: level(out) });
        }
        curves.push(tidy(pts));
    }
    let extra = curves.len().saturating_sub(4);
    let mut it = curves.into_iter();
    let master = it.next().unwrap_or_else(line);
    let per_channel = [it.next().unwrap_or_else(line), it.next().unwrap_or_else(line), it.next().unwrap_or_else(line)];
    let report = if extra > 0 { vec![format!("{} skipped", count(extra, "more channel curve", "more channel curves"))] } else { Vec::new() };
    Ok((Adjustment::Curves { master, per_channel, space: ToneSpace::Rgb, black: Vec::new(), pencil: false }, report))
}

/// `.acv` version 1: the composite, then the channels of the curve's mode (red, green and blue;
/// cyan, magenta, yellow and black; or, as Lab has no composite, an identity composite and then
/// lightness, a and b).
fn write_acv(master: &[CurvePoint], per_channel: &[Vec<CurvePoint>; 3], space: ToneSpace, black: &[CurvePoint], pencil: bool) -> Vec<u8> {
    let identity = line();
    let mut curves: Vec<&[CurvePoint]> = vec![if space == ToneSpace::Lab { &identity } else { master }];
    curves.extend(per_channel.iter().map(Vec::as_slice));
    if space == ToneSpace::Cmyk {
        curves.push(if black.len() >= 2 { black } else { &identity });
    }
    let mut v = Vec::new();
    super::put16(&mut v, 1);
    super::put16(&mut v, curves.len() as u16);
    for c in curves {
        let pts = if pencil || c.len() > MAX_POINTS { sampled(c) } else { tidy(c.to_vec()) };
        super::put16(&mut v, pts.len() as u16);
        for p in &pts {
            super::put16(&mut v, super::q255(p.output));
            super::put16(&mut v, super::q255(p.input));
        }
    }
    v
}

// ------------------------------------------------------------------ Hue/Saturation

fn read_ahu(d: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    if d.len() < 100 {
        return Err("This is not a Hue/Saturation file".into());
    }
    let version = be16(d, 0).unwrap_or(0);
    if !matches!(version, 1 | 2) {
        return Err(format!("Hue/Saturation file version {version} is not supported"));
    }
    let adj = parse(b"hue2", &d[..100], None, Channels::Rgb);
    if matches!(adj, Adjustment::Unsupported { .. }) {
        return Err("This is not a Hue/Saturation file".into());
    }
    let report =
        if version == 1 { vec!["An old (version 1) Hue/Saturation file: its ranges were read with Photoshop's later layout".to_string()] } else { Vec::new() };
    Ok((adj, report))
}

// ------------------------------------------------------------------ Channel Mixer

/// Channel Mixer records: red, green and blue outputs, then the gray mix (percent).
const MIXER_DEFAULT: [[i16; 5]; 4] = [[100, 0, 0, 0, 0], [0, 100, 0, 0, 0], [0, 0, 100, 0, 0], [40, 40, 20, 0, 0]];

fn read_cha(d: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    if d.len() < 14 {
        return Err("This is not a Channel Mixer file".into());
    }
    if be16(d, 0) != Some(1) {
        return Err("This Channel Mixer file version is not supported".into());
    }
    let monochrome = be16(d, 2).unwrap_or(0) != 0;
    let mut recs = MIXER_DEFAULT;
    for (r, rec) in recs.iter_mut().enumerate() {
        let at = 4 + r * 10;
        if at + 10 > d.len() {
            break;
        }
        for (k, v) in rec.iter_mut().enumerate() {
            *v = bei16(d, at + k * 2).unwrap_or(*v);
        }
    }
    let mut report = Vec::new();
    let short = d.len() < 44;
    if short {
        report.push("A short Channel Mixer file: the missing outputs keep their defaults".to_string());
    }
    // Where the gray mix is: PSD `mixr` blocks (and PhotoCraft's files, which write it in both
    // places) keep it in the first record; the JavaScript Pigment wrote the red output there and
    // the gray mix in the fourth. The fourth record is taken when the first is the untouched red
    // output and the fourth holds a mix.
    if monochrome && !short && recs[0] == MIXER_DEFAULT[0] && recs[3][..3].iter().any(|v| *v != 0) {
        recs[0] = recs[3];
    }
    let mut block = vec![0, 1, 0, u8::from(monochrome)];
    for rec in recs {
        for v in rec {
            block.extend_from_slice(&v.to_be_bytes());
        }
    }
    let adj = parse(b"mixr", &block, None, Channels::Rgb);
    if matches!(adj, Adjustment::Unsupported { .. }) {
        return Err("This is not a Channel Mixer file".into());
    }
    Ok((adj, report))
}

// ------------------------------------------------------------------ Selective Color

fn read_asv(d: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    if d.len() < 84 {
        return Err("This is not a Selective Color file".into());
    }
    if be16(d, 0) != Some(1) {
        return Err("This Selective Color file version is not supported".into());
    }
    match parse(b"selc", &d[..84], None, Channels::Rgb) {
        Adjustment::Unsupported { .. } => Err("This is not a Selective Color file".into()),
        adj => Ok((adj, Vec::new())),
    }
}

// ------------------------------------------------------------------ Black & White

fn read_blw(d: &[u8]) -> Result<(Adjustment, Vec<String>), String> {
    if d.len() < 16 || d.get(2..6) != Some(&16u32.to_be_bytes()[..]) {
        return Err("This is not a Black & White file".into());
    }
    let body = &d[2..];
    let (v, _) = craft_psd::descriptor::VersionedDescriptor::parse_prefix(body).map_err(|e| format!("This Black & White file cannot be read: {e}"))?;
    if !BW_KEYS.iter().any(|k| v.descriptor.get(k).is_some()) {
        return Err("This Black & White file holds no settings".into());
    }
    match parse(b"blwh", body, None, Channels::Rgb) {
        Adjustment::Unsupported { .. } => Err("This is not a Black & White file".into()),
        adj => Ok((adj, Vec::new())),
    }
}

#[cfg(test)]
mod tests;
