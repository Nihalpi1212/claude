//! Pigment: the Tool Presets panel menu and `.tpl` files (P2).

use std::sync::{Arc, Mutex};

use craft::host::{Picked, ScriptedFiles};
use photocraft_io::tpl_map::{JS_TOOLS, TOOL_CLASSES};

use super::*;
use crate::panels::preset_panels::tool_presets::tool_id;
use crate::state::Tool;

/// Written by the JavaScript Pigment 0.5 (`crates/io/tests/fixtures/pigment-0.4/README.md`).
const JS_FILE: &[u8] = include_bytes!("../../../../../io/tests/fixtures/pigment-0.4/wip05-tool-presets.tpl");

type Written = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

fn app_with(files: Vec<Picked>) -> (Box<PhotocraftApp>, Written) {
    let written = Arc::new(Mutex::new(Vec::new()));
    let sink = written.clone();
    let services = crate::Services {
        files: Some(Arc::new(ScriptedFiles::answering(files))),
        write: Some(Box::new(move |path, data| {
            sink.lock().unwrap().push((path.to_string(), data.to_vec()));
            Ok(())
        })),
        ..Default::default()
    };
    (PhotocraftApp::new(photocraft_engine::Session::new(), services), written)
}

fn fire(app: &mut PhotocraftApp, cmd: CommandRef) {
    let ctx = app.ctx().clone();
    assert!(run(app, &ctx, &cmd), "the Tool Presets menu runs its own rows");
    app.poll_file_dialog();
}

fn names(app: &PhotocraftApp) -> Vec<String> {
    app.session.presets.tool_presets.iter().map(|t| t.name.clone()).collect()
}

/// io's tool-class table speaks the shell's tool names, and names every tool the shell has.
#[test]
fn the_tool_class_table_resolves_through_tool_from_name() {
    for (tool, class) in TOOL_CLASSES {
        let t = Tool::from_name(tool).unwrap_or_else(|| panic!("{tool} ({class}) is no tool"));
        assert_eq!(tool_id(t), *tool, "{class}");
    }
    for (js, tool) in JS_TOOLS {
        assert!(Tool::from_name(tool).is_some(), "{js} → {tool}");
    }
    for t in Tool::ALL {
        assert!(TOOL_CLASSES.iter().any(|(n, _)| *n == tool_id(t)), "{t:?} has no Photoshop class");
    }
}

