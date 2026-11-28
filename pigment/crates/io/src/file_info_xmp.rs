//! Pigment: a small XMP writer for File Info's fields (F1).
//!
//! craft-metadata reads every XMP property ([`craft_metadata::parse_xmp_with`]) and merges a fresh
//! packet into an existing one ([`craft_metadata::merge_xmp`]), but writes only its own subset. File
//! Info's Origin, IPTC and IPTC Extension tabs need language alternatives, ordered and unordered
//! arrays and structures (and arrays of structures) in the `photoshop:`, `Iptc4xmpCore:`,
//! `Iptc4xmpExt:` and `plus:` namespaces: [`packet`] writes them as one `rdf:Description`, which the
//! engine's File Info then merges into the document's packet, and which an IPTC-IIM-only file's
//! fields are seeded through ([`crate::iptc_iim::seed_xmp`]).

use craft_metadata::XmpNamespace;

/// PLUS (Picture Licensing Universal System), the licensing namespace of IPTC Extension.
pub const PLUS: XmpNamespace<'static> = XmpNamespace { prefix: "plus", uri: "http://ns.useplus.org/ldf/xmp/1.0/" };
/// Adobe's dynamic media namespace (File Info's Audio Data and Video Data).
pub const XMP_DM: XmpNamespace<'static> = XmpNamespace { prefix: "xmpDM", uri: "http://ns.adobe.com/xmp/1.0/DynamicMedia/" };
/// Adobe's DICOM namespace (File Info's DICOM tab).
pub const DICOM: XmpNamespace<'static> = XmpNamespace { prefix: "DICOM", uri: "http://ns.adobe.com/DICOM/" };
/// The namespaces beyond craft-metadata's standard ones that File Info reads and writes.
pub const EXTRA_NAMESPACES: [XmpNamespace<'static>; 3] = [PLUS, XMP_DM, DICOM];

/// Every namespace a written property can use, declared on the description.
const DECLARED: [(&str, &str); 9] = [
    ("dc", "http://purl.org/dc/elements/1.1/"),
    ("xmp", "http://ns.adobe.com/xap/1.0/"),
    ("xmpRights", "http://ns.adobe.com/xap/1.0/rights/"),
    ("photoshop", "http://ns.adobe.com/photoshop/1.0/"),
    ("Iptc4xmpCore", "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"),
    ("Iptc4xmpExt", "http://iptc.org/std/Iptc4xmpExt/2008-02-29/"),
    ("plus", "http://ns.useplus.org/ldf/xmp/1.0/"),
    ("xmpDM", "http://ns.adobe.com/xmp/1.0/DynamicMedia/"),
    ("DICOM", "http://ns.adobe.com/DICOM/"),
];

/// A value to write.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// A simple property (or array item).
    Text(String),
    /// A language alternative with one `x-default` item.
    Alt(String),
    /// An ordered array.
    Seq(Vec<Out>),
    /// An unordered array.
    Bag(Vec<Out>),
    /// A structure: `(prefix:name, value)` fields, written with `rdf:parseType="Resource"`.
    Struct(Vec<(String, Out)>),
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // XML 1.0 cannot carry these at all, not even as references: drop them.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            '\u{fffe}' | '\u{ffff}' => {}
            c => out.push(c),
        }
    }
    out
}

