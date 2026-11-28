//! Pigment: File Info's other tabs (F1, as the JavaScript Pigment and Photoshop have them).
//!
//! Upstream's `info.rs` owns the eight Basic keys (title, author, authorTitle, description, keywords,
//! copyright, copyrightStatus, copyrightUrl) and their hand-rolled XMP reader and writer. This module adds
//! the rest of Photoshop's File Info beside them, so upstream's fixes stay in one place:
//!
//! - Basic: `rating`, `descriptionWriter`; Origin: `dateCreated`, `city`, `state`, `country`, `credit`,
//!   `source`, `headline`, `instructions`, `transmissionReference`, `urgency`; IPTC: `creatorContactInfo`,
//!   `subjectCode`, `intellectualGenre`, `scene`, `sublocation`, `countryCode`, `usageTerms`, `altText`; IPTC
//!   Extension: people, locations, organisations, event, releases, licensing, digital source type, size,
//!   registry and artwork ([`FIELDS`]).
//! - Read-only: `created`, `modified`, `application`, `format`, the Camera Data beyond upstream's nine
//!   ([`CAMERA_MORE`]), `gps`, `raw` (the packet), `history` (`photoshop:History`), `dynamicMedia`
//!   (`xmpDM:`) and `dicom`.
//!
//! Reading goes through `craft_metadata::parse_xmp_with`; writing serializes the edited keys into a fresh
//! packet ([`photocraft_io::file_info_xmp::packet`]) and merges it into the document's
//! (`craft_metadata::merge_xmp`), which keeps every property it does not own byte for byte. Resource
//! 1028 (IPTC-IIM) follows the edit ([`photocraft_io::iptc_iim::sync_resource`]).

use craft_metadata::{MergeRules, Metadata, XmpData, XmpValue, merge_xmp, parse_xmp_with};
use photocraft_doc::Document;
use photocraft_io::file_info_xmp::{EXTRA_NAMESPACES, Out, packet};

use super::{EngineError, Result, Value, json};

/// The kind of a struct field.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SubKind {
    Text,
    Alt,
    Seq,
}

