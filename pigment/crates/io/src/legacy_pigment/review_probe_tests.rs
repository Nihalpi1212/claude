//! Temporary probes (review).

use std::time::Instant;

use super::tests::zip;

fn png() -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pigment-0.4/v3-smart-image.png")).unwrap()
}

fn doc(layers: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let json = format!(r#"{{"version":3,"app":"pigment","width":64,"height":64,"dpi":72,"layers":{layers}}}"#);
    let mut entries: Vec<(&str, &[u8])> = vec![("mimetype", b"application/x-pigment"), ("document.json", json.as_bytes())];
    entries.extend_from_slice(extra);
    zip(&entries)
}

#[test]
fn probe_smart_huge_transform() {
    let png = png();
    let all = ["[1e7,0,0,1e7,0,0]", "[1e7,0,0,1e-6,0,0]", "[1e-4,0,0,1e-4,0,0]", "[1,0,0,1,-1e7,-1e7]", "[0,1e7,-1e7,0,5,5]", "[100,0,0,100,0,0]", "[1000,0,0,1000,0,0]"];
    let pick: usize = std::env::var("PROBE").ok().and_then(|v| v.parse().ok()).unwrap_or(99);
    for (i, t) in all.into_iter().enumerate() {
        if pick != 99 && i != pick { continue; }
        let layers = format!(r#"[{{"id":"s","type":"smart","source":{{"kind":"image","name":"x"}},"transform":{t}}}]"#);
        let bytes = doc(&layers, &[("smart/s.png", &png)]);
        let at = Instant::now();
        let r = crate::import("p.pigment", &bytes);
        eprintln!("{t}: {:?} {:?}", at.elapsed(), r.as_ref().map(|r| r.warnings.clone()).map_err(|e| e.to_string()));
    }
}

#[test]
fn probe_text_huge() {
    for desc in [
        r#"{"id":"t","type":"text","content":{"v":1,"text":"Hello","runs":[{"len":5,"style":{"size":10000,"scaleX":1000,"scaleY":1000}}],"paras":[{}]},"x":0,"y":0}"#,
        r#"{"id":"t","type":"text","content":{"v":1,"text":"Hello","runs":[{"len":5,"style":{"size":48}}],"paras":[{}]},"transform":[1e7,0,0,1e7,0,0]}"#,
        r#"{"id":"t","type":"text","content":{"v":1,"text":"Hello","runs":[{"len":5,"style":{"size":48,"tracking":10000}}],"paras":[{"align":"center"}]},"x":1e7,"y":-1e7}"#,
        r#"{"id":"t","type":"text","content":{"v":1,"text":"Hello","runs":[{"len":5,"style":{"size":10000}}],"paras":[{}]},"width":1e7,"height":1e7}"#,
        r#"{"id":"t","type":"text","content":{"v":1,"text":"Hello","runs":[{"len":5,"style":{"size":0.1}}],"paras":[{}]},"width":0.001}"#,
    ] {
        let bytes = doc(&format!("[{desc}]"), &[]);
        let at = Instant::now();
        let r = crate::import("p.pigment", &bytes);
        eprintln!("{:?} {:?}", at.elapsed(), r.as_ref().map(|r| r.warnings.clone()).map_err(|e| e.to_string()));
    }
}

#[test]
fn probe_text_long() {
    let text = "word ".repeat(200_000);
    let runs: Vec<String> = (0..60_000).map(|i| format!(r#"{{"len":1,"style":{{"size":{}}}}}"#, 10 + i % 50)).collect();
    let desc = format!(r#"{{"id":"t","type":"text","content":{{"v":1,"text":"{text}","runs":[{}],"paras":[{{"align":"center"}}]}},"x":0,"y":0}}"#, runs.join(","));
    let bytes = doc(&format!("[{desc}]"), &[]);
    let at = Instant::now();
    let r = crate::import("p.pigment", &bytes);
    eprintln!("long: {:?} {:?}", at.elapsed(), r.as_ref().map(|r| r.warnings.len()).map_err(|e| e.to_string()));
}

#[test]
fn probe_psd_round_trip_of_every_fixture() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pigment-0.4");
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "pigment")).collect();
    names.sort();
    let mut bad = Vec::new();
    for p in names {
        let bytes = std::fs::read(&p).unwrap();
        let Ok(r) = crate::import("x.pigment", &bytes) else { continue };
        let psd = match crate::export(&r.document, "psd", &Default::default()) {
            Ok(b) => b.bytes,
            Err(e) => {
                bad.push(format!("{}: export {e}", p.display()));
                continue;
            }
        };
        match crate::import("x.psd", &psd) {
            Ok(back) => {
                let n = |d: &photocraft_doc::Document| {
                    let mut c = 0;
                    fn walk(l: &[photocraft_doc::Layer], c: &mut usize) {
                        for l in l {
                            *c += 1;
                            if let Some(ch) = l.children() {
                                walk(ch, c);
                            }
                        }
                    }
                    walk(&d.layers, &mut c);
                    c
                };
                if n(&back.document) != n(&r.document) {
                    bad.push(format!("{}: layers {} -> {}", p.display(), n(&r.document), n(&back.document)));
                }
            }
            Err(e) => bad.push(format!("{}: reimport {e}", p.display())),
        }
    }
    for b in &bad {
        eprintln!("{b}");
    }
}
