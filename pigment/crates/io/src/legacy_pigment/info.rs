//! File Info of a Pigment 0.1–0.4 document (`doc.meta`, `renderer/lib/file-info.js`): title,
//! author, description, copyright, keywords, rating, credit, source, copyright status and URL,
//! and the camera data the app had parsed out of a photograph's EXIF block (`meta.exif`, an
//! object, not the block). They become an XMP packet, which is what File Info and Camera Data
//! read: the properties are the ones `photocraft-engine`'s `file_cmds::info` reads and writes.

use serde_json::{Map, Value};

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // XML 1.0 has no other control characters.
            c if c < ' ' && !matches!(c, '\n' | '\r' | '\t') => {}
            c => out.push(c),
        }
    }
    out
}

/// Text of at most 64 KiB (a field of a dialog, not a document).
fn text(v: Option<&Value>) -> Option<String> {
    let s = match v? {
        Value::String(s) => s.trim_end().to_string(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let s: String = s.chars().take(65_536).collect();
    (!s.trim().is_empty()).then_some(s)
}

/// `parseKeywords` of file-info.js: an array, or "a; b, c"; trimmed, without repeats.
fn keywords(v: Option<&Value>) -> Vec<String> {
    let list: Vec<String> = match v {
        Some(Value::Array(a)) => a.iter().filter_map(|k| k.as_str()).map(str::to_string).collect(),
        Some(Value::String(s)) => s.split([';', ',', '\n']).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<String> = Vec::new();
    for k in list.iter().map(|k| k.trim()).filter(|k| !k.is_empty()).take(4096) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(k)) {
            out.push(k.chars().take(1024).collect());
        }
    }
    out
}

fn number(v: Option<&Value>) -> Option<f64> {
    let n = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// A number as XMP writes rationals and decimals: no exponent, no trailing zeros.
fn decimal(n: f64) -> String {
    let s = format!("{n:.6}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The XMP packet for `meta`, and whether `meta.exif` held camera data (whose original EXIF
/// block the file never had). `None` when there is nothing to say.
pub(crate) fn xmp_packet(meta: &Map<String, Value>) -> Option<(String, bool)> {
    let mut body = String::new();
    let alt = |body: &mut String, prop: &str, v: Option<String>| {
        if let Some(v) = v {
            body.push_str(&format!("   <{prop}><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></{prop}>\n", escape(&v)));
        }
    };
    let simple = |body: &mut String, prop: &str, v: Option<String>| {
        if let Some(v) = v {
            body.push_str(&format!("   <{prop}>{}</{prop}>\n", escape(&v)));
        }
    };
    alt(&mut body, "dc:title", text(meta.get("title")));
    if let Some(author) = text(meta.get("author")) {
        let items: String = author.split(';').map(str::trim).filter(|a| !a.is_empty()).map(|a| format!("<rdf:li>{}</rdf:li>", escape(a))).collect();
        body.push_str(&format!("   <dc:creator><rdf:Seq>{items}</rdf:Seq></dc:creator>\n"));
    }
    alt(&mut body, "dc:description", text(meta.get("description")));
    let keys = keywords(meta.get("keywords"));
    if !keys.is_empty() {
        let items: String = keys.iter().map(|k| format!("<rdf:li>{}</rdf:li>", escape(k))).collect();
        body.push_str(&format!("   <dc:subject><rdf:Bag>{items}</rdf:Bag></dc:subject>\n"));
    }
    alt(&mut body, "dc:rights", text(meta.get("copyright")));
    simple(&mut body, "photoshop:Credit", text(meta.get("credit")));
    simple(&mut body, "photoshop:Source", text(meta.get("source")));
    if let Some(rating) = number(meta.get("rating")).map(|r| r.round().clamp(0.0, 5.0) as u8).filter(|r| *r > 0) {
        body.push_str(&format!("   <xmp:Rating>{rating}</xmp:Rating>\n"));
    }
    // COPYRIGHT_STATUS of file-info.js: unknown, copyrighted, public.
    match meta.get("copyrightStatus").and_then(Value::as_str) {
        Some("copyrighted") => body.push_str("   <xmpRights:Marked>True</xmpRights:Marked>\n"),
        Some("public") => body.push_str("   <xmpRights:Marked>False</xmpRights:Marked>\n"),
        _ => {}
    }
    simple(&mut body, "xmpRights:WebStatement", text(meta.get("copyrightUrl")));

    // Camera data: the keys of `readExif` in file-info.js.
    let mut camera = false;
    if let Some(exif) = meta.get("exif").and_then(Value::as_object) {
        let at = body.len();
        simple(&mut body, "tiff:Make", text(exif.get("make")));
        simple(&mut body, "tiff:Model", text(exif.get("model")));
        simple(&mut body, "tiff:Software", text(exif.get("software")));
        // `2026:01:02 03:04:05` in EXIF is `2026-01-02T03:04:05` in XMP.
        if let Some(date) = text(exif.get("dateTimeOriginal")).or_else(|| text(exif.get("dateTime"))) {
            let b = date.as_bytes();
            let exif_form = b.len() >= 19 && b[4] == b':' && b[7] == b':' && b[10] == b' ' && date.is_char_boundary(19);
            let date = if exif_form { format!("{}-{}-{}T{}", &date[0..4], &date[5..7], &date[8..10], &date[11..19]) } else { date };
            simple(&mut body, "exif:DateTimeOriginal", Some(date));
        }
        let positive = |key: &str| number(exif.get(key)).filter(|n| *n > 0.0);
        simple(&mut body, "exif:ExposureTime", positive("exposureTime").map(decimal));
        simple(&mut body, "exif:FNumber", positive("fNumber").map(decimal));
        if let Some(iso) = positive("iso") {
            body.push_str(&format!("   <exif:ISOSpeedRatings><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></exif:ISOSpeedRatings>\n", decimal(iso.round())));
        }
        simple(&mut body, "exif:ExposureBiasValue", number(exif.get("exposureBias")).filter(|n| *n != 0.0).map(decimal));
        simple(&mut body, "exif:FocalLength", positive("focalLength").map(decimal));
        simple(&mut body, "exif:FocalLengthIn35mmFilm", positive("focalLength35").map(|n| decimal(n.round())));
        let lens = [text(exif.get("lensMake")), text(exif.get("lens"))].into_iter().flatten().collect::<Vec<_>>().join(" ");
        simple(&mut body, "aux:Lens", (!lens.is_empty()).then_some(lens));
        camera = body.len() > at;
    }
    if body.is_empty() {
        return None;
    }
    let packet = format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" xmlns:xmpRights=\"http://ns.adobe.com/xap/1.0/rights/\" xmlns:tiff=\"http://ns.adobe.com/tiff/1.0/\" xmlns:exif=\"http://ns.adobe.com/exif/1.0/\" xmlns:aux=\"http://ns.adobe.com/exif/1.0/aux/\">\n{body}  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>"
    );
    Some((packet, camera))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn packet(meta: Value) -> Option<(String, bool)> {
        xmp_packet(meta.as_object().unwrap())
    }

    #[test]
    fn nothing_to_say_is_no_packet() {
        assert_eq!(packet(json!({})), None);
        assert_eq!(packet(json!({"title": "  ", "keywords": [], "rating": 0, "copyrightStatus": "unknown", "url": "x", "layerTags": {}, "exif": {}})), None);
        assert_eq!(packet(json!({"title": 3.5, "rating": "many", "exif": "none"})).unwrap().0.matches("<dc:title>").count(), 1);
    }

    #[test]
    fn file_info_fields_become_the_properties_file_info_reads() {
        let (x, camera) = packet(json!({
            "title": "A <title> & more", "author": "One; Two", "description": "Two\nlines  ", "copyright": "© \"me\"",
            "keywords": "one, two; One\nthree", "rating": 4.4, "credit": "Credit", "source": "Source",
            "copyrightStatus": "public", "copyrightUrl": "https://example.com/?a=1&b=2",
        }))
        .unwrap();
        assert!(!camera);
        for part in [
            "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">A &lt;title&gt; &amp; more</rdf:li></rdf:Alt></dc:title>",
            "<dc:creator><rdf:Seq><rdf:li>One</rdf:li><rdf:li>Two</rdf:li></rdf:Seq></dc:creator>",
            "<dc:description><rdf:Alt><rdf:li xml:lang=\"x-default\">Two\nlines</rdf:li></rdf:Alt></dc:description>",
            "<dc:subject><rdf:Bag><rdf:li>one</rdf:li><rdf:li>two</rdf:li><rdf:li>three</rdf:li></rdf:Bag></dc:subject>",
            "<dc:rights><rdf:Alt><rdf:li xml:lang=\"x-default\">© &quot;me&quot;</rdf:li></rdf:Alt></dc:rights>",
            "<photoshop:Credit>Credit</photoshop:Credit>",
            "<photoshop:Source>Source</photoshop:Source>",
            "<xmp:Rating>4</xmp:Rating>",
            "<xmpRights:Marked>False</xmpRights:Marked>",
            "<xmpRights:WebStatement>https://example.com/?a=1&amp;b=2</xmpRights:WebStatement>",
        ] {
            assert!(x.contains(part), "{part} is not in\n{x}");
        }
        assert!(x.starts_with("<?xpacket begin=") && x.ends_with("<?xpacket end=\"w\"?>") && x.contains("</rdf:RDF>"));
        assert!(packet(json!({"copyrightStatus": "copyrighted"})).unwrap().0.contains("<xmpRights:Marked>True</xmpRights:Marked>"));
    }

    #[test]
    fn camera_data_becomes_tiff_and_exif_properties() {
        let (x, camera) = packet(json!({"exif": {
            "make": "Maker", "model": "Model 7", "software": "Firmware 1.0", "dateTimeOriginal": "2026:01:02 03:04:05", "exposureTime": 0.004,
            "fNumber": 2.8, "iso": 200, "exposureBias": -0.33, "focalLength": 35, "focalLength35": 52.4, "lensMake": "Glass", "lens": "35mm F2.8",
            "flash": 16,
        }}))
        .unwrap();
        assert!(camera);
        for part in [
            "<tiff:Make>Maker</tiff:Make>",
            "<tiff:Model>Model 7</tiff:Model>",
            "<tiff:Software>Firmware 1.0</tiff:Software>",
            "<exif:DateTimeOriginal>2026-01-02T03:04:05</exif:DateTimeOriginal>",
            "<exif:ExposureTime>0.004</exif:ExposureTime>",
            "<exif:FNumber>2.8</exif:FNumber>",
            "<exif:ISOSpeedRatings><rdf:Seq><rdf:li>200</rdf:li></rdf:Seq></exif:ISOSpeedRatings>",
            "<exif:ExposureBiasValue>-0.33</exif:ExposureBiasValue>",
            "<exif:FocalLength>35</exif:FocalLength>",
            "<exif:FocalLengthIn35mmFilm>52</exif:FocalLengthIn35mmFilm>",
            "<aux:Lens>Glass 35mm F2.8</aux:Lens>",
        ] {
            assert!(x.contains(part), "{part} is not in\n{x}");
        }
        // A date that is not in EXIF's form is kept as it is; nothing usable is no camera data.
        assert!(packet(json!({"exif": {"dateTime": "yesterday"}})).unwrap().0.contains("<exif:DateTimeOriginal>yesterday</exif:DateTimeOriginal>"));
        assert_eq!(packet(json!({"exif": {"iso": -1, "flash": 1, "make": ""}})), None);
    }
}
