use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::xbel;

/// Another application's list, as GLib writes it, with a file Pigment will also open.
const OTHERS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<xbel version="1.0"
      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"
      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info"
>
  <bookmark href="file:///home/ann/notes.txt" added="2026-01-02T03:04:05.000001Z" modified="2026-01-02T03:04:05.000001Z" visited="2026-01-02T03:04:05.000001Z">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="text/plain"/>
        <bookmark:applications>
          <bookmark:application name="Text Editor" exec="&apos;gnome-text-editor %u&apos;" modified="2026-01-02T03:04:05.000001Z" count="3"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>
  <bookmark href="file:///home/ann/Pictures/sea%20view.png" added="2026-02-01T00:00:00.000000Z" modified="2026-02-01T00:00:00.000000Z" visited="2026-02-01T00:00:00.000000Z">
    <info>
      <metadata owner="http://freedesktop.org">
        <mime:mime-type type="image/png"/>
        <bookmark:applications>
          <bookmark:application name="Image Viewer" exec="&apos;loupe %u&apos;" modified="2026-02-01T00:00:00.000000Z" count="1"/>
        </bookmark:applications>
      </metadata>
    </info>
  </bookmark>
</xbel>
"#;

const T1: &str = "2026-11-28T05:00:00.000000Z";
const T2: &str = "2026-11-28T06:00:00.000000Z";

/// The text of the bookmark naming `uri` (start tag to end tag).
fn bookmark<'a>(text: &'a str, uri: &str) -> &'a str {
    let s = text.find(&format!("<bookmark href=\"{uri}\"")).unwrap();
    let e = s + text[s..].find("</bookmark>").unwrap() + "</bookmark>".len();
    &text[s..e]
}

/// How many bookmarks the list holds, read by an XML parser (so the text is well-formed).
fn bookmarks(text: &str) -> usize {
    let root = craft_xml::parse(text.as_bytes()).unwrap();
    assert_eq!(root.name, "xbel");
    root.children("bookmark").count()
}

fn notes_txt(text: &str) -> &str {
    bookmark(text, "file:///home/ann/notes.txt")
}

/// A temporary XDG data home: tests never touch the process environment.
fn data_home() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("share").join("recently-used.xbel");
    (dir, file)
}

fn env(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<OsString> {
    move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(*v))
}

#[test]
fn the_list_is_found_where_xdg_says() {
    assert_eq!(xbel::default_file(env(&[("XDG_DATA_HOME", "/d"), ("HOME", "/h")])), Some(PathBuf::from("/d/recently-used.xbel")));
    assert_eq!(xbel::default_file(env(&[("XDG_DATA_HOME", "rel"), ("HOME", "/h")])), Some(PathBuf::from("/h/.local/share/recently-used.xbel")));
    assert_eq!(xbel::default_file(env(&[("HOME", "/h")])), Some(PathBuf::from("/h/.local/share/recently-used.xbel")));
    assert_eq!(xbel::default_file(env(&[])), None);
}

#[test]
fn a_new_list_gets_one_bookmark_in_glib_s_layout() {
    let (_dir, file) = data_home();
    xbel::note_in(&file, Path::new("/home/ann/a b/Poster #1.psd"), T1).unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    let uri = "file:///home/ann/a%20b/Poster%20%231.psd";
    let b = bookmark(&text, uri);
    assert!(b.starts_with(&format!("<bookmark href=\"{uri}\" added=\"{T1}\" modified=\"{T1}\" visited=\"{T1}\">")), "{b}");
    assert!(b.contains("<mime:mime-type type=\"image/vnd.adobe.photoshop\"/>"));
    assert!(b.contains(&format!("<bookmark:application name=\"Pigment\" exec=\"&apos;pigment %u&apos;\" modified=\"{T1}\" count=\"1\"/>")));
    assert!(text.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<xbel version=\"1.0\""));
    assert!(text.ends_with("</bookmark>\n</xbel>\n"));
    assert_eq!(bookmarks(&text), 1);
}

#[test]
fn others_bookmarks_stay_byte_for_byte_and_a_second_note_updates_ours() {
    let (_dir, file) = data_home();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, OTHERS).unwrap();
    xbel::note_in(&file, Path::new("/home/ann/work/cover.tif"), T1).unwrap();
    xbel::note_in(&file, Path::new("/home/ann/work/cover.tif"), T2).unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    // Everything before our bookmark is the other list, unchanged.
    let ours = text.find("<bookmark href=\"file:///home/ann/work/cover.tif\"").unwrap();
    assert_eq!(&text[..ours], &OTHERS[..OTHERS.rfind("</xbel>").unwrap()]);
    assert!(text.ends_with("</bookmark>\n</xbel>\n"));
    // One bookmark, not two: added stays, the times and the count move.
    assert_eq!(text.matches("cover.tif").count(), 1);
    let b = bookmark(&text, "file:///home/ann/work/cover.tif");
    assert!(b.contains(&format!("added=\"{T1}\" modified=\"{T2}\" visited=\"{T2}\"")), "{b}");
    assert!(b.contains(&format!("name=\"Pigment\" exec=\"&apos;pigment %u&apos;\" modified=\"{T2}\" count=\"2\"/>")), "{b}");
    assert!(b.contains("image/tiff"));
    assert_eq!(bookmarks(&text), 3);
}

