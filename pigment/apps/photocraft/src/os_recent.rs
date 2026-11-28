//! Pigment: files opened or saved go on the operating system's recent lists too (PORTS-A row 46),
//! as the JavaScript Pigment's Electron `app.addRecentDocument` did and as Photoshop does:
//! - **Windows**: `SHAddToRecentDocs` (Explorer's Recent, Start, the taskbar Jump List). The call
//!   is `unsafe` FFI, so it lives in the workspace's one `unsafe` helper crate
//!   ([`photocraft_tablet::windows::add_recent_document`]).
//! - **macOS**: `NSDocumentController.noteNewRecentDocumentURL` (Apple menu › Recent Items, the
//!   Dock menu); safe objc2 calls on the main thread.
//! - **Linux and the BSDs**: a bookmark in the desktop's `recently-used.xbel` (GTK's format, read
//!   by GNOME, KDE's file dialogs and most file managers): [`xbel`].
//!
//! [`photocraft_ui_egui::Services::note_recent`] calls [`service`]'s closure from `push_recent`
//! (only while the in-app recent list is on) and from Clear Recent File List. Files in the
//! crash-recovery folder are never noted.

use std::path::{Path, PathBuf};

/// The `note_recent` service: `Some(path)` notes a file, `None` clears Pigment's own entries where
/// the platform allows (Linux; Windows and macOS have only an every-app clear, never called).
pub fn service(recovery: Option<PathBuf>) -> photocraft_ui_egui::recent_os::NoteRecentFn {
    Box::new(move |path: Option<&Path>| match path {
        Some(p) if !in_folder(p, recovery.as_deref()) => note(p),
        Some(_) => {}
        None => clear_ours(),
    })
}

/// Is `path` inside `folder` (the crash-recovery folder)?
fn in_folder(path: &Path, folder: Option<&Path>) -> bool {
    folder.is_some_and(|f| path.starts_with(f))
}

