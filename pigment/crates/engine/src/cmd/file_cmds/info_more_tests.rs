//! Pigment (F1): File Info's Origin, IPTC, IPTC Extension, GPS Data and Raw Data, the rating, the
//! fuller Camera Data and IPTC-IIM (resource 1028).

use std::sync::Arc;

use super::*;
use crate::Session;

fn session() -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    s
}

fn info(s: &mut Session) -> Value {
    s.execute("file.fileInfo", json!({})).unwrap()
}

fn past(s: &Session) -> usize {
    s.active().unwrap().history.past_len()
}

/// A value for every Pigment key, as the command reads it back.
fn every_field() -> Value {
    let mut all = json!({
        "rating": 4,
        "descriptionWriter": "Theo",
        "dateCreated": "1889-06-18",
        "city": "Saint-Rémy-de-Provence",
        "state": "Provence",
        "country": "France",
        "credit": "MoMA",
        "source": "Scan 12",
        "headline": "Starry Night",
        "instructions": "Do not crop",
        "transmissionReference": "JOB-7",
        "urgency": 2,
    });
    let more = json!({
        "creatorContactInfo": {"CiAdrExtadr": "Rue 1", "CiAdrCity": "Arles", "CiAdrRegion": "Bouches-du-Rhône", "CiAdrPcode": "13200", "CiAdrCtry": "France", "CiTelWork": "+33 1", "CiEmailWork": "v@example.com", "CiUrlWork": "https://example.com"},
        "subjectCode": ["01000000", "01001000"],
        "intellectualGenre": "Landscape",
        "scene": ["011100"],
        "sublocation": "Asylum",
        "countryCode": "FR",
        "usageTerms": "Editorial only",
        "altText": "A night sky over a village",
        "extDescrAccessibility": "Swirling stars",
    });
    let rest = json!({
        "personInImage": ["Nobody", "Smith, Ann"],
        "locationShown": [{"City": "Saint-Rémy", "CountryCode": "FR"}, {"City": "Arles", "WorldRegion": "Europe"}],
        "locationCreated": [{"Sublocation": "Room", "ProvinceState": "Provence", "CountryName": "France"}],
        "organisationInImageName": ["Asylum"],
        "organisationInImageCode": ["A1"],
        "event": "Stay",
        "modelReleaseStatus": "http://ns.useplus.org/ldf/vocab/MR-NON",
        "modelReleaseId": ["MR1"],
        "propertyReleaseStatus": "http://ns.useplus.org/ldf/vocab/PR-NON",
        "propertyReleaseId": ["PR1", "PR2"],
        "modelAge": ["30"],
        "additionalModelInfo": "none",
        "licensor": [{"LicensorName": "Agency", "LicensorID": "L1", "LicensorTelephone1": "+1", "LicensorEmail": "a@example.com", "LicensorURL": "https://a.example.com"}],
        "imageSupplier": [{"ImageSupplierName": "Supplier", "ImageSupplierID": "S1"}],
        "imageCreator": [{"ImageCreatorName": "Vincent", "ImageCreatorID": "V1"}],
        "copyrightOwner": [{"CopyrightOwnerName": "MoMA", "CopyrightOwnerID": "M1"}],
        "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture",
        "maxAvailWidth": 7360,
        "maxAvailHeight": 5826,
        "registryId": [{"RegItemId": "472.1941", "RegOrgId": "MoMA"}],
        "artworkOrObject": [{"AOTitle": "The Starry Night", "AOCreator": "Vincent; Theo", "AODateCreated": "1889", "AOSource": "MoMA", "AOSourceInvNo": "472.1941", "AOCopyrightNotice": "Public domain"}],
        "imageSupplierImageId": "IMG-1",
        "minorModelAgeDisclosure": "http://ns.useplus.org/ldf/vocab/AG-UNK"
    });
    let m = all.as_object_mut().unwrap();
    m.extend(more.as_object().unwrap().clone());
    m.extend(rest.as_object().unwrap().clone());
    all
}

