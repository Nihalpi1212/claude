//! Help › Check for Updates (Pigment opens its releases page; no check starts at launch, see
//! docs/FORK.md) and the window craft-update's `Updater` draws for the last update's outcome.
//!
//! Pigment: upstream's `Updater` stays for its result window, but nothing here ever calls
//! `check_now` or `check_at_start`: Help › Check for Updates and the window's Check Now / Check
//! Again open the releases page (`links::RELEASES`, the engine's `build_info::RELEASES`), and
//! nothing is fetched or installed.

use serde_json::Value;

use crate::PhotocraftApp;

/// The update checker's state (desktop); the web build has none.
pub(crate) struct Runtime {
    /// The one checker: the startup prompt, the manual check, the installation and the last update's outcome.
    #[cfg(not(target_arch = "wasm32"))]
    updater: craft::update::updater::Updater,
    /// The check-result dialog on the dialog host, while one is open.
    #[cfg(not(target_arch = "wasm32"))]
    result_dialog: Option<craft::ui::dialog::DialogId>,
    /// The last update's outcome opened the result window; it opens once, so closing it with `ui.set` stays closed.
    #[cfg(not(target_arch = "wasm32"))]
    outcome_announced: bool,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            updater: craft::update::updater::Updater::new(&crate::UPDATE_APP, photocraft_engine::build_info::VERSION),
            #[cfg(not(target_arch = "wasm32"))]
            result_dialog: None,
            #[cfg(not(target_arch = "wasm32"))]
            outcome_announced: false,
        }
    }
}

/// Help › Check for Updates: opens Pigment's releases page in the browser, where each release
/// (`pigment-vX.Y.Z`) lists what changed and its downloads. Nothing is fetched or installed: Pigment
/// makes no network request on its own (docs/FORK.md). The same on the web.
pub(crate) fn check(app: &mut PhotocraftApp, ctx: &egui::Context, params: Value) -> Result<Value, String> {
    if params.as_object().is_some_and(|o| !o.is_empty()) || !(params.is_null() || params.is_object()) {
        return Err("help.checkForUpdates takes no parameters".into());
    }
    let mut opened = crate::links::open(app, ctx, crate::links::RELEASES);
    opened["status"] = "opened".into();
    Ok(opened)
}

/// Once per pass: only the read of the last update's outcome (a local file, once, inside the
/// `Updater`). Pigment starts no update check at launch, whatever the hidden preference holds
/// (docs/FORK.md): `check_at_start` is never called.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn tick(app: &mut PhotocraftApp) {
    use craft::update::updater::Status;
    app.updates_rt.updater.read_last_update();
    if !app.updates_rt.outcome_announced && matches!(app.updates_rt.updater.status(), Status::Updated(_) | Status::InstallFailed(_)) {
        app.updates_rt.outcome_announced = true;
        app.ui.updates_open = true;
    }
}

/// The web build has no checker.
#[cfg(target_arch = "wasm32")]
pub(crate) fn tick(_app: &mut PhotocraftApp) {}

/// The web build has no checker.
#[cfg(target_arch = "wasm32")]
pub(crate) fn show(_app: &mut PhotocraftApp, _ctx: &egui::Context) {}

/// Drives the updater's own prompt and the check-result dialog on the framework dialog host. Runs
/// before `DialogHost::run`.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    use craft::update::stack_dialogs::{CheckChoice, UpdateCheckDialog};
    use craft::update::updater::{Action, Status};

    // An update starts, and a ready one asks the app to close, only while no work is unsaved.
    let clean = !app.has_unsaved_work();
    app.updates_rt.updater.tick(ctx);
    match app.updates_rt.updater.run(&mut app.framework.dialogs, clean) {
        Action::None => {}
        Action::OpenUrl(url) => {
            let _ = crate::links::open(app, ctx, &url);
        }
        // The guarded close path asks about unsaved work and waits for saves; the restart helper
        // relaunches once the process exits.
        Action::Close => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
        _ => {}
    }

    // A cancelled result (the dialog withdrawn below) answers nothing.
    if let Some(choice) = app.framework.dialogs.take::<UpdateCheckDialog>().and_then(|result| result.ok()) {
        app.updates_rt.result_dialog = None;
        match choice {
            // Pigment: the releases page, never a check (docs/FORK.md).
            CheckChoice::CheckNow | CheckChoice::CheckAgain => {
                let _ = check(app, ctx, Value::Null);
            }
            CheckChoice::RestartToUpdate => app.updates_rt.updater.restart_to_update(),
            CheckChoice::Close => {
                app.updates_rt.updater.dismiss_status();
                app.ui.updates_open = false;
            }
            _ => {}
        }
    }

    // An available release shows in the updater's prompt instead of the result window.
    let updater = &app.updates_rt.updater;
    let wanted = app.ui.updates_open && *updater.status() != Status::Idle && !updater.prompt_open();
    let status = updater.status().clone();
    let dialogs = &mut app.framework.dialogs;
    if wanted {
        if let Ok(id) = dialogs.open_unless_open(UpdateCheckDialog::new(photocraft_engine::build_info::VERSION)) {
            app.updates_rt.result_dialog = Some(id);
        }
        if let Some(dialog) = app.updates_rt.result_dialog.and_then(|id| dialogs.get_mut_by_id::<UpdateCheckDialog>(id)) {
            dialog.set_status(status);
        }
    } else if let Some(id) = app.updates_rt.result_dialog.take() {
        dialogs.cancel_by_id(ctx, id);
    }
}