#[test]
fn a_file_another_app_listed_gets_our_entry_beside_its_own() {
    let out = xbel::noted(OTHERS, "file:///home/ann/Pictures/sea%20view.png", "image/png", T1).unwrap();
    let b = bookmark(&out, "file:///home/ann/Pictures/sea%20view.png");
    assert!(b.contains("name=\"Image Viewer\" exec=\"&apos;loupe %u&apos;\" modified=\"2026-02-01T00:00:00.000000Z\" count=\"1\"/>"));
    assert!(b.contains(&format!("name=\"Pigment\" exec=\"&apos;pigment %u&apos;\" modified=\"{T1}\" count=\"1\"/>")));
    assert!(b.contains(&format!("added=\"2026-02-01T00:00:00.000000Z\" modified=\"{T1}\" visited=\"{T1}\"")));
    assert_eq!(notes_txt(&out), notes_txt(OTHERS));
    // The same file spelled with other escapes is the same bookmark.
    let again = xbel::noted(&out, "file:///home/ann/Pictures/sea%20vi%65w.png", "image/png", T2).unwrap();
    assert_eq!(bookmarks(&again), 2);
    assert!(again.contains(&format!("name=\"Pigment\" exec=\"&apos;pigment %u&apos;\" modified=\"{T2}\" count=\"2\"/>")));
    // Clearing ours leaves the viewer's entry and the bookmark.
    let cleared = xbel::cleared(&again, 0).unwrap();
    assert_eq!(
        cleared.replace(&format!("modified=\"{T2}\" visited=\"{T2}\""), "modified=\"2026-02-01T00:00:00.000000Z\" visited=\"2026-02-01T00:00:00.000000Z\""),
        OTHERS
    );
}

#[test]
fn clear_takes_out_only_pigment_s_bookmarks() {
    let (_dir, file) = data_home();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, OTHERS).unwrap();
    for i in 0..3 {
        xbel::note_in(&file, Path::new(&format!("/home/ann/{i}.png")), T1).unwrap();
    }
    xbel::clear_in(&file).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), OTHERS);
    // Nothing of ours: the file is not rewritten.
    assert_eq!(xbel::cleared(OTHERS, 0), None);
    // No list at all: nothing is created.
    let (_d, missing) = data_home();
    xbel::clear_in(&missing).unwrap();
    assert!(!missing.exists());
}

#[test]
fn at_most_five_hundred_of_ours_are_kept_oldest_out_first() {
    let mut text = OTHERS.to_string();
    for i in 0..xbel::KEEP + 3 {
        let t = format!("2026-11-28T05:{:02}:{:02}.000000Z", i / 60, i % 60);
        text = xbel::noted(&text, &format!("file:///p/{i}.png"), "image/png", &t).unwrap();
    }
    assert_eq!(text.matches("name=\"Pigment\"").count(), xbel::KEEP);
    assert_eq!(bookmarks(&text), xbel::KEEP + 2);
    for gone in 0..3 {
        assert!(!text.contains(&format!("file:///p/{gone}.png\"")), "{gone}");
    }
    assert!(text.contains("file:///p/3.png\"") && text.contains(&format!("file:///p/{}.png\"", xbel::KEEP + 2)));
    assert!(text.starts_with(&OTHERS[..OTHERS.rfind("</xbel>").unwrap()]));
}

#[test]
fn a_list_that_is_not_glib_s_is_left_alone() {
    for text in ["<xbel version=\"1.0\"></xbel>", "not xml", "<xbel xmlns:bookmark=\"http://www.freedesktop.org/standards/desktop-bookmarks\">"] {
        assert_eq!(xbel::noted(text, "file:///a.png", "image/png", T1), None, "{text}");
        assert_eq!(xbel::cleared(text, 0), None);
    }
    let (_dir, file) = data_home();
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, "garbage").unwrap();
    xbel::note_in(&file, Path::new("/a.png"), T1).unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "garbage");
    // A relative path is refused, not guessed.
    assert!(xbel::note_in(&file, Path::new("a.png"), T1).is_err());
}

#[test]
fn an_unwritable_list_is_an_error_the_service_swallows() {
    let (dir, _) = data_home();
    // The "list" is a folder: it can't be opened for writing.
    let file = dir.path().join("recently-used.xbel");
    std::fs::create_dir_all(&file).unwrap();
    assert!(xbel::note_in(&file, Path::new("/a.png"), T1).is_err());
    assert!(file.is_dir());
}

#[test]
fn uris_and_mime_types() {
    assert_eq!(xbel::file_uri(Path::new("/a/ä &<\"'.png")).as_deref(), Some("file:///a/%C3%A4%20%26%3C%22%27.png"));
    assert_eq!(xbel::file_uri(Path::new("rel.png")), None);
    assert_eq!(xbel::mime_type(Path::new("/x/A.JPG")), "image/jpeg");
    assert_eq!(xbel::mime_type(Path::new("/x/a.pigment")), "application/x-pigment");
    assert_eq!(xbel::mime_type(Path::new("/x/a")), "application/octet-stream");
}