#[test]
fn every_field_reads_back_as_set_and_is_one_history_step() {
    let mut s = session();
    let before = past(&s);
    let all = every_field();
    s.execute("file.fileInfo", all.clone()).unwrap();
    assert_eq!(past(&s), before + 1, "one step");
    assert_eq!(s.active().unwrap().history.undo_label(), Some("File Info"));
    let read = info(&mut s);
    for (key, want) in all.as_object().unwrap() {
        assert_eq!(&read[key], want, "{key}");
    }
    assert_eq!(info_more::FIELDS.len(), all.as_object().unwrap().len(), "the test sets every key");
    // The written packet parses, and through .pigment's own XMP and PSD the fields survive.
    let xmp = doc_xmp(&s);
    craft_metadata::parse_xmp_with(&xmp, &photocraft_io::file_info_xmp::EXTRA_NAMESPACES).unwrap();
    let psd = photocraft_io::export(&s.active().unwrap().doc, "x.psd", &Default::default()).unwrap().bytes;
    let back = photocraft_io::import("x.psd", &psd).unwrap().document;
    let mut s2 = Session::new();
    open_bytes_as(&mut s2, "x.psd", &psd, None, None).unwrap();
    let read2 = info(&mut s2);
    for (key, want) in all.as_object().unwrap() {
        assert_eq!(&read2[key], want, "{key} after PSD");
    }
    assert_eq!(back.metadata.xmp.as_deref(), Some(xmp.as_str()));
    // Undo takes all of them away, redo brings them back.
    assert!(s.undo());
    assert_eq!(info(&mut s)["headline"], "");
    assert!(s.redo());
    assert_eq!(info(&mut s)["headline"], "Starry Night");
}

fn doc_xmp(s: &Session) -> String {
    s.active().unwrap().doc.metadata.xmp.as_deref().unwrap_or_default().to_string()
}

#[test]
fn unknown_properties_survive_and_unchanged_fields_leave_the_packet_alone() {
    let mut s = session();
    let foreign = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" crs:Exposure2012="+0.50" photoshop:Headline="Old"><photoshop:City>Arles</photoshop:City></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>"#;
    Arc::make_mut(&mut s.active_mut().unwrap().doc).metadata.xmp = Some(Arc::from(foreign));
    assert_eq!(info(&mut s)["headline"], "Old");
    assert_eq!(info(&mut s)["city"], "Arles");
    // The dialog sends every field: only the changed one is rewritten.
    let mut all = info(&mut s);
    all["headline"] = json!("New");
    s.execute("file.fileInfo", all).unwrap();
    let xmp = doc_xmp(&s);
    let parsed = craft_metadata::parse_xmp(&xmp).unwrap();
    assert_eq!(parsed.values["crs:Exposure2012"].text(), Some("+0.50"), "{xmp}");
    assert_eq!(parsed.values["photoshop:Headline"].text(), Some("New"));
    assert_eq!(parsed.values["photoshop:City"].text(), Some("Arles"));
    assert_eq!(xmp.matches("<photoshop:Headline>").count(), 1, "replaced, not duplicated: {xmp}");
    assert!(!xmp.contains("photoshop:Headline=\""), "the attribute form is gone: {xmp}");
    // Sending the same values again changes nothing in the packet.
    let all = info(&mut s);
    s.execute("file.fileInfo", all).unwrap();
    assert_eq!(doc_xmp(&s), xmp);
    // Clearing a field removes it.
    s.execute("file.fileInfo", json!({"city": ""})).unwrap();
    assert!(!craft_metadata::parse_xmp(&doc_xmp(&s)).unwrap().values.contains_key("photoshop:City"));
    // Upstream's keys still work beside Pigment's in one call.
    s.execute("file.fileInfo", json!({"title": "T", "credit": "C"})).unwrap();
    let r = info(&mut s);
    assert_eq!((r["title"].as_str(), r["credit"].as_str(), r["headline"].as_str()), (Some("T"), Some("C"), Some("New")));
}

