# Pigment on PhotoCraft: the rebrand, CI and release workflows

The user's goal is every Photoshop feature in a free editor called Pigment. Pigment 0.1 to 0.4 was an Electron app in JavaScript. A row-by-row comparison of 1,432 Photoshop features found PhotoCraft (github.com/storytold/photocraft, a clean-room Photoshop reimplementation in pure Rust, MIT OR Apache-2.0) far ahead: 905 features done against Pigment's 545. The user decided to build Pigment on PhotoCraft, keep the name Pigment, and stop the JavaScript app.

Nib did the same with VectorCraft (another app from the same ArtCraft team), and its rebrand is the model to follow:
- `git show origin/claude/nib-vector-editor:nib/docs/FORK.md` (what was renamed, what was kept, how upstream merges work);
- `git show origin/claude/nib-vector-editor:nib/scripts/nib-rebrand.py`;
- `git show origin/claude/nib-vector-editor:.github/workflows/nib-ci.yml` and `nib-release.yml`;
- `git ls-tree -r --name-only origin/claude/nib-vector-editor nib/packaging nib/assets` to see the files.

Run all git commands from /home/user/claude.

## Where things are

- Repository /home/user/claude, branch `claude/pigment-photocraft`. Commit 15b8ea5 imported PhotoCraft's tree unchanged at abb30dff47638eaa38a09de11b60ae8a14baa334 into `pigment/` (workspace version 0.23.1; the commit is recorded in `pigment/UPSTREAM-REVISION`). It left out PhotoCraft's `.github`, `.coderabbit.yaml` and `sonar-project.properties`.
- The JavaScript Pigment is on branch `claude/fervent-newton-263lz3`, for example `git show claude/fervent-newton-263lz3:pigment/package.json`. It has tags pigment-v0.1.0 to v0.4.0 and was released as pigment-v0.4.0. Its icon is `pigment/build/icon.svg` and `icon.png` on that branch.
- PhotoCraft's upstream clone, with its `.github/workflows`, is /home/user/storytold/photocraft. craft-libs, at the revision PhotoCraft pins, is /home/user/storytold/craft-libs. Read these; don't change them.
- The machine has 4 CPUs and about 25 GB of free disk.
  - **One build at a time.** Cargo locks the target directory, so run one cargo process at a time, with `-j 4`.
  - **No second target directory,** and no `cargo clean`.
  - **The first build may still be running.** It started at 13:12 UTC; its log is `/tmp/claude-0/-home-user-claude/02aa60de-818c-5d38-b2f3-33055ac112a1/scratchpad/pc-build/build-1.log`, which ends with an `exit` line when done. Read and edit while it runs, and wait for its `exit` line before your first cargo command.
  - **Don't run the whole workspace test suite.** It is far too long here, and CI runs it. Run the tests of the crates and files you touched.
