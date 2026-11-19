//! PhotoCraft's driver over its one framework [`ScreenPick`]: every screen colour pick, from the
//! Color Picker dialog and from colour popovers, runs through these functions. The capture, the
//! capture windows, the loupe and the pixel mapping are the framework's
//! (`craft::color_ui::ui::{ScreenPick, ScreenColorPicker}`).
use crate::PhotocraftApp;
use craft::color_ui::ui::{ScreenColorPicker, ScreenPickGesture, ScreenPickerWords};
use craft::theme::Srgba;
use craft::ui::runtime::env::Env;
use egui::Context;
use std::hash::{Hash, Hasher};

/// What a pick belongs to: the active document, its active layer and the top dialog. A pick whose
/// target changes before it ends is cancelled, and a colour it left is dropped.
fn target_hash(app: &PhotocraftApp) -> u64 {
    let active = app.session.active();
    let target = (active.map(|s| s.doc.id), active.and_then(|s| s.active_layer), app.framework.dialogs.stack().top());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    target.hash(&mut hasher);
    hasher.finish()
}

/// Runs the pick for one pass, before the shortcuts: starts a requested capture (the test source
/// in `services.screen_capture`, else the platform capture) and settles a finished one. Returns
/// whether a pick is still running.
pub fn tick(app: &mut PhotocraftApp, ctx: &Context) -> bool {
    let target = target_hash(app);
    match &app.services.screen_capture {
        Some(make) => app.screen_pick.tick_with(ctx, target, &|| make()),
        None => app.screen_pick.tick(ctx, target),
    }
    busy(app)
}

<<<<<<< ours
/// The picker window: hidden until its snapshot has been painted (#3210).
fn viewport_builder(ctx: &Context, image: &ScreenImage) -> egui::ViewportBuilder {
    let mut builder = crate::os_window::builder()
        .with_title(tl!("Pigment — Screen Color Picker"))
        .with_decorations(false)
        .with_resizable(false)
        .with_position(image.position / ctx.zoom_factor())
        .with_inner_size(image.size / ctx.zoom_factor())
        // Not `AlwaysOnTop` here: a monitor-sized window created topmost makes the DX12 backend
        // fail its swapchain creation (0x887A0001) and the app panics. The level is raised once
        // the first frame has been painted, in `show`.
        // Do not expose the native window's empty first frame over the desktop.
        // The viewport is made visible after its snapshot has been painted below.
        .with_visible(false)
        .with_clamp_size_to_monitor_size(false);
    if let Some(monitor) = image.monitor {
        builder = builder.with_monitor(monitor);
    }
    builder
}
pub fn show(ctx: &Context) {
    let r = runtime(ctx);
    let s = lock(&r);
    let images = s.images.clone();
    let generation = s.generation;
    drop(s);
    for (n, snapshot) in images.into_iter().enumerate() {
        let Snapshot { image, texture, conversion } = snapshot;
        let shared = r.clone();
        let vid = egui::ViewportId::from_hash_of(("screen-color", generation, n));
        let builder = viewport_builder(ctx, &image);
        // Immediate, so it paints inside the main window's own frame: as a deferred viewport the
        // main window stopped being redrawn on Windows (OpenGL) once the picker was up, so a click
        // or Esc was never turned into an answer and the overlay could not be left.
        ctx.show_viewport_immediate(vid, builder, move |ui, _| {
            {
                let s = lock(&shared);
                if s.generation != generation || s.owner.is_none() {
                    ui.ctx().send_viewport_cmd(egui::ViewportCommand::Close);
                    return;
                }
            }
            frame(ui, &shared, &image, &texture, conversion.as_deref());
            // Showing a new native viewport before this frame is painted can briefly cover
            // the screen with the window's default white clear color.
            ui.ctx().send_viewport_cmd(egui::ViewportCommand::Visible(true));
            // Once per picker window (`show` runs every frame, so a local flag would resend it):
            // raise it, and take the keyboard so Esc reaches the picker: a window shown later
            // isn't always given focus by the OS, and the picker covers the screen (#4291).
            let raised = Id::unique(("screen-picker-raised", ui.ctx().viewport_id()));
            if !ui.ctx().data_mut(|d| std::mem::replace(d.get_temp_mut_or_default::<bool>(raised), true)) {
                ui.ctx().send_viewport_cmd(egui::ViewportCommand::WindowLevel(egui::WindowLevel::AlwaysOnTop));
                ui.ctx().send_viewport_cmd(egui::ViewportCommand::Focus);
            }
        });
    }
=======
/// Follows the picker button's press for `owner` (a dialog id, a popover id): a click starts a
/// capture; a held drag inside the app's windows returns the live sample under the pointer.
pub fn hold(app: &mut PhotocraftApp, ctx: &Context, owner: impl Hash, gesture: ScreenPickGesture) -> Option<Srgba> {
    app.screen_pick.hold(ctx, owner, gesture)
>>>>>>> theirs
}

/// The colour `owner`'s pick ended with, once; another owner gets nothing.
pub fn take(app: &mut PhotocraftApp, owner: impl Hash) -> Option<Srgba> {
    app.screen_pick.take(owner)
}

/// Whether a pick runs or waits for its capture; the app takes no other input meanwhile.
pub fn busy(app: &PhotocraftApp) -> bool {
    app.screen_pick.busy()
}

/// Ends a running or requested pick without a colour.
pub fn cancel(app: &mut PhotocraftApp) {
    app.screen_pick.cancel();
}

/// Shows the running pick's capture windows, once per pass after the app's UI, and puts a capture
/// failure in the status bar.
pub fn show(app: &mut PhotocraftApp, ui: &mut egui::Ui) {
    // A frame sampled during a held drag converts from the monitor's profile to sRGB; only a running pick needs it.
    if app.screen_pick.busy() {
        app.screen_pick.set_monitor(&app.session.color.monitor());
    }
    ScreenColorPicker::new(&mut app.screen_pick, "PhotoCraft").show(ui);
    // The status is taken here rather than in `tick`: the words come from the Env, which needs a
    // `Ui`, and `show` runs after every settle of the pass (tick's and the windows').
    let words = Env::of(ui).words::<ScreenPickerWords>();
    if let Some(message) = app.screen_pick.take_status(&words) {
        app.ui.status = message.text.as_str().to_owned();
        app.ui.status_error = true;
    }
}
