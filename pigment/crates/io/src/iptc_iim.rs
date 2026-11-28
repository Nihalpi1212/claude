//! Pigment: IPTC-IIM (Information Interchange Model 4.2) for File Info (F1).
//!
//! Photoshop keeps the IIM copy of File Info in image resource 1028 (PSD, and the APP13 "Photoshop 3.0"
//! segment of a JPEG) beside the XMP packet, and old JPEGs carry only IIM. craft-metadata reads IIM
//! ([`craft_metadata::parse_iptc`], six fields) but writes none, so this module holds the rest:
//!
//! - [`from_xmp`]: the record-2 datasets that the packet's File Info fields map to (Photoshop's list);
//! - [`encode`]: an IIM stream of them, UTF-8 (1:90 = `ESC % G`), keeping the datasets of the old
//!   stream that File Info does not map;
//! - [`sync_resource`]: resource 1028 rewritten when, and only when, a File Info edit changed a mapped
//!   field, so an unchanged document saves byte-identical;
//! - [`on_import`] / [`seed_xmp`]: a flat file's 1028 kept for its next save, and a file with IIM but no
//!   XMP seeded with an XMP packet of its fields (as Photoshop reconciles them);
//! - [`insert_app13`] / [`with_app13`]: the APP13 segment of a JPEG export with its metadata on.

use std::sync::Arc;

use craft_metadata::{XmpValue, parse_xmp_with};
use photocraft_doc::Document;

use crate::file_info_xmp::{EXTRA_NAMESPACES, Out, packet};
use crate::{ExportOptions, ExportResult, XmpEmbed};

/// The image resource that holds the IIM stream.
pub const RESOURCE: u16 = 1028;
/// The image resource that holds the MD5 digest of the IIM stream (Photoshop's "IPTC-NAA digest").
/// Readers that follow the Metadata Working Group's guidance take a digest that does not match
/// the stream as a sign that an older application changed the IIM, and then prefer the IIM to
/// the XMP; so a rewritten stream drops it.
pub const DIGEST: u16 = 1061;
/// 1:90 Coded Character Set: UTF-8.
const UTF8: &[u8] = b"\x1b%G";
/// The longest dataset written with a standard (two-byte) length.
const MAX_STANDARD: usize = 0x7fff;

/// How a dataset maps to its XMP property.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// One value: a simple property or the `x-default` of a language alternative.
    Text,
    Alt,
    /// One dataset per array item.
    Bag,
    Seq,
}

/// Photoshop's IIM ⇄ XMP map for record 2: (dataset, XMP property, kind). 2:55 and 2:60 (date and
/// time created) are `photoshop:DateCreated` together, handled apart.
const MAPPED: [(u8, &str, Kind); 18] = [
    (5, "dc:title", Kind::Alt),
    (10, "photoshop:Urgency", Kind::Text),
    (25, "dc:subject", Kind::Bag),
    (40, "photoshop:Instructions", Kind::Text),
    (80, "dc:creator", Kind::Seq),
    (85, "photoshop:AuthorsPosition", Kind::Text),
    (90, "photoshop:City", Kind::Text),
    (92, "Iptc4xmpCore:Location", Kind::Text),
    (95, "photoshop:State", Kind::Text),
    (100, "Iptc4xmpCore:CountryCode", Kind::Text),
    (101, "photoshop:Country", Kind::Text),
    (103, "photoshop:TransmissionReference", Kind::Text),
    (105, "photoshop:Headline", Kind::Text),
    (110, "photoshop:Credit", Kind::Text),
    (115, "photoshop:Source", Kind::Text),
    (116, "dc:rights", Kind::Alt),
    (120, "dc:description", Kind::Alt),
    (122, "photoshop:CaptionWriter", Kind::Text),
];
const DATE_CREATED: u8 = 55;
const TIME_CREATED: u8 = 60;

/// Whether File Info owns record-2 dataset `n` (it is rewritten from the XMP).
fn mapped(n: u8) -> bool {
    n == 0 || n == DATE_CREATED || n == TIME_CREATED || MAPPED.iter().any(|(d, _, _)| *d == n)
}

/// One dataset of a stream: (record, dataset, data).
pub type Dataset = (u8, u8, Vec<u8>);

