//! Pigment (F2): Color Lookup Tables in .3dl, .csp and ICC beside .cube, with the copyright,
//! lowercase extensions and Photoshop's 256-point Maximum.

use super::*;
use crate::Session;

const CMD: &str = "file.export.colorLookupTables";

/// An 8×8 RGB document with one Invert adjustment: the table at node (r, g, b) is (1-r, 1-g, 1-b),
/// which tells the three axes apart.
fn inverted(mode: &str) -> Session {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 8, "height": 8, "mode": mode})).unwrap();
    s.execute("layer.newAdjustmentLayer.invert", json!({})).unwrap();
    s
}

fn invert_at(n: usize, r: usize, g: usize, b: usize) -> [f32; 3] {
    let v = |i: usize| 1.0 - i as f32 / (n - 1) as f32;
    [v(r), v(g), v(b)]
}

fn close(a: [f32; 3], b: [f32; 3], tol: f32) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() <= tol)
}

/// A temporary folder of its own.
fn tmp(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("pigment-lut-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().into_owned()
}

/// A `.csp` 3D table's values (red fastest) and its metadata lines, as the format describes them.
fn parse_csp(text: &str) -> (usize, Vec<[f32; 3]>, Vec<String>) {
    let mut lines = text.lines();
    assert_eq!(lines.next(), Some("CSPLUTV100"));
    assert_eq!(lines.next(), Some("3D"));
    let mut meta = Vec::new();
    let mut in_meta = false;
    let mut rest: Vec<&str> = Vec::new();
    for l in lines {
        match l.trim() {
            "BEGIN METADATA" => in_meta = true,
            "END METADATA" => in_meta = false,
            t if in_meta => meta.push(t.to_owned()),
            "" => {}
            t => rest.push(t),
        }
    }
    // Three pre-LUTs: a point count, then input and output values.
    let mut at = 0;
    for _ in 0..3 {
        let points: usize = rest[at].parse().unwrap();
        assert_eq!(points, 2);
        assert_eq!((rest[at + 1], rest[at + 2]), ("0.0 1.0", "0.0 1.0"), "identity pre-LUT");
        at += 3;
    }
    let dims: Vec<usize> = rest[at].split_whitespace().map(|v| v.parse().unwrap()).collect();
    let n = dims[0];
    assert_eq!(dims, [n, n, n]);
    let rows = rest[at + 1..]
        .iter()
        .map(|l| {
            let v: Vec<f32> = l.split_whitespace().map(|v| v.parse().unwrap()).collect();
            [v[0], v[1], v[2]]
        })
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), n * n * n);
    (n, rows, meta)
}

#[test]
fn every_format_reads_back_as_the_table() {
    for n in [3usize, 7, 17, 33] {
        let mut s = inverted("rgb");
        let r = s.execute(CMD, json!({"size": n, "formats": ["cube", "3dl", "csp", "icc"], "title": "Look", "copyright": "(c) Someone"})).unwrap();
        assert_eq!(r["size"], n);
        let cube = craft_cms::lutfile::parse_cube(r["cube"].as_str().unwrap()).unwrap();
        let three = craft_cms::lutfile::parse_3dl(r["threeDl"].as_str().unwrap()).unwrap();
        assert_eq!((cube.size, three.size), (n, n), "size {n}");
        let (csp_n, csp, _) = parse_csp(r["csp"].as_str().unwrap());
        assert_eq!(csp_n, n);
        for b in 0..n {
            for g in 0..n {
                for rr in 0..n {
                    let want = invert_at(n, rr, g, b);
                    let i = (b * n + g) * n + rr;
                    let at = |d: &[f32]| [d[i * 3], d[i * 3 + 1], d[i * 3 + 2]];
                    assert!(close(at(&cube.data), want, 1e-3), "cube {n} at {rr},{g},{b}");
                    assert!(close(at(&three.data), want, 0.5 / 4095.0 + 1e-3), "3dl {n} at {rr},{g},{b}: {:?}", at(&three.data));
                    assert!(close(csp[i], want, 1e-3), "csp {n} at {rr},{g},{b}");
                }
            }
        }
        let icc = base64::engine::general_purpose::STANDARD.decode(r["icc"].as_str().unwrap()).unwrap();
        check_icc(&icc, n, "Look", "(c) Someone");
    }
}

