//! Pigment (PORTS-B B2, row 19): the Character panel menu, in Photoshop's order: Faux Bold, Faux
//! Italic, All Caps, Small Caps, Superscript, Subscript, Underline, Strikethrough (checked while
//! on); Fractional Widths, System Layout, No Break; Reset Character. Every row is an engine
//! command (B1's `type.character.*`, `type.fractionalWidths`, `type.systemLayout`,
//! `type.noBreak`, `type.resetCharacter`), run on the Character panel's target: the edited
//! layer's selected characters (or its whole text), else every selected type layer. Without a
//! type target the character toggles set the defaults of the next Type-tool layer, as the panel's
//! buttons do.
//!
//! The superscript, subscript and small caps chords (⇧⌘=, ⌥⇧⌘=, ⇧⌘H) are Photoshop's while type is
//! edited: [`TypeChords`] holds them in the text editor's typing scope (see its docs).

use craft::ui::contract::CommandSet;
use craft::ui::menu::PanelRow;
use craft::ui::runtime::commands::{CommandRef, CommandState};
use serde_json::{Value, json};

use super::defaults::{apply_defaults, formatting_params, target_text};
use super::{PhotocraftApp, values};

/// The menu's rows: a command id, or `None` for a separator.
pub(crate) const CHARACTER_ITEMS: &[Option<&str>] = &[
    Some("type.character.fauxBold"),
    Some("type.character.fauxItalic"),
    Some("type.character.allCaps"),
    Some("type.character.smallCaps"),
    Some("type.character.superscript"),
    Some("type.character.subscript"),
    Some("type.character.underline"),
    Some("type.character.strikethrough"),
    None,
    Some(FRACTIONAL_WIDTHS),
    Some(SYSTEM_LAYOUT),
    Some(NO_BREAK),
    None,
    Some(RESET_CHARACTER),
];

const FRACTIONAL_WIDTHS: &str = "type.fractionalWidths";
const SYSTEM_LAYOUT: &str = "type.systemLayout";
const NO_BREAK: &str = "type.noBreak";
const RESET_CHARACTER: &str = "type.resetCharacter";

/// Whether `id` is one of the menu's commands: a click or a chord without a target gets the
/// Character panel's (`menus::invoke`'s type arm).
pub(crate) fn takes_panel_target(id: &str) -> bool {
    CHARACTER_ITEMS.iter().flatten().any(|&item| item == id)
}

/// Superscript, Subscript and Small Caps on Photoshop's chords while type is edited. Photoshop
/// binds them only then: elsewhere ⇧⌘= is View › Zoom In's alternate and ⇧⌘H View › Show › Target
/// Path. The set sits in the framework text editor's typing scope, so its keys come before the
/// application's while the editor holds them; the editor ignores ids it does not know, and the fired
/// command reaches [`run_fired`] (`character` registry entry).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, CommandSet)]
#[command(prefix = "pigmentTypeChords", scope = "textEditor", typing)]
pub(crate) enum TypeChords {
    /// Toggle Superscript on the selection.
    #[command(label = "Superscript", default = "Cmd+Shift+=")]
    Superscript,
    /// Toggle Subscript on the selection.
    #[command(label = "Subscript", default = "Cmd+Alt+Shift+=")]
    Subscript,
    /// Toggle Small Caps on the selection.
    #[command(label = "Small Caps", default = "Cmd+Shift+H")]
    SmallCaps,
}

impl TypeChords {
    fn command(self) -> &'static str {
        match self {
            Self::Superscript => "type.character.superscript",
            Self::Subscript => "type.character.subscript",
            Self::SmallCaps => "type.character.smallCaps",
        }
    }
}

