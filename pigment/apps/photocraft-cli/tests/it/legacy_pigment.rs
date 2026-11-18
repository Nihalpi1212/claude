//! Pigment: documents of Pigment 0.1–0.4 on the command line. `convert` runs in a process of its
//! own, so nothing else has installed the engine's smart object renderer first: the CLI's own
//! open path must, or the smart filters are left out.

use std::path::PathBuf;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/io/tests/fixtures/pigment-0.4").join(name)
}

fn rgba8(bytes: &[u8]) -> photocraft_codecs::Image {
    photocraft_codecs::decode(bytes).unwrap().converted(photocraft_codecs::ChannelLayout::Rgba, photocraft_codecs::SampleType::U8).into_owned()
}

/// `convert` of a 0.4 document with a smart object and four smart filters gives the JavaScript
/// app's picture of it (within a few levels; the filters are PhotoCraft's), not the unfiltered
/// source.
#[test]
fn convert_draws_the_smart_filters_of_a_pigment_0_4_document() {
    let dir = std::env::temp_dir().join(format!("pc-cli-{}-legacy-smart", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for v in ["v2", "v3"] {
        let out = dir.join(format!("{v}.png"));
        let o = crate::command().arg("convert").arg(fixture(&format!("{v}-smart-filters.pigment"))).arg(&out).output().unwrap();
        assert!(o.status.success(), "{v}: {}", String::from_utf8_lossy(&o.stderr));
        let ours = rgba8(&std::fs::read(&out).unwrap());
        let theirs = rgba8(&std::fs::read(fixture(&format!("{v}-smart-filters.png"))).unwrap());
        assert_eq!(ours.dimensions(), theirs.dimensions(), "{v}");
        let sum: u64 = ours.data().iter().zip(theirs.data()).map(|(a, b)| u64::from(a.abs_diff(*b))).sum();
        let mean = sum as f64 / theirs.data().len() as f64;
        assert!(mean < 3.0, "{v}: mean {mean}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