/// The ICC is an RGB → RGB DeviceLink whose A2B0 maps the nodes like the table.
fn check_icc(bytes: &[u8], n: usize, title: &str, copyright: &str) {
    assert_eq!(&bytes[12..16], b"link");
    assert_eq!((&bytes[16..20], &bytes[20..24]), (&b"RGB "[..], &b"RGB "[..]));
    assert_eq!(craft_cms::profile_id(bytes).unwrap()[..], bytes[84..100], "the profile ID is stamped");
    let p = craft_cms::Profile::parse(bytes).unwrap();
    assert_eq!(p.class, craft_cms::ProfileClass::DeviceLink);
    assert_eq!((p.description.as_str(), p.copyright.as_str()), (title, copyright));
    let lut = p.a2b[0].as_ref().expect("an A2B0 table");
    assert_eq!((lut.inputs, lut.outputs), (3, 3));
    let pipeline = craft_cms::pipeline::Pipeline::new(3, lut.stages.clone()).unwrap();
    let m = n.min(MAX_ICC_SIZE);
    for (r, g, b) in [(0, 0, 0), (m - 1, 0, 0), (0, m - 1, 0), (0, 0, m - 1), (m / 2, 1, m - 2), (m - 1, m - 1, m - 1)] {
        let x = |i: usize| i as f32 / (m - 1) as f32;
        let mut out = [0.0f32; 3];
        pipeline.eval(&[x(r), x(g), x(b)], &mut out).unwrap();
        let want = [1.0 - x(r), 1.0 - x(g), 1.0 - x(b)];
        assert!(close(out, want, 2e-3), "icc {n} at {r},{g},{b}: {out:?}, want {want:?}");
    }
}

#[test]
fn the_copyright_and_description_are_in_every_file() {
    let mut s = inverted("rgb");
    let r = s.execute(CMD, json!({"size": 3, "formats": ["cube", "3dl", "csp"], "title": "My Look", "copyright": "(c) 2026 Pigment\nline two"})).unwrap();
    let cube = r["cube"].as_str().unwrap();
    let head: Vec<&str> = cube.lines().take(3).collect();
    assert_eq!(head, ["#Created by: Pigment", "#Copyright: (c) 2026 Pigment line two", "TITLE \"My Look\""]);
    craft_cms::lutfile::parse_cube(cube).unwrap();
    let three = r["threeDl"].as_str().unwrap();
    assert!(three.starts_with("3DMESH\nMesh 1 12\n# Title: My Look\n# Copyright: (c) 2026 Pigment line two\n"), "{three}");
    let (_, _, meta) = parse_csp(r["csp"].as_str().unwrap());
    assert_eq!(meta, ["My Look", "Copyright: (c) 2026 Pigment line two"]);
    // Without a copyright the cube is upstream's, byte for byte.
    let plain = s.execute(CMD, json!({"size": 3, "title": "My Look"})).unwrap();
    assert!(plain.get("threeDl").is_none() && plain.get("icc").is_none());
    assert_eq!(plain["cube"].as_str().unwrap(), cube.replace("#Copyright: (c) 2026 Pigment line two\n", ""));
}