/// Tell the OS that `path` was opened or saved. Never fails: a list that can't be written is
/// left alone.
pub fn note(path: &Path) {
    let Ok(path) = std::path::absolute(path) else { return };
    #[cfg(target_os = "windows")]
    photocraft_tablet::windows::add_recent_document(&path);
    #[cfg(target_os = "macos")]
    mac::note(&path);
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(file) = xbel::default_file(|k| std::env::var_os(k)) {
        // Off the UI thread: the file can be large and on a slow home folder.
        let _ = std::thread::Builder::new().name("recent-documents".into()).spawn(move || {
            if let Err(e) = xbel::note_in(&file, &path, &xbel::now()) {
                log::debug!("recent documents: {} not updated: {e}", file.display());
            }
        });
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    let _ = path;
}

/// Clear Recent File List: take Pigment's own bookmarks out of `recently-used.xbel` (Linux).
pub fn clear_ours() {
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(file) = xbel::default_file(|k| std::env::var_os(k)) {
        let _ = std::thread::Builder::new().name("recent-documents".into()).spawn(move || {
            if let Err(e) = xbel::clear_in(&file) {
                log::debug!("recent documents: {} not cleared: {e}", file.display());
            }
        });
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSDocumentController;
    use objc2_foundation::{NSString, NSURL};

    /// AppKit's recent documents (Recent Items, the Dock menu). `push_recent` runs on the main
    /// thread; anywhere else the call is skipped, since AppKit is main-thread only.
    pub fn note(path: &std::path::Path) {
        let (Some(mtm), Some(text)) = (MainThreadMarker::new(), path.to_str()) else { return };
        let url = NSURL::fileURLWithPath(&NSString::from_str(text));
        NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&url);
    }
}

#[cfg(all(unix, any(not(target_os = "macos"), test)))]
pub mod xbel {
    //! The freedesktop recently-used list, `$XDG_DATA_HOME/recently-used.xbel` (default
    //! `~/.local/share/recently-used.xbel`), in the layout GLib's `GBookmarkFile` writes.
    //!
    //! The file is edited as text, so every other application's bookmark stays byte for byte as it
    //! was: a new file gets a bookmark before `</xbel>`; a file already listed gets fresh
    //! `modified`/`visited` times and Pigment's `<bookmark:application>` (added, or its time and
    //! count updated). At most [`KEEP`] bookmarks name Pigment; the oldest go first (a bookmark
    //! another application also names keeps that application's entry). A file whose root doesn't
    //! declare GLib's two namespaces, or that is larger than [`MAX_BYTES`], is left alone.
    //!
    //! Writes are atomic (temp file and rename, `photocraft_format::atomic_write`) under an
    //! advisory lock on the file, so two Pigment windows don't lose each other's entries.

    use std::ffi::OsString;
    use std::io;
    use std::path::{Path, PathBuf};

    /// How many bookmarks naming Pigment are kept.
    pub const KEEP: usize = 500;
    /// A larger file is not read.
    pub const MAX_BYTES: u64 = 32 << 20;
    const APP: &str = "Pigment";
    /// `g_shell_quote("pigment %u")`, as GLib stores an application's command line.
    const EXEC: &str = "&apos;pigment %u&apos;";
    const NS_BOOKMARK: &str = "xmlns:bookmark=\"http://www.freedesktop.org/standards/desktop-bookmarks\"";
    const NS_MIME: &str = "xmlns:mime=\"http://www.freedesktop.org/standards/shared-mime-info\"";
    const EMPTY: &str = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<xbel version=\"1.0\"\n",
        "      xmlns:bookmark=\"http://www.freedesktop.org/standards/desktop-bookmarks\"\n",
        "      xmlns:mime=\"http://www.freedesktop.org/standards/shared-mime-info\"\n",
        ">\n",
        "</xbel>\n"
    );

    /// `$XDG_DATA_HOME/recently-used.xbel`, or `$HOME/.local/share/recently-used.xbel` when it is
    /// unset or relative (the XDG Base Directory spec ignores relative paths).
    pub fn default_file(env: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
        let data = env("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute());
        let data = data.or_else(|| env("HOME").map(PathBuf::from).filter(|p| p.is_absolute()).map(|h| h.join(".local/share")))?;
        Some(data.join("recently-used.xbel"))
    }

    /// The time as GLib writes it: `2026-11-28T05:00:00.123456Z`.
    pub fn now() -> String {
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string()
    }

    /// Note `path` in the list at `file` (created with its folder when missing).
    pub fn note_in(file: &Path, path: &Path, now: &str) -> io::Result<()> {
        let uri = file_uri(path).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "not an absolute path"))?;
        let mime = mime_type(path);
        edit(file, |text| noted(text, &uri, mime, now))
    }

    /// Take Pigment's bookmarks out of the list at `file`.
    pub fn clear_in(file: &Path) -> io::Result<()> {
        if !file.exists() {
            return Ok(());
        }
        edit(file, |text| cleared(text, 0))
    }

    /// Read, change and atomically replace `file` under a lock. `change` gets the text (empty for
    /// a new file) and returns the new text, or `None` to leave the file alone.
    fn edit(file: &Path, change: impl Fn(&str) -> Option<String>) -> io::Result<()> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // The lock is on the file itself; a writer that replaced it while we waited leaves us
        // holding the old inode, so look again.
        for _ in 0..8 {
            let handle = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(file)?;
            rustix::fs::flock(&handle, rustix::fs::FlockOperation::LockExclusive)?;
            if !same_inode(&handle, file)? {
                continue;
            }
            let meta = handle.metadata()?;
            if meta.len() > MAX_BYTES {
                return Err(io::Error::other("the list is too large"));
            }
            let text = std::fs::read_to_string(file)?;
            if let Some(new) = change(&text) {
                photocraft_format::atomic_write(file, new.as_bytes())?;
            }
            return Ok(());
        }
        Err(io::Error::other("the list kept changing"))
    }

    fn same_inode(handle: &std::fs::File, file: &Path) -> io::Result<bool> {
        use std::os::unix::fs::MetadataExt;
        let (a, b) = (handle.metadata()?, std::fs::metadata(file)?);
        Ok(a.ino() == b.ino() && a.dev() == b.dev())
    }

    /// `file://` URI of an absolute path, percent-encoding every byte but the unreserved ones and `/`.
    pub fn file_uri(path: &Path) -> Option<String> {
        if !path.is_absolute() {
            return None;
        }
        let mut out = String::from("file://");
        for &b in path.as_os_str().as_encoded_bytes() {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        Some(out)
    }

    /// The MIME type the desktop uses for the formats Pigment registers (`packaging/linux`).
    pub fn mime_type(path: &Path) -> &'static str {
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        match ext.as_str() {
            "pigment" => "application/x-pigment",
            "pcraft" | "photocraft" => "application/x-photocraft",
            "psd" => "image/vnd.adobe.photoshop",
            "psb" => "image/x-psb",
            "png" => "image/png",
            "jpg" | "jpeg" | "jpe" => "image/jpeg",
            "tif" | "tiff" => "image/tiff",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            "tga" => "image/x-tga",
            "ico" => "image/vnd.microsoft.icon",
            "avif" => "image/avif",
            "heic" | "heif" => "image/heif",
            "jxl" => "image/jxl",
            "svg" => "image/svg+xml",
            "pdf" => "application/pdf",
            "ora" => "image/openraster",
            "kra" => "application/x-krita",
            "pdn" => "image/x-paintnet",
            "exr" => "image/x-exr",
            "qoi" => "image/qoi",
            "pbm" | "pgm" | "ppm" | "pnm" | "pam" => "image/x-portable-anymap",
            _ => "application/octet-stream",
        }
    }

    // ---------- the text edits (pure) ----------

    /// One `<bookmark>` element: its byte range (start tag to end tag) and its start tag's end.
    #[derive(Clone, Copy, Debug)]
    struct Block {
        start: usize,
        tag_end: usize,
        end: usize,
    }

    /// `text` with `uri` noted, or `None` when the file isn't a list this module writes.
    pub fn noted(text: &str, uri: &str, mime: &str, now: &str) -> Option<String> {
        let mut text = if text.trim().is_empty() { EMPTY.to_string() } else { text.to_string() };
        let close = root_close(&text)?;
        let target = percent_decode(&unescape(uri));
        let found = blocks(&text).into_iter().find(|b| href(&text[b.start..b.tag_end]).is_some_and(|h| percent_decode(&unescape(h)) == target));
        match found {
            Some(b) => {
                let block = &text[b.start..b.end];
                let updated = touched(block, b.tag_end - b.start, now)?;
                text.replace_range(b.start..b.end, &updated);
            }
            None => {
                let fresh = format!(
                    "  <bookmark href=\"{uri}\" added=\"{now}\" modified=\"{now}\" visited=\"{now}\">\n    <info>\n      <metadata owner=\"http://freedesktop.org\">\n        <mime:mime-type type=\"{mime}\"/>\n        <bookmark:applications>\n          {}\n        </bookmark:applications>\n      </metadata>\n    </info>\n  </bookmark>\n",
                    app_element(now, 1),
                    uri = escape(uri),
                );
                let at = line_start(&text, close);
                text.insert_str(at, &fresh);
            }
        }
        cleared(&text, KEEP).or(Some(text))
    }

    /// `text` with all but the newest `keep` of Pigment's entries taken out; `None` when nothing
    /// changes (or the file isn't a list this module writes).
    pub fn cleared(text: &str, keep: usize) -> Option<String> {
        root_close(text)?;
        let mut ours: Vec<(Block, String)> = blocks(text)
            .into_iter()
            .filter_map(|b| our_app(&text[b.start..b.end]).map(|(s, e)| (b, attr(&text[b.start + s..b.start + e], "modified").unwrap_or_default().to_string())))
            .collect();
        if ours.len() <= keep {
            return None;
        }
        // Oldest first; ties keep document order.
        ours.sort_by(|a, b| a.1.cmp(&b.1));
        let mut drop: Vec<Block> = ours[..ours.len() - keep].iter().map(|(b, _)| *b).collect();
        drop.sort_by_key(|b| std::cmp::Reverse(b.start));
        let mut out = text.to_string();
        for b in drop {
            let block = &out[b.start..b.end];
            let (s, e) = our_app(block)?;
            if apps(block) > 1 {
                // Another application also lists the file: take only Pigment's entry out.
                let (s, e) = whole_lines(block, s, e);
                out.replace_range(b.start + s..b.start + e, "");
            } else {
                let (s, e) = whole_lines(&out, b.start, b.end);
                out.replace_range(s..e, "");
            }
        }
        Some(out)
    }

    /// The bookmark `block` (start tag `tag_len` bytes long) with fresh times and Pigment's entry.
    fn touched(block: &str, tag_len: usize, now: &str) -> Option<String> {
        let tag = &block[..tag_len];
        if tag.ends_with("/>") {
            return None;
        }
        let tag = set_attr(&set_attr(tag, "modified", now), "visited", now);
        let mut body = block[tag_len..].to_string();
        match our_app(&body) {
            Some((s, e)) => {
                let element = &body[s..e];
                let count = attr(element, "count").and_then(|c| c.parse::<u64>().ok()).unwrap_or(0).saturating_add(1);
                let new = set_attr(&set_attr(element, "modified", now), "count", &count.to_string());
                body.replace_range(s..e, &new);
            }
            None => {
                let element = app_element(now, 1);
                if let Some(at) = body.find("</bookmark:applications>") {
                    let at = line_start(&body, at);
                    body.insert_str(at, &format!("          {element}\n"));
                } else {
                    let at = line_start(&body, body.find("</metadata>")?);
                    body.insert_str(at, &format!("        <bookmark:applications>\n          {element}\n        </bookmark:applications>\n"));
                }
            }
        }
        Some(tag + &body)
    }

    fn app_element(now: &str, count: u64) -> String {
        format!("<bookmark:application name=\"{APP}\" exec=\"{EXEC}\" modified=\"{now}\" count=\"{count}\"/>")
    }

    /// Where the root's `</xbel>` starts, when the root declares GLib's namespaces.
    fn root_close(text: &str) -> Option<usize> {
        let open = text.find("<xbel")?;
        let open_end = open + tag_end(&text[open..])?;
        let root = &text[open..open_end];
        if !root.contains(NS_BOOKMARK) || !root.contains(NS_MIME) {
            return None;
        }
        let close = text.rfind("</xbel>")?;
        (close >= open_end).then_some(close)
    }

    /// The length of the tag starting at `s[0]` (`<…>`), skipping `>` inside quoted values.
    fn tag_end(s: &str) -> Option<usize> {
        let mut quote = None;
        for (i, c) in s.char_indices() {
            match (quote, c) {
                (None, '"' | '\'') => quote = Some(c),
                (Some(q), c) if c == q => quote = None,
                (None, '>') => return Some(i + 1),
                _ => {}
            }
        }
        None
    }

    /// Every `<bookmark …>…</bookmark>` (or `<bookmark …/>`) in `text`.
    fn blocks(text: &str) -> Vec<Block> {
        let mut out = Vec::new();
        let mut at = 0;
        while let Some(i) = text[at..].find("<bookmark") {
            let start = at + i;
            let next = text[start + "<bookmark".len()..].chars().next();
            if !matches!(next, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
                at = start + 1;
                continue;
            }
            let Some(len) = tag_end(&text[start..]) else { break };
            let tag_end = start + len;
            let end = if text[start..tag_end].ends_with("/>") {
                tag_end
            } else {
                match text[tag_end..].find("</bookmark>") {
                    Some(j) => tag_end + j + "</bookmark>".len(),
                    None => break,
                }
            };
            out.push(Block { start, tag_end, end });
            at = end;
        }
        out
    }

    /// The `<bookmark:application>` elements in `block`, as byte ranges.
    fn app_elements(block: &str) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut at = 0;
        while let Some(i) = block[at..].find("<bookmark:application") {
            let s = at + i;
            let after = block[s + "<bookmark:application".len()..].chars().next();
            let Some(len) = tag_end(&block[s..]) else { break };
            if matches!(after, Some(c) if c.is_whitespace() || c == '/') {
                out.push((s, s + len));
            }
            at = s + len;
        }
        out
    }

    fn apps(block: &str) -> usize {
        app_elements(block).len()
    }

    fn our_app(block: &str) -> Option<(usize, usize)> {
        app_elements(block).into_iter().find(|&(s, e)| attr(&block[s..e], "name").is_some_and(|n| unescape(n) == APP))
    }

    fn href(tag: &str) -> Option<&str> {
        attr(tag, "href")
    }

    /// The raw (still escaped) value of attribute `name` in the tag `tag`.
    fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
        attr_range(tag, name).map(|(s, e)| &tag[s..e])
    }

    fn attr_range(tag: &str, name: &str) -> Option<(usize, usize)> {
        let mut at = 0;
        while let Some(i) = tag[at..].find(name) {
            let s = at + i;
            let before = tag[..s].chars().next_back();
            let rest = &tag[s + name.len()..];
            let trimmed = rest.trim_start();
            if matches!(before, Some(c) if c.is_whitespace())
                && let Some(after_eq) = trimmed.strip_prefix('=')
            {
                let after_eq = after_eq.trim_start();
                let q = after_eq.chars().next().filter(|c| *c == '"' || *c == '\'')?;
                let vs = tag.len() - after_eq.len() + 1;
                let ve = vs + tag[vs..].find(q)?;
                return Some((vs, ve));
            }
            at = s + name.len();
        }
        None
    }

    /// `tag` with attribute `name` set to `value` (added before the tag's end when missing).
    fn set_attr(tag: &str, name: &str, value: &str) -> String {
        match attr_range(tag, name) {
            Some((s, e)) => format!("{}{}{}", &tag[..s], escape(value), &tag[e..]),
            None => {
                let end = if tag.ends_with("/>") { tag.len() - 2 } else { tag.len() - 1 };
                format!("{} {name}=\"{}\"{}", tag[..end].trim_end(), escape(value), &tag[end..])
            }
        }
    }

    /// The range `s..e` of `text` widened to whole lines when only blanks share them.
    fn whole_lines(text: &str, s: usize, e: usize) -> (usize, usize) {
        let ls = line_start(text, s);
        let le = text[e..].find('\n').map(|i| e + i + 1).unwrap_or(text.len());
        if text[ls..s].trim().is_empty() && text[e..le].trim().is_empty() { (ls, le) } else { (s, e) }
    }

    /// The start of `at`'s line when only blanks precede it there, else `at`.
    fn line_start(text: &str, at: usize) -> usize {
        let ls = text[..at].rfind('\n').map_or(0, |i| i + 1);
        if text[ls..at].trim().is_empty() { ls } else { at }
    }

    fn escape(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }

    fn unescape(s: &str) -> String {
        s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
    }

    fn percent_decode(s: &str) -> Vec<u8> {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%'
                && let Some(v) = b.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(v);
                i += 3;
                continue;
            }
            out.push(b[i]);
            i += 1;
        }
        out
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod smoke {
    use std::path::{Path, PathBuf};

    #[test]
    fn recovery_files_are_never_noted() {
        assert!(super::in_folder(Path::new("/state/pigment/Recovery/x.pcraft"), Some(Path::new("/state/pigment/Recovery"))));
        assert!(!super::in_folder(Path::new("/state/pigment/Recovery2/x.pcraft"), Some(Path::new("/state/pigment/Recovery"))));
        assert!(!super::in_folder(Path::new("/a.png"), None));
    }

    #[test]
    fn the_platform_call_does_not_panic_on_a_missing_file() {
        // Through the recovery filter (every path is "in" `/`), so a test run on Linux never adds
        // to the person's own recent files.
        let service = super::service(Some(PathBuf::from("/")));
        service(Some(Path::new("/no/such/folder/pigment-test.psd")));
        // Windows and macOS: the real call, for a file that doesn't exist.
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        super::note(Path::new("/no/such/folder/pigment-test.psd"));
    }
}
