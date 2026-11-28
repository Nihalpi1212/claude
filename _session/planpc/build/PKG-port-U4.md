# PKG-port-U4: Select Similar Layers and the operating system's recent documents (rows 45, 46)

Built on `claude/pigment-photocraft` after `2ca195b` (F1; PhotoCraft 057297b, craft-libs 18ffc07). Spec: PORTS-A §6.1,
§6.2 and §9 U4; REBASE-FU "U4" (it wins). Fourth package of group FU to land (F3, F2, F1 before it; U1, U2, U3 not
built yet: REBASE-FU's order puts U4 right after F1).

**CI first.** At the start (05:00 UTC) the newest finished run was 46101890525 (`aacdf9b`, F2), **green**;
46106173806 (`51dedef`) and 46110072787 (`2ca195b`, F1) then finished **green** too. Nothing red, so no CI commit.
The runs on this package's commits (46115758573 on `e8ec9d5`, then `0a8765f` and `53805fb`) were in
progress when I finished: **the next engineer checks them first.**

**REBASE-FU's line numbers** were checked against the tree: `layer_multi_cmds.rs:96-114` (specs),
`layer_multi_cmds/selection.rs:354` (`select_all_layers`), `menu_catalog.rs:544-547`, `menus/items.rs:40`
(`PLACE_AFTER`, now 40-47) and `:201` (the AI place hook, now 201-202 with A6's), `app/files.rs:15/32/40`,
`services.rs:503` (`Services`, `#[derive(Default)]`), `apps/photocraft/src/services.rs:470-500` (`native`, now
465-583), `apps/photocraft/Cargo.toml:74-76` (the objc2 lines, now 75-77), `cmd.rs:1474` (the registry; the AI line
is now 1516). All matched or had moved by a few lines; nothing was missing.

## Commits (pushed)

- `e8ec9d5` Pigment Select › Similar Layers (U4), engine and interface: every layer of the selected layers' kinds,
  after Deselect Layers
- `0a8765f` Pigment operating-system recent documents (U4), app, interface and tablet: files opened or saved go on
  Windows', macOS' and the desktop's recent lists
- `53805fb` Pigment recent documents (U4), docs: FORK.md names `pub mod recent_os` and its NoteRecentFn

## What was built

### Select › Similar Layers (row 45)

- `crates/engine/src/cmd/similar_layers_cmds.rs` (new): `select.similarLayers`, label "Similar Layers", menu
  `["Select"]`, enabled when a layer is selected, params `{}` (ignored). It collects `LayerContent::kind_name` of
  the selected layers (Pixel, Group, Adjustment, Fill, Type, Shape, Smart Object: adjustment layers of any kind
  match each other, fills too, as Photoshop and the spec want), selects every layer of those kinds in
  `doc.walk()` (inside groups), keeps the active layer when it is among them (else the topmost match), through
  `layer_multi_cmds::set_selection` (no history step; a clean document stays clean). Replies `{"selected": n}`.
- **Choice recorded (Background):** REBASE-FU says "leaving out the Background as `select_all_layers` does". I
  leave it out *unless it was selected*: otherwise Similar Layers on a selected Background would drop the active
  layer from its own selection. JS compared only the active layer's type; Photoshop's rule for the Background is
  not documented.
- Artboards are groups in `kind_name`, so they match groups (not split out; the spec names `kind_name`).
- Menu: `PLACE_AFTER` tuple `("select.similarLayers", "select.deselectLayers")` in `menus/items.rs` (REBASE-FU's
  second option: one marked line; no shared Pigment place table was made, A6 already has its own
  `newer::place_after`). `menu_catalog.rs` is not touched. Photoshop's pixel `select.similar` stays its own row.
- i18n: the label is an engine command label; the catalogues (craft-i18n TSVs) have no row, so it falls back to
  English. No `tl!` strings added.
- Not mapped to an `.atn` event (`atn_cmds/events.rs` has `selectAllLayers`/`selectNoLayers` for its siblings;
  Photoshop's event for Similar Layers is not known here). Recording it in an action keeps Pigment's own step.

### Operating-system recent documents (row 46)

- `crates/ui-egui/src/services.rs`: `Services::note_recent: Option<recent_os::NoteRecentFn>` (one field; `Default`
  is derived). `NoteRecentFn = Box<dyn Fn(Option<&Path>) + Send + Sync>`: `Some(path)` notes, `None` clears ours.
- `crates/ui-egui/src/recent_os.rs` (new, `pub mod`): `note(app, path)` (only when `recent_cap() > 0`) and
  `clear(app)`. Hooks: one marked line each in `push_recent` and `clear_recent` (`app/files.rs`).
  `remove_recent` (the Home screen's ×) does not touch the OS lists (no per-file API on Windows/macOS).
- `apps/photocraft/src/os_recent.rs` (new, safe code): `service(recovery_dir)` returns the closure; files inside the
  crash-recovery folder are skipped there (the folder is only known in the app). `note` makes the path absolute, then:
  - **Windows**: `photocraft_tablet::windows::add_recent_document(path)`: a marked section at the end of
    `crates/tablet/src/windows.rs`, `#[link(name = "shell32")] SHAddToRecentDocs(SHARD_PATHW, wide)`, `SAFETY:`
    comment; `recent_document_wide` refuses an empty path or one with a NUL (NULL would clear every app's list).
  - **macOS**: `NSDocumentController::sharedDocumentController(mtm).noteNewRecentDocumentURL(&NSURL::fileURLWithPath(..))`,
    skipped off the main thread or for a non-UTF-8 path. Features added: objc2-foundation `NSString`, `NSURL`;
    objc2-app-kit `NSDocumentController` (`Cargo.lock` unchanged; `--locked` passes).
  - **Linux/BSD**: module `xbel`: `$XDG_DATA_HOME/recently-used.xbel` (relative values ignored; default
    `~/.local/share`), GLib's layout (`mime:mime-type`, `bookmark:application name="Pigment"
    exec="&apos;pigment %u&apos;"`, `added`/`modified`/`visited`, `count`). Text-level edits so others' bytes stay
    identical: a known file (same href after XML-unescaping and percent-decoding) gets fresh times and our
    application entry beside the others'; new files go before `</xbel>`. At most 500 bookmarks name Pigment (oldest by
    our `modified` go; a bookmark another app also names keeps that app's entry). Written with
    `photocraft_format::atomic_write` under `rustix::fs::flock` on the file itself (re-checking the inode after the
    lock), on a thread of its own. A file without GLib's two namespace declarations, over 32 MiB, or not writable is
    left alone and the error only goes to `log::debug!`. MIME types from the formats `packaging/linux` registers.
  - `clear_ours` (Clear Recent): Linux only.
- `apps/photocraft/src/services.rs` `native`: `let recovery = recovery_dir();` once (it moves legacy autosaves, so it
  is not called twice), `note_recent: Some(crate::os_recent::service(recovery.clone()))`, `..recovery_services(recovery)`.
- `mod os_recent;` in `main.rs`.
- **Found in the code, not in the spec:** the Flatpak's `$XDG_DATA_HOME` is the sandbox's own, so the host list gets
  nothing unless the manifest grants `--filesystem=xdg-data/recently-used.xbel` (GTK apps need the same). Not changed
  (packaging is a separate decision); recorded in FORK.md.
- **Jump List:** the process keeps Windows' implicit AppUserModelID (`app_icon.rs:12`; the MSI test forbids an
  explicit one), so Explorer's Recent gets the entries; whether the taskbar Jump List shows a Recent category depends
  on the shell tying the implicit ID to Pigment's registered file types. **To check on the Windows runner / a real
  Windows machine** in the group's release dry run, and record what it shows.
- macOS: AppKit's `clearRecentDocuments:` would clear Pigment's own list, but its binding is `unsafe`
  (`NSDocumentController.rs:305`); left out, so Clear Recent leaves macOS' Recent Items alone. A one-line follow-up in
  `crates/tablet/src/macos.rs` could do it if wanted.

## Spec rows

- Row 45 Select Similar Layers: **done** (engine command, menu after Deselect Layers, tests).
- Row 46 OS recent documents: **done** for Windows (Recent; Jump List unverified), macOS (Recent Items, Dock), Linux/BSD
  (`recently-used.xbel`). Not done: Windows/macOS clearing (no per-app API on Windows; macOS's is an `unsafe` binding),
  the Flatpak permission (packaging decision), a hardware check of the Jump List.

## Tests

New:
- `crates/engine/src/cmd/similar_layers_cmds/tests.rs` (5): the fixture's kinds and type layers in different groups;
  active type layer → both type layers, active kept, no history step; adjustment (Invert + Levels) and fill (solid +
  gradient) layers of any kind match each other, groups select groups, a shape only itself; several kinds at once,
  the Background only when selected; no document / no selection is an error (and `enabled` says so), junk params
  are ignored.
- `crates/ui-egui/src/similar_layers_tests.rs` (1): the row sits right after Deselect Layers in the same submenu path,
  labelled and enabled; `select.similar` stays its own row.
- `crates/ui-egui/src/recent_os.rs` tests (3): `push_recent` calls the service with the path each time (de-duplicated
  in-app list unchanged), `clear_recent` calls it with `None`, `remove_recent` doesn't; nothing with Recent File List
  Contains = 0; no service works as before.
- `apps/photocraft/src/os_recent/tests.rs` (9, `#![cfg(unix)]`): XDG paths (relative ignored, no HOME → none); a new
  list in GLib's layout (parsed back by craft-xml); others' bookmarks byte for byte with a second note updating ours
  (count 2, `added` kept); a file another app lists gets our entry beside its own, another spelling of the same URI is
  the same bookmark, clearing ours restores the other app's bytes except its times; clear removes only ours and
  creates nothing when there is no list; the 500 cap drops the oldest; a non-GLib file is left alone, a relative path
  is refused; an unwritable list is an error the service swallows; URI escaping and MIME types.
- `apps/photocraft/src/os_recent.rs` `smoke` (2, every platform): recovery-folder filter; the service and (on Windows
  and macOS) the real platform call on a missing file do not panic.
- `crates/tablet/src/windows.rs` (1, Windows only): the wide path and the empty path; `add_recent_document` on a
  missing file and an empty path doesn't panic. Compiled here for the Windows target (clippy), not run.

Results (nextest `--profile ci`, `TMPDIR=/dev/shm/pt`, CI's font and i18n dirs):
- `cargo nextest run -p photocraft-engine --features photocraft-io/heif --lib --bins --tests`: **5031 passed**, 26
  skipped (the container-only `cancelling_the_open_stops_the_smart_filters` passed this time too).
- Panic hunt (`cargo test -p photocraft-engine --features photocraft-io/heif --test panic_hunt -- --ignored`): 1 passed.
- `cargo nextest run -j 3 -p photocraft-ui-egui --features photocraft-io/heif --lib --bins --tests` (whole suite):
  **3808 passed**, 6 skipped. After that run `NoteRecentFn` was given its own type alias (clippy's type_complexity);
  the recent-file and menu tests were re-run on the final tree (see the last line of this list).
- `cargo nextest run -p photocraft -p photocraft-tablet --features heif --lib --bins --tests`: **258 passed**, 2 skipped
  (the 11 `os_recent` tests among them; one of mine failed first on its own off-by-indent assertion, fixed).
- Re-run on the final tree: `-p photocraft-ui-egui --features photocraft-io/heif --lib
  -E 'test(/recent_os|similar_layers|recent|home_recent/)'`: 27 passed.
- `cargo fmt --all -- --check`; `cargo clippy --locked --features heif -p photocraft-engine -p photocraft-ui-egui
  -p photocraft-tablet -p photocraft --all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check`;
  `cargo xtask layers`, `panel-commands`, `test-binaries`, `scorecard --check`: all clean.

### The other platforms

- `rustup target add x86_64-pc-windows-msvc aarch64-apple-darwin` (both installed now).
- `cargo check` and `cargo clippy --all-targets -- -D warnings` of `-p photocraft-tablet` for
  **x86_64-pc-windows-msvc** and **aarch64-apple-darwin**: clean (the Windows shell call and its test compile).
- `-p photocraft` (the app) for both targets: **not possible here**: `ring 0.17.14`'s build script fails (no MSVC /
  Apple C toolchain for the target: "GNU compiler is not supported for this target" on Windows, the same build script
  on macOS). So the app's `os_recent.rs` Windows and macOS branches were not compiled by cargo here. Instead:
  - the macOS `mac` module was copied verbatim into a scratch crate with the app's exact objc2 pins and features and
    `#![forbid(unsafe_code)]`, and `cargo clippy --target aarch64-apple-darwin -- -D warnings` passed (scratch deleted);
  - the Windows branch is the single call `photocraft_tablet::windows::add_recent_document(&path)`, whose crate
    checked clean.
  The release dry run on real runners will compile both for real.
- Deleted afterwards: `target/x86_64-pc-windows-msvc`, `target/aarch64-apple-darwin` (and the examples executables
  over 20 MB in `target/debug/examples`, 1.7 GB, to have more than 8 GB free for the app checks).

## Hooks into upstream files (all in FORK.md, "Select › Similar Layers" and "The operating system's recent documents")

- `crates/engine/src/cmd.rs`: `pub mod similar_layers_cmds;` (alphabetical place, rustfmt wants it there, after
  `selection_cmds`) and `v.extend(similar_layers_cmds::specs());` after the AI line.
- `crates/ui-egui/src/menus/items.rs`: one `PLACE_AFTER` tuple.
- `crates/ui-egui/src/lib.rs`: `pub mod recent_os;`, `#[cfg(test)] mod similar_layers_tests;` (each marked).
- `crates/ui-egui/src/services.rs`: the `note_recent` field.
- `crates/ui-egui/src/app/files.rs`: one line in `push_recent`, one in `clear_recent`.
- `apps/photocraft/src/main.rs`: `mod os_recent;`.
- `apps/photocraft/src/services.rs`: `let recovery = recovery_dir();`, the `note_recent` field, `..recovery_services(recovery)`.
- `apps/photocraft/Cargo.toml`: three objc2 features and the comment.
- `crates/tablet/src/windows.rs`: the marked shell32 section and one test.
- Docs: `docs/parity/README.md` (the two U4 rows "Done in 0.6"), `docs/user/guides/open-and-save-files.md` (the
  recent-lists sentence), FORK.md.

## For the next package

- **CI**: check the runs on `e8ec9d5`, `0a8765f` and `53805fb` first.
- **U3** edits `crates/tablet/src/windows.rs` too: my code is one marked section just above `#[cfg(test)] mod tests`,
  plus the test `recent_documents_take_a_terminated_path_and_never_null` at the top of that module. Keep both.
  U3 also adds `install_windows(feed)` to `apps/photocraft/src/main.rs`; my only line there is `mod os_recent;`.
- **The Windows and macOS app builds cannot be checked here** (ring's C build script). Check `-p photocraft-tablet`
  for those targets, and compile any app-side platform code in a scratch crate, as above.
- **Release dry run / hardware**: on Windows, open a file and look at Explorer's Recent and the taskbar Jump List; on
  macOS, Apple menu › Recent Items and the Dock menu. Record what the Jump List shows (implicit AppUserModelID).
- The Flatpak manifest (`packaging/linux/flatpak`) might want `--filesystem=xdg-data/recently-used.xbel` so the host
  desktop sees Pigment's files: a packaging decision for the project's owner.
- Disk: about 9 GB free at the end; the ui-egui test build took ~23 minutes.
