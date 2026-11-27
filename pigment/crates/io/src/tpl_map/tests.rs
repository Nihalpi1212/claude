use super::*;

/// Written by the JavaScript Pigment 0.5's `writeTplFile` (fixgen `make-fixture-tpl.mjs`).
const JS_FILE: &[u8] = include_bytes!("../../tests/fixtures/pigment-0.4/wip05-tool-presets.tpl");

fn find<'a>(imp: &'a TplImport, name: &str) -> &'a TplPreset {
    imp.presets.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("no preset {name}: {:?}", imp.presets.iter().map(|p| &p.name).collect::<Vec<_>>()))
}

fn close(v: &Value, want: f64) -> bool {
    v.as_f64().is_some_and(|x| (x - want).abs() < 1e-4)
}

/// The descriptor of a file's `desc` section and the bytes around it.
fn desc_of(bytes: &[u8]) -> (Descriptor, Vec<u8>) {
    let secs = sections(bytes, &mut Vec::new());
    let d = VersionedDescriptor::parse_prefix(secs.desc[0]).unwrap().0.descriptor;
    // Header and every section but `desc`.
    let mut rest = bytes[..8].to_vec();
    if let Some(s) = section_of(&bytes[8..], b"samp") {
        rest.extend_from_slice(s);
    }
    (d, rest)
}

/// The file with `pigmentData` taken out of every preset: what a file Photoshop wrote holds.
fn without_pigment_data(bytes: &[u8]) -> Vec<u8> {
    let (mut d, mut out) = desc_of(bytes);
    if let Some((_, DValue::List(items))) = d.items.iter_mut().find(|(k, _)| k.is("Prst")) {
        for v in items {
            if let DValue::Descriptor(p) = v {
                p.items.retain(|(k, _)| !k.is("pigmentData"));
            }
        }
    }
    put_section(&mut out, b"desc", &VersionedDescriptor::new(d).to_bytes());
    out
}

#[test]
fn reads_the_javascript_apps_file_with_its_pigment_data() {
    let imp = read_tpl(JS_FILE).unwrap();
    assert_eq!(imp.presets.len(), 7, "{:?}", imp.warnings);
    assert!(imp.warnings.iter().any(|w| w.contains("\"Adjust Brush\"") && w.contains("adjustment-brush")), "{:?}", imp.warnings);

    let soft = find(&imp, "Soft Round 30");
    assert_eq!((soft.tool.as_str(), soft.class.as_str()), ("brush", "paintbrushTool"));
    let b = &soft.options["brush"];
    assert!(close(&b["size"], 30.0) && close(&b["hardness"], 0.25), "{b}");
    assert!(close(&b["opacity"], 0.6) && close(&b["flow"], 0.4), "{b}");
    assert_eq!(b["mode"], json!("Multiply"));
    assert!(close(&b["smoothing"]["amount"], 0.5));
    assert_eq!(b["pressureSize"], json!(false));
    // The brush descriptor's tip: angle and roundness.
    assert!(close(&b["angle"], 30.0) && close(&b["roundness"], 0.5), "{b}");
    assert!(b.get("color").is_none(), "a preset leaves the colours alone");
    assert!(imp.warnings.iter().any(|w| w.contains("\"Soft Round 30\": 1 options of brush")), "{:?}", imp.warnings);

    let pencil = find(&imp, "Sampled Pencil");
    assert_eq!(pencil.tool, "pencil");
    let tile: GrayTile = serde_json::from_value(pencil.options["brush"]["tip"]["sampled"].clone()).unwrap();
    assert_eq!((tile.width, tile.height), (6, 4));
    // The app wrote coverage x * 40 + y * 10 (8-bit).
    for y in 0..4u32 {
        for x in 0..6u32 {
            let want = f64::from(x * 40 + y * 10) / 255.0;
            let got = f64::from(tile.data[(y * 6 + x) as usize]) / 65535.0;
            assert!((got - want).abs() < 1.0 / 255.0, "({x},{y}) {got} vs {want}");
        }
    }
    assert_eq!(pencil.options["brush"]["mode"], json!("Screen"));
    assert_eq!(pencil.options["toolOptions"]["pencil_auto_erase"], json!(true));

    let eraser = find(&imp, "Block Eraser");
    assert_eq!(eraser.options["toolOptions"], json!({"eraser_mode": "pencil", "erase_to_history": true}));
    assert!(close(&eraser.options["brush"]["size"], 16.0));

    let gradient = find(&imp, "Red Gradient");
    assert_eq!(gradient.tool, "gradient");
    assert_eq!(gradient.options["toolOptions"], json!({"fill_opacity": 50.0, "gradient_blend_mode": "Overlay", "gradient_style": "radial"}));
    assert_eq!(gradient.options["foreground"], json!([1.0, 0.0, 0.0, 1.0]));

    let headline = find(&imp, "Headline");
    assert_eq!(headline.options["toolOptions"], json!({"type_font": "Inter", "type_size": 36.0}));
    assert_eq!(find(&imp, "Spot Heal 20").tool, "spotHealing");
    let dodge = find(&imp, "Dodge Highlights");
    assert_eq!(dodge.options["toolOptions"], json!({"exposure": 30.0, "tone_range": "highlights"}));
}

