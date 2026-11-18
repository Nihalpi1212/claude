//! Pigment: a document saved by Pigment 0.1–0.4 opens through the interface's own open paths,
//! and none of them lets File › Save write the new format over the old file.

use photocraft_ui_egui::{PhotocraftApp, Services};

/// Written by Pigment 0.4.0 itself (`crates/io/tests/fixtures/pigment-0.4/README.md`).
const GROUPS: &[u8] = include_bytes!("../../../io/tests/fixtures/pigment-0.4/v3-groups.pigment");

/// An app with the real importer and no file dialog.
fn app() -> PhotocraftApp {
    let services = Services {
        import: Some(Box::new(|name: &str, bytes: &[u8], opts: &photocraft_io::ImportOptions| {
            photocraft_io::import_with_options(name, bytes, opts).map(|r| (r.document, r.warnings)).map_err(|e| e.to_string())
        })),
        ..Default::default()
    };
    PhotocraftApp::new(photocraft_engine::Session::new(), services)
}

fn layer_names(app: &PhotocraftApp) -> Vec<String> {
    app.session.active().expect("an open document").doc.layers.iter().map(|l| l.name.clone()).collect()
}

#[test]
fn a_pigment_0_4_document_opens_and_save_asks_for_a_new_file() {
    // File › Open, a dropped file, Open Recent.
    let mut a = app();
    let warnings = a.open_file("/pictures/poster.pigment", GROUPS).unwrap();
    assert_eq!(warnings, Vec::<String>::new());
    assert_eq!(layer_names(&a), ["Background", "Outer", "Top"]);
    let st = a.session.active().unwrap();
    assert_eq!(st.doc.name, "poster.pigment");
    // The old file is not the document's file: Save cannot go back over it.
    assert!(st.source_read_only);
    assert_eq!(st.path, None);

    // The control channel's `app.open`, as an agent uses it.
    let mut a = app();
    a.open_automation_bytes("poster.pigment", GROUPS).unwrap();
    assert_eq!(layer_names(&a), ["Background", "Outer", "Top"]);
    assert!(a.session.active().unwrap().source_read_only);
}

#[test]
fn a_damaged_pigment_0_4_document_says_so() {
    let mut a = app();
    // One byte of the compressed description changed: still recognised, no longer readable.
    let mut damaged = GROUPS.to_vec();
    let at = damaged.windows(13).position(|w| w == b"document.json").expect("the entry's name") + 40;
    damaged[at] ^= 0xff;
    let e = a.open_file("/pictures/poster.pigment", &damaged).unwrap_err();
    assert!(e.contains("This Pigment 0.4 file is damaged: "), "{e}");
    assert!(a.session.active().is_none());
}