/// The datasets of an IIM stream, up to the first malformed tag.
pub fn datasets(b: &[u8]) -> Vec<Dataset> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while let Some(head) = b.get(i..i + 5) {
        if head[0] != 0x1c {
            break;
        }
        let (rec, ds) = (head[1], head[2]);
        let mut size = usize::from(u16::from_be_bytes([head[3], head[4]]));
        let mut at = i + 5;
        if size & 0x8000 != 0 {
            let n = size & 0x7fff;
            let Some(len) = b.get(at..at + n).filter(|_| (1..=4).contains(&n)) else { break };
            size = len.iter().fold(0usize, |a, &c| (a << 8) | usize::from(c));
            at += n;
        }
        let Some(data) = b.get(at..at.saturating_add(size)) else { break };
        out.push((rec, ds, data.to_vec()));
        i = at + size;
    }
    out
}

/// Whether the stream's 1:90 says UTF-8.
fn is_utf8(sets: &[Dataset]) -> bool {
    sets.iter().any(|(r, d, v)| *r == 1 && *d == 90 && v == UTF8)
}

/// Text of a dataset: UTF-8 when the stream says so or the bytes are valid UTF-8, else Latin-1.
fn text(data: &[u8], utf8: bool) -> String {
    let s = match std::str::from_utf8(data) {
        Ok(s) => s.to_string(),
        Err(_) if utf8 => String::from_utf8_lossy(data).into_owned(),
        Err(_) => data.iter().map(|&c| c as char).collect(),
    };
    s.trim_end_matches('\0').trim().to_string()
}

/// The record-2 text datasets of a stream, in order: (dataset, text). Empty values are left out.
pub fn decode(b: &[u8]) -> Vec<(u8, String)> {
    let sets = datasets(b);
    let utf8 = is_utf8(&sets);
    sets.iter().filter(|(r, d, _)| *r == 2 && *d != 0).map(|(_, d, v)| (*d, text(v, utf8))).filter(|(_, t)| !t.is_empty()).collect()
}

/// `photoshop:DateCreated` (`2024-02-17`, `2024-02-17T12:40:19+01:00`, `2024-02`) as IIM's 2:55
/// (`CCYYMMDD`, `00` for an unknown month or day) and 2:60 (`HHMMSS±HHMM`; six digits for a time
/// without an offset, `Z` as `+0000`).
fn iim_date(iso: &str) -> Option<(String, Option<String>)> {
    let iso = iso.trim();
    let (date, time) = iso.split_once('T').map_or((iso, None), |(d, t)| (d, Some(t)));
    let mut parts = date.split('-');
    let year = parts.next().filter(|y| y.len() == 4 && y.bytes().all(|b| b.is_ascii_digit()))?;
    let two = |p: Option<&str>| p.map_or(Some("00".to_string()), |v| (v.len() == 2 && v.bytes().all(|b| b.is_ascii_digit())).then(|| v.to_string()));
    let (month, day) = (two(parts.next())?, two(parts.next())?);
    let date = format!("{year}{month}{day}");
    let time = time.and_then(|t| {
        let (clock, offset) = match t.find(['+', '-', 'Z']) {
            Some(at) => (&t[..at], Some(&t[at..])),
            None => (t, None),
        };
        let mut hms: Vec<&str> = clock.split(':').collect();
        hms.resize(3, "00");
        let sec = hms[2].split('.').next().unwrap_or("00");
        let fields = [hms[0], hms[1], sec];
        if !fields.iter().all(|f| f.len() == 2 && f.bytes().all(|b| b.is_ascii_digit())) {
            return None;
        }
        let clock = fields.concat();
        Some(match offset {
            None => clock,
            Some("Z") => format!("{clock}+0000"),
            Some(o) => {
                let digits: String = o[1..].chars().filter(char::is_ascii_digit).collect();
                if digits.len() != 4 {
                    return Some(clock);
                }
                format!("{clock}{}{digits}", &o[..1])
            }
        })
    });
    Some((date, time))
}

/// 2:55 and 2:60 back as an XMP date.
fn xmp_date(date: &str, time: Option<&str>) -> Option<String> {
    let b = date.as_bytes();
    if b.len() != 8 || !b.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let (y, m, d) = (&date[..4], &date[4..6], &date[6..8]);
    let mut iso = match (m, d) {
        ("00", _) => y.to_string(),
        (_, "00") => format!("{y}-{m}"),
        _ => format!("{y}-{m}-{d}"),
    };
    if let Some(t) = time.filter(|t| t.len() >= 6 && t.as_bytes()[..6].iter().all(u8::is_ascii_digit) && d != "00" && m != "00") {
        iso.push_str(&format!("T{}:{}:{}", &t[..2], &t[2..4], &t[4..6]));
        if t.len() == 11 && matches!(&t[6..7], "+" | "-") && t.as_bytes()[7..].iter().all(u8::is_ascii_digit) {
            iso.push_str(&format!("{}{}:{}", &t[6..7], &t[7..9], &t[9..11]));
        }
    }
    Some(iso)
}