#[test]
fn rating_and_urgency_are_clamped_and_lists_take_text() {
    let mut s = session();
    s.execute("file.fileInfo", json!({"rating": 7, "urgency": 12, "personInImage": "Ann; Smith, Bo ;", "maxAvailWidth": "640"})).unwrap();
    let r = info(&mut s);
    assert_eq!(r["rating"], 5);
    assert_eq!(r["urgency"], 8);
    assert_eq!(r["personInImage"], json!(["Ann", "Smith, Bo"]));
    assert_eq!(r["maxAvailWidth"], 640);
    s.execute("file.fileInfo", json!({"rating": -3})).unwrap();
    assert_eq!(info(&mut s)["rating"], -1, "rejected is the lowest");
    s.execute("file.fileInfo", json!({"rating": 0})).unwrap();
    assert!(!doc_xmp(&s).contains("xmp:Rating"), "unrated writes no rating");
    for bad in [json!({"rating": "lots"}), json!({"personInImage": {"a": 1}}), json!({"locationShown": 3}), json!({"creatorContactInfo": "x"})] {
        let err = s.execute("file.fileInfo", bad.clone()).unwrap_err();
        assert!(err.to_string().contains("file.fileInfo"), "{bad}: {err}");
    }
}

#[test]
fn one_object_edits_the_first_item_of_a_list_of_structures() {
    let mut s = session();
    s.execute("file.fileInfo", json!({"locationShown": [{"City": "Arles"}, {"City": "Paris"}]})).unwrap();
    s.execute("file.fileInfo", json!({"locationShown": {"City": "Nîmes", "CountryCode": "FR", "Unknown": "x"}})).unwrap();
    assert_eq!(info(&mut s)["locationShown"], json!([{"City": "Nîmes", "CountryCode": "FR"}, {"City": "Paris"}]));
    s.execute("file.fileInfo", json!({"locationShown": {"City": ""}})).unwrap();
    assert_eq!(info(&mut s)["locationShown"], json!([{"City": "Paris"}]));
    s.execute("file.fileInfo", json!({"licensor": {"LicensorName": "Agency"}})).unwrap();
    assert_eq!(info(&mut s)["licensor"], json!([{"LicensorName": "Agency"}]));
}