#[test]
fn without_pigment_data_the_photoshop_keys_map() {
    let imp = read_tpl(&without_pigment_data(JS_FILE)).unwrap();
    assert_eq!(imp.presets.len(), 7, "{:?}", imp.warnings);
    let soft = find(&imp, "Soft Round 30");
    let b = &soft.options["brush"];
    // `Opct` and `flow` of the tool object, `Md  ` its mode, the tip from `Brsh`.
    assert!(close(&b["opacity"], 0.6) && close(&b["flow"], 0.4), "{b}");
    assert_eq!(b["mode"], json!("Multiply"));
    assert!(close(&b["size"], 30.0) && close(&b["hardness"], 0.25) && close(&b["angle"], 30.0), "{b}");
    let pencil = find(&imp, "Sampled Pencil");
    assert!(pencil.options["brush"]["tip"].get("sampled").is_some());
    let gradient = find(&imp, "Red Gradient");
    assert_eq!(gradient.options["toolOptions"], json!({"fill_opacity": 50.0, "gradient_blend_mode": "Overlay"}));
    assert_eq!(find(&imp, "Headline").options["toolOptions"], json!({"type_font": "Inter", "type_size": 36.0}));
    // Without Pigment's tool id the Adjustment Brush's class is unknown.
    assert!(imp.warnings.iter().any(|w| w.contains("\"Adjust Brush\"")), "{:?}", imp.warnings);
}

/// A file as Photoshop's keys describe it, built here: a class the table does not know, a
/// localised name, a long opacity.
#[test]
fn photoshop_presets_built_by_hand() {
    let brush = Descriptor::new("brushPreset")
        .with("Nm  ", text_value("Hard"))
        .with("Brsh", DValue::Descriptor(Descriptor::new("computedBrush").with("Dmtr", unit(b"#Pxl", 40.0)).with("Hrdn", unit(b"#Prc", 30.0))));
    let presets = vec![
        DValue::Descriptor(
            Descriptor::new("toolPreset")
                .with("Nm  ", text_value("$$$/Presets/ToolPresets/Hard=Hard Brush"))
                .with(
                    "Tool",
                    DValue::Descriptor(
                        Descriptor::new("paintbrushTool")
                            .with("Opct", DValue::Integer(50))
                            .with("flow", unit(b"#Prc", 25.0))
                            .with("Md  ", crate::effects_map::blend_value(BlendMode::Darken)),
                    ),
                )
                .with("Brsh", DValue::Descriptor(brush)),
        ),
        DValue::Descriptor(
            Descriptor::new("toolPreset")
                .with("Nm  ", text_value("Wand"))
                .with("Tool", DValue::Descriptor(Descriptor::new("magicWandTool").with("Opct", DValue::Integer(10)))),
        ),
        DValue::Descriptor(
            Descriptor::new("toolPreset").with("Nm  ", text_value("3D")).with("Tool", DValue::Descriptor(Descriptor::new("threeDObjectRotateTool"))),
        ),
    ];
    let mut file = b"8BTP\0\x01\0\x02".to_vec();
    put_section(&mut file, b"desc", &VersionedDescriptor::new(Descriptor::new("null").with("Hrch", DValue::List(presets))).to_bytes());
    let imp = read_tpl(&file).unwrap();
    assert_eq!(imp.presets.len(), 2, "{:?}", imp.warnings);
    let hard = find(&imp, "Hard Brush");
    assert_eq!(hard.tool, "brush");
    let b = &hard.options["brush"];
    assert!(close(&b["size"], 40.0) && close(&b["hardness"], 0.3) && close(&b["opacity"], 0.5) && close(&b["flow"], 0.25), "{b}");
    assert_eq!(b["mode"], json!("Darken"));
    let wand = find(&imp, "Wand");
    assert_eq!(wand.tool, "magicWand");
    assert!(imp.warnings.iter().any(|w| w.contains("\"Wand\": 1 options")), "{:?}", imp.warnings);
    assert!(imp.warnings.iter().any(|w| w.contains("threeDObjectRotateTool")), "{:?}", imp.warnings);
}

