//! Pigment: Photoshop's Default Actions set (PORTS-A rows 37 and 38, §5.3).
//!
//! Photoshop and the JavaScript Pigment (`renderer/lib/actions/defaults.js` `defaultActions`)
//! start with a set called "Default Actions". These are the JavaScript app's ten actions,
//! translated step by step to this engine's commands, plus two of Photoshop's other three where
//! the commands exist (Make Clip Path (selection), Mixer Brush Cloning Paint Setup), in
//! Photoshop's order. Every step is an ordinary step: expand it in the Actions panel to see or
//! change its settings.
//!
//! Left out, and why:
//! - **Save As Photoshop PDF**: a played Save As in Pigment writes to its recorded path (the
//!   player pauses only for filter and adjustment dialogs, not for Save As), so the step would
//!   write a fixed file instead of asking where, as Photoshop's does.
//! - **Mixer Brush Cloning Paint Setup**'s tool switch: choosing a tool is not an action step
//!   here, so the action sets up the layer and the Mixer Brush's options; pick the Mixer Brush
//!   to paint.
//! - **Cast Shadow (type)**'s slant: Free Transform's relative form scales, rotates and moves but
//!   has no skew, and a matrix would depend on where the layer sits. The shadow is flattened
//!   onto the text's base line instead.
//!
//! Where the set comes from: Reset Actions… (`actions.reset`, `library_commands::basics`) and, in
//! the desktop app only ([`seed_on_first_launch`]), a new preset store on first launch. It is
//! never re-created when the user deletes it (Photoshop does not either; the JavaScript app did).
//! The names stay English, as in the files Photoshop ships; the interface translates them at
//! display time.

use std::sync::atomic::{AtomicBool, Ordering};

use craft::automation::actions::ActionList;
use serde_json::{Value, json};

use crate::actions_cmds::{Action, ActionStep, ActionsFile};
use crate::preset_store::{ACTIONS_FILE, INDEX_FILE, PresetBackend};

#[cfg(test)]
mod tests;

/// The set's name, as Photoshop and the JavaScript Pigment call it.
pub const SET: &str = "Default Actions";

fn step(command: &str, params: Value) -> ActionStep {
    ActionStep::new(command, params)
}

fn plain(command: &str) -> ActionStep {
    step(command, json!({}))
}

/// One quarter of the canvas: select all, then scale the selection to half about `corner`.
fn quadrant(corner: &str) -> [ActionStep; 2] {
    [plain("select.all"), step("select.transformSelection", json!({"scaleX": 50, "scaleY": 50, "reference": corner}))]
}

fn color_balance(midtones: [i32; 3]) -> ActionStep {
    step("image.adjustments.colorBalance", json!({"shadows": [0, 0, 0], "midtones": midtones, "highlights": [0, 0, 0], "preserveLuminosity": true}))
}