#[test]
fn four_formats_write_four_files_with_lowercase_extensions() {
    let dir = tmp("files");
    let mut s = inverted("rgb");
    let all = json!(["icc", "csp", "cube", "3dl"]);
    let r = s.execute(CMD, json!({"size": 5, "formats": all, "title": "Look", "path": format!("{dir}/Look.cube")})).unwrap();
    let names: Vec<String> = ["3dl", "cube", "csp", "icc"].iter().map(|e| format!("{dir}/Look.{e}")).collect();
    assert_eq!(r["files"], json!(names), "Photoshop's order, the base name of the path");
    assert_eq!(r["path"], json!(names[0]));
    for name in &names {
        assert!(std::fs::metadata(name).unwrap().len() > 0, "{name}");
    }
    craft_cms::lutfile::parse_3dl(&std::fs::read_to_string(&names[0]).unwrap()).unwrap();
    check_icc(&std::fs::read(&names[3]).unwrap(), 5, "Look", "");
    // Use lowercase file extensions off.
    let r = s.execute(CMD, json!({"size": 5, "formats": ["cube", "icc"], "lowercase": false, "path": format!("{dir}/Up")})).unwrap();
    assert_eq!(r["files"], json!([format!("{dir}/Up.CUBE"), format!("{dir}/Up.ICC")]));
    // One format and a path with its extension: the path as given (upstream's behaviour).
    let r = s.execute(CMD, json!({"size": 5, "path": format!("{dir}/Exact.CUBE")})).unwrap();
    assert_eq!(r["files"], json!([format!("{dir}/Exact.CUBE")]));
    let r = s.execute(CMD, json!({"size": 5, "formats": ["3dl"], "path": format!("{dir}/Other.cube")})).unwrap();
    assert_eq!(r["files"], json!([format!("{dir}/Other.3dl")]));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn file_paths_keep_other_dots() {
    let f = [LutFormat::Cube, LutFormat::Icc];
    assert_eq!(file_paths("/a.b/c", &f, true), ["/a.b/c.cube", "/a.b/c.icc"]);
    assert_eq!(file_paths("/a/look.v2", &f, true), ["/a/look.v2.cube", "/a/look.v2.icc"]);
    assert_eq!(file_paths("/a/.cube", &f, true), ["/a/.cube.cube", "/a/.cube.icc"]);
    assert_eq!(file_paths("c:\\x\\look.icm", &f, false), ["c:\\x\\look.CUBE", "c:\\x\\look.ICC"]);
}

/// Photoshop's Maximum (256 points) is written, baked in bands; the ICC holds 177 points and says so.
#[test]
fn a_256_point_table_bakes_in_bands_and_the_icc_is_capped() {
    let n = 256;
    let doc = {
        let s = inverted("rgb");
        s.active().unwrap().doc.as_ref().clone()
    };
    let layers: Vec<&Layer> = doc.layers.iter().filter(|l| matches!(l.content, photocraft_doc::LayerContent::Adjustment(_))).collect();
    let table = super::super::export::bake_table(n, &layers);
    assert_eq!(table.len(), n * n * n);
    // Band edges (64 blue slices a band at 256 points) and the corners.
    for (r, g, b) in [(0, 0, 0), (255, 0, 0), (0, 255, 0), (0, 0, 255), (17, 200, 63), (17, 200, 64), (3, 4, 127), (3, 4, 128), (255, 255, 255)] {
        assert!(close(table[(b * n + g) * n + r], invert_at(n, r, g, b), 1e-4), "{r},{g},{b}");
    }
    let icc = write_icc(&table, n, "Max", "").unwrap();
    check_icc(&icc, n, "Max", "");
    let mut s = inverted("rgb");
    let r = s.execute(CMD, json!({"size": 256, "formats": ["icc"]})).unwrap();
    assert_eq!((r["size"].as_u64(), r["iccSize"].as_u64()), (Some(256), Some(177)));
    assert!(s.execute(CMD, json!({"size": 257})).is_err());
    // A 130-point table, over upstream's old cap: the .3dl has no Mesh line (130 is not 2^k + 1).
    let r = s.execute(CMD, json!({"size": 130, "formats": ["3dl"]})).unwrap();
    let three = r["threeDl"].as_str().unwrap();
    assert!(!three.contains("Mesh"));
    assert_eq!(three.lines().filter(|l| !l.starts_with('#')).count(), 1 + 130 * 130 * 130);
}

#[test]
fn icc_is_refused_in_cmyk_and_lab_documents() {
    for mode in ["cmyk", "lab"] {
        let mut s = inverted(mode);
        let e = s.execute(CMD, json!({"size": 3, "formats": ["icc"]})).unwrap_err().to_string();
        assert!(e.contains("RGB document"), "{mode}: {e}");
        assert!(s.execute(CMD, json!({"size": 3, "formats": ["cube", "3dl", "csp"]})).is_ok(), "{mode}: the text formats are written");
    }
}

#[test]
fn bad_format_params_are_refused_before_baking() {
    let mut s = inverted("rgb");
    for p in [
        json!({"formats": []}),
        json!({"formats": "cube"}),
        json!({"formats": ["tiff"]}),
        json!({"formats": [3]}),
        json!({"copyright": 3}),
        json!({"lowercase": "yes"}),
    ] {
        assert!(s.execute(CMD, p.clone()).is_err(), "{p}");
    }
    // Repeats are written once.
    let r = s.execute(CMD, json!({"size": 3, "formats": ["csp", "csp"]})).unwrap();
    assert!(r["csp"].is_string() && r.get("cube").is_none());
}