/// The updater's installation progress or error line, for `ui.inspect`.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn status_message(app: &PhotocraftApp) -> Option<String> {
    app.updates_rt.updater.status_message()
}

/// The web build has no updater, so no message.
#[cfg(target_arch = "wasm32")]
pub(crate) fn status_message(_app: &PhotocraftApp) -> Option<String> {
    None
}

/// Offers `version` as an available release, as a check at start would, for the snapshot example.
#[cfg(not(target_arch = "wasm32"))]
pub fn preview_release(app: &mut PhotocraftApp, version: &str, url: &str) {
    app.updates_rt.updater.offer(craft::update::Release {
        tag: format!("v{version}"),
        version: craft::update::parse_version(version),
        name: format!("Pigment {version}"),
        html_url: url.into(),
        ..Default::default()
    });
    app.ui.updates_open = true;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Services, menus};
    use photocraft_engine::Session;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;

    fn app() -> Box<PhotocraftApp> {
        PhotocraftApp::new(Session::new(), Services::default())
    }

    #[cfg(not(target_arch = "wasm32"))]
    /// An app whose update checker (were a check started) counts its calls, and whose browser
    /// service records what it opened.
    fn counting_app() -> (Box<PhotocraftApp>, mpsc::Receiver<()>, Arc<Mutex<Vec<String>>>) {
        let (started, checks) = mpsc::channel();
        let started = Mutex::new(started);
        let source: craft::update::updater::CheckSource = Arc::new(move || {
            let _ = started.lock().unwrap().send(());
            Err("offline".into())
        });
        let opened: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let rec = opened.clone();
        let services = Services {
            open_url: Some(Box::new(move |u: &str| {
                rec.lock().unwrap().push(u.to_string());
                Ok(())
            })),
            ..Default::default()
        };
        let mut app = PhotocraftApp::new(Session::new(), services);
        app.updates_rt.updater = craft::update::updater::Updater::new(&crate::UPDATE_APP, photocraft_engine::build_info::VERSION).with_source(source);
        (app, checks, opened)
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn no_check_runs_at_launch_even_with_automatic_checks_on() {
        let (mut app, checks, _) = counting_app();
        app.session.edit_prefs(|p| p.general.automatically_check_updates = true);
        let ctx = app.ctx().clone();
        for t in [0.0, 1.0, 86400.0] {
            let mut output = ctx.run_ui(egui::RawInput { time: Some(t), ..Default::default() }, |ui| {
                tick(&mut app);
                show(&mut app, ui.ctx());
            });
            output.textures_delta.clear();
        }
        assert!(checks.recv_timeout(Duration::from_millis(300)).is_err(), "Pigment makes no network request on its own");
        assert_eq!(*app.updates_rt.updater.status(), craft::update::updater::Status::Idle);
        assert!(!app.ui.updates_open);
    }

    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn check_for_updates_opens_the_releases_page_and_fetches_nothing() {
        let (mut app, checks, opened) = counting_app();
        let ctx = app.ctx().clone();
        assert!(menus::is_enabled(&app, "help.checkForUpdates"));
        let r = menus::invoke(&mut app, &ctx, "help.checkForUpdates", serde_json::json!({})).unwrap();
        assert_eq!(r["url"], "https://github.com/Nihalpi1212/claude/releases");
        assert_eq!(r["status"], "opened");
        assert_eq!(app.ui.status, "Opened https://github.com/Nihalpi1212/claude/releases");
        assert_eq!(opened.lock().unwrap().as_slice(), ["https://github.com/Nihalpi1212/claude/releases"]);
        assert_eq!(crate::links::RELEASES, photocraft_engine::build_info::RELEASES);
        assert!(menus::invoke(&mut app, &ctx, "help.checkForUpdates", serde_json::json!({"x": 1})).is_err());
        assert!(!app.ui.updates_open, "no result window: nothing was checked");
        assert!(checks.recv_timeout(Duration::from_millis(300)).is_err(), "no check ran");
        assert_eq!(*app.updates_rt.updater.status(), craft::update::updater::Status::Idle);
        // Without a browser service it is the same link.
        let mut plain = PhotocraftApp::new(Session::new(), Services::default());
        assert!(menus::is_enabled(&plain, "help.checkForUpdates"));
        assert_eq!(menus::invoke(&mut plain, &ctx, "help.checkForUpdates", serde_json::json!({})).unwrap()["url"], crate::links::RELEASES);
    }

    #[test]
    fn update_window_is_drivable_and_bad_state_changes_are_atomic() {
        let mut app = app();
        let ctx = app.ctx().clone();
        let call = |app: &mut PhotocraftApp, method: &str, params: Value| {
            let (req, _) = crate::control::ControlRequest::new(method, params);
            match crate::control::handle(app, &ctx, &req) {
                crate::control::Reply::Done(value) => value,
                _ => panic!("expected an immediate reply"),
            }
        };
        assert_eq!(call(&mut app, "ui.set", serde_json::json!({"updatesOpen": true}))["ok"], true);
        let inspected = call(&mut app, "ui.inspect", serde_json::json!({}));
        assert_eq!(inspected["result"]["updatesOpen"], true);
        assert_eq!(inspected["result"]["updates"]["supported"], true);
        assert_eq!(call(&mut app, "ui.set", serde_json::json!({"updatesOpen": false, "maskTarget": "bad"}))["ok"], false);
        assert!(app.ui.updates_open);
        assert_eq!(call(&mut app, "ui.set", serde_json::json!({"updatesOpen": false}))["ok"], true);
        assert!(!app.ui.updates_open);
    }
}