/// Review FU: editing a structure in File Info rewrote it from the fields File Info shows, so a
/// location's GPS position, name and identifier, a licensor's address and the items File Info
/// cannot show were lost.
#[test]
fn editing_a_structure_keeps_its_fields_and_items_file_info_does_not_show() {
    let mut s = session();
    let packet = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""
      xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:plus="http://ns.useplus.org/ldf/xmp/1.0/">
     <Iptc4xmpExt:LocationShown><rdf:Bag>
      <rdf:li rdf:parseType="Resource"><Iptc4xmpExt:City>Arles</Iptc4xmpExt:City><exif:GPSLatitude>43,40.6N</exif:GPSLatitude><exif:GPSLongitude>4,37.8E</exif:GPSLongitude><Iptc4xmpExt:LocationName><rdf:Alt><rdf:li xml:lang="x-default">Place du Forum</rdf:li></rdf:Alt></Iptc4xmpExt:LocationName></rdf:li>
      <rdf:li rdf:parseType="Resource"><Iptc4xmpExt:LocationId><rdf:Bag><rdf:li>https://sws.geonames.org/3037854/</rdf:li></rdf:Bag></Iptc4xmpExt:LocationId></rdf:li>
     </rdf:Bag></Iptc4xmpExt:LocationShown>
     <plus:Licensor><rdf:Seq><rdf:li rdf:parseType="Resource"><plus:LicensorName>Agency</plus:LicensorName><plus:LicensorCity>Lyon</plus:LicensorCity></rdf:li></rdf:Seq></plus:Licensor>
     <Iptc4xmpCore:CreatorContactInfo rdf:parseType="Resource"><Iptc4xmpCore:CiAdrCity>Arles</Iptc4xmpCore:CiAdrCity><Iptc4xmpCore:CiTelCell>+33 6</Iptc4xmpCore:CiTelCell></Iptc4xmpCore:CreatorContactInfo>
    </rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>"#;
    Arc::make_mut(&mut s.active_mut().unwrap().doc).metadata.xmp = Some(Arc::from(packet));
    // File Info shows the first location only; the second has no field it edits.
    assert_eq!(info(&mut s)["locationShown"], json!([{"City": "Arles"}]));
    // The dialog's single object, an API caller's whole list, and a plain structure.
    s.execute(
        "file.fileInfo",
        json!({"locationShown": {"City": "Arles (Provence)"}, "licensor": [{"LicensorName": "Agency 2"}], "creatorContactInfo": {"CiAdrCity": "Nîmes"}}),
    )
    .unwrap();
    let xmp = doc_xmp(&s);
    let d = craft_metadata::parse_xmp_with(&xmp, &photocraft_io::file_info_xmp::EXTRA_NAMESPACES).unwrap();
    let shown = d.values["Iptc4xmpExt:LocationShown"].items();
    assert_eq!(shown.len(), 2, "{xmp}");
    let text = |v: &craft_metadata::XmpValue, k: &str| v.field(k).and_then(craft_metadata::XmpValue::text).map(str::to_owned);
    assert_eq!(text(&shown[0], "Iptc4xmpExt:City").as_deref(), Some("Arles (Provence)"));
    assert_eq!(text(&shown[0], "exif:GPSLatitude").as_deref(), Some("43,40.6N"), "{xmp}");
    assert_eq!(text(&shown[0], "exif:GPSLongitude").as_deref(), Some("4,37.8E"));
    assert_eq!(text(&shown[0], "Iptc4xmpExt:LocationName").as_deref(), Some("Place du Forum"));
    assert!(xmp.contains("<Iptc4xmpExt:LocationName><rdf:Alt>"), "a language alternative stays one: {xmp}");
    assert_eq!(text(&shown[1], "Iptc4xmpExt:LocationId").as_deref(), Some("https://sws.geonames.org/3037854/"), "{xmp}");
    let licensor = &d.values["plus:Licensor"].items()[0];
    assert_eq!(text(licensor, "plus:LicensorName").as_deref(), Some("Agency 2"));
    assert_eq!(text(licensor, "plus:LicensorCity").as_deref(), Some("Lyon"), "{xmp}");
    let contact = &d.values["Iptc4xmpCore:CreatorContactInfo"];
    assert_eq!(text(contact, "Iptc4xmpCore:CiAdrCity").as_deref(), Some("Nîmes"));
    assert_eq!(text(contact, "Iptc4xmpCore:CiTelCell").as_deref(), Some("+33 6"), "{xmp}");
    // Clearing the shown fields of the first location removes it, the hidden one stays.
    s.execute("file.fileInfo", json!({"locationShown": {"City": ""}})).unwrap();
    let d = craft_metadata::parse_xmp_with(&doc_xmp(&s), &photocraft_io::file_info_xmp::EXTRA_NAMESPACES).unwrap();
    let shown = d.values["Iptc4xmpExt:LocationShown"].items();
    assert_eq!(shown.len(), 1);
    assert!(shown[0].field("Iptc4xmpExt:LocationId").is_some());
}

#[test]
fn read_outs_raw_data_and_the_other_namespaces() {
    let mut s = session();
    let packet = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmp:CreateDate="2024-02-17T12:40:19+01:00" xmp:ModifyDate="2024-02-18T08:00:00" xmp:CreatorTool="Pigment" dc:format="image/vnd.adobe.photoshop" photoshop:History="Opened; Saved" xmpDM:artist="Band" xmpDM:album="Songs"/></rdf:RDF></x:xmpmeta>"#;
    Arc::make_mut(&mut s.active_mut().unwrap().doc).metadata.xmp = Some(Arc::from(packet));
    let r = info(&mut s);
    assert_eq!(r["created"], "2024-02-17T12:40:19+01:00");
    assert_eq!(r["modified"], "2024-02-18T08:00:00");
    assert_eq!(r["application"], "Pigment");
    assert_eq!(r["format"], "image/vnd.adobe.photoshop");
    assert_eq!(r["history"], "Opened; Saved");
    assert_eq!(r["dynamicMedia"], json!({"album": "Songs", "artist": "Band"}));
    assert_eq!(r["dicom"], json!({}));
    assert_eq!(r["raw"], packet);
    assert_eq!(r["gps"], json!({}));
    // Read-only keys sent back are no edit.
    let before = past(&s);
    s.execute("file.fileInfo", json!({"raw": "x", "created": "y", "gps": {}})).unwrap();
    assert_eq!(past(&s), before);
    assert_eq!(doc_xmp(&s), packet);
}

// ---------- EXIF ----------

/// One IFD entry: (tag, type, count, value bytes).
type Entry = (u16, u16, u32, Vec<u8>);

