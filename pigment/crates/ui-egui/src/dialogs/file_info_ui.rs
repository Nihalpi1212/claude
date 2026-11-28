//! Pigment: File › File Info… with Photoshop's tabs (F1, rows 33 to 36): Basic (with the Rating stars and Description
//! Writer), Camera Data, Origin, IPTC, IPTC Extension, GPS Data, Raw Data, and Audio/Video Data, DICOM and Photoshop
//! (the history log) when the file has them.
//!
//! It stays upstream's hosted parameter form, so upstream's tests that drive it by key still hold: upstream's eight rows
//! keep their keys (`title`, `author`, `authorTitle`, `description`, `keywords`, `copyrightStatus`, `copyright`,
//! `copyrightUrl`) and its Camera Data rows theirs (`camera/<label>`). A first row draws the tab strip and keeps the
//! shown tab in the `tab` field; every other row is shown while `tab` names its tab. Structures are flat rows with
//! slashed keys (`creatorContactInfo/CiAdrCity`; a list of structures shows its first item), lists of text are one
//! field split on `;`. [`nest`] turns the confirmed fields back into `file.fileInfo`'s params.

use std::borrow::Cow;

use craft::behavior::{DisplayOrder, ItemSource, SelectionChange};
use craft::ui::buttons::Button;
use craft::ui::choice::Rating;
use craft::ui::contract::{Bind, CollectionEvent, Props as _, Show as _, ShowCollection as _, clicked};
use craft::ui::patterns::form_dialogs::{DialogFields, FieldValue, Param, ParamKind};
use craft::ui::runtime::env::Label;
use craft::ui::tabs::{Tab, TabKind, TabStrip};
use photocraft_engine::file_cmds::info_more::{self, CAMERA_MORE, GPS_FIELDS, Kind};
use serde_json::{Map, Value, json};

use crate::PhotocraftApp;

/// The command whose form this is.
pub(crate) const COMMAND: &str = "file.fileInfo";
/// The field of the shown tab (left out of the command's params).
pub(crate) const TAB: &str = "tab";
/// The longest raw packet the Raw Data row shows; Copy copies all the command read.
const RAW_SHOWN: usize = 64 * 1024;

/// The tabs: id and label, in Photoshop's order. The `optional` ones are shown only when the file has their data.
fn tabs() -> [(&'static str, &'static str, bool); 10] {
    [
        ("basic", tl!("Basic"), false),
        ("camera", tl!("Camera Data"), false),
        ("origin", tl!("Origin"), false),
        ("iptc", tl!("IPTC"), false),
        ("iptcExt", tl!("IPTC Extension"), false),
        ("gps", tl!("GPS Data"), false),
        ("audioVideo", tl!("Audio/Video Data"), true),
        ("dicom", tl!("DICOM"), true),
        ("history", tl!("Photoshop"), true),
        ("raw", tl!("Raw Data"), false),
    ]
}

/// The labels of Pigment's text keys, in each tab's order (Photoshop's words).
fn labels() -> [(&'static str, &'static str); 28] {
    [
        ("descriptionWriter", tl!("Description Writer")),
        ("dateCreated", tl!("Date Created")),
        ("city", tl!("City")),
        ("state", tl!("State/Province")),
        ("country", tl!("Country")),
        ("credit", tl!("Credit Line")),
        ("source", tl!("Source")),
        ("headline", tl!("Headline")),
        ("instructions", tl!("Instructions")),
        ("transmissionReference", tl!("Transmission Reference")),
        ("subjectCode", tl!("IPTC Subject Code")),
        ("intellectualGenre", tl!("Intellectual Genre")),
        ("scene", tl!("IPTC Scene Code")),
        ("sublocation", tl!("Sublocation")),
        ("countryCode", tl!("ISO Country Code")),
        ("usageTerms", tl!("Rights Usage Terms")),
        ("altText", tl!("Alt Text (Accessibility)")),
        ("extDescrAccessibility", tl!("Extended Description (Accessibility)")),
        ("personInImage", tl!("Person Shown")),
        ("organisationInImageName", tl!("Organisation Name")),
        ("organisationInImageCode", tl!("Organisation Code")),
        ("event", tl!("Event")),
        ("modelReleaseStatus", tl!("Model Release Status")),
        ("modelReleaseId", tl!("Model Release ID")),
        ("propertyReleaseStatus", tl!("Property Release Status")),
        ("propertyReleaseId", tl!("Property Release ID")),
        ("modelAge", tl!("Model Age")),
        ("additionalModelInfo", tl!("Additional Model Info")),
    ]
}