fn texts(v: &XmpValue) -> Vec<String> {
    v.items().iter().filter_map(XmpValue::text).map(str::to_string).filter(|t| !t.is_empty()).collect()
}

/// The record-2 datasets File Info's fields in `xmp` map to, in dataset order. Nothing for no packet
/// or one that does not parse.
pub fn from_xmp(xmp: Option<&str>) -> Vec<(u8, String)> {
    let Some(d) = xmp.and_then(|x| parse_xmp_with(x, &EXTRA_NAMESPACES).ok()) else { return Vec::new() };
    let mut out = Vec::new();
    for (ds, prop, kind) in MAPPED {
        let Some(v) = d.values.get(prop) else { continue };
        match kind {
            Kind::Bag | Kind::Seq => out.extend(texts(v).into_iter().map(|t| (ds, t))),
            Kind::Text | Kind::Alt => out.extend(v.text().filter(|t| !t.is_empty()).map(|t| (ds, t.to_string()))),
        }
    }
    if let Some((date, time)) = d.values.get("photoshop:DateCreated").and_then(XmpValue::text).and_then(iim_date) {
        out.push((DATE_CREATED, date));
        out.extend(time.map(|t| (TIME_CREATED, t)));
    }
    out.sort_by_key(|(ds, _)| *ds);
    out
}

fn tag(out: &mut Vec<u8>, rec: u8, ds: u8, data: &[u8]) {
    out.extend_from_slice(&[0x1c, rec, ds]);
    if data.len() <= MAX_STANDARD {
        out.extend_from_slice(&(data.len() as u16).to_be_bytes());
    } else {
        // Extended dataset: four bytes of length (IIM 4.2 §1.5.2).
        out.extend_from_slice(&0x8004u16.to_be_bytes());
        out.extend_from_slice(&(data.len().min(u32::MAX as usize) as u32).to_be_bytes());
    }
    out.extend_from_slice(data);
}

/// An IIM stream of `fields` (record 2, UTF-8), keeping from `keep` (the stream the file had) every
/// dataset File Info does not map: record 1 but its character set, record 2's unmapped datasets
/// (converted to UTF-8 when they were Latin-1), and the later records. Empty when nothing is left.
pub fn encode(fields: &[(u8, String)], keep: Option<&[u8]>) -> Vec<u8> {
    let old = keep.map(datasets).unwrap_or_default();
    let latin1 = !is_utf8(&old);
    let mut rec2: Vec<(u8, Vec<u8>)> = fields.iter().filter(|(_, t)| !t.is_empty()).map(|(d, t)| (*d, t.as_bytes().to_vec())).collect();
    for (_, d, v) in old.iter().filter(|(r, d, _)| *r == 2 && !mapped(*d)) {
        // 2:125 is a rasterized caption (binary); the rest are text.
        let v = if latin1 && *d != 125 && std::str::from_utf8(v).is_err() { v.iter().map(|&c| c as char).collect::<String>().into_bytes() } else { v.clone() };
        rec2.push((*d, v));
    }
    rec2.sort_by_key(|(d, _)| *d);
    let others: Vec<&Dataset> = old.iter().filter(|(r, d, _)| !matches!((r, d), (1, 90) | (2, _))).collect();
    if rec2.is_empty() && others.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut wrote_charset = false;
    for (r, d, v) in others.iter().filter(|(r, _, _)| *r == 1) {
        if !wrote_charset && *d > 90 {
            tag(&mut out, 1, 90, UTF8);
            wrote_charset = true;
        }
        tag(&mut out, *r, *d, v);
    }
    if !wrote_charset {
        tag(&mut out, 1, 90, UTF8);
    }
    // 2:00 Record Version 4, as Photoshop writes it.
    tag(&mut out, 2, 0, &[0, 4]);
    for (d, v) in &rec2 {
        tag(&mut out, 2, *d, v);
    }
    for (r, d, v) in others.iter().filter(|(r, _, _)| *r > 2) {
        tag(&mut out, *r, *d, v);
    }
    out
}

/// Keeps resource 1028 in step with a File Info edit from `old` to `new` (the XMP packets): when a
/// mapped field changed, 1028 is rewritten (added, or removed when nothing is left) and its digest
/// (1061) dropped; otherwise the resources are left as they are, byte for byte.
pub fn sync_resource(resources: &mut Vec<(u16, String, Arc<Vec<u8>>)>, old: Option<&str>, new: Option<&str>) {
    let fields = from_xmp(new);
    if from_xmp(old) == fields {
        return;
    }
    // The old stream's digest no longer describes what is written.
    resources.retain(|(id, _, _)| *id != DIGEST);
    let at = resources.iter().position(|(id, _, _)| *id == RESOURCE);
    let stream = encode(&fields, at.map(|i| resources[i].2.as_slice()));
    match (at, stream.is_empty()) {
        (Some(i), true) => {
            resources.remove(i);
        }
        (Some(i), false) => resources[i].2 = Arc::new(stream),
        (None, false) => resources.push((RESOURCE, String::new(), Arc::new(stream))),
        (None, true) => {}
    }
}