fn ascii(tag: u16, s: &str) -> Entry {
    let mut b = s.as_bytes().to_vec();
    b.push(0);
    (tag, 2, b.len() as u32, b)
}
fn short(tag: u16, v: u16) -> Entry {
    (tag, 3, 1, v.to_be_bytes().to_vec())
}
fn long(tag: u16, v: u32) -> Entry {
    (tag, 4, 1, v.to_be_bytes().to_vec())
}
fn rationals(tag: u16, vs: &[(u32, u32)]) -> Entry {
    (tag, 5, vs.len() as u32, vs.iter().flat_map(|(a, b)| [a.to_be_bytes(), b.to_be_bytes()].concat()).collect())
}
fn srational(tag: u16, a: i32, b: i32) -> Entry {
    (tag, 10, 1, [a.to_be_bytes(), b.to_be_bytes()].concat())
}
fn bytes(tag: u16, v: &[u8]) -> Entry {
    (tag, 1, v.len() as u32, v.to_vec())
}

/// A big-endian TIFF (EXIF block) of IFD0 with its EXIF and GPS IFDs.
fn tiff(ifd0: Vec<Entry>, exif: Vec<Entry>, gps: Vec<Entry>) -> Vec<u8> {
    let size = |n: usize| 2 + 12 * n + 4;
    // IFD0 gains the two pointers.
    let n0 = ifd0.len() + 2;
    let (at0, at_exif) = (8usize, 8 + size(n0));
    let at_gps = at_exif + size(exif.len());
    let mut data_at = at_gps + size(gps.len());
    let mut ifd0 = ifd0;
    ifd0.push(long(0x8769, at_exif as u32));
    ifd0.push(long(0x8825, at_gps as u32));
    let mut out = b"MM\0\x2a".to_vec();
    out.extend_from_slice(&(at0 as u32).to_be_bytes());
    let mut data = Vec::new();
    for mut ifd in [ifd0, exif, gps] {
        ifd.sort_by_key(|e| e.0);
        out.extend_from_slice(&(ifd.len() as u16).to_be_bytes());
        for (tag, ty, count, v) in ifd {
            out.extend_from_slice(&tag.to_be_bytes());
            out.extend_from_slice(&ty.to_be_bytes());
            out.extend_from_slice(&count.to_be_bytes());
            if v.len() <= 4 {
                let mut inline = v.clone();
                inline.resize(4, 0);
                out.extend_from_slice(&inline);
            } else {
                out.extend_from_slice(&(data_at as u32).to_be_bytes());
                let mut v = v;
                if v.len() % 2 == 1 {
                    v.push(0);
                }
                data_at += v.len();
                data.extend_from_slice(&v);
            }
        }
        out.extend_from_slice(&0u32.to_be_bytes());
    }
    out.extend_from_slice(&data);
    out
}

/// The 17 EXIF tags the JavaScript Pigment read, a serial number, pixel size and orientation, and GPS.
fn camera_exif() -> Vec<u8> {
    tiff(
        vec![ascii(0x010f, "Canon"), ascii(0x0110, "Canon EOS R5"), short(0x0112, 6), ascii(0x0131, "Firmware 1.8"), ascii(0x0132, "2024:02:18 08:00:00")],
        vec![
            rationals(0x829a, &[(1, 250)]),
            rationals(0x829d, &[(28, 10)]),
            short(0x8822, 3),
            short(0x8827, 400),
            ascii(0x9003, "2024:02:17 12:40:19"),
            srational(0x9204, -2, 3),
            short(0x9207, 5),
            short(0x9209, 0x59),
            rationals(0x920a, &[(50, 1)]),
            long(0xa002, 6000),
            long(0xa003, 4000),
            short(0xa403, 1),
            short(0xa405, 75),
            ascii(0xa431, "0123456"),
            ascii(0xa433, "Canon"),
            ascii(0xa434, "RF50mm F1.8 STM"),
        ],
        vec![
            bytes(0x0000, &[2, 3, 0, 0]),
            ascii(0x0001, "N"),
            rationals(0x0002, &[(48, 1), (51, 1), (2960, 100)]),
            ascii(0x0003, "E"),
            rationals(0x0004, &[(2, 1), (17, 1), (4000, 100)]),
            bytes(0x0005, &[0]),
            rationals(0x0006, &[(355, 10)]),
            rationals(0x0007, &[(11, 1), (40, 1), (19, 1)]),
            ascii(0x0010, "T"),
            rationals(0x0011, &[(90, 1)]),
            ascii(0x001d, "2024:02:17"),
        ],
    )
}

