//! Help › Check for Updates (Pigment opens its releases page; no check starts at launch, see
//! docs/FORK.md) and the non-modal window for release information craft-update draws.

use photocraft_engine::updates_cmds::Status;
use serde_json::Value;

use crate::PhotocraftApp;

pub(crate) struct Runtime {
    notified_version: Option<String>,
    /// The startup prompt and the self-update behind it (desktop).
    #[cfg(not(target_arch = "wasm32"))]
    updater: craft_update::updater::Updater,
    /// What the last self-update came to, shown in the result window until it is closed.
    #[cfg(not(target_arch = "wasm32"))]
    last_update: craft_update::updater::Status,
    /// The check running was asked for with Help ▸ Check for Updates.
    #[cfg(not(target_arch = "wasm32"))]
    requested: bool,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            notified_version: None,
            #[cfg(not(target_arch = "wasm32"))]
            updater: craft_update::updater::Updater::new(&crate::UPDATE_APP, photocraft_engine::build_info::VERSION),
            #[cfg(not(target_arch = "wasm32"))]
            last_update: craft_update::updater::Status::Idle,
            #[cfg(not(target_arch = "wasm32"))]
            requested: false,
        }
    }
}

/// The release the engine found, as `craft-update` knows it.
#[cfg(not(target_arch = "wasm32"))]
fn release_of(found: &photocraft_engine::updates_cmds::Release) -> craft_update::Release {
    craft_update::Release {
        tag: format!("v{}", found.version),
        version: craft_update::parse_version(&found.version),
        name: format!("Pigment {}", found.version),
        html_url: found.url.clone(),
        ..Default::default()
    }
}

/// Help › Check for Updates: opens Pigment's releases page in the browser, where each release
/// (`pigment-vX.Y.Z`) lists what changed and its downloads. Nothing is fetched or installed: Pigment
/// makes no network request on its own (docs/FORK.md).
pub(crate) fn check(app: &mut PhotocraftApp, ctx: &egui::Context, params: Value) -> Result<Value, String> {
    if params.as_object().is_some_and(|o| !o.is_empty()) || !(params.is_null() || params.is_object()) {
        return Err("help.checkForUpdates takes no parameters".into());
    }
    Ok(crate::links::open(app, ctx, crate::links::RELEASES))
}