fn round_trip_presets() -> Vec<(String, String, Value)> {
    let tip = GrayTile::from_fn(5, 3, |x, y| (x as f32 * 0.2 + y as f32 * 0.1).min(1.0));
    let sampled = BrushSettings { size: 5.0, tip: TipShape::Sampled(tip), opacity: 0.7, flow: 0.3, mode: BlendMode::Overlay, ..BrushSettings::default() };
    let mut sampled = serde_json::to_value(&sampled).unwrap();
    for k in BRUSH_KEYS_LEFT_OUT {
        sampled.as_object_mut().unwrap().remove(*k);
    }
    vec![
        ("Textured".into(), "brush".into(), json!({"brush": sampled, "toolOptions": {"brush_clear": false}})),
        ("Soft Eraser".into(), "eraser".into(), json!({"brush": {"size": 60.0, "hardness": 0.0}})),
        ("Radial".into(), "gradient".into(), json!({"toolOptions": {"gradient_style": "radial", "fill_opacity": 40.0, "gradient_blend_mode": "Screen"}})),
        ("Square".into(), "crop".into(), json!({"toolOptions": {"crop_ratio": "1:1"}})),
        ("Five Points".into(), "star".into(), json!({})),
        ("Headline".into(), "type".into(), json!({"toolOptions": {"type_font": "Inter", "type_size": 24.0}, "foreground": [0.5, 0.25, 0.0, 1.0]})),
        ("Mine".into(), "someFutureTool".into(), json!({"x": 1})),
    ]
}

fn write(presets: &[(String, String, Value)]) -> Vec<u8> {
    let entries: Vec<TplEntry> = presets.iter().map(|(n, t, o)| TplEntry { name: n, tool: t, options: o }).collect();
    let (bytes, report) = write_tpl(&entries).unwrap();
    assert!(report.is_empty(), "{report:?}");
    bytes
}

#[test]
fn write_then_read_keeps_every_preset() {
    let presets = round_trip_presets();
    let bytes = write(&presets);
    let imp = read_tpl(&bytes).unwrap();
    assert!(imp.warnings.is_empty(), "{:?}", imp.warnings);
    let got: Vec<(String, String, Value)> = imp.presets.iter().map(|p| (p.name.clone(), p.tool.clone(), p.options.clone())).collect();
    assert_eq!(got, presets);
    assert_eq!(imp.presets[0].class, "paintbrushTool");
    assert_eq!(imp.presets[4].class, "polygonTool");
    assert_eq!(imp.presets[6].class, "someFutureTool");
    // One tip in `samp`, written at 16 bits and named in `pigmentData`.
    let secs = sections(&bytes, &mut Vec::new());
    assert!(secs.samp.is_some());
    let utf16: Vec<u8> = PIGMENT_FORMAT.encode_utf16().flat_map(u16::to_be_bytes).collect();
    assert!(bytes.windows(utf16.len()).any(|w| w == utf16));
}