#[test]
fn camera_data_has_the_javascript_tags_and_gps() {
    let mut s = session();
    let mut exif = b"Exif\0\0".to_vec();
    exif.extend(camera_exif());
    Arc::make_mut(&mut s.active_mut().unwrap().doc).metadata.exif = Some(Arc::new(exif));
    let r = info(&mut s);
    let c = &r["camera"];
    let want = [
        ("make", "Canon"),
        ("model", "Canon EOS R5"),
        ("dateTaken", "2024-02-17 12:40:19"),
        ("exposure", "1/250 s"),
        ("fNumber", "f/2.8"),
        ("iso", "ISO 400"),
        ("focalLength", "50 mm"),
        ("focalLength35mm", "75 mm"),
        ("lens", "RF50mm F1.8 STM"),
        ("program", "Aperture-priority AE"),
        ("metering", "Pattern"),
        ("flash", "Fired, auto mode, red-eye reduction"),
        ("exposureBias", "-0.67 EV"),
        ("whiteBalance", "Manual"),
        ("lensMake", "Canon"),
        ("serialNumber", "0123456"),
        ("software", "Firmware 1.8"),
        ("pixelDimensions", "6000 × 4000"),
        ("orientation", "Rotate 90° CW"),
    ];
    for (key, value) in want {
        assert_eq!(c[key], value, "{key}: {c}");
    }
    assert!(c["dateTime"].as_str().is_some_and(|d| d.contains("2024")), "{c}");
    let g = &r["gps"];
    assert_eq!(g["latitude"], "48° 51′ 29.60″ N", "{g}");
    assert_eq!(g["longitude"], "2° 17′ 40.00″ E");
    assert_eq!(g["altitude"], "35.5 m");
    assert!(g["time"].as_str().is_some_and(|t| t.contains("2024") && t.ends_with("UTC")), "{g}");
    assert!(g["direction"].as_str().is_some_and(|d| d.contains("true north")), "{g}");
    // Upstream's nine come first, as before.
    let keys: Vec<&str> = c.as_object().unwrap().keys().map(String::as_str).collect();
    assert!(keys.len() >= 20, "{keys:?}");
}

#[test]
fn flash_words() {
    assert_eq!(info_more::flash_text(0), "Did not fire");
    assert_eq!(info_more::flash_text(0x01), "Fired");
    assert_eq!(info_more::flash_text(0x10), "Did not fire, compulsory off");
    assert_eq!(info_more::flash_text(0x0f), "Fired, compulsory, return detected");
    assert_eq!(info_more::flash_text(0x20), "No flash function");
}

// ---------- IPTC-IIM ----------

fn iim_of(s: &Session) -> Option<Vec<u8>> {
    s.active().unwrap().doc.metadata.psd_resources.iter().find(|(id, _, _)| *id == 1028).map(|(_, _, d)| d.to_vec())
}

