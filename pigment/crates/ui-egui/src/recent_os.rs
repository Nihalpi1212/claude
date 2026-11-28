//! Pigment: the operating system's recent documents (PORTS-A row 46).
//!
//! The JavaScript Pigment called Electron's `app.addRecentDocument` for every file opened or
//! saved, so they showed in the Windows Recent list and Jump List, macOS Recent Items and the
//! Dock menu, and the desktop's recently-used files on Linux. This crate stays platform-free: the
//! desktop app installs [`crate::Services::note_recent`] and [`PhotocraftApp::push_recent`] /
//! [`PhotocraftApp::clear_recent`] call it through here.

use crate::PhotocraftApp;

/// [`crate::Services::note_recent`]: `Some(path)` notes a file opened or saved, `None` clears
/// Pigment's own entries where the platform can.
pub type NoteRecentFn = Box<dyn Fn(Option<&std::path::Path>) + Send + Sync>;

/// A file was added to File › Open Recent: tell the OS too, while the in-app list is on
/// (Preferences › File Handling › Recent File List Contains above 0), as Photoshop does.
pub(crate) fn note(app: &PhotocraftApp, path: &str) {
    if app.recent_cap() == 0 || path.is_empty() {
        return;
    }
    if let Some(f) = &app.services.note_recent {
        f(Some(std::path::Path::new(path)));
    }
}

/// Clear Recent File List: also clear Pigment's own entries where the platform can (Linux).
pub(crate) fn clear(app: &PhotocraftApp) {
    if let Some(f) = &app.services.note_recent {
        f(None);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use crate::{PhotocraftApp, Services};

    type Calls = Arc<Mutex<Vec<Option<PathBuf>>>>;

    fn app() -> (Box<PhotocraftApp>, Calls) {
        let calls: Calls = Arc::default();
        let seen = calls.clone();
        let services = Services { note_recent: Some(Box::new(move |p| seen.lock().unwrap().push(p.map(PathBuf::from)))), ..Default::default() };
        (PhotocraftApp::new(photocraft_engine::Session::new(), services), calls)
    }

    #[test]
    fn push_recent_notes_the_file_with_the_os_and_clear_recent_clears_ours() {
        let (mut app, calls) = app();
        app.push_recent("/work/a.psd");
        app.push_recent("/work/b.png");
        app.push_recent("/work/a.psd");
        assert_eq!(*calls.lock().unwrap(), [Some("/work/a.psd".into()), Some("/work/b.png".into()), Some("/work/a.psd".into())]);
        assert_eq!(app.ui.recent_files, ["/work/a.psd", "/work/b.png"]);
        calls.lock().unwrap().clear();
        app.clear_recent();
        assert_eq!(*calls.lock().unwrap(), [None]);
        // Taking one file off the in-app list leaves the OS lists alone (no per-file API there).
        app.push_recent("/work/c.tif");
        calls.lock().unwrap().clear();
        app.remove_recent("/work/c.tif");
        assert!(calls.lock().unwrap().is_empty());
    }

    #[test]
    fn nothing_reaches_the_os_while_the_recent_list_is_off() {
        let (mut app, calls) = app();
        app.session.prefs.edit(|p| p.file_handling.recent_file_count = 0);
        app.push_recent("/work/a.psd");
        assert!(calls.lock().unwrap().is_empty());
        assert!(app.ui.recent_files.is_empty());
    }

    #[test]
    fn without_the_service_push_recent_works_as_before() {
        let mut app = PhotocraftApp::new(photocraft_engine::Session::new(), Services::default());
        app.push_recent("/work/a.psd");
        app.clear_recent();
        assert!(app.ui.recent_files.is_empty());
    }
}