#[test]
fn photoshop_reads_the_written_brushes_and_tools() {
    let bytes = without_pigment_data(&write(&round_trip_presets()));
    let imp = read_tpl(&bytes).unwrap();
    // The future tool has no class Photoshop knows.
    assert_eq!(imp.presets.len(), 6, "{:?}", imp.warnings);
    let textured = find(&imp, "Textured");
    let b = &textured.options["brush"];
    assert!(close(&b["opacity"], 0.7) && close(&b["flow"], 0.3) && close(&b["size"], 5.0), "{b}");
    assert_eq!(b["mode"], json!("Overlay"));
    let tile: GrayTile = serde_json::from_value(b["tip"]["sampled"].clone()).unwrap();
    assert_eq!(tile, GrayTile::from_fn(5, 3, |x, y| (x as f32 * 0.2 + y as f32 * 0.1).min(1.0)));
    let eraser = find(&imp, "Soft Eraser");
    assert!(close(&eraser.options["brush"]["size"], 60.0) && close(&eraser.options["brush"]["hardness"], 0.0));
    assert_eq!(find(&imp, "Radial").options["toolOptions"], json!({"fill_opacity": 40.0, "gradient_blend_mode": "Screen"}));
    assert_eq!(find(&imp, "Headline").options["toolOptions"], json!({"type_font": "Inter", "type_size": 24.0}));
    assert_eq!(find(&imp, "Five Points").tool, "polygon");
    assert_eq!(find(&imp, "Square").tool, "crop");
}

#[test]
fn truncated_and_foreign_files() {
    assert!(read_tpl(b"").is_err());
    assert!(read_tpl(b"8BTP\0\x01").is_err());
    assert!(read_tpl(b"8BPS\0\x01\0\x02rest").is_err());
    let bytes = write(&round_trip_presets());
    for cut in 0..bytes.len() {
        match read_tpl(&bytes[..cut]) {
            Err(_) => assert!(cut < 8, "a {cut}-byte prefix is a .tpl header"),
            // A cut in the last section's padding loses no preset, but still says so.
            Ok(imp) => assert!(imp.presets.len() <= 7 && !imp.warnings.is_empty(), "{cut}: {:?}", imp.warnings),
        }
    }
    // Flipped bytes never panic.
    for i in (8..bytes.len()).step_by(7) {
        let mut b = bytes.clone();
        b[i] ^= 0x5a;
        let _ = read_tpl(&b);
    }
    let imp = read_tpl(b"8BTP\0\x01\0\x02").unwrap();
    assert!(imp.presets.is_empty() && imp.warnings == ["the file holds no tool presets"]);
}

#[test]
fn a_file_without_sections_is_scanned_for_descriptors() {
    let d = Descriptor::new("null").with(
        "Prst",
        DValue::List(vec![DValue::Descriptor(
            Descriptor::new("toolPreset").with("Nm  ", text_value("Zoom In")).with("Tool", DValue::Descriptor(Descriptor::new("zoomTool"))),
        )]),
    );
    let mut file = b"8BTP\0\x01\0\x02\0\0".to_vec();
    file.extend_from_slice(&VersionedDescriptor::new(d).to_bytes());
    let imp = read_tpl(&file).unwrap();
    assert_eq!(imp.presets.len(), 1);
    assert_eq!(imp.presets[0].tool, "zoom");
}

#[test]
fn the_tool_tables_agree() {
    for (tool, class) in TOOL_CLASSES {
        assert_eq!(class_for_tool(tool), Some(*class), "{tool}");
        let back = tool_for_class(class).unwrap();
        assert_eq!(class_for_tool(back), Some(*class), "{class}");
    }
    for (js, tool) in JS_TOOLS {
        assert!(TOOL_CLASSES.iter().any(|(t, _)| t == tool), "{js} → {tool}");
    }
    for (_, tool) in CLASS_ALIASES {
        assert!(TOOL_CLASSES.iter().any(|(t, _)| t == tool), "{tool}");
    }
    for t in PAINTING {
        assert!(TOOL_CLASSES.iter().any(|(n, _)| n == t), "{t}");
    }
    assert_eq!(class_for_tool("Clone Stamp"), Some("cloneStampTool"));
    assert_eq!(class_for_tool("nothing"), None);
}