#[test]
fn file_info_writes_iim_that_parse_iptc_reads_back_in_utf8() {
    let mut s = session();
    s.execute(
        "file.fileInfo",
        json!({"title": "Nuit étoilée", "author": "Vincent; Théo", "keywords": ["étoiles", "nuit"], "copyright": "© MoMA", "description": "Huile sur toile",
               "headline": "Ciel", "city": "Saint-Rémy", "state": "Provence", "country": "France", "countryCode": "FR", "sublocation": "Asile",
               "credit": "MoMA", "source": "Scan", "instructions": "Ne pas recadrer", "transmissionReference": "J7", "urgency": 3,
               "descriptionWriter": "Théo", "authorTitle": "Peintre", "dateCreated": "1889-06-18T10:30:00+02:00"}),
    )
    .unwrap();
    let iim = iim_of(&s).expect("resource 1028");
    let m = craft_metadata::parse_iptc(&iim);
    assert_eq!(m.title.as_deref(), Some("Nuit étoilée"));
    // craft-metadata keeps the last By-line of several.
    assert_eq!(m.artist.as_deref(), Some("Théo"));
    assert_eq!(m.keywords, ["étoiles", "nuit"]);
    assert_eq!(m.copyright.as_deref(), Some("© MoMA"));
    assert_eq!(m.caption.as_deref(), Some("Huile sur toile"));
    assert_eq!(m.capture_time.map(|d| (d.year, d.month, d.day)), Some((1889, 6, 18)));
    let all = photocraft_io::iptc_iim::decode(&iim);
    let want: [(u8, &str); 19] = [
        (5, "Nuit étoilée"),
        (10, "3"),
        (25, "étoiles"),
        (25, "nuit"),
        (40, "Ne pas recadrer"),
        (55, "18890618"),
        (60, "103000+0200"),
        (80, "Vincent"),
        (80, "Théo"),
        (85, "Peintre"),
        (90, "Saint-Rémy"),
        (92, "Asile"),
        (95, "Provence"),
        (100, "FR"),
        (101, "France"),
        (103, "J7"),
        (105, "Ciel"),
        (110, "MoMA"),
        (115, "Scan"),
    ];
    for (ds, text) in want {
        assert!(all.iter().any(|(d, t)| *d == ds && t == text), "2:{ds} {text} in {all:?}");
    }
    assert!(all.iter().any(|(d, t)| *d == 116 && t == "© MoMA") && all.iter().any(|(d, t)| *d == 122 && t == "Théo"));
    // A field that IIM does not hold leaves 1028 as it is.
    s.execute("file.fileInfo", json!({"event": "Stay"})).unwrap();
    assert_eq!(iim_of(&s), Some(iim.clone()));
    // Undo puts the old resource back with the packet.
    s.execute("file.fileInfo", json!({"headline": "Nuit"})).unwrap();
    assert_ne!(iim_of(&s), Some(iim.clone()));
    assert!(s.undo());
    assert_eq!(iim_of(&s), Some(iim));
}

#[test]
fn a_jpeg_with_only_iim_seeds_the_fields_and_exports_them_again() {
    let mut iim = Vec::new();
    for (ds, text) in [(5u8, &b"Old title"[..]), (25, b"one"), (25, b"two"), (80, b"Ann"), (105, b"Headline"), (90, b"Arles"), (15, b"ART")] {
        iim.extend_from_slice(&[0x1c, 2, ds]);
        iim.extend_from_slice(&(text.len() as u16).to_be_bytes());
        iim.extend_from_slice(text);
    }
    let mut src = Session::new();
    src.execute("file.new", json!({"width": 8, "height": 8})).unwrap();
    let plain = photocraft_io::export(&src.active().unwrap().doc, "a.jpg", &Default::default()).unwrap().bytes;
    let jpeg = photocraft_io::iptc_iim::insert_app13(&plain, &iim);
    let mut s = Session::new();
    open_bytes_as(&mut s, "old.jpg", &jpeg, None, None).unwrap();
    let r = info(&mut s);
    assert_eq!(r["title"], "Old title");
    assert_eq!(r["keywords"], json!(["one", "two"]));
    assert_eq!(r["author"], "Ann");
    assert_eq!(r["headline"], "Headline");
    assert_eq!(r["city"], "Arles");
    // Editing keeps the unmapped dataset 2:15.
    s.execute("file.fileInfo", json!({"headline": "New"})).unwrap();
    let iim2 = iim_of(&s).unwrap();
    let ds = photocraft_io::iptc_iim::decode(&iim2);
    assert!(ds.contains(&(15, "ART".into())) && ds.contains(&(105, "New".into())), "{ds:?}");
    // A JPEG export with its metadata carries it in APP13.
    let out = photocraft_io::export(&s.active().unwrap().doc, "b.jpg", &Default::default()).unwrap().bytes;
    let e = craft_metadata::jpeg_segments(&out);
    assert_eq!(e.iptc.as_deref(), Some(iim2.as_slice()));
    let none = photocraft_io::ExportOptions { xmp: photocraft_io::XmpEmbed::None, ..Default::default() };
    let out = photocraft_io::export(&s.active().unwrap().doc, "b.jpg", &none).unwrap().bytes;
    assert!(craft_metadata::jpeg_segments(&out).iptc.is_none(), "Metadata: None leaves it out");
}
