//! Pigment (F1): File Info's tabs, the Rating stars and the structure rows, and what OK sends.

use std::sync::Arc;

use super::*;
use craft::ui::dialog::DialogId;

fn app() -> (Box<PhotocraftApp>, egui::Context) {
    let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), crate::Services::default());
    app.run("file.new", json!({"width": 40, "height": 30})).unwrap();
    app.sync_views();
    let ctx = app.ctx().clone();
    (app, ctx)
}

fn frame(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let mut output = ctx.run_ui(Default::default(), |ui| {
        let mut frame = eframe::Frame::_new_kittest();
        app.logic_frame(ui.ctx(), &mut frame);
        app.ui_frame(ui, &mut frame);
    });
    output.textures_delta.clear();
}

fn open(app: &mut PhotocraftApp, ctx: &egui::Context) -> DialogId {
    let reply = crate::menus::invoke(app, ctx, COMMAND, json!({})).unwrap();
    let want = reply["dialog"].as_str().expect("the reply names a dialog").to_owned();
    let id = app.framework.dialogs.open_dialogs().into_iter().map(|d| d.id).find(|id| id.value().to_string() == want).expect("File Info is open");
    frame(app, ctx);
    id
}

fn fields(app: &PhotocraftApp, id: DialogId) -> Value {
    app.framework.dialogs.open_dialogs().into_iter().find(|open| open.id == id).and_then(|open| open.fields).expect("the form lists its fields")
}

fn set(app: &mut PhotocraftApp, ctx: &egui::Context, id: DialogId, key: &str, value: Value) {
    app.framework.dialogs.set_json_field(ctx, id, key, value).unwrap_or_else(|e| panic!("{key}: {e}"));
}

fn past(app: &PhotocraftApp) -> usize {
    app.session.active().unwrap().history.past_len()
}

fn set_xmp(app: &mut PhotocraftApp, xmp: &str) {
    Arc::make_mut(&mut app.session.active_mut().unwrap().doc).metadata.xmp = Some(Arc::from(xmp));
}

#[test]
fn the_origin_tab_edits_the_headline_in_one_history_step() {
    let (mut app, ctx) = app();
    let before = past(&app);
    let id = open(&mut app, &ctx);
    assert_eq!(fields(&app, id)[TAB], "basic", "File Info opens on Basic");
    set(&mut app, &ctx, id, TAB, json!("origin"));
    frame(&mut app, &ctx);
    assert_eq!(fields(&app, id)[TAB], "origin");
    set(&mut app, &ctx, id, "headline", json!("Starry Night"));
    set(&mut app, &ctx, id, "rating", json!(3));
    set(&mut app, &ctx, id, "urgency", json!("2"));
    set(&mut app, &ctx, id, "creatorContactInfo/CiAdrCity", json!("Arles"));
    set(&mut app, &ctx, id, "personInImage", json!("Ann; Smith, Bo"));
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    assert_eq!(past(&app), before + 1, "one step");
    assert_eq!(app.session.active().unwrap().history.undo_label(), Some("File Info"));
    let info = app.run(COMMAND, json!({})).unwrap();
    assert_eq!(info["headline"], "Starry Night");
    assert_eq!(info["rating"], 3);
    assert_eq!(info["urgency"], 2);
    assert_eq!(info["creatorContactInfo"], json!({"CiAdrCity": "Arles"}));
    assert_eq!(info["personInImage"], json!(["Ann", "Smith, Bo"]));
    // The form reopens with what was written.
    let id = open(&mut app, &ctx);
    let f = fields(&app, id);
    assert_eq!((f["headline"].as_str(), f["creatorContactInfo/CiAdrCity"].as_str(), f["personInImage"].as_str()), (Some("Starry Night"), Some("Arles"), Some("Ann; Smith, Bo")));
    assert_eq!(f["rating"], 3);
    assert_eq!(f[TAB], "basic", "the tab is not remembered");
}

#[test]
fn ok_on_an_unchanged_form_leaves_the_packet_byte_for_byte() {
    let (mut app, ctx) = app();
    let packet = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="-1" photoshop:Headline="Old"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">T</rdf:li></rdf:Alt></dc:title><Iptc4xmpExt:LocationShown><rdf:Bag><rdf:li rdf:parseType="Resource"><Iptc4xmpExt:City>Arles</Iptc4xmpExt:City></rdf:li><rdf:li rdf:parseType="Resource"><Iptc4xmpExt:City>Paris</Iptc4xmpExt:City></rdf:li></rdf:Bag></Iptc4xmpExt:LocationShown></rdf:Description></rdf:RDF></x:xmpmeta>"#;
    set_xmp(&mut app, packet);
    let id = open(&mut app, &ctx);
    let f = fields(&app, id);
    assert_eq!(f["locationShown/City"], "Arles", "the first location");
    assert_eq!(f["rating"], -1, "a rejected file keeps its rating");
    for tab in ["camera", "origin", "iptc", "iptcExt", "gps", "raw"] {
        set(&mut app, &ctx, id, TAB, json!(tab));
        frame(&mut app, &ctx);
    }
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    assert_eq!(app.session.active().unwrap().doc.metadata.xmp.as_deref(), Some(packet));
    let info = app.run(COMMAND, json!({})).unwrap();
    assert_eq!(info["locationShown"], json!([{"City": "Arles"}, {"City": "Paris"}]));
    // Editing the first location keeps the second.
    let id = open(&mut app, &ctx);
    set(&mut app, &ctx, id, "locationShown/City", json!("Nîmes"));
    crate::dialogs::confirm(&mut app, &ctx, id).unwrap();
    assert_eq!(app.run(COMMAND, json!({})).unwrap()["locationShown"], json!([{"City": "Nîmes"}, {"City": "Paris"}]));
}

#[test]
fn nest_leaves_out_the_tab_and_read_only_rows_and_folds_the_structures() {
    let mut map = json!({
        "tab": "iptc",
        "title": "T",
        "camera/Make": "Canon",
        "gps/latitude": "1",
        "raw/packet": "<x/>",
        "readout/created": "2024",
        "creatorContactInfo/CiAdrCity": "Arles",
        "creatorContactInfo/CiAdrPcode": "",
        "locationShown/City": "Paris",
        "locationShown/more": "",
        "rating": 2,
    })
    .as_object()
    .cloned()
    .unwrap();
    nest(&mut map);
    assert_eq!(
        Value::Object(map),
        json!({"title": "T", "rating": 2, "creatorContactInfo": {"CiAdrCity": "Arles", "CiAdrPcode": ""}, "locationShown": {"City": "Paris"}})
    );
}

#[test]
fn the_optional_tabs_follow_the_file() {
    let (mut app, ctx) = app();
    let id = open(&mut app, &ctx);
    let plain = fields(&app, id);
    assert!(plain.get("dynamicMedia/artist").is_none());
    crate::dialogs::cancel(&mut app, &ctx, id).unwrap();
    set_xmp(
        &mut app,
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmpDM:artist="Band"/></rdf:RDF></x:xmpmeta>"#,
    );
    let (rows, _) = form(&mut app).unwrap();
    assert!(rows.iter().any(|r| r.key == "dynamicMedia/artist"), "Audio/Video Data lists the property");
    assert!(rows.iter().any(|r| r.key == "raw/copy"), "Raw Data has Copy");
    assert!(rows.iter().filter(|r| r.key != TAB).all(|r| r.visible_when.is_some()), "every row belongs to a tab");
}