/// More labels: the rest of the plain keys.
fn more_labels() -> [(&'static str, &'static str); 5] {
    [
        ("digitalSourceType", tl!("Digital Source Type")),
        ("maxAvailWidth", tl!("Max Avail Width")),
        ("maxAvailHeight", tl!("Max Avail Height")),
        ("imageSupplierImageId", tl!("Image Supplier Image ID")),
        ("minorModelAgeDisclosure", tl!("Minor Model Age Disclosure")),
    ]
}

/// The fields of a location (Location Shown, Location Created).
fn location() -> Vec<(&'static str, &'static str)> {
    vec![
        ("Sublocation", tl!("Sublocation")),
        ("City", tl!("City")),
        ("ProvinceState", tl!("State/Province")),
        ("CountryName", tl!("Country")),
        ("CountryCode", tl!("ISO Country Code")),
        ("WorldRegion", tl!("World Region")),
    ]
}

/// The section title of each structure key, and its fields' labels.
fn structures() -> [(&'static str, &'static str, Vec<(&'static str, &'static str)>); 9] {
    let name_id = |name: &'static str, id: &'static str| vec![(name, tl!("Name")), (id, tl!("ID"))];
    [
        (
            "creatorContactInfo",
            tl!("Creator Contact Info"),
            vec![
                ("CiAdrExtadr", tl!("Address")),
                ("CiAdrCity", tl!("City")),
                ("CiAdrRegion", tl!("State/Province")),
                ("CiAdrPcode", tl!("Postal Code")),
                ("CiAdrCtry", tl!("Country")),
                ("CiTelWork", tl!("Phone(s)")),
                ("CiEmailWork", tl!("Email(s)")),
                ("CiUrlWork", tl!("Website(s)")),
            ],
        ),
        ("locationShown", tl!("Location Shown"), location()),
        ("locationCreated", tl!("Location Created"), location()),
        (
            "licensor",
            tl!("Licensor"),
            vec![("LicensorName", tl!("Name")), ("LicensorID", tl!("ID")), ("LicensorTelephone1", tl!("Phone(s)")), ("LicensorEmail", tl!("Email(s)")), ("LicensorURL", tl!("Website(s)"))],
        ),
        ("imageSupplier", tl!("Image Supplier"), name_id("ImageSupplierName", "ImageSupplierID")),
        ("imageCreator", tl!("Image Creator"), name_id("ImageCreatorName", "ImageCreatorID")),
        ("copyrightOwner", tl!("Copyright Owner"), name_id("CopyrightOwnerName", "CopyrightOwnerID")),
        ("registryId", tl!("Registry Entry"), vec![("RegItemId", tl!("Item ID")), ("RegOrgId", tl!("Organisation ID"))]),
        (
            "artworkOrObject",
            tl!("Artwork or Object"),
            vec![
                ("AOTitle", tl!("Title")),
                ("AOCreator", tl!("Creator")),
                ("AODateCreated", tl!("Date Created")),
                ("AOSource", tl!("Source")),
                ("AOSourceInvNo", tl!("Source Inventory Number")),
                ("AOCopyrightNotice", tl!("Copyright Notice")),
            ],
        ),
    ]
}

/// The tab strip's item source: the shown tabs, keyed by position in `ids`.
struct Tabs(Vec<(&'static str, &'static str)>);