/// Whether the toggle `id` is on at the target (a mixed selection is off), or `None` for a row
/// that is no toggle.
fn checked(app: &PhotocraftApp, id: &str) -> Option<bool> {
    use craft::text::ui::character::{BaselinePosition, Caps};
    let v = values::character_values(app);
    Some(match id {
        "type.character.fauxBold" => v.faux_bold == Some(true),
        "type.character.fauxItalic" => v.faux_italic == Some(true),
        "type.character.allCaps" => v.caps == Some(Caps::AllCaps),
        "type.character.smallCaps" => v.caps == Some(Caps::SmallCaps),
        "type.character.superscript" => v.position == Some(BaselinePosition::Superscript),
        "type.character.subscript" => v.position == Some(BaselinePosition::Subscript),
        "type.character.underline" => v.underline == Some(true),
        "type.character.strikethrough" => v.strikethrough == Some(true),
        NO_BREAK => {
            let (chars, _) = values::target_styles(app);
            !chars.is_empty() && chars.iter().all(|c| c.no_break)
        }
        FRACTIONAL_WIDTHS => target_text(app).is_some_and(|t| t.fractional_widths),
        SYSTEM_LAYOUT => target_text(app).is_some_and(|t| t.system_layout),
        _ => return None,
    })
}

/// The style key a character toggle sets on the defaults of the next layer (no type target).
fn default_props(id: &str, on: bool) -> Option<Value> {
    Some(match id {
        "type.character.fauxBold" => json!({"fauxBold": on}),
        "type.character.fauxItalic" => json!({"fauxItalic": on}),
        "type.character.allCaps" => json!({"caps": if on { "allCaps" } else { "normal" }}),
        "type.character.smallCaps" => json!({"caps": if on { "smallCaps" } else { "normal" }}),
        "type.character.superscript" => json!({"baseline": if on { "superscript" } else { "normal" }}),
        "type.character.subscript" => json!({"baseline": if on { "subscript" } else { "normal" }}),
        "type.character.underline" => json!({"underline": on}),
        "type.character.strikethrough" => json!({"strikethrough": on}),
        NO_BREAK => json!({"noBreak": on}),
        _ => return None,
    })
}

/// Whether row `id` can run: every row on a type target; without one, the character toggles (the
/// defaults); Fractional Widths not while System Layout is on (Photoshop greys it).
fn enabled(app: &PhotocraftApp, has_target: bool, id: &str) -> bool {
    if !has_target {
        return default_props(id, true).is_some();
    }
    id != FRACTIONAL_WIDTHS || !checked(app, SYSTEM_LAYOUT).unwrap_or(false)
}

/// The Character panel menu's rows: labels and chords from the command catalogue.
pub(crate) fn character_rows(_app: &PhotocraftApp) -> Vec<PanelRow> {
    CHARACTER_ITEMS.iter().map(|item| item.map_or(PanelRow::Separator, |id| PanelRow::Command(CommandRef::new(id)))).collect()
}

/// Each row's state: enabled, and checked for the toggles that are on.
pub(crate) fn character_states(app: &PhotocraftApp) -> Vec<(CommandRef, CommandState)> {
    let has_target = formatting_params(app).is_some();
    CHARACTER_ITEMS
        .iter()
        .flatten()
        .map(|&id| {
            let mut state = CommandState::new().enabled(enabled(app, has_target, id));
            if let Some(on) = checked(app, id) {
                state = state.checked(on);
            }
            (CommandRef::new(id), state)
        })
        .collect()
}

/// Runs row (or chord) `id` on the panel's target. A toggle is set to the opposite of what the
/// menu shows, so it follows the checkmark the user saw.
pub(crate) fn run_item(app: &mut PhotocraftApp, id: &str) {
    let shown = checked(app, id);
    let Some(mut params) = formatting_params(app) else {
        if let Some(props) = default_props(id, !shown.unwrap_or(false)) {
            apply_defaults(app, &props);
        }
        return;
    };
    if !enabled(app, true, id) {
        return;
    }
    if let Some(on) = shown {
        params["on"] = json!(!on);
    }
    if let Err(e) = app.run(id, params) {
        app.ui.status = e;
        app.ui.status_error = true;
    }
}

/// Runs a fired row of the Character panel menu, or one of [`TypeChords`]; `false` for another
/// panel's command.
pub(crate) fn run_fired(app: &mut PhotocraftApp, _ctx: &egui::Context, command: &CommandRef) -> bool {
    let id = match TypeChords::from_ref(command) {
        Some(chord) => chord.command(),
        None if takes_panel_target(&command.id) => command.id.as_str(),
        None => return false,
    };
    let id = id.to_owned();
    run_item(app, &id);
    true
}