- **Commits.** Make a local commit on `claude/pigment-photocraft` after each verified part. End each message with these two lines:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_012irzNNBVSJyVqHJpCPbdwm
  ```

  Don't push, don't rewrite history, and put no model names elsewhere in the repository.

## Decisions (already made)

1. **Names.**
   - The product name is Pigment everywhere a user sees it: interface, messages, logs, CLI help, MCP, the web build's page title, PDF and other file "creator" fields.
   - The desktop binary is `pigment` and the CLI binary is `pigment-cli` (the `[[bin]]` names; the package names stay `photocraft`, `photocraft-cli`).
2. **Version.**
   - `[workspace.package] version = "0.5.0"`; regenerate Cargo.lock with cargo, never by hand. Pigment 0.5.0 succeeds the JavaScript 0.4.0.
   - `pigment --version`, `pigment-cli --version` and Help › About print `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`, with an `UPSTREAM_VERSION` constant as in Nib's `brand.rs`.
3. **Application id: `io.github.nihalpi1212.pigment`.**
   - It covers the Wayland/X11 app id, desktop entry, AppStream, MIME, macOS bundle id, Flatpak id and any Windows AppUserModelID.
   - The JavaScript app's appId was `com.pigmentapp.app`. The two are different apps and can be installed side by side.
4. **Folders.**
   - Settings, logs, data recovery, fonts, plug-ins, scripts and templates go in `Pigment` (`~/.config/pigment` on Linux, `%APPDATA%\Pigment`, `~/Library/Application Support/Pigment`).
   - Portable mode uses `Pigment.portable` (or `portable.txt` if upstream has it) and `PigmentData`, and the log file is `pigment.log`. Nothing is read from PhotoCraft's or ArtCraft's folders.
   - **Check for clashes with the JavaScript app.** Electron's userData folder for that app is also named `Pigment` on Windows and macOS. Find what the JavaScript app writes there (its `src/main/*.js` on the old branch; Electron's own Cache, Local Storage, Preferences and similar) and what PhotoCraft writes in its folder. If any file or folder name clashes, give PhotoCraft's a different name. Say in FORK.md what you found.
5. **Native file extension: `.pigment`.**
   - Saves keep PhotoCraft's format inside (craft-pcraft-format's manifest.json and tiles; the format id and markers stay). MIME type `application/x-pigment`, description "Pigment Image". `.pcraft` still opens.
   - A `.pigment` file from Pigment 0.1 to 0.4 is a ZIP with `document.json` and `layers/<id>.png`, and no `manifest.json`. Opening one must fail with a typed error and the message: "This file was saved by Pigment 0.4 or earlier. Opening these files is coming in a later update." A later package adds the importer behind that error, so make it easy to hook.
6. **Icon.**
   - Pigment's icon (the JavaScript app's `build/icon.svg`) replaces PhotoCraft's fox everywhere the app ships an icon. That includes the hicolor PNG sizes, `.ico`, `.icns`, document icons, Windows and macOS packaging assets, the DMG background if it is branded, and the web favicon and manifest.
   - Follow `assets/app-icon/README.md` and `packaging/icons.sh` for the sizes. Render the SVG with whatever converter is available here (pip packages such as cairosvg are fine, run with `python3 -I`).
   - Never ship PhotoCraft's or ArtCraft's icons or logos as Pigment's; `docs/brand` logos go from the README.
7. **Links.**
   - Report an Issue: https://github.com/Nihalpi1212/claude/issues
   - Pigment on GitHub: https://github.com/Nihalpi1212/claude
   - Pigment Releases: https://github.com/Nihalpi1212/claude/releases
   - PhotoCraft (upstream project): https://github.com/storytold/photocraft
   - Discord, getartcraft.com and other ArtCraft links go. About says: "Pigment is based on PhotoCraft by the ArtCraft team and the PhotoCraft contributors (MIT OR Apache-2.0)", and keeps the upstream contributors list.
8. **No network request on its own.**
   - Check for Updates opens the releases page in the browser.
   - The once-per-launch update check and any update prompt or installer are switched off, as in Nib. The AppImage carries no update information or `.zsync`, and the Flatpak loses update and launcher permissions.
   - Audit every outgoing endpoint (update checks, telemetry, crash reports, font or model downloads, the ArtCraft Launcher) and list them in FORK.md.
   - The MCP and agent gate (`craft_ai_agents::allowed`, which reads the ArtCraft Launcher's app list) must depend on Pigment's own setting, not on the ArtCraft Launcher. Choose the default that keeps the command line and MCP server usable, as upstream intends for its own users, and document it.
9. **Keep internal identifiers, for upstream merges.** Keep crate and package names, module paths, types, command ids, environment variables (`PHOTOCRAFT_*`), the native format id and the file markers PhotoCraft reads back. Keep comments, upstream docs (other than README, FORK.md and release notes), contributor credits and licence texts.
10. **Packaging.**
    - Linux: desktop entry, AppStream metainfo, MIME xml, AppRun, package.sh and Flatpak manifests, renamed to the new id.
    - Windows: WiX with a new UpgradeCode and new component GUIDs (generate fresh UUIDs), `Program Files\Pigment`, `Software\Pigment`, `pigment.exe`, `pigment-cli.exe`.
    - macOS: `Pigment.app`, Info.plist document types for `.pigment`, the bundle id and the DMG volume name.
    - FreeBSD naming.
    - Release asset names: `pigment-<ver>-…` and `pigment-cli-<ver>-…`.
11. **Docs and a rebrand script.**
    - `pigment/scripts/pigment-rebrand.py`, modelled on nib-rebrand.py: idempotent, with `--check`.
    - `pigment/docs/FORK.md`, modelled on Nib's: what was renamed, what was kept, the endpoint audit, how to merge a later PhotoCraft revision, and the classification of the names that remain.
    - `pigment/README.md` for Pigment: what it is, that it is based on PhotoCraft (with credit), downloads from our releases, first launch of unsigned builds, licence.
    - `pigment/NOTICE` and `ATTRIBUTION.md` keep upstream's text and add Pigment's line.
12. **CI and release workflows.**
    - `.github/workflows/pigment-ci.yml`, modelled on nib-ci.yml. Path filters on `pigment/**` and the workflow itself. It runs fmt, clippy with `-D warnings`, the workspace tests (lib, bins, tests), doctests, the repository checks of PhotoCraft's own gate that need no extra toolchain (find them in xtask and upstream's `.github/workflows/ci.yml`; leave out those that need secrets, the network or corpora), and a CLI smoke test that checks the version line and converts an example to PNG and `.pigment` and back.
    - `.github/workflows/pigment-release.yml`, modelled on nib-release.yml and PhotoCraft's own release.yml. Tags `pigment-v*` and workflow_dispatch with a `tag` input. Linux AppImage, deb and tar.gz on ubuntu-22.04; Windows x64 MSI and portable zip; macOS universal DMG and CLI zip; SHA256SUMS. Release notes from `pigment/docs/RELEASE-NOTES-<version>.md`. Unsigned, with an ad-hoc macOS signature as in Nib. No signing secrets are needed.
    - Pin every action by commit SHA, as Nib does.

## Checks before you finish

- `cargo build --locked -p photocraft -p photocraft-cli -j 4`. Then `target/debug/pigment --version` and `target/debug/pigment-cli --version` print the version line.
- The CLI converts an example document to PNG, saves `.pigment`, and reopens it. A JavaScript-era `.pigment` gives the typed error: build one with python3's zipfile, holding a `document.json` and a `layers/1.png`.
- cargo test for every crate and test file you touched; cargo fmt --check; cargo clippy with `-D warnings` on the touched crates.
- `python3 pigment/scripts/pigment-rebrand.py --check` is clean.
- `rg` finds no user-visible PhotoCraft, ArtCraft or storyteller name outside the kept classes; give the counts in FORK.md, as Nib does.
- Validate both workflows' YAML (for example with python3 and yaml).