impl DisplayOrder<usize> for Tabs {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn key(&self, at: usize) -> usize {
        at
    }
    fn index_of(&self, key: &usize) -> Option<usize> {
        (*key < self.0.len()).then_some(*key)
    }
    fn text(&self, at: usize) -> Option<Cow<'_, str>> {
        self.0.get(at).map(|(_, label)| Cow::Borrowed(*label))
    }
}

impl ItemSource<usize> for Tabs {}

fn tab_row(shown: Vec<(&'static str, &'static str)>) -> Param {
    Param::custom(TAB, Label::from(tl!("File Info")), move |ui, fields, _| {
        // Automation sets a custom row's key as JSON; the rows' `visible_when` compares text.
        if let Some(FieldValue::Json(Value::String(t))) = fields.get(TAB).cloned() {
            fields.set(TAB, t);
        }
        let current = fields.text(TAB).and_then(|t| shown.iter().position(|(id, _)| *id == t)).unwrap_or(0);
        let source = Tabs(shown.clone());
        let strip = TabStrip::new(Label::from(tl!("File Info"))).kind(TabKind::Text).shown(current).show_items(ui, &source, &mut |key, _| {
            Tab::new(Label::from(shown.get(*key).map_or("", |(_, label)| *label)))
        });
        for event in &strip.response.events {
            if let CollectionEvent::Selection(SelectionChange::Set(keys)) = event
                && let Some((id, _)) = keys.last().and_then(|k| shown.get(*k))
            {
                fields.set(TAB, *id);
            }
        }
        strip.response.response.clone()
    })
    .opens_with("basic")
    .full_width()
    .not_remembered()
}

fn rating_row() -> Param {
    Param::custom("rating", Label::from(tl!("Rating")), |ui, fields, _| {
        // −1 (rejected) is kept as it is unless a star is clicked.
        let stored = fields.int("rating").unwrap_or(0);
        let mut stars = stored.clamp(0, 5) as u8;
        let out = Rating::new(Bind::bound(&mut stars), 5).show(ui);
        if i64::from(stars) != stored.max(0) {
            fields.set("rating", i64::from(stars));
        }
        out.response
    })
    .not_remembered()
}

/// `info[key]` as the text a row edits: lists joined with `; `.
fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; "),
        Value::Number(n) if n.as_i64() == Some(0) => String::new(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn label_of(key: &str) -> &'static str {
    labels().into_iter().chain(more_labels()).find(|(k, _)| *k == key).map_or("", |(_, l)| l)
}