#[test]
fn the_menu_lists_load_replace_save_and_reset() {
    let (app, _) = app_with(vec![]);
    let rows = rows(&app);
    let commands: Vec<CommandRef> = rows
        .iter()
        .filter_map(|r| match r {
            PanelRow::Command(c) => Some(c.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        commands,
        [
            CommandRef::from(PresetCommands::Load),
            CommandRef::from(PresetCommands::Replace),
            CommandRef::from(PresetCommands::Save),
            CommandRef::from(ToolPresetsCommand::Reset)
        ]
    );
    let defs = ToolPresetsCommand::defs().unwrap();
    assert!(defs.iter().any(|d| d.label == "Reset Tool Presets…"), "{defs:?}");
    // Save… waits for a preset.
    let save = |app: &PhotocraftApp| states(app).into_iter().find(|(c, _)| *c == CommandRef::from(PresetCommands::Save)).unwrap().1;
    assert!(save(&app).is_enabled());
    let (mut empty, _) = app_with(vec![]);
    empty.session.presets.tool_presets.clear();
    assert!(!save(&empty).is_enabled());
    // The Tool Presets panel carries these rows.
    let entry = crate::panels::registry::entry("toolPresets").expect("the panel is registered");
    assert_eq!((entry.rows)(&app).len(), rows.len());
}

#[test]
fn save_writes_every_tool_preset_and_load_reads_them_back() {
    let (mut a, written) = app_with(vec![Picked::Paths(vec!["/tmp/Mine.tpl".into()])]);
    fire(&mut a, CommandRef::from(PresetCommands::Save));
    assert!(!a.ui.status_error, "{}", a.ui.status);
    assert!(a.ui.status.contains("Mine.tpl"), "{}", a.ui.status);
    let files = written.lock().unwrap().clone();
    let [(path, bytes)] = files.as_slice() else { panic!("one file written, got {}", files.len()) };
    assert_eq!(path, "/tmp/Mine.tpl");
    assert_eq!(&bytes[..4], b"8BTP");
    let read = photocraft_io::tpl_map::read_tpl(bytes).unwrap();
    assert_eq!(read.presets.iter().map(|p| p.name.clone()).collect::<Vec<_>>(), names(&a));

    // Load… into an empty list brings every one back.
    let (mut b, _) = app_with(vec![Picked::Contents(vec![("Mine.tpl".into(), bytes.clone())])]);
    b.session.presets.tool_presets.clear();
    fire(&mut b, CommandRef::from(PresetCommands::Load));
    assert!(!b.ui.status_error, "{}", b.ui.status);
    assert_eq!(names(&b), names(&a));
    assert!(b.ui.status.contains("Loaded 5 tool presets from Mine.tpl"), "{}", b.ui.status);
}

#[test]
fn replace_asks_first_then_takes_the_files_presets() {
    let (mut app, _) = app_with(vec![
        Picked::Contents(vec![("Old Pigment.tpl".into(), JS_FILE.to_vec())]),
        Picked::Contents(vec![("Old Pigment.tpl".into(), JS_FILE.to_vec())]),
    ]);
    let before = names(&app);
    fire(&mut app, CommandRef::from(PresetCommands::Replace));
    let id = crate::dialogs::alerts::prompt_tagged::<ReplacePrompt>(&app).expect("Replace asks first");
    crate::dialogs::testing::cancel(&mut app, id).unwrap();
    assert_eq!(names(&app), before, "Cancel keeps the list");
    fire(&mut app, CommandRef::from(PresetCommands::Replace));
    let id = crate::dialogs::alerts::prompt_tagged::<ReplacePrompt>(&app).expect("Replace asks first");
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    assert_eq!(names(&app), ["Soft Round 30", "Sampled Pencil", "Block Eraser", "Red Gradient", "Headline", "Spot Heal 20", "Dodge Highlights"]);
    // The Adjustment Brush preset is noted.
    assert!(app.ui.status.contains("notes: "), "{}", app.ui.status);
    // Choosing one switches the tool and its options.
    crate::panels::preset_panels::tool_presets::select(&mut app, "Block Eraser");
    assert_eq!(app.ui.tool, Tool::Eraser);
    assert_eq!(app.ui.tool_options.eraser_mode, "pencil");
    assert!(app.ui.tool_options.erase_to_history);
}

#[test]
fn reset_asks_first_then_brings_the_built_ins_back() {
    let (mut app, _) = app_with(vec![]);
    let before = names(&app);
    app.session.presets.tool_presets.truncate(1);
    fire(&mut app, CommandRef::from(ToolPresetsCommand::Reset));
    let id = crate::dialogs::alerts::prompt_tagged::<ResetPrompt>(&app).expect("Reset asks first");
    crate::dialogs::testing::confirm(&mut app, id).unwrap();
    assert_eq!(names(&app), before);
}

/// File › Open and drag-and-drop take a `.tpl` too.
#[test]
fn file_open_of_a_tpl_loads_its_tool_presets() {
    let (mut app, _) = app_with(vec![]);
    assert!(crate::preset_files_ui::is_preset_file("Kit.TPL"));
    crate::preset_files_ui::open(&mut app, "Kit.tpl", JS_FILE).expect("a .tpl is a preset file").unwrap();
    assert!(names(&app).contains(&"Spot Heal 20".to_string()));
    let heal = app.session.presets.tool_presets.iter().find(|t| t.name == "Spot Heal 20").unwrap();
    assert_eq!(Tool::from_name(&heal.tool), Some(Tool::SpotHealing));
}