/// The actions of the set, in Photoshop's order, with `set` as their set.
pub fn default_actions(set: &str) -> Vec<Action> {
    let actions = vec![
        // Needs a selection: softens its edge, lifts it onto its own layer and puts a white layer
        // underneath.
        Action::new(
            "Vignette (selection)",
            vec![
                step("select.modify.feather", json!({"radius": 5})),
                plain("layer.new.layerViaCopy"),
                plain("select.deselect"),
                step("layer.new.layer", json!({"name": "Vignette Background"})),
                step("edit.fill", json!({"contents": "white"})),
                plain("layer.arrange.sendBackward"),
            ],
        ),
        // A 50 pixel bevelled frame on its own layer; its shape is kept as the channel "Frame".
        Action::new(
            "Frame Channel – 50 pixel",
            vec![
                step("layer.new.layer", json!({"name": "Frame"})),
                plain("select.all"),
                step("edit.stroke", json!({"width": 50, "color": "#9c9c9c", "location": "inside"})),
                step("select.loadSelection", json!({"channel": "transparency"})),
                step("select.saveSelection", json!({"name": "Frame"})),
                plain("select.deselect"),
                step("layer.layerStyle.bevelEmboss", json!({"style": "inner", "size": 12, "depth": 150, "soften": 2})),
                step("layer.layerStyle.innerShadow", json!({"distance": 2, "size": 6, "opacity": 50})),
            ],
        ),
        // Grows the canvas by 50 pixels on every side and fills the border with bevelled wood grain.
        Action::new(
            "Wood Frame – 50 pixel",
            vec![
                step("image.canvasSize", json!({"width": 100, "height": 100, "relative": true, "anchor": "center", "extensionColor": "white"})),
                step("layer.new.layer", json!({"name": "Wood Frame"})),
                plain("select.all"),
                step("edit.stroke", json!({"width": 50, "color": "#8a5a2b", "location": "inside"})),
                step("select.loadSelection", json!({"channel": "transparency"})),
                step("filter.render.fibers", json!({"variance": 20, "strength": 30, "seed": 3, "foreground": "#5b3716", "background": "#b07a3f"})),
                plain("select.deselect"),
                step("layer.layerStyle.bevelEmboss", json!({"style": "inner", "size": 14, "depth": 180, "soften": 1})),
                step("layer.layerStyle.dropShadow", json!({"distance": 3, "size": 8, "opacity": 60})),
            ],
        ),
        // For a type layer: a flattened, blurred black copy behind it.
        Action::new(
            "Cast Shadow (type)",
            vec![
                plain("layer.duplicate"),
                plain("layer.rasterize.layer"),
                step("edit.fill", json!({"contents": "black", "preserveTransparency": true})),
                step("edit.transform", json!({"scaleY": 50, "reference": "bottom"})),
                step("filter.blur.gaussianBlur", json!({"radius": 3})),
                step("layer.setProps", json!({"opacity": 0.5})),
                plain("layer.arrange.sendBackward"),
            ],
        ),
        // For a type layer: a rippled, faded mirror image below it.
        Action::new(
            "Water Reflection (type)",
            vec![
                plain("layer.duplicate"),
                plain("layer.rasterize.layer"),
                step("edit.transform", json!({"scaleY": -100, "reference": "bottom"})),
                step("filter.distort.ripple", json!({"amount": 20, "size": "large"})),
                step("filter.blur.gaussianBlur", json!({"radius": 1})),
                step("layer.setProps", json!({"opacity": 0.45})),
            ],
        ),
        Action::new(
            "Custom RGB to Grayscale",
            vec![step(
                "image.adjustments.channelMixer",
                json!({"red": [100, 0, 0, 0], "green": [0, 100, 0, 0], "blue": [0, 0, 100, 0], "gray": [24, 68, 8, 0], "monochrome": true}),
            )],
        ),
        Action::new(
            "Molten Lead",
            vec![
                step("filter.gallery.chrome", json!({"detail": 4, "smoothness": 7})),
                step("image.adjustments.levels", json!({"inBlack": 30, "gamma": 1.1, "inWhite": 225, "outBlack": 0, "outWhite": 255})),
                step("image.adjustments.hueSaturation", json!({"hue": 215, "saturation": 12, "lightness": 0, "colorize": true})),
            ],
        ),
        // Needs a selection: its outline becomes the clipping path a PSD carries to page layout.
        Action::new(
            "Make Clip Path (selection)",
            vec![
                step("select.toWorkPath", json!({"tolerance": 2})),
                step("path.rename", json!({"name": "work", "to": "Path 1"})),
                step("path.clippingPath.set", json!({"name": "Path 1", "flatness": 0})),
            ],
        ),
        // A desaturated copy of the layer under a colourising Hue/Saturation adjustment layer.
        Action::new(
            "Sepia Toning (layer)",
            vec![
                plain("layer.duplicate"),
                plain("image.adjustments.desaturate"),
                step("layer.newAdjustmentLayer.hueSaturation", json!({"hue": 35, "saturation": 28, "lightness": 0, "colorize": true})),
            ],
        ),
        // A different colour cast in each quarter of the image, whatever its size.
        Action::new("Quadrant Colors", {
            let mut steps = Vec::new();
            for (corner, midtones) in [("topLeft", [60, 0, 0]), ("topRight", [0, 0, -60]), ("bottomLeft", [0, 60, 0]), ("bottomRight", [0, 0, 60])] {
                steps.extend(quadrant(corner));
                steps.push(color_balance(midtones));
            }
            steps.push(plain("select.deselect"));
            steps
        }),
        Action::new(
            "Gradient Map",
            vec![step("layer.newAdjustmentLayer.gradientMap", json!({"stops": [[0, "#1b1464"], [0.5, "#d4145a"], [1, "#fbb03b"]], "reverse": false}))],
        ),
        // An empty layer to paint on with the Mixer Brush, which picks its colours up from the
        // image underneath and starts each stroke clean.
        Action::new(
            "Mixer Brush Cloning Paint Setup",
            vec![
                step("layer.new.layer", json!({"name": "Mixer Brush Painting"})),
                step("brush.mixer.sampleAllLayers", json!({"on": true})),
                step("brush.mixer.autoLoad", json!({"on": false})),
                step("brush.mixer.autoClean", json!({"on": true})),
            ],
        ),
    ];
    actions.into_iter().map(|action| Action { set: Some(set.to_owned()), ..action }).collect()
}

/// The set as an `actions.json` file.
pub fn default_file(set: &str) -> ActionsFile {
    ActionsFile::new(default_actions(set), Vec::new())
}

static SEED: AtomicBool = AtomicBool::new(false);

/// The desktop app calls this before it opens the preset store: a new store then starts with
/// the Default Actions set. Tests, the CLI and the web app start with an empty list.
pub fn seed_on_first_launch() {
    SEED.store(true, Ordering::Relaxed);
}

/// The list a store without `actions.json` opens with: the Default Actions set when the
/// desktop app asked for it ([`seed_on_first_launch`]) and the store is new, else empty.
pub(crate) fn first_launch(backend: &dyn PresetBackend) -> ActionList {
    seeded(backend, SEED.load(Ordering::Relaxed))
}

/// [`first_launch`] with the flag given. A store is new when it has neither `actions.json` nor
/// the brush index: a user who cleared every action has an `actions.json` (empty) and keeps an
/// empty panel. The set is written at once, so it outlives a later brush change.
pub(crate) fn seeded(backend: &dyn PresetBackend, seed: bool) -> ActionList {
    let new = seed && backend.list().is_ok_and(|files| !files.iter().any(|(name, _)| name == INDEX_FILE || name == ACTIONS_FILE));
    if !new {
        return ActionList::new();
    }
    let file = default_file(SET);
    if let Ok(text) = file.to_json() {
        // A failed write only means the set is offered again next time.
        let _ = backend.write(ACTIONS_FILE, text.as_bytes());
    }
    ActionList::load(file).0
}