/// The form's rows and their values from `file.fileInfo`'s answer.
pub(crate) fn form(app: &mut PhotocraftApp) -> Option<(Vec<Param>, DialogFields)> {
    let info = app.session.execute(COMMAND, json!({})).ok()?;
    let mut fields = DialogFields::default();
    let text = |key: &str| info[key].as_str().unwrap_or_default().to_owned();
    for key in ["title", "author", "authorTitle", "description", "copyright", "copyrightUrl"] {
        fields.set(key, text(key));
    }
    fields.set("keywords", text_of(&info["keywords"]));
    fields.set("copyrightStatus", info["copyrightStatus"].as_str().unwrap_or("unknown"));
    fields.set(TAB, "basic");

    let has = |key: &str| info[key].as_object().is_some_and(|m| !m.is_empty()) || info[key].as_str().is_some_and(|s| !s.is_empty());
    let shown: Vec<(&'static str, &'static str)> = tabs()
        .into_iter()
        .filter(|(id, _, optional)| !optional || has(match *id {
            "audioVideo" => "dynamicMedia",
            other => other,
        }))
        .map(|(id, label, _)| (id, label))
        .collect();
    let mut rows = vec![tab_row(shown)];
    let on = |p: Param, tab: &str| p.visible_when(TAB, tab);

    // Basic: upstream's rows, the stars and Description Writer, and the read-outs.
    rows.push(on(Param::new("title", tl!("Document Title"), ParamKind::text("")), "basic"));
    rows.push(on(Param::new("author", tl!("Author"), ParamKind::text("")), "basic"));
    rows.push(on(Param::new("authorTitle", tl!("Author Title"), ParamKind::text("")), "basic"));
    rows.push(on(Param::new("description", tl!("Description"), ParamKind::text("")).multiline(3), "basic"));
    rows.push(on(rating_row(), "basic"));
    rows.push(on(Param::new("descriptionWriter", tl!("Description Writer"), ParamKind::text("")), "basic"));
    rows.push(on(Param::new("keywords", tl!("Keywords"), ParamKind::text("")).multiline(3), "basic"));
    let status = [("unknown", tl!("Unknown")), ("copyrighted", tl!("Copyrighted")), ("publicDomain", tl!("Public Domain"))];
    let status = status.iter().map(|(id, l)| ((*id).to_owned(), Label::from(*l))).collect();
    rows.push(on(Param::new("copyrightStatus", tl!("Copyright Status"), ParamKind::choice(status, Some("unknown".into()))), "basic"));
    rows.push(on(Param::new("copyright", tl!("Copyright Notice"), ParamKind::text("")).multiline(3), "basic"));
    rows.push(on(Param::new("copyrightUrl", tl!("Copyright Info URL"), ParamKind::text("")), "basic"));
    for (key, label) in [("created", tl!("Created")), ("modified", tl!("Modified")), ("application", tl!("Application")), ("format", tl!("Format"))] {
        if let Some(v) = info[key].as_str().filter(|v| !v.is_empty()) {
            rows.push(on(Param::read_only_text(format!("readout/{key}"), label, v.to_owned()), "basic"));
        }
    }
    fields.set("rating", info["rating"].as_i64().unwrap_or(0));

    // Camera Data: upstream's nine (their keys), then Pigment's.
    let lang = crate::i18n::current();
    let camera = &info["camera"];
    let upstream = photocraft_engine::file_cmds::CAMERA_FIELDS.iter().chain(CAMERA_MORE.iter());
    let mut any = false;
    for (key, label) in upstream {
        if let Some(v) = camera.get(*key).and_then(Value::as_str) {
            any = true;
            rows.push(on(Param::read_only_text(format!("camera/{label}"), crate::i18n::tr_ctx(lang, "cameraData", label), v.to_owned()), "camera"));
        }
    }
    if !any {
        rows.push(on(Param::read_only_text("camera/none", "", tl!("This file has no camera data.")).full_width(), "camera"));
    }

    // The editable Pigment keys, tab by tab, in the engine's order.
    for field in info_more::FIELDS.iter().filter(|f| f.tab != "basic") {
        let tab = field.tab;
        match field.kind {
            Kind::Struct(_) | Kind::StructBag(_) | Kind::StructSeq(_) => {
                let Some((_, title, subs)) = structures().into_iter().find(|(k, _, _)| *k == field.key) else { continue };
                rows.push(on(Param::section(title), tab));
                // A list of structures shows its first item.
                let item = match &info[field.key] {
                    Value::Array(a) => a.first().cloned().unwrap_or(Value::Null),
                    other => other.clone(),
                };
                for (sub, label) in &subs {
                    let key = format!("{}/{sub}", field.key);
                    fields.set(key.clone(), item.get(*sub).and_then(Value::as_str).unwrap_or_default());
                    rows.push(on(Param::new(key, *label, ParamKind::text("")), tab));
                }
                if info[field.key].as_array().is_some_and(|a| a.len() > 1) {
                    let more = crate::i18n::fmt(tl!("The file lists {n} entries; the first one is shown here."), &[("n", &info[field.key].as_array().map_or(0, Vec::len).to_string())]);
                    rows.push(on(Param::read_only_text(format!("{}/more", field.key), "", more).full_width(), tab));
                }
            }
            Kind::Int(..) if field.key == "urgency" => {
                let mut options = vec![("0".to_owned(), Label::from(tl!("None")))];
                for n in 1..=8 {
                    let l = match n {
                        1 => tl!("1 (High)"),
                        5 => tl!("5 (Normal)"),
                        8 => tl!("8 (Low)"),
                        _ => "",
                    };
                    options.push((n.to_string(), Label::from(if l.is_empty() { n.to_string() } else { l.to_owned() })));
                }
                fields.set("urgency", info["urgency"].as_i64().unwrap_or(0).to_string());
                rows.push(on(Param::new("urgency", tl!("Urgency"), ParamKind::choice(options, Some("0".into()))), tab));
            }
            _ => {
                let long = matches!(field.key, "instructions" | "usageTerms" | "altText" | "extDescrAccessibility");
                let mut p = Param::new(field.key, label_of(field.key), ParamKind::text(""));
                if long {
                    p = p.multiline(3);
                }
                fields.set(field.key, text_of(&info[field.key]));
                rows.push(on(p, tab));
            }
        }
    }

    // GPS Data.
    let gps = &info["gps"];
    let mut any = false;
    for (key, label) in GPS_FIELDS {
        if let Some(v) = gps.get(key).and_then(Value::as_str) {
            any = true;
            rows.push(on(Param::read_only_text(format!("gps/{key}"), crate::i18n::tr_ctx(lang, "gpsData", label), v.to_owned()), "gps"));
        }
    }
    if !any {
        rows.push(on(Param::read_only_text("gps/none", "", tl!("This file has no GPS data.")).full_width(), "gps"));
    }

    // Audio/Video Data, DICOM and the history log: what the file holds, as stored.
    for (key, tab) in [("dynamicMedia", "audioVideo"), ("dicom", "dicom")] {
        for (name, v) in info[key].as_object().into_iter().flatten() {
            rows.push(on(Param::read_only_text(format!("{key}/{name}"), name.clone(), v.as_str().unwrap_or_default().to_owned()), tab));
        }
    }
    if let Some(h) = info["history"].as_str().filter(|h| !h.is_empty()) {
        rows.push(on(Param::read_only_text("history/log", tl!("History"), h.to_owned()), "history"));
    }

    // Raw Data: the packet, and Copy.
    let raw = info["raw"].as_str().unwrap_or_default().to_owned();
    let cut = (0..=raw.len().min(RAW_SHOWN)).rev().find(|&i| raw.is_char_boundary(i)).unwrap_or(0);
    let shown = if raw.is_empty() { tl!("This file has no XMP metadata.").to_owned() } else { raw[..cut].to_owned() };
    rows.push(on(Param::read_only_text("raw/packet", "", shown).full_width(), "raw"));
    if !raw.is_empty() {
        rows.push(on(
            Param::custom("raw/copy", Label::from(tl!("Raw Data")), move |ui, _fields, _| {
                let out = Button::new(tl!("Copy")).id_salt("pigment.fileInfo.copyRaw").show(ui);
                if clicked(&out) {
                    ui.ctx().copy_text(raw.clone());
                }
                out.response.clone()
            })
            .not_remembered(),
            "raw",
        ));
    }
    Some((rows, fields))
}

/// The confirmed fields as `file.fileInfo`'s params: no `tab` and no read-only rows, the slashed keys folded into the
/// objects the command takes.
pub(crate) fn nest(map: &mut Map<String, Value>) {
    map.remove(TAB);
    map.retain(|key, _| !["camera/", "gps/", "raw/", "readout/", "history/", "dynamicMedia/", "dicom/"].iter().any(|p| key.starts_with(p)));
    for field in info_more::FIELDS.iter().filter(|f| matches!(f.kind, Kind::Struct(_) | Kind::StructBag(_) | Kind::StructSeq(_))) {
        let prefix = format!("{}/", field.key);
        let keys: Vec<String> = map.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        if keys.is_empty() {
            continue;
        }
        let mut object = Map::new();
        for key in keys {
            if let Some(v) = map.remove(&key)
                && !key.ends_with("/more")
            {
                object.insert(key[prefix.len()..].to_owned(), v);
            }
        }
        map.insert(field.key.to_owned(), Value::Object(object));
    }
}

#[cfg(test)]
#[path = "file_info_ui_tests.rs"]
mod tests;