pub(crate) fn tick(app: &mut PhotocraftApp, ctx: &egui::Context) {
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(read) = app.services.last_update.take() {
        use craft_update::updater::Status as Shown;
        app.updates_rt.last_update = match read() {
            Some(Ok(version)) => Shown::Updated(version),
            Some(Err(reason)) => Shown::InstallFailed(reason),
            None => Shown::Idle,
        };
        if app.updates_rt.last_update != Shown::Idle {
            app.ui.updates_open = true;
        }
    }
    // `updates.status` also polls (automation may consume the result before this frame).
    app.session.updates.poll();
    if let Status::Available { release } = &app.session.updates.status
        && app.updates_rt.notified_version.as_ref() != Some(&release.version)
    {
        app.updates_rt.notified_version = Some(release.version.clone());
        app.ui.updates_open = true;
        #[cfg(not(target_arch = "wasm32"))]
        {
            let updater = &mut app.updates_rt.updater;
            updater.offer(release_of(release));
            // While an update installs or waits for the app to close, or while the launcher keeps
            // this version, no prompt opens: a manual check reports that state in the result window.
            if std::mem::take(&mut app.updates_rt.requested) && !updater.prompt_open() {
                updater.check_now(ctx);
            }
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    if !matches!(app.session.updates.status, Status::Checking) {
        app.updates_rt.requested = false;
    }
    if app.session.updates.check.is_none() {
        return;
    }
    // Pigment starts no check at launch (docs/FORK.md); a check another frontend started is
    // still followed.
    if matches!(app.session.updates.status, Status::Checking) {
        ctx.request_repaint_after(std::time::Duration::from_millis(100));
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn show(_app: &mut PhotocraftApp, _ctx: &egui::Context) {}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn show(app: &mut PhotocraftApp, ctx: &egui::Context) {
    let mut download: Option<String> = None;
    {
        let was_open = app.updates_rt.updater.prompt_open();
        app.updates_rt.updater.tick(ctx);
        // An update starts, and a ready one asks the app to close, only while no work is unsaved.
        let clean = !app.has_unsaved_work();
        match app.updates_rt.updater.show_if(ctx, clean) {
            craft_update::updater::Action::None => {}
            craft_update::updater::Action::OpenUrl(url) => download = Some(url),
            // The guarded close path asks about unsaved work and waits for saves; the restart helper
            // relaunches once the process exits.
            craft_update::updater::Action::Close => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
        }
        // The last self-update's outcome, hidden while the prompt showed, is still shown after it.
        if was_open && !app.updates_rt.updater.prompt_open() {
            app.ui.updates_open = app.updates_rt.last_update != craft_update::updater::Status::Idle;
        }
    }
    if let Some(url) = download {
        crate::links::open(app, ctx, &url);
    }
    if app.updates_rt.updater.prompt_open() {
        return;
    }
    let status = shown_status(app);
    let dialog = craft_update::CheckResultDialog::new(&crate::UPDATE_APP, photocraft_engine::build_info::VERSION);
    match dialog.show(ctx, &status) {
        craft_update::CheckResultResponse::None => {}
        craft_update::CheckResultResponse::Close => {
            app.ui.updates_open = false;
            app.updates_rt.updater.dismiss_status();
            app.updates_rt.last_update = craft_update::updater::Status::Idle;
        }
        craft_update::CheckResultResponse::CheckAgain => {
            let _ = check(app, ctx, serde_json::json!({}));
        }
        craft_update::CheckResultResponse::RestartToUpdate => app.updates_rt.updater.restart_to_update(),
    }
}

/// What the open result window shows: the updater's answer to a manual check (an update installing
/// or ready, or a version the launcher keeps), else the last self-update's outcome, else the
/// engine's check.
#[cfg(not(target_arch = "wasm32"))]
fn shown_status(app: &PhotocraftApp) -> craft_update::updater::Status {
    use craft_update::updater::Status as Shown;
    let updater = app.updates_rt.updater.status();
    if !app.ui.updates_open {
        Shown::Idle
    } else if *updater != Shown::Idle {
        updater.clone()
    } else if app.updates_rt.last_update != Shown::Idle {
        app.updates_rt.last_update.clone()
    } else {
        check_status(&app.session.updates.status)
    }
}

/// The engine's check state as the result dialog shows it. An available release goes to the
/// startup prompt, so the dialog draws nothing for it.
#[cfg(not(target_arch = "wasm32"))]
fn check_status(status: &Status) -> craft_update::updater::Status {
    use craft_update::updater::Status as Shown;
    match status {
        Status::Checking => Shown::Checking,
        Status::UpToDate => Shown::UpToDate,
        Status::Failed { message } => Shown::Failed(message.clone()),
        Status::Idle | Status::Available { .. } => Shown::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Services, menus};
    use photocraft_engine::Session;
    use std::sync::{Arc, Mutex, mpsc};

    type Sender = Arc<Mutex<Option<mpsc::Sender<photocraft_engine::updates_cmds::CheckResult>>>>;

    /// An app whose update check (were one started) counts its calls.
    fn app() -> (PhotocraftApp, Arc<Mutex<u32>>, Sender) {
        let calls = Arc::new(Mutex::new(0));
        let count = calls.clone();
        let sender = Arc::new(Mutex::new(None));
        let tx = sender.clone();
        let opened: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let app = PhotocraftApp::new(
            Session::new(),
            Services {
                check_updates: Some(Box::new(move || {
                    *count.lock().unwrap() += 1;
                    let (sender, receiver) = mpsc::channel();
                    *tx.lock().unwrap() = Some(sender);
                    Ok(receiver)
                })),
                open_url: Some(Box::new(move |u: &str| {
                    opened.lock().unwrap().push(u.to_string());
                    Ok(())
                })),
                ..Default::default()
            },
        );
        (app, calls, sender)
    }

    fn at(app: &mut PhotocraftApp, ctx: &egui::Context, time: f64) {
        let mut output = ctx.run_ui(egui::RawInput { time: Some(time), ..Default::default() }, |ui| tick(app, ui.ctx()));
        output.textures_delta.clear();
    }

    #[test]
    fn no_check_runs_at_launch_even_with_automatic_checks_on() {
        let (mut app, calls, _) = app();
        let ctx = egui::Context::default();
        app.session.edit_prefs(|p| p.general.automatically_check_updates = true);
        for t in [0.0, 1.0, 86400.0] {
            at(&mut app, &ctx, t);
        }
        assert_eq!(*calls.lock().unwrap(), 0, "Pigment makes no network request on its own");
        assert_eq!(app.session.updates.status, Status::Idle);
        assert!(!app.ui.updates_open);
    }

    #[test]
    fn check_for_updates_opens_the_releases_page_and_fetches_nothing() {
        let (mut app, calls, _) = app();
        let ctx = egui::Context::default();
        assert!(menus::is_enabled(&app, "help.checkForUpdates"));
        let r = menus::invoke(&mut app, &ctx, "help.checkForUpdates", serde_json::json!({})).unwrap();
        assert_eq!(r["url"], "https://github.com/Nihalpi1212/claude/releases");
        assert_eq!(app.ui.status, "Opened https://github.com/Nihalpi1212/claude/releases");
        assert_eq!(*calls.lock().unwrap(), 0);
        assert!(menus::invoke(&mut app, &ctx, "help.checkForUpdates", serde_json::json!({"x": 1})).is_err());
        // Without an update service (Pigment's desktop and web builds) it is the same link.
        let mut plain = PhotocraftApp::new(Session::new(), Services::default());
        assert!(menus::is_enabled(&plain, "help.checkForUpdates"));
        assert_eq!(menus::invoke(&mut plain, &ctx, "help.checkForUpdates", serde_json::json!({})).unwrap()["url"], crate::links::RELEASES);
        at(&mut plain, &ctx, 2.0);
        assert_eq!(plain.session.updates.status, Status::Idle);
    }

    #[test]
    fn update_window_is_drivable_and_bad_state_changes_are_atomic() {
        let (mut app, _, _) = app();
        let ctx = egui::Context::default();
        let call = |app: &mut PhotocraftApp, method: &str, params: Value| {
            let (req, _) = crate::control::ControlRequest::new(method, params);
            match crate::control::handle(app, &ctx, &req) {
                crate::control::Outcome::Done(value) => value,
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