/// An XMP packet of an IIM stream's File Info fields (what Photoshop shows for a file without
/// XMP), or `None` when the stream holds none.
pub fn seed_xmp(iim: &[u8]) -> Option<String> {
    let fields = decode(iim);
    let mut props: Vec<(String, Out)> = Vec::new();
    for (ds, prop, kind) in MAPPED {
        let vals: Vec<String> = fields.iter().filter(|(d, _)| *d == ds).map(|(_, t)| t.clone()).collect();
        let Some(first) = vals.first().cloned() else { continue };
        let value = match kind {
            Kind::Text => Out::Text(first),
            Kind::Alt => Out::Alt(first),
            Kind::Bag => Out::Bag(vals.into_iter().map(Out::Text).collect()),
            Kind::Seq => Out::Seq(vals.into_iter().map(Out::Text).collect()),
        };
        props.push((prop.to_string(), value));
    }
    let date = fields.iter().find(|(d, _)| *d == DATE_CREATED).map(|(_, t)| t.as_str());
    let time = fields.iter().find(|(d, _)| *d == TIME_CREATED).map(|(_, t)| t.as_str());
    if let Some(iso) = date.and_then(|d| xmp_date(d, time)) {
        props.push(("photoshop:DateCreated".into(), Out::Text(iso)));
    }
    (!props.is_empty()).then(|| packet(&props))
}

/// A flat file's Photoshop resources on open: resource 1028 is kept for the next save, and a file
/// without XMP gets a packet of the IIM fields.
pub fn on_import(doc: &mut Document, photoshop_resources: Option<&[u8]>) {
    let Some((res, _)) = photoshop_resources.and_then(|r| craft_psd::tiff::resources_from_bytes(r).ok()) else { return };
    let Some(iim) = res.into_iter().find(|r| r.id == RESOURCE) else { return };
    if doc.metadata.xmp.is_none()
        && let Some(x) = seed_xmp(&iim.data)
    {
        doc.metadata.xmp = Some(x.into());
    }
    if !doc.metadata.psd_resources.iter().any(|(id, _, _)| *id == RESOURCE) {
        doc.metadata.psd_resources.push((RESOURCE, String::from_utf8_lossy(&iim.name).into_owned(), Arc::new(iim.data)));
    }
}

/// The JPEG `jpeg` with `iim` in APP13 "Photoshop 3.0" segments (resource 1028), after the leading
/// APP0/APP1 segments (JFIF, Exif, XMP), as Photoshop places it. A stream above one segment's 64 KB
/// continues in the next segments. Bytes that are no JPEG come back unchanged.
pub fn insert_app13(jpeg: &[u8], iim: &[u8]) -> Vec<u8> {
    if iim.is_empty() || !jpeg.starts_with(&[0xff, 0xd8]) {
        return jpeg.to_vec();
    }
    let mut irb = b"8BIM".to_vec();
    irb.extend_from_slice(&RESOURCE.to_be_bytes());
    irb.extend_from_slice(&[0, 0]);
    irb.extend_from_slice(&(iim.len().min(u32::MAX as usize) as u32).to_be_bytes());
    irb.extend_from_slice(iim);
    if irb.len() % 2 == 1 {
        irb.push(0);
    }
    let mut at = 2;
    while let Some(seg) = jpeg.get(at..at + 4) {
        if seg[0] != 0xff || !matches!(seg[1], 0xe0 | 0xe1) {
            break;
        }
        let next = at + 2 + usize::from(u16::from_be_bytes([seg[2], seg[3]]));
        if next > jpeg.len() {
            break;
        }
        at = next;
    }
    const HEAD: &[u8] = b"Photoshop 3.0\0";
    let room = 0xffff - 2 - HEAD.len();
    let mut out = Vec::with_capacity(jpeg.len() + irb.len() + 32);
    out.extend_from_slice(&jpeg[..at]);
    for chunk in irb.chunks(room) {
        out.extend_from_slice(&[0xff, 0xed]);
        out.extend_from_slice(&((2 + HEAD.len() + chunk.len()) as u16).to_be_bytes());
        out.extend_from_slice(HEAD);
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&jpeg[at..]);
    out
}