/// A struct field: (local name, kind). Its prefix is the property's.
pub type Sub = (&'static str, SubKind);

/// How a key is stored.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Text,
    /// A language alternative (its `x-default`).
    Alt,
    /// Arrays of text: `[str]`, or one string split on `;`.
    Bag,
    Seq,
    /// A whole number, clamped to the range; 0 clears the property.
    Int(i64, i64),
    /// A structure: `{field: str}`.
    Struct(&'static [Sub]),
    /// Arrays of structures: `[{field: str}]`; one object replaces the first item.
    StructBag(&'static [Sub]),
    StructSeq(&'static [Sub]),
}

/// One editable key: the param, its XMP property, kind and File Info tab.
#[derive(Clone, Copy, Debug)]
pub struct Field {
    pub key: &'static str,
    pub prop: &'static str,
    pub kind: Kind,
    pub tab: &'static str,
}

const T: SubKind = SubKind::Text;
const CONTACT: &[Sub] =
    &[("CiAdrExtadr", T), ("CiAdrCity", T), ("CiAdrRegion", T), ("CiAdrPcode", T), ("CiAdrCtry", T), ("CiTelWork", T), ("CiEmailWork", T), ("CiUrlWork", T)];
const LOCATION: &[Sub] = &[("Sublocation", T), ("City", T), ("ProvinceState", T), ("CountryName", T), ("CountryCode", T), ("WorldRegion", T)];
const LICENSOR: &[Sub] = &[("LicensorName", T), ("LicensorID", T), ("LicensorTelephone1", T), ("LicensorEmail", T), ("LicensorURL", T)];
const SUPPLIER: &[Sub] = &[("ImageSupplierName", T), ("ImageSupplierID", T)];
const CREATOR: &[Sub] = &[("ImageCreatorName", T), ("ImageCreatorID", T)];
const OWNER: &[Sub] = &[("CopyrightOwnerName", T), ("CopyrightOwnerID", T)];
const REGISTRY: &[Sub] = &[("RegItemId", T), ("RegOrgId", T)];
const ARTWORK: &[Sub] =
    &[("AOTitle", SubKind::Alt), ("AOCreator", SubKind::Seq), ("AODateCreated", T), ("AOSource", T), ("AOSourceInvNo", T), ("AOCopyrightNotice", T)];

macro_rules! f {
    ($key:literal, $prop:literal, $kind:expr, $tab:literal) => {
        Field { key: $key, prop: $prop, kind: $kind, tab: $tab }
    };
}

/// Pigment's File Info keys, in each tab's order. `rating` is −1 (rejected, read but not offered) to 5;
/// `urgency` 0 (none) to 8; the sizes 0 (none) and up.
pub const FIELDS: [Field; 44] = [
    f!("rating", "xmp:Rating", Kind::Int(-1, 5), "basic"),
    f!("descriptionWriter", "photoshop:CaptionWriter", Kind::Text, "basic"),
    f!("dateCreated", "photoshop:DateCreated", Kind::Text, "origin"),
    f!("city", "photoshop:City", Kind::Text, "origin"),
    f!("state", "photoshop:State", Kind::Text, "origin"),
    f!("country", "photoshop:Country", Kind::Text, "origin"),
    f!("credit", "photoshop:Credit", Kind::Text, "origin"),
    f!("source", "photoshop:Source", Kind::Text, "origin"),
    f!("headline", "photoshop:Headline", Kind::Text, "origin"),
    f!("instructions", "photoshop:Instructions", Kind::Text, "origin"),
    f!("transmissionReference", "photoshop:TransmissionReference", Kind::Text, "origin"),
    f!("urgency", "photoshop:Urgency", Kind::Int(0, 8), "origin"),
    f!("creatorContactInfo", "Iptc4xmpCore:CreatorContactInfo", Kind::Struct(CONTACT), "iptc"),
    f!("subjectCode", "Iptc4xmpCore:SubjectCode", Kind::Bag, "iptc"),
    f!("intellectualGenre", "Iptc4xmpCore:IntellectualGenre", Kind::Text, "iptc"),
    f!("scene", "Iptc4xmpCore:Scene", Kind::Bag, "iptc"),
    f!("sublocation", "Iptc4xmpCore:Location", Kind::Text, "iptc"),
    f!("countryCode", "Iptc4xmpCore:CountryCode", Kind::Text, "iptc"),
    f!("usageTerms", "xmpRights:UsageTerms", Kind::Alt, "iptc"),
    // Shared with the AI port's Describe Image, which writes `description` today.
    f!("altText", "Iptc4xmpCore:AltTextAccessibility", Kind::Alt, "iptc"),
    f!("extDescrAccessibility", "Iptc4xmpCore:ExtDescrAccessibility", Kind::Alt, "iptc"),
    f!("personInImage", "Iptc4xmpExt:PersonInImage", Kind::Bag, "iptcExt"),
    f!("locationShown", "Iptc4xmpExt:LocationShown", Kind::StructBag(LOCATION), "iptcExt"),
    f!("locationCreated", "Iptc4xmpExt:LocationCreated", Kind::StructBag(LOCATION), "iptcExt"),
    f!("organisationInImageName", "Iptc4xmpExt:OrganisationInImageName", Kind::Bag, "iptcExt"),
    f!("organisationInImageCode", "Iptc4xmpExt:OrganisationInImageCode", Kind::Bag, "iptcExt"),
    f!("event", "Iptc4xmpExt:Event", Kind::Alt, "iptcExt"),
    f!("modelReleaseStatus", "plus:ModelReleaseStatus", Kind::Text, "iptcExt"),
    f!("modelReleaseId", "plus:ModelReleaseID", Kind::Bag, "iptcExt"),
    f!("propertyReleaseStatus", "plus:PropertyReleaseStatus", Kind::Text, "iptcExt"),
    f!("propertyReleaseId", "plus:PropertyReleaseID", Kind::Bag, "iptcExt"),
    f!("modelAge", "Iptc4xmpExt:ModelAge", Kind::Bag, "iptcExt"),
    f!("additionalModelInfo", "Iptc4xmpExt:AddlModelInfo", Kind::Text, "iptcExt"),
    f!("licensor", "plus:Licensor", Kind::StructSeq(LICENSOR), "iptcExt"),
    f!("imageSupplier", "plus:ImageSupplier", Kind::StructSeq(SUPPLIER), "iptcExt"),
    f!("imageCreator", "plus:ImageCreator", Kind::StructSeq(CREATOR), "iptcExt"),
    f!("copyrightOwner", "plus:CopyrightOwner", Kind::StructSeq(OWNER), "iptcExt"),
    f!("digitalSourceType", "Iptc4xmpExt:DigitalSourceType", Kind::Text, "iptcExt"),
    f!("maxAvailWidth", "Iptc4xmpExt:MaxAvailWidth", Kind::Int(0, 1 << 31), "iptcExt"),
    f!("maxAvailHeight", "Iptc4xmpExt:MaxAvailHeight", Kind::Int(0, 1 << 31), "iptcExt"),
    f!("registryId", "Iptc4xmpExt:RegistryId", Kind::StructBag(REGISTRY), "iptcExt"),
    f!("artworkOrObject", "Iptc4xmpExt:ArtworkOrObject", Kind::StructBag(ARTWORK), "iptcExt"),
    f!("imageSupplierImageId", "plus:ImageSupplierImageID", Kind::Text, "iptcExt"),
    f!("minorModelAgeDisclosure", "plus:MinorModelAgeDisclosure", Kind::Text, "iptcExt"),
];

/// Whether `key` is one of Pigment's editable File Info keys.
pub fn owns(key: &str) -> bool {
    FIELDS.iter().any(|f| f.key == key)
}

/// File Info's read-only Basic read-outs: (result key, XMP property).
const READ_OUTS: [(&str, &str); 4] =
    [("created", "xmp:CreateDate"), ("modified", "xmp:ModifyDate"), ("application", "xmp:CreatorTool"), ("format", "dc:format")];

/// Camera Data beyond upstream's [`super::CAMERA_FIELDS`], as (result key, English label), shown after them.
pub const CAMERA_MORE: [(&str, &str); 11] = [
    ("program", "Exposure Program"),
    ("metering", "Metering Mode"),
    ("flash", "Flash"),
    ("exposureBias", "Exposure Bias"),
    ("whiteBalance", "White Balance"),
    ("lensMake", "Lens Make"),
    ("serialNumber", "Serial Number"),
    ("software", "Software"),
    ("dateTime", "Date Time"),
    ("pixelDimensions", "Pixel Dimensions"),
    ("orientation", "Orientation"),
];

/// GPS Data, as (result key, English label).
pub const GPS_FIELDS: [(&str, &str); 7] = [
    ("latitude", "Latitude"),
    ("longitude", "Longitude"),
    ("altitude", "Altitude"),
    ("time", "GPS Time"),
    ("direction", "Direction"),
    ("speed", "Speed"),
    ("mapDatum", "Map Datum"),
];

/// The raw packet shown in Raw Data is cut here (a hostile packet can be megabytes).
const MAX_RAW: usize = 1 << 20;

fn prefix(prop: &str) -> &str {
    prop.split_once(':').map_or("", |(p, _)| p)
}

fn sub_text(v: &XmpValue, kind: SubKind) -> String {
    match kind {
        SubKind::Seq => v.items().iter().filter_map(XmpValue::text).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("; "),
        SubKind::Text | SubKind::Alt => v.text().unwrap_or_default().to_string(),
    }
}

fn struct_json(v: &XmpValue, ns: &str, subs: &[Sub]) -> Value {
    let mut m = serde_json::Map::new();
    for (local, kind) in subs {
        if let Some(t) = v.field(&format!("{ns}:{local}")).map(|f| sub_text(f, *kind)).filter(|t| !t.is_empty()) {
            m.insert((*local).into(), json!(t));
        }
    }
    Value::Object(m)
}

fn number(t: &str) -> Option<i64> {
    let t = t.trim();
    t.parse::<i64>().ok().or_else(|| t.parse::<f64>().ok().filter(|v| v.is_finite()).map(|v| v.round() as i64))
}

/// A key's value as File Info reports it.
fn read_value(field: &Field, v: Option<&XmpValue>) -> Value {
    let texts = |v: &XmpValue| v.items().iter().filter_map(XmpValue::text).filter(|t| !t.is_empty()).map(str::to_string).collect::<Vec<_>>();
    let ns = prefix(field.prop);
    match (field.kind, v) {
        (Kind::Text | Kind::Alt, v) => json!(v.and_then(XmpValue::text).unwrap_or_default()),
        (Kind::Int(lo, hi), v) => json!(v.and_then(XmpValue::text).and_then(number).map_or(0, |n| n.clamp(lo, hi))),
        (Kind::Bag | Kind::Seq, v) => json!(v.map(texts).unwrap_or_default()),
        (Kind::Struct(subs), Some(v)) => struct_json(v, ns, subs),
        (Kind::Struct(_), None) => json!({}),
        (Kind::StructBag(subs) | Kind::StructSeq(subs), v) => Value::Array(
            v.map(|v| {
                v.items()
                    .iter()
                    .filter(|i| matches!(i, XmpValue::Struct(_)))
                    .map(|i| struct_json(i, ns, subs))
                    .filter(|o| o.as_object().is_some_and(|m| !m.is_empty()))
                    .collect()
            })
            .unwrap_or_default(),
        ),
    }
}

fn bad(msg: String) -> EngineError {
    EngineError::BadParams { cmd: "file.fileInfo".into(), msg }
}

fn as_text(key: &str, v: &Value) -> Result<String> {
    match v {
        Value::Null => Ok(String::new()),
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        _ => Err(bad(format!("`{key}` must be text"))),
    }
}

fn as_list(key: &str, v: &Value) -> Result<Vec<String>> {
    let items = match v {
        Value::Null => Vec::new(),
        // Not on commas: names ("Smith, Ann") and codes can hold them.
        Value::String(s) => s.split(';').map(str::to_string).collect(),
        Value::Array(a) => a.iter().map(|i| as_text(key, i)).collect::<Result<_>>()?,
        _ => return Err(bad(format!("`{key}` must be a list of text or one text split on `;`"))),
    };
    Ok(items.into_iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

fn norm_struct(key: &str, subs: &[Sub], v: &Value) -> Result<Value> {
    let m = match v {
        Value::Null => return Ok(json!({})),
        Value::Object(m) => m,
        _ => return Err(bad(format!("`{key}` must be an object"))),
    };
    let mut out = serde_json::Map::new();
    for (local, kind) in subs {
        let Some(v) = m.get(*local) else { continue };
        let t = match kind {
            SubKind::Seq => as_list(key, v)?.join("; "),
            SubKind::Text | SubKind::Alt => as_text(key, v)?,
        };
        if !t.trim().is_empty() {
            out.insert((*local).into(), json!(t));
        }
    }
    Ok(Value::Object(out))
}

fn empty_object(v: &Value) -> bool {
    v.as_object().is_none_or(serde_json::Map::is_empty)
}

/// The param `v` of `field` in the form File Info reads it back, given the current value `cur`.
fn normalize(field: &Field, v: &Value, cur: &Value) -> Result<Value> {
    let key = field.key;
    Ok(match field.kind {
        Kind::Text | Kind::Alt => json!(as_text(key, v)?),
        Kind::Int(lo, hi) => {
            let n = match v {
                Value::Null => 0,
                Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64)).unwrap_or(0),
                Value::String(s) if s.trim().is_empty() => 0,
                Value::String(s) => number(s).ok_or_else(|| bad(format!("`{key}` must be a whole number")))?,
                _ => return Err(bad(format!("`{key}` must be a whole number"))),
            };
            json!(n.clamp(lo, hi))
        }
        Kind::Bag | Kind::Seq => json!(as_list(key, v)?),
        Kind::Struct(subs) => norm_struct(key, subs, v)?,
        Kind::StructBag(subs) | Kind::StructSeq(subs) => match v {
            // One object edits the first item (the dialog shows one), keeping the others.
            Value::Object(_) => {
                let mut items = cur.as_array().cloned().unwrap_or_default();
                let item = norm_struct(key, subs, v)?;
                match (items.is_empty(), empty_object(&item)) {
                    (true, true) => {}
                    (true, false) => items.push(item),
                    (false, true) => {
                        items.remove(0);
                    }
                    (false, false) => items[0] = item,
                }
                Value::Array(items)
            }
            Value::Null => json!([]),
            Value::Array(a) => {
                Value::Array(a.iter().map(|i| norm_struct(key, subs, i)).filter(|r| r.as_ref().map_or(true, |o| !empty_object(o))).collect::<Result<_>>()?)
            }
            _ => return Err(bad(format!("`{key}` must be a list of objects"))),
        },
    })
}

fn struct_out(ns: &str, subs: &[Sub], v: &Value) -> Vec<(String, Out)> {
    subs.iter()
        .filter_map(|(local, kind)| {
            let t = v.get(*local)?.as_str()?.to_string();
            let out = match kind {
                SubKind::Text => Out::Text(t),
                SubKind::Alt => Out::Alt(t),
                SubKind::Seq => Out::Seq(t.split(';').map(str::trim).filter(|s| !s.is_empty()).map(|s| Out::Text(s.into())).collect()),
            };
            Some((format!("{ns}:{local}"), out))
        })
        .collect()
}

/// A normalized value as the XMP to write, or `None` when it clears the property.
fn to_out(field: &Field, v: &Value) -> Option<Out> {
    let ns = prefix(field.prop);
    let texts = || v.as_array().map(|a| a.iter().filter_map(Value::as_str).map(|s| Out::Text(s.into())).collect::<Vec<_>>()).unwrap_or_default();
    let structs = |subs: &[Sub]| v.as_array().map(|a| a.iter().map(|o| Out::Struct(struct_out(ns, subs, o))).collect::<Vec<_>>()).unwrap_or_default();
    let out = match field.kind {
        Kind::Text => Out::Text(v.as_str()?.to_string()),
        Kind::Alt => Out::Alt(v.as_str()?.to_string()),
        Kind::Int(..) => Out::Text(v.as_i64().filter(|n| *n != 0)?.to_string()),
        Kind::Bag => Out::Bag(texts()),
        Kind::Seq => Out::Seq(texts()),
        Kind::Struct(subs) => Out::Struct(struct_out(ns, subs, v)),
        Kind::StructBag(subs) => Out::Bag(structs(subs)),
        Kind::StructSeq(subs) => Out::Seq(structs(subs)),
    };
    let empty = match &out {
        Out::Text(s) | Out::Alt(s) => s.trim().is_empty(),
        Out::Seq(a) | Out::Bag(a) => a.is_empty(),
        Out::Struct(f) => f.is_empty(),
    };
    (!empty).then_some(out)
}

fn parse(xmp: Option<&str>) -> XmpData {
    xmp.and_then(|x| parse_xmp_with(x, &EXTRA_NAMESPACES).ok()).unwrap_or_default()
}

/// Writes the Pigment keys of `p` that differ from the packet `xmp` (upstream's write already applied)
/// into it. Unchanged keys leave the packet as it is, byte for byte.
pub fn write(xmp: String, p: &Value) -> Result<String> {
    let cur = parse(Some(&xmp));
    let mut owned: Vec<&str> = Vec::new();
    let mut props: Vec<(String, Out)> = Vec::new();
    for field in &FIELDS {
        let Some(v) = p.get(field.key) else { continue };
        let now = read_value(field, cur.values.get(field.prop));
        let want = normalize(field, v, &now)?;
        if want == now {
            continue;
        }
        owned.push(field.prop);
        props.extend(to_out(field, &want).map(|o| (field.prop.to_string(), o)));
    }
    if owned.is_empty() {
        return Ok(xmp);
    }
    let rules = MergeRules { owned: &owned, owned_if_present: &[], namespaces: &EXTRA_NAMESPACES };
    merge_xmp(&xmp, &packet(&props), rules).map_err(|e| bad(format!("the document's XMP packet cannot take these File Info fields: {e}")))
}

/// Photoshop's (and ExifTool's) words for the EXIF orientation codes.
fn orientation_name(code: u16) -> &'static str {
    match code {
        1 => "Normal",
        2 => "Mirror horizontal",
        3 => "Rotate 180°",
        4 => "Mirror vertical",
        5 => "Mirror horizontal and rotate 270° CW",
        6 => "Rotate 90° CW",
        7 => "Mirror horizontal and rotate 90° CW",
        8 => "Rotate 270° CW",
        _ => "Unknown",
    }
}

/// The EXIF `Flash` bit field in words: fired or not, the mode, red-eye reduction.
pub fn flash_text(raw: u16) -> String {
    if raw & 0x20 != 0 {
        return "No flash function".into();
    }
    let mut parts = vec![if raw & 1 != 0 { "Fired" } else { "Did not fire" }];
    parts.extend(match (raw >> 3) & 3 {
        1 => Some("compulsory"),
        2 => Some("compulsory off"),
        3 => Some("auto mode"),
        _ => None,
    });
    match (raw >> 1) & 3 {
        2 => parts.push("return not detected"),
        3 => parts.push("return detected"),
        _ => {}
    }
    if raw & 0x40 != 0 {
        parts.push("red-eye reduction");
    }
    parts.join(", ")
}

fn bias_text(ev: f64) -> String {
    let r = (ev * 100.0).round() / 100.0;
    let s = format!("{r:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if r > 0.0 { format!("+{s} EV") } else { format!("{s} EV") }
}

fn rational(t: &str) -> Option<f64> {
    let v = match t.split_once('/') {
        Some((a, b)) => {
            let (a, b) = (a.trim().parse::<f64>().ok()?, b.trim().parse::<f64>().ok()?);
            (b != 0.0).then(|| a / b)?
        }
        None => t.trim().parse().ok()?,
    };
    v.is_finite().then_some(v)
}

/// Camera Data beyond upstream's nine, from the EXIF block, else the XMP copies.
fn camera_more(exif: Option<&[u8]>, x: &XmpData) -> serde_json::Map<String, Value> {
    let e = exif.map(craft_metadata::read_exif).unwrap_or_default();
    let rows = exif.map(|e| craft_metadata::file_tag_rows(craft_metadata::strip_exif_header(e))).unwrap_or_default();
    let xt = |p: &str| x.values.get(p).and_then(XmpValue::text).filter(|t| !t.is_empty()).map(str::to_string);
    let code = |v: Option<u16>, p: &str| v.or_else(|| xt(p).and_then(|t| t.parse().ok()));
    let program =
        code(e.exposure_program, "exif:ExposureProgram").and_then(|c| Metadata { exposure_program: Some(c), ..Default::default() }.exposure_program_name());
    let metering = code(e.metering_mode, "exif:MeteringMode").and_then(|c| Metadata { metering_mode: Some(c), ..Default::default() }.metering_name());
    let flash = e.flash.map(|f| flash_text(f.raw)).or_else(|| {
        let fired = x.properties.get("exif:Flash/exif:Fired")?.first()?.trim().eq_ignore_ascii_case("true");
        Some(if fired { "Fired" } else { "Did not fire" }.to_string())
    });
    let bias = e.exposure_bias.or_else(|| xt("exif:ExposureBiasValue").and_then(|t| rational(&t))).filter(|b| b.is_finite()).map(bias_text);
    let white = code(e.white_balance, "exif:WhiteBalance").map(|w| if w == 0 { "Auto" } else { "Manual" });
    let date_time = rows.iter().find(|r| r.group == "TIFF" && r.tag == 0x0132).map(|r| r.value.clone()).or_else(|| xt("tiff:DateTime"));
    let dims = match (e.width, e.height) {
        (Some(w), Some(h)) => Some(format!("{w} × {h}")),
        _ => xt("exif:PixelXDimension").zip(xt("exif:PixelYDimension")).map(|(w, h)| format!("{w} × {h}")),
    };
    let orientation = code(e.orientation.map(|o| o.to_exif()), "tiff:Orientation").map(orientation_name);
    let values = [
        program.map(str::to_string),
        metering.map(str::to_string),
        flash,
        bias,
        white.map(str::to_string),
        e.lens_make.or_else(|| xt("exifEX:LensMake")),
        e.serial_number.or_else(|| xt("exifEX:BodySerialNumber")).or_else(|| xt("aux:SerialNumber")),
        e.software,
        date_time,
        dims,
        orientation.map(str::to_string),
    ];
    let mut m = serde_json::Map::new();
    for ((key, _), v) in CAMERA_MORE.into_iter().zip(values) {
        if let Some(v) = v.map(|v| v.trim().chars().take(200).collect::<String>()).filter(|v| !v.is_empty()) {
            m.insert(key.into(), json!(v));
        }
    }
    m
}

fn degrees(v: f64, pos: char, neg: char) -> String {
    let hemi = if v < 0.0 { neg } else { pos };
    let a = v.abs();
    let d = a.floor();
    let m = ((a - d) * 60.0).floor();
    let s = (a - d - m / 60.0) * 3600.0;
    format!("{}° {}′ {:.2}″ {hemi}", d as i64, m as i64, s)
}

/// GPS Data from the EXIF GPS IFD, else XMP's `exif:GPS*`.
fn gps(exif: Option<&[u8]>, x: &XmpData) -> serde_json::Map<String, Value> {
    let e = exif.map(craft_metadata::read_exif).unwrap_or_default();
    let rows = exif.map(|e| craft_metadata::file_tag_rows(craft_metadata::strip_exif_header(e))).unwrap_or_default();
    let row = |tag: u16| rows.iter().find(|r| r.group == "GPS" && r.tag == tag).map(|r| r.value.trim().to_string()).filter(|v| !v.is_empty());
    let xt = |p: &str| x.values.get(p).and_then(XmpValue::text).filter(|t| !t.is_empty()).map(str::to_string);
    let pos = e.gps.map(|g| (g.latitude, g.longitude, g.altitude)).or_else(|| {
        let (lat, lon) = craft_metadata::parse_gps_position(&xt("exif:GPSLatitude")?, &xt("exif:GPSLongitude")?)?;
        let alt = xt("exif:GPSAltitude").and_then(|a| rational(&a)).map(|a| if xt("exif:GPSAltitudeRef").as_deref() == Some("1") { -a } else { a });
        Some((lat, lon, alt))
    });
    let time = match (row(0x001d), row(0x0007)) {
        (Some(d), Some(t)) => Some(format!("{d} {t} UTC")),
        (d, t) => d.or(t).or_else(|| xt("exif:GPSTimeStamp")),
    };
    let with_ref = |value: u16, reference: u16| {
        row(value).map(|v| match row(reference).as_deref() {
            Some("T") => format!("{v} (true north)"),
            Some("M") => format!("{v} (magnetic north)"),
            _ => v,
        })
    };
    let values = [
        pos.map(|p| degrees(p.0, 'N', 'S')),
        pos.map(|p| degrees(p.1, 'E', 'W')),
        pos.and_then(|p| p.2).filter(|a| a.is_finite()).map(|a| format!("{} m", (a * 10.0).round() / 10.0)),
        time,
        with_ref(0x0011, 0x0010).or_else(|| xt("exif:GPSImgDirection").and_then(|d| rational(&d)).map(|d| format!("{d}°"))),
        row(0x000d),
        row(0x0012).or_else(|| xt("exif:GPSMapDatum")),
    ];
    let mut m = serde_json::Map::new();
    for ((key, _), v) in GPS_FIELDS.into_iter().zip(values) {
        if let Some(v) = v.map(|v| v.chars().take(200).collect::<String>()) {
            m.insert(key.into(), json!(v));
        }
    }
    m
}

/// The flattened properties of one namespace, as `{name: text}` (Audio/Video Data, DICOM).
fn namespace(x: &XmpData, ns: &str) -> serde_json::Map<String, Value> {
    let pre = format!("{ns}:");
    x.properties
        .iter()
        .filter(|(k, v)| k.starts_with(&pre) && v.iter().any(|t| !t.trim().is_empty()))
        .take(500)
        .map(|(k, v)| (k[pre.len()..].to_string(), json!(v.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("; "))))
        .collect()
}

/// Adds Pigment's keys and read-outs to upstream's File Info result `info`.
pub fn read(info: &mut Value, doc: &Document) {
    let Value::Object(m) = info else { return };
    let xmp = doc.metadata.xmp.as_deref();
    let x = parse(xmp);
    for field in &FIELDS {
        m.insert(field.key.into(), read_value(field, x.values.get(field.prop)));
    }
    for (key, prop) in READ_OUTS {
        m.insert(key.into(), json!(x.values.get(prop).and_then(XmpValue::text).unwrap_or_default()));
    }
    let exif = doc.metadata.exif.as_deref().map(Vec::as_slice);
    if let Some(Value::Object(camera)) = m.get_mut("camera") {
        camera.extend(camera_more(exif, &x));
    }
    m.insert("gps".into(), Value::Object(gps(exif, &x)));
    let raw = xmp.unwrap_or_default();
    let cut = (0..=raw.len().min(MAX_RAW)).rev().find(|&i| raw.is_char_boundary(i)).unwrap_or(0);
    m.insert("raw".into(), json!(&raw[..cut]));
    if cut < raw.len() {
        m.insert("rawTruncated".into(), json!(true));
    }
    let history = x.values.get("photoshop:History").and_then(XmpValue::text).unwrap_or_default();
    m.insert("history".into(), json!(history));
    m.insert("dynamicMedia".into(), Value::Object(namespace(&x, "xmpDM")));
    m.insert("dicom".into(), Value::Object(namespace(&x, "DICOM")));
}