/// A property name that can be written: `prefix:local` with a declared prefix and an XML name.
fn writable(name: &str) -> bool {
    let Some((prefix, local)) = name.split_once(':') else { return false };
    DECLARED.iter().any(|(p, _)| *p == prefix)
        && local.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && local.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

/// The element `<name>…</name>` of `value`, at `indent` spaces.
fn element(out: &mut String, name: &str, value: &Out, indent: usize) {
    let pad = " ".repeat(indent);
    match value {
        Out::Text(s) => out.push_str(&format!("{pad}<{name}>{}</{name}>\n", escape(s))),
        Out::Alt(s) => out.push_str(&format!("{pad}<{name}><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></{name}>\n", escape(s))),
        Out::Seq(items) | Out::Bag(items) => {
            let kind = if matches!(value, Out::Seq(_)) { "Seq" } else { "Bag" };
            out.push_str(&format!("{pad}<{name}>\n{pad} <rdf:{kind}>\n"));
            for item in items {
                match item {
                    Out::Struct(fields) => {
                        out.push_str(&format!("{pad}  <rdf:li rdf:parseType=\"Resource\">\n"));
                        for (field, v) in fields.iter().filter(|(f, _)| writable(f)) {
                            element(out, field, v, indent + 3);
                        }
                        out.push_str(&format!("{pad}  </rdf:li>\n"));
                    }
                    Out::Text(s) | Out::Alt(s) => out.push_str(&format!("{pad}  <rdf:li>{}</rdf:li>\n", escape(s))),
                    // Arrays of arrays are not XMP File Info writes.
                    Out::Seq(_) | Out::Bag(_) => {}
                }
            }
            out.push_str(&format!("{pad} </rdf:{kind}>\n{pad}</{name}>\n"));
        }
        Out::Struct(fields) => {
            out.push_str(&format!("{pad}<{name} rdf:parseType=\"Resource\">\n"));
            for (field, v) in fields.iter().filter(|(f, _)| writable(f)) {
                element(out, field, v, indent + 1);
            }
            out.push_str(&format!("{pad}</{name}>\n"));
        }
    }
}

/// A whole XMP packet holding `props` (`prefix:name`, value) in one `rdf:Description` that declares
/// every namespace File Info uses. Names with another prefix are left out.
pub fn packet(props: &[(String, Out)]) -> String {
    let mut body = String::new();
    for (name, value) in props.iter().filter(|(n, _)| writable(n)) {
        element(&mut body, name, value, 3);
    }
    let ns: String = DECLARED.iter().map(|(p, u)| format!("\n    xmlns:{p}=\"{u}\"")).collect();
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  <rdf:Description rdf:about=\"\"{ns}>\n{body}  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use craft_metadata::{XmpValue, parse_xmp_with};

    #[test]
    fn every_kind_reads_back_through_craft_metadata() {
        let city = |c: &str| Out::Struct(vec![("Iptc4xmpExt:City".into(), Out::Text(c.into())), ("Iptc4xmpExt:CountryCode".into(), Out::Text("FR".into()))]);
        let x = packet(&[
            ("photoshop:Headline".into(), Out::Text("Café <&> \"night\"\u{1}".into())),
            ("Iptc4xmpCore:AltTextAccessibility".into(), Out::Alt("Stars".into())),
            ("Iptc4xmpExt:PersonInImage".into(), Out::Bag(vec![Out::Text("Ann".into()), Out::Text("Bo, C.".into())])),
            ("Iptc4xmpCore:CreatorContactInfo".into(), Out::Struct(vec![("Iptc4xmpCore:CiAdrCity".into(), Out::Text("Arles".into()))])),
            ("Iptc4xmpExt:LocationShown".into(), Out::Bag(vec![city("Arles"), city("Paris")])),
            ("plus:Licensor".into(), Out::Seq(vec![Out::Struct(vec![("plus:LicensorName".into(), Out::Text("Agency".into()))])])),
            ("bad name:x".into(), Out::Text("left out".into())),
        ]);
        let d = parse_xmp_with(&x, &EXTRA_NAMESPACES).unwrap();
        assert_eq!(d.values["photoshop:Headline"].text(), Some("Café <&> \"night\""));
        assert_eq!(d.values["Iptc4xmpCore:AltTextAccessibility"].text(), Some("Stars"));
        let people: Vec<_> = d.values["Iptc4xmpExt:PersonInImage"].items().iter().filter_map(XmpValue::text).collect();
        assert_eq!(people, ["Ann", "Bo, C."]);
        assert_eq!(d.values["Iptc4xmpCore:CreatorContactInfo"].field("Iptc4xmpCore:CiAdrCity").and_then(XmpValue::text), Some("Arles"));
        let shown = d.values["Iptc4xmpExt:LocationShown"].items();
        assert_eq!(shown.len(), 2);
        assert_eq!(shown[1].field("Iptc4xmpExt:City").and_then(XmpValue::text), Some("Paris"));
        assert_eq!(d.values["plus:Licensor"].items()[0].field("plus:LicensorName").and_then(XmpValue::text), Some("Agency"));
        assert!(!x.contains("left out"));
    }
}