/// A flat export's result with the document's IIM in APP13, for a JPEG exported with its metadata
/// (the encoder writes none).
pub(crate) fn with_app13(doc: &Document, format: photocraft_codecs::Format, opts: &ExportOptions, mut r: ExportResult) -> ExportResult {
    if format != photocraft_codecs::Format::Jpeg || !opts.encode.embed_metadata || opts.xmp != XmpEmbed::All {
        return r;
    }
    if let Some((_, _, iim)) = doc.metadata.psd_resources.iter().find(|(id, _, _)| *id == RESOURCE) {
        r.bytes = insert_app13(&r.bytes, iim);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_convert_both_ways() {
        assert_eq!(iim_date("2024-02-17T12:40:19+01:00"), Some(("20240217".into(), Some("124019+0100".into()))));
        assert_eq!(iim_date("2024-02-17T12:40:19.25Z"), Some(("20240217".into(), Some("124019+0000".into()))));
        assert_eq!(iim_date("2024-02-17T12:40"), Some(("20240217".into(), Some("124000".into()))));
        assert_eq!(iim_date("2024-02"), Some(("20240200".into(), None)));
        assert_eq!(iim_date("yesterday"), None);
        assert_eq!(xmp_date("20240217", Some("124019+0100")).as_deref(), Some("2024-02-17T12:40:19+01:00"));
        assert_eq!(xmp_date("20240217", Some("124019")).as_deref(), Some("2024-02-17T12:40:19"));
        assert_eq!(xmp_date("20240200", None).as_deref(), Some("2024-02"));
        assert_eq!(xmp_date("2024", None), None);
    }

    #[test]
    fn a_long_dataset_uses_an_extended_length_and_reads_back() {
        let long = "é".repeat(20_000);
        let iim = encode(&[(120, long.clone())], None);
        assert_eq!(decode(&iim), [(120, long)]);
    }

    #[test]
    fn unmapped_datasets_survive_and_latin1_becomes_utf8() {
        let mut old = Vec::new();
        tag(&mut old, 1, 0, &[0, 4]);
        tag(&mut old, 2, 0, &[0, 4]);
        tag(&mut old, 2, 5, b"Old title");
        tag(&mut old, 2, 15, b"ART");
        tag(&mut old, 2, 20, &[b'C', 0xe9]); // "Cé" in Latin-1
        tag(&mut old, 3, 10, b"x");
        let new = encode(&[(5, "New title".into())], Some(&old));
        let sets = datasets(&new);
        assert_eq!(sets.iter().map(|(r, d, _)| (*r, *d)).collect::<Vec<_>>(), [(1, 0), (1, 90), (2, 0), (2, 5), (2, 15), (2, 20), (3, 10)]);
        assert_eq!(decode(&new), [(5, "New title".into()), (15, "ART".into()), (20, "Cé".into())]);
    }

    /// Review FU: a rewritten stream kept the old IPTC digest, which tells MWG-guided readers
    /// (Photoshop among them) that the IIM was changed behind the XMP's back.
    #[test]
    fn a_rewritten_stream_drops_its_stale_digest_and_an_unchanged_one_keeps_it() {
        let old = encode(&[(5, "Old".into())], None);
        let packet = |title: &str| packet(&[("dc:title".to_string(), Out::Alt(title.into()))]);
        let mut res =
            vec![(RESOURCE, String::new(), Arc::new(old.clone())), (DIGEST, String::new(), Arc::new(vec![7; 16])), (1005, String::new(), Arc::new(vec![1]))];
        let kept = res.clone();
        sync_resource(&mut res, Some(&packet("Old")), Some(&packet("Old")));
        assert_eq!(res, kept, "nothing mapped changed");
        sync_resource(&mut res, Some(&packet("Old")), Some(&packet("New")));
        assert_eq!(res.iter().map(|(id, _, _)| *id).collect::<Vec<_>>(), [RESOURCE, 1005]);
        assert_eq!(decode(&res[0].2), [(5, "New".to_string())]);
    }

    #[test]
    fn every_prefix_of_a_stream_decodes_without_panicking() {
        let iim = encode(&[(5, "Title".into()), (25, "a".into()), (25, "b".into())], None);
        for n in 0..iim.len() {
            let _ = decode(&iim[..n]);
            let _ = seed_xmp(&iim[..n]);
        }
        let jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
        // A truncated APP0: the segment goes right after SOI, and nothing panics.
        assert_eq!(insert_app13(&jpeg, &iim)[..4], [0xff, 0xd8, 0xff, 0xed]);
    }
}
