# Pigment and PhotoCraft

Pigment is a free, open-source image editor based on
[PhotoCraft](https://github.com/storytold/photocraft) by the ArtCraft team and the PhotoCraft
contributors (MIT OR Apache-2.0). This page says what Pigment changed, which upstream revision it
is built on, and how to bring in a later upstream revision without losing the rebrand.

- **Upstream revision:** `abb30dff47638eaa38a09de11b60ae8a14baa334`, PhotoCraft workspace version
  0.23.1. The current revision is always in [`UPSTREAM-REVISION`](../UPSTREAM-REVISION); the version
  Pigment names in `--version` and About is `UPSTREAM_VERSION` in
  [`crates/format/src/brand.rs`](../crates/format/src/brand.rs).
- **Pigment's version:** 0.5.0 (`[workspace.package] version` in `Cargo.toml`). It follows the
  JavaScript Pigment 0.1 to 0.4 (an Electron app, released up to `pigment-v0.4.0`), which this
  version replaces. `pigment --version`, `pigment-cli --version` and Help › About print
  `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`.
- **Pigment's repository:** <https://github.com/Nihalpi1212/claude> (the app lives in `pigment/`).
  Issues: <https://github.com/Nihalpi1212/claude/issues>. Releases: tags `pigment-vX.Y.Z`, assets
  `pigment-*`, at <https://github.com/Nihalpi1212/claude/releases>.

Everything in PhotoCraft's docs (`docs/*.md` other than this page and the release notes, `book/`)
describes PhotoCraft as it was at the upstream revision; read "PhotoCraft" there as "Pigment" unless
it names the upstream project. [`AGENTS.md`](../AGENTS.md) is PhotoCraft's agent guide: its
engineering rules (Rust only, no panics or `unsafe` in shipped code, hostile input, clean room,
asset and licence policy) apply to Pigment; its process rules (pull requests, issues, contributor
credits, the suite's naming) are PhotoCraft's own.

## What Pigment changed: the rebrand

The rebrand keeps every crate, package and module name (`photocraft-*`, `photocraft_*`,
`PhotocraftApp`), the native format's content, id and markers, command ids and environment variables
(`PHOTOCRAFT_*`), so upstream changes still apply. What a user sees is Pigment's.

### Renamed

| What | PhotoCraft | Pigment |
|---|---|---|
| Product name in the interface, messages, logs, CLI help, MCP, the web build's page | PhotoCraft | Pigment |
| Desktop binary (`[[bin]]` of package `photocraft`) | `photocraft` | `pigment` |
| CLI binary (`[[bin]]` of package `photocraft-cli`) | `photocraft-cli` | `pigment-cli` |
| Version | 0.23.1 | 0.5.0, shown as `Pigment 0.5.0 (based on PhotoCraft 0.23.1)` |
| Application id (Wayland/X11 app id, desktop entry, AppStream, MIME icon, macOS bundle id, Flatpak id) | `ai.storyteller.photocraft` | `io.github.nihalpi1212.pigment` |
| Packaging files | `packaging/linux/ai.storyteller.photocraft.*`, `packaging/linux/flatpak/ai.storyteller.photocraft*.yml`, `packaging/windows/photocraft.wxs`, `photocraft.en-us.wxl` | `…/io.github.nihalpi1212.pigment.*`, `packaging/windows/pigment.wxs`, `pigment.en-us.wxl` |
| Windows installer | UpgradeCode `D9660F32-…`, component GUID `A6DE41B7-…`, `Program Files\ArtCraft\PhotoCraft`, `Software\PhotoCraft`, ProgIds `Photocraft.*`, publisher Learning Machines LLC | new UpgradeCode `E3B35B0C-7545-464E-928A-546E924AC29F` and component GUID `267EC2F2-849F-4160-8162-83687268DDAB`, `Program Files\Pigment` (`Programs\Pigment` per user), `Software\Pigment`, ProgIds `Pigment.*`, `pigment.exe`, `pigment-cli.exe`, publisher "Pigment contributors" |
| Windows AppUserModelID | none set by PhotoCraft (Windows derives it from the exe) | none, so it follows `pigment.exe` |
| Release asset names | `photocraft-<ver>-…`, `photocraft-cli-<ver>-…` | `pigment-<ver>-…`, `pigment-cli-<ver>-…` |
| macOS app | `PhotoCraft.app` | `Pigment.app` (executable `Pigment`, volume `Pigment`; the CLI's signing identifier `io.github.nihalpi1212.pigment-cli`) |
| FreeBSD and Linux trees | `bin/photocraft`, `share/doc/photocraft`, `photocraft-<ver>-freebsd-<arch>.tar.gz` | `bin/pigment`, `share/doc/pigment`, `pigment-<ver>-freebsd-<arch>.tar.gz`; deb/rpm package `pigment` |
| Settings, logs, Data Recovery, presets folder | `Photocraft` (`~/.config/photocraft`, `%APPDATA%\Photocraft`, `~/Library/Application Support/Photocraft`; recovery in `%LOCALAPPDATA%\Photocraft` and `$XDG_STATE_HOME/photocraft`) | `Pigment` (`~/.config/pigment`, `%APPDATA%\Pigment`, `~/Library/Application Support/Pigment`; `%LOCALAPPDATA%\Pigment`, `$XDG_STATE_HOME/pigment`); nothing is read from PhotoCraft's or ArtCraft's folders |
| Brush and preset library in the settings folder | `Presets` | `Preset Library` (see [the clash check](#the-settings-folder-and-pigment-01-04)) |
| Portable mode | `portable.txt` beside the exe, `PhotoCraftData` | `portable.txt`, `PigmentData` |
| Log file | `logs/photocraft.log` (`photocraft.1.log` …), lock `photocraft.lock` | `logs/pigment.log` (`pigment.1.log` …), lock `pigment.lock` |
| Native file extension | `.pcraft` | `.pigment` (MIME `application/x-pigment`, "Pigment Image"; macOS type `io.github.nihalpi1212.pigment.document`); `.pcraft` still opens and can still be saved |
| Pigment 0.1–0.4 documents | — | a `.pigment` ZIP with `document.json` and `layers/<id>.png` is recognised by content and refused with a typed error ([below](#documents-from-pigment-01-04)) |
| Shortcut set and actions | "PhotoCraft Defaults", "PhotoCraft Actions" | "Pigment Defaults", "Pigment Actions" |
| MCP server | `serverInfo.name` `photocraft` | `pigment` (title and instructions say Pigment) |
| Agent consent | the ArtCraft Launcher's switch, behind the suite's `AI-MCP` flag | Pigment's own preference ([below](#ai-agents-and-mcp)) |
| Windows version resources | ProductName PhotoCraft, CompanyName Learning Machines LLC | ProductName Pigment, CompanyName "Pigment contributors", copyright naming both |
| App icon | the engraved nine-tailed fox on blue | Pigment's palette-and-brush icon (the JavaScript app's `build/icon.svg`, [`assets/app-icon/`](../assets/app-icon/README.md)): hicolor PNGs, `.ico`, `.icns`, the runtime icons, the brand mark, the MSI art (drawn from it by `package.ps1`) |
| Help menu, About, start screen links | ArtCraft Discord, getartcraft.com, `storytold/photocraft` | Report an Issue, Pigment on GitHub, Pigment Releases, PhotoCraft (upstream project) |
| About | "Part of ArtCraft", Discord button | `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`, "Pigment is based on PhotoCraft by the ArtCraft team and the PhotoCraft contributors (MIT OR Apache-2.0)", with the upstream contributors list kept |
| Interface translations | craft-i18n's `photocraft.tsv` and `common.tsv`, embedded raw | the same catalogs, rebranded by `crates/ui-egui/build.rs` as it embeds them |
| README, NOTICE, ATTRIBUTION.md | PhotoCraft's | Pigment's README; NOTICE and ATTRIBUTION.md keep upstream's text with Pigment's lines added |
| `docs/brand/` (ArtCraft's name, wordmark and logos) | shipped, under a trademark licence that tells forks to remove them | removed |

The command ids behind the links stay PhotoCraft's: `help.reportIssue` opens Pigment's issue
tracker, `help.github` Pigment's repository, `help.website` Pigment's releases and
`help.artcraftWebsite` the upstream project (`crates/engine/src/shell_commands.rs`,
`crates/ui-egui/src/links.rs`). `help.discord` is gone: PhotoCraft had five link commands and
Pigment has four links, and a second "Report an Issue" entry would only duplicate one.

### Documents from Pigment 0.1–0.4

Pigment 0.5 saves PhotoCraft's native format unchanged (craft-pcraft-format's `manifest.json`, tiles
and markers) under the `.pigment` extension, so `.pigment` and `.pcraft` files are the same format
and PhotoCraft opens Pigment's files once renamed. A `.pigment` file from the JavaScript app is a
ZIP with `document.json` and `layers/<id>.png` and no `manifest.json`.
`photocraft_format::brand::is_legacy_pigment` recognises one by its content, whatever it is called,
and every open path (File › Open and Open As, Place, Open Recent, the CLI, MCP, scripts) reaches
`crates/io/src/legacy_pigment.rs` before any other importer. Its `import` fails with
`IoError::LegacyPigment`, whose message is "This file was saved by Pigment 0.4 or earlier. Opening
these files is coming in a later update." The importer goes in that one function.

### The settings folder and Pigment 0.1–0.4

Electron names the JavaScript app's userData folder after its product name, `Pigment`: on Windows
`%APPDATA%\Pigment` and on macOS `~/Library/Application Support/Pigment`, the folders Pigment 0.5
uses for its settings (on Linux Electron uses `~/.config/Pigment`, Pigment 0.5 `~/.config/pigment`,
two folders on case-sensitive file systems). What each writes there:

| Pigment 0.1–0.4 (`src/main/*.js` and Electron itself) | Pigment 0.5 (PhotoCraft's files) |
|---|---|
| `settings.json`, `recent.json`, `ai-credentials.json`, `presets/` (`<kind>.json` and `<kind>/<name>`) | `preferences.json`, `ui.ron`, `gpu-compositor.json`, `gpu-starting.json`, `instance.lock`, `instance.json`, `agent-connection.json`, `agent-control.token`, `recovery-migration.lock`, `logs/` (`pigment.log`, `pigment.lock`, `rotate.lock`), `Recovery/` (macOS; Windows keeps it in `%LOCALAPPDATA%\Pigment`), `Presets` → `Preset Library/` (`index.json`, `actions.json`, `patterns.json` and tip bitmaps) |
| Electron and Chromium: `Preferences`, `Local State`, `Cache/`, `Code Cache/`, `GPUCache/`, `DawnGraphiteCache/`, `DawnWebGPUCache/`, `Local Storage/`, `Session Storage/`, `IndexedDB/`, `blob_storage/`, `Shared Dictionary/`, `SharedStorage`, `Network Persistent State`, `TransportSecurity`, `Trust Tokens`, `Cookies`, `Crashpad/` | — |

One name clashed: PhotoCraft's `Presets` folder and the JavaScript app's `presets` are the same
folder on the case-insensitive file systems Windows and macOS use by default, and both write
`<name>.json` files there with different contents. Pigment 0.5 names its folder `Preset Library`
(`PRESETS_DIR` in `apps/photocraft/src/services.rs`). Nothing else shares a name: Chromium's
`Preferences` has no extension, PhotoCraft's `preferences.json` has one, and Electron writes no
`logs`, `Recovery` or `ui.ron`. `com.pigmentapp.app` and `io.github.nihalpi1212.pigment` are
different application ids, and Pigment 0.5 reads none of the JavaScript app's files.

**Install locations do clash.** The JavaScript app's installers used the same places Pigment 0.5's
use by default, so installing 0.5 there replaces 0.4 instead of installing beside it:

- Windows: electron-builder's assisted NSIS installer put Pigment 0.4 in
  `%LOCALAPPDATA%\Programs\Pigment` (for one user) or `C:\Program Files\Pigment` (for everyone),
  the folders the MSI picks for "Only for me" and "Everyone". The MSI then writes `pigment.exe` over
  0.4's `Pigment.exe` (Windows names ignore case), and 0.4's uninstaller later deletes the whole
  folder, Pigment 0.5's files included. Both also add a Start menu shortcut named `Pigment`.
- macOS: both DMGs hold `Pigment.app`; dragging 0.5 to Applications replaces 0.4.
- Linux: the AppImages have different file names and can be kept side by side.

The README and the 0.5.0 release notes tell 0.4 users to export their `.pigment` documents (PSD or
PNG) before installing 0.5, or to install 0.5 in another folder (the MSI's folder page, or another
folder on macOS). Changing the default install folder or the app bundle name is left as a decision
for a later release.

There are no separate fonts, plug-ins, scripts or templates folders: PhotoCraft reads system fonts,
loads plug-ins and scripts from where the user opens them, and keeps templates in its presets.

### AI agents and MCP

PhotoCraft lets agents use the open window only behind the suite's `AI-MCP` feature flag
(`ArtCraft/flags.toml` or `CRAFT_FLAGS`, read by `craft-flags`) and the ArtCraft Launcher's switch
(the launcher's app list, read by `craft_ai_agents::allowed("photocraft")`). Pigment reads neither:
`agent_link::mcp_flag()` and `agent_link::launcher_allows_agents()` in
`crates/automation/src/agent_link.rs` are always false, the app no longer loads the flags file or
watches the launcher, and the gate is Pigment's own preference, **Preferences › AI Integrations ›
Let AI apps use this window** (`connectAgents`, also turned on by a Control Port saved in older
preferences). Allow Agent Control off still refuses agents.

**Default: off.** That is what PhotoCraft gives a user without the launcher (no app list counts as
no), and it keeps the command line and the MCP server usable as upstream intends: `pigment-cli mcp`
serves a headless session with the folders given to it, exactly as before; with the switch on it
uses the open window and, while the app is closed, does what **When Pigment is closed** says
(start it, a headless session, or an error). `pigment --control` and `pigment-cli mcp --bridge` work
as before, whatever the switch. `pigment-cli` always calls its MCP server `pigment`.

### Updates and the network

Pigment never downloads or installs anything and makes no network request on its own:

- **Check for Updates** (`help.checkForUpdates`) opens the releases page in the browser
  (`crates/ui-egui/src/updates_ui.rs`); it is always enabled, and fetches nothing.
- The once-per-launch check is gone: the desktop app has no update service (`check_updates` and
  `last_update` are `None` in `apps/photocraft/src/services.rs`), and `updates_ui::tick` starts no
  check. **Automatically Check for Updates** is hidden from Preferences
  (`prefs::HIDDEN_UNTIL_IMPLEMENTED`; the setting still loads and saves). craft-update's release window stays
  compiled in, pointed at Pigment's repository and ids (`UPDATE_APP` in
  `crates/ui-egui/src/lib.rs`). `apps/photocraft/src/updates.rs` (PhotoCraft's checker) is kept for
  merges but not wired in, and the Windows update helper (`--finish-update`) is not wired in.
- The AppImage carries no update information and no `.zsync`; the Flatpaks lost
  `--talk-name=org.freedesktop.Flatpak` and the ArtCraft Launcher folder
  (`--filesystem=xdg-data/ArtCraft/versions:ro`). The network stays for printing to a CUPS server and
  the `--control` server.

#### Outgoing endpoints

Every place in the shipped code that can reach another machine, and what Pigment does with it:

| Endpoint | Where | In PhotoCraft | In Pigment |
|---|---|---|---|
| GitHub releases API (`api.github.com/repos/storytold/photocraft/releases`) and release downloads | `craft-update` via `apps/photocraft/src/updates.rs` | checked once per launch and from Help › Check for Updates; the installer downloads and runs updates | not called: no update service, the menu opens <https://github.com/Nihalpi1212/claude/releases> |
| Windows self-update helper (`--finish-update`) | `craft_update::self_update::finish` in `main.rs` | finishes a downloaded update | not wired in |
| ArtCraft Launcher app list and suite flags | `craft_ai_agents::allowed`, `craft_flags::load` (local files under the launcher's data folder) | decides whether agents may use the window | never read |
| Release pages in error messages and the release window | `crates/engine/src/cmd/updates_cmds.rs` (`RELEASES`), `crates/engine/src/error.rs` | `storytold/photocraft/releases` | Pigment's releases; opened only when the user clicks |
| Help, About and start-screen links; contributor profiles (`github.com/<login>`) in About › Contributors; Learn (`pigment/docs/user` on GitHub) | `crates/ui-egui/src/links.rs`, `dialogs/credits.rs`, `canvas/start_screen.rs` | Discord, getartcraft.com, `storytold/photocraft` | Pigment's issues, repository and releases, and the upstream project; opened in the browser only when clicked |
| Printing (IPP to a printer or CUPS server, `lp`/`lpstat`, Avahi) | `crates/ipp`, the print commands | when the user prints | unchanged |
| Control server, MCP bridge, single-instance hand-off, agent connection | `apps/photocraft/src/control_server.rs`, `crates/automation/src/{bridge,agent_link}.rs`, `single_instance.rs` | loopback (`127.0.0.1`) only | unchanged, loopback only |
| Web build: its own WebAssembly parts and served fonts | `apps/photocraft-web-boot`, `crates/text` (`fonts/manifest.txt`) | same origin as the page | unchanged (the web build is not part of Pigment's releases) |
| Telemetry, crash reports, font or model downloads | — | none: crash and start-up reports are local files and dialogs, fonts are system or embedded, the face-detection weights are bundled | none |
| Packaging and developer tooling: appimagetool and its runtime, nfpm, cargo-fuzz, corpora (`cargo xtask corpus`) | `packaging/`, `xtask/` | pinned, SHA-256 checked downloads | unchanged; never part of the app |

### Not renamed (internal identifiers, kept for upstream merges)

- Crate and package names, Rust paths and types (`photocraft_engine`, `PhotocraftApp`), the source
  folders `apps/photocraft*`, the web build's binary `photocraft-web`, its DOM ids, script names and
  browser storage keys (`photocraft.preferences`, `photocraft.presets`), and the WiX element ids
  (`PhotocraftExe`, `PhotocraftFiles`, …).
- The native format: craft-pcraft-format's `EXTENSION` (`pcraft`), its manifest and markers, the
  format id `pcraft` in the command API (`document.save {format: "pcraft"}`, `file.package`), MCP
  resource URIs (`photocraft://document`, `photocraft://commands`), the MIME type
  `application/x-photocraft` and the macOS type `ai.storyteller.photocraft.document` for `.pcraft`.
- Markers other files carry and PhotoCraft reads back: the XMP toolkit `PhotoCraft` that Camera Raw
  sidecars carry (`is_photocraft_xmp`), the built-in profile descriptions (`Dot Gain 20%-compatible
  (gamma 1.732, PhotoCraft)`, `PhotoCraft Coated CMYK`), the hidden font-face aliases
  (`.PhotoCraft-face-…`), the case-sensitivity probe file.
- Environment variables (`PHOTOCRAFT_CONFIG_DIR`, `PHOTOCRAFT_CONTROL_PORT`, `PHOTOCRAFT_BUILD_SHA`, …)
  and the library crates' log targets (`photocraft_engine::…`). The desktop binary is `pigment`, so
  its own modules log as `pigment::…` (`RUST_LOG=pigment=debug`); the default filter
  (`apps/photocraft/src/logging.rs`) shows `info` for both `photocraft*` and `pigment*`. A second
  instance's log is `pigment-<pid>.log`.
- The id the ArtCraft Launcher would know PhotoCraft by (`LAUNCHER_APP_ID`), unused.
- Comments, PhotoCraft's docs, `book/`, changelogs and roadmap, the contributor credits
  (`contributors/`, Help › About › Contributors), `NOTICE`'s upstream text, `ATTRIBUTION.md`'s rows
  and the licence files.

### Classification of the remaining upstream names

`rg -n -i 'photocraft|artcraft|storyteller|getartcraft|storytold' pigment --glob '!target'` after
the rebrand (counts of matching lines, 2026-11-15):

| Kind | Matches | Decision |
|---|---|---|
| All matches | 35,906 lines | |
| PhotoCraft's own docs and book (`docs/*.md` but this page and the release notes, `book/`) | 7,414 | keep (upstream history) |
| Comments in Rust code | 1,308 lines | keep (internal) |
| Crate, package, module and type identifiers in Rust code (`photocraft_*`, `photocraft-*`, `PhotocraftApp`, `photocraft::` log targets) | ~25,700 lines | keep (internal) |
| Environment variables `PHOTOCRAFT_*` (code, scripts, docs) | 577 | keep (internal interface) |
| `Cargo.toml` and `Cargo.lock` (package names, `storytold/craft-libs`, `storytold/egui` and other dependency sources) | 511 | keep (internal names, dependencies) |
| `PhotoCraft` as a word in Rust code outside comments | 30 lines | keep: the XMP toolkit marker and its tests, profile descriptions documents carry, the font-face alias and case probe, the upstream link, credit and version line (`brand.rs`, `links.rs`, `shell_commands.rs`), the copyright in the Windows resources, the catalog rebrand (`build.rs`), the example plug-in's author, developer tooling (`xtask`), tests of those (including the test that the embedded catalogues name neither) |
| `ArtCraft` in Rust code outside comments | 6 lines | keep: the credit line in About, the never-wired launcher watch (`apps/photocraft/src/agent_link.rs`), a test that the launcher is gone |
| Packaging (`packaging/`) | 147 lines | keep: environment variables, `-p photocraft` package names, `apps/photocraft*` paths, WiX element ids (`PhotocraftExe`, …), the web build's `photocraft-web` file names and `photocraft-parts` marker, `.pcraft`'s own types (`application/x-photocraft`, `ai.storyteller.photocraft.document`, "PhotoCraft Document"), the craft-i18n and craft-fonts sources, credits and comments, the ArtCraft Launcher's own install-policy mode in `check-install-policy.ps1` (unused by Pigment) |
| README, NOTICE, ATTRIBUTION.md, this page, the release notes | 204 | keep: credits, upstream links, upstream notice and asset rows |
| `AGENTS.md`, `ROADMAP.md`, `SECURITY.md`, `Dockerfile`, `xtask/`, `scorecard/`, `perf/`, `tests/`, `examples/` | 169 | keep (upstream guides, roadmap and developer tooling) |
| `contributors/` | 1 | keep (credits) |
| User-visible strings, catalogues (rebranded at build time), packaging names, icons, links | 0 left | changed to Pigment |

## What Pigment added

Pigment's own features live in files of their own. Where they hook into an upstream file, the hook
is a line or two marked `// Pigment: …` (or `# Pigment: …`), and every one is listed here, so a
merge knows what to keep.

### Generative AI

The JavaScript Pigment's AI features rebuilt on PhotoCraft; the contract is
[`docs/generative-ai.md`](generative-ai.md). New files: `crates/engine/src/generative.rs`,
`crates/engine/src/generative/mock.rs`, `crates/engine/src/cmd/ai_cmds.rs` and
`crates/engine/src/cmd/ai_cmds/` (`region.rs`, `fill.rs`, `expand.rs`, `generate.rs`,
`background.rs`, `describe.rs`, `tests.rs`), this page's section and `docs/generative-ai.md`; the
provider crate `crates/genai` (package `pigment-genai`, with its tests in `crates/genai/tests/genai/`;
Sign in with ChatGPT is its `src/chatgpt.rs` and `tests/genai/chatgpt.rs`),
`crates/automation/src/genai.rs`, `apps/photocraft-cli/src/ai.rs` and
`apps/photocraft-cli/tests/it/ai.rs`; the interface `crates/ui-egui/src/ai_ui.rs` and
`crates/ui-egui/src/ai_ui/` (`generate.rs`, `accounts.rs`, `describe.rs`, `task_bar.rs`, and the
Assistant's `assistant.rs` and `assistant_tools.rs`) with its tests in
`crates/ui-egui/tests/it/ai.rs` and `crates/ui-egui/tests/it/ai_assistant.rs`.

| Upstream file | Hook |
|---|---|
| `crates/engine/src/lib.rs` | `pub mod generative;`, `pub use cmd::ai_cmds;`, the `Session` field `generative` (its `set_generative` and `generative` live in `generative.rs`) |
| `crates/engine/src/cmd.rs` | `pub mod ai_cmds;` and `v.extend(crate::ai_cmds::specs());` at the end of `build()` |
| `crates/engine/src/error.rs` | the `EngineError::Generative { kind, message }` variant |
| `crates/engine/src/cmd/actions_cmds.rs` | `recorded()` skips `ai_cmds::unrecorded` steps, so an `ai.*` step that may send is never recorded into an action |
| `crates/engine/Cargo.toml` | the `testgen` feature (the mock backend for other crates' tests) |
| `Cargo.toml` (workspace) | `pigment-genai = { path = "crates/genai" }` in `[workspace.dependencies]` (`Cargo.lock` gains it, `keyring` and keyring's macOS and Windows dependencies) |
| `crates/automation/Cargo.toml` | the `pigment-genai` dependency |
| `crates/automation/src/lib.rs` | `pub mod genai;` |
| `crates/automation/src/headless.rs` | `untrusted()` builds its session with `genai::session(Caller::Agent)`, `trusted_local()` with `genai::session(Caller::CommandLine { allow_ai: false })` |
| `apps/photocraft-cli/Cargo.toml` | the `pigment-genai` dependency |
| `apps/photocraft-cli/src/args.rs` | the `Ai(crate::ai::AiArgs)` subcommand and `run`'s `--allow-ai` |
| `apps/photocraft-cli/src/lib.rs` | `mod ai;` and `Command::Ai(a) => ai::run(a, out, err)` |
| `apps/photocraft-cli/src/document.rs` | `run_cmds` calls `crate::ai::install(&mut h, a)?` (refuses an `ai.*` step without `--allow-ai`, installs the backend that may send with it) |
| `apps/photocraft-cli/tests/it/main.rs` | `mod ai;` |
| `apps/photocraft-cli/tests/it/man_and_completions.rs` | the man pages `ai` and its subcommands add |
| `crates/ui-egui/Cargo.toml` | `pigment-genai` under the not-wasm target dependencies; the engine's `testgen` feature in the dev-dependencies |
| `crates/ui-egui/src/lib.rs` | `pub mod ai_ui;` and the `PhotocraftApp` field `ai: ai_ui::AiUi` |
| `crates/ui-egui/src/app.rs` | `ai: Default::default()` in `PhotocraftApp::new` |
| `crates/ui-egui/src/app/frame.rs` | `crate::ai_ui::show(self, &ctx)` after `dialogs::show` (the windows, AI Accounts, and the Assistant's turn, moved on once a frame) |
| `crates/ui-egui/src/app/commands.rs` | `crate::ai_ui::gate(self, id, &params)?` after the automation check in `run_command_at_depth` (agents need "Allow agents to run AI commands") |
| `crates/ui-egui/src/control.rs` | `handle` runs `dispatch` inside `crate::ai_ui::as_agent` |
| `crates/ui-egui/src/menus/items.rs` | `is_live` asks `ai_ui::handles`; `menu_items` adds `ai_ui::menu_items` to the extras and asks `ai_ui::place_after` after `PLACE_AFTER` |
| `crates/ui-egui/src/menus/state.rs` | `is_enabled` asks `ai_ui::is_enabled` for the shell's AI commands; `checked` asks `ai_ui::checked` (Window › Assistant's check mark) |
| `crates/ui-egui/src/menus/invoke.rs` | `crate::ai_ui::menu(app, id, params)` in `invoke_early_commands` (the windows, AI Accounts, Remove Background, Describe, Window › Assistant) |
| `crates/ui-egui/src/jobs_ui.rs` | `on_event` gives `ai_ui::on_job_event` the events first; `dialog` leaves `ai.*` jobs to the status bar (no modal) |
| `crates/ui-egui/src/canvas.rs` | `crate::ai_ui::task_bars(app, ui, xf)` after `crop_task_bar::draw` |
| `crates/ui-egui/src/tools/crop_task_bar.rs` | `crate::ai_ui::crop_task_bar_item(app, ui)` in the slot kept for Generative Expand |
| `crates/ui-egui/src/canvas/canvas_tool_menu.rs` | the `Generative Fill…` row of `SELECTION_MENU` (and its doc line) |
| `crates/ui-egui/src/canvas/canvas_tool_menu/tests.rs` | `selection_menus_follow_photoshop_order` expects that row |
| `crates/ui-egui/src/prefs/prefs_ui/agents.rs` | the Generative AI rows with the AI Accounts… button (`ai_ui::preferences_button`) and its `aiAccounts` action |
| `crates/ui-egui/tests/it/main.rs` | `mod ai;` and `mod ai_assistant;` (not on wasm) |
| `apps/photocraft/src/main.rs` | `photocraft_ui_egui::ai_ui::install(&mut app, &dir)` with the settings folder, after `background_jobs` |
| `xtask/src/layers.rs` | `pigment-genai` in the layers table (L6), and the two orderings that let `automation` and `ui-egui` (also L6) depend on it |

At an upstream merge: if PhotoCraft adds generative commands of its own (through craft-ai-client),
either alias ours to them or keep ours and hide theirs, and record the choice here.

Sign in with ChatGPT (experimental, chat models only) added no hook of its own: it lives in
`pigment-genai` and in AI Accounts (`ai_ui/accounts.rs`), and `pigment-cli ai sign-in` and
`sign-out` are two more names on the man-page line above. Its dependencies (`sha2`, `getrandom`,
`chrono`) were in `Cargo.lock` already. It rests on an OpenAI flow that is not documented as
stable and was never checked against the live service; if it stops working, set
`pigment_genai::chatgpt::ENABLED` to `false` (`crates/genai/src/chatgpt.rs`): AI Accounts loses the
row, a stored sign-in is ignored, API keys are untouched, and the tests still pass.

## Keeping the rebrand: `scripts/pigment-rebrand.py`

Most of the rebrand is mechanical and done by [`scripts/pigment-rebrand.py`](../scripts/pigment-rebrand.py):
the product name in Rust strings (not comments, not the kept markers; `///` doc comments in the
files clap and the MCP server turn into help), the binary names in the app's, CLI's, MCP's,
engine's and interface's text, and the application id in every text file (except PhotoCraft's own
document type, `ai.storyteller.photocraft.document`). It is idempotent; `--check` lists what it would
change and fails if anything is left.

The interface catalogues are not in this tree: they come from craft-i18n at the commit in
`craft-i18n.rev`, and `crates/ui-egui/build.rs` (`rebrand_catalog`) rebrands them as it embeds them,
in the English and the translated column alike (so the rebranded English strings still find their
rows), with the case endings Finnish, Hungarian, Turkish and Korean put on the name adjusted for
"Pigment" and Tamil's transliteration replaced. Strings Pigment added (the four links, the credit
line, the agents switch) have no translations yet and show in English.

The rest was done by hand and is listed above: `crates/format/src/brand.rs` (names, versions,
application id, extension, the legacy check), `crates/io/src/legacy_pigment.rs`, the `.pigment`
extension (`crates/io/src/lib.rs`, `export_estimate.rs`, `crates/automation/src/{files,workspace}.rs`,
`crates/engine/src/cmd/file_cmds/{open,paths,batch_run}.rs`, `print_cmds.rs`, `video_cmds.rs`,
`crates/ui-egui/src/{app/files.rs, control/dispatch.rs, home_recent_ui.rs}`,
`apps/photocraft/src/services.rs`, `apps/photocraft-cli/src/batch.rs`, `apps/photocraft-web/src/web.rs`),
the version line (`apps/photocraft/src/launch_args.rs`, `apps/photocraft-cli/src/lib.rs`, About in
`crates/ui-egui/src/dialogs.rs`), the folders (`crates/automation/src/app_dirs.rs`,
`apps/photocraft/src/{app_dirs.rs, logging.rs, services.rs}`), the links
(`crates/ui-egui/src/links.rs`, `crates/engine/src/shell_commands.rs`,
`crates/engine/src/cmd/updates_cmds.rs`, `canvas/start_screen.rs`), updates
(`crates/ui-egui/src/updates_ui.rs`, `menus/state.rs`, `lib.rs`, `apps/photocraft/src/main.rs`),
the agents gate (`crates/automation/src/{agent_link,live}.rs`, `crates/ui-egui/src/prefs/prefs_ui/{agents,fields}.rs`,
`apps/photocraft-cli/src/automation.rs`, `apps/photocraft/src/main.rs`), the `[[bin]]` names in
`apps/*/Cargo.toml`, the Windows resources (`apps/*/build.rs`), the catalog rebrand
(`crates/ui-egui/build.rs`), packaging (desktop entry, AppStream, MIME package, AppRun, nfpm,
package scripts, Flatpak manifests, Info.plist document types, WiX, the install policy), the icon
(`assets/app-icon/`, `packaging/icons.sh`), the web pages' text, README, NOTICE, ATTRIBUTION.md and
the release notes.

## Merging a later upstream revision

1. Fetch PhotoCraft and note the new revision `NEW` (`git ls-remote https://github.com/storytold/photocraft main`).
   `OLD` is the revision in `UPSTREAM-REVISION`.
2. Diff upstream between the two revisions, leaving out what Pigment doesn't ship:
   ```sh
   git clone https://github.com/storytold/photocraft /tmp/pc && cd /tmp/pc
   git diff --binary OLD NEW -- . ':!docs/brand' ':!.github' ':!.coderabbit.yaml' ':!sonar-project.properties' > /tmp/upstream.patch
   ```
3. Apply it to `pigment/` with a three-way merge, so hunks that touch rebranded lines become conflicts
   instead of failures:
   ```sh
   cd /path/to/claude && git apply --3way --directory=pigment /tmp/upstream.patch
   ```
   For renamed files (the packaging files, `packaging/windows/photocraft.wxs` and `.wxl`, the icon
   files) apply their hunks to the Pigment names (`git apply --3way` follows a rename only when it
   can; otherwise apply the hunk by hand). Never take back PhotoCraft's icon files or `docs/brand/`.
4. Resolve the conflicts by keeping Pigment's names, ids, links, folders, update behaviour and
   agents gate from the tables above and taking upstream's other changes.
5. Run the rebrand pass, then check that it left nothing:
   ```sh
   python3 pigment/scripts/pigment-rebrand.py && python3 pigment/scripts/pigment-rebrand.py --check
   rg -n 'PhotoCraft' pigment --glob '*.rs' --glob '!target' | grep -v -E ':\s*//'   # only the kept markers
   rg -n -i 'getartcraft|discord\.gg|storytold/photocraft' pigment --glob '!target' --glob '!docs/**' --glob '!book/**'
   ```
   New upstream strings that name the product become "Pigment"; their catalogue rows are rebranded
   at build time. A new file-format marker that PhotoCraft reads back must keep its name: add it to
   `KEEP_LINE` in the script (or put `upstream-ok` on the line). Check new `///` doc comments in the
   clap and MCP files (`HELP_DOC_FILES`) and new packaging files by hand.
6. Update `UPSTREAM-REVISION`, `UPSTREAM_VERSION` in `crates/format/src/brand.rs` and the tests that
   print the version line (`brand.rs`, `apps/photocraft-cli/tests/it/cli.rs`), this page's upstream
   revision, and `craft-i18n.rev` if upstream moved it (the Flatpak manifests pin the same commit).
7. If upstream added an update path (a new craft-update call, an updater in a package format, a
   version check) or another outgoing request, point it at Pigment's releases or turn it into a link,
   and add it to the endpoint table above; Pigment makes no network request on its own. If upstream
   added a file or folder to the settings folder, check it against the
   [clash table](#the-settings-folder-and-pigment-01-04).
8. Build and test the packages the merge touched (`cargo build -p photocraft -p photocraft-cli`,
   `cargo test -p …`), and run `pigment --version` and `pigment-cli --version`.
9. Check `scripts/upstream-test-failures.txt`. It lists the 60 integration tests (in
   photocraft-format, photocraft-io and photocraft-raw) that already fail on PhotoCraft's own tree
   at the imported revision, because they were written for an earlier craft-libs than the one its
   Cargo.lock pins; Pigment changes none of the code they exercise. `pigment-ci.yml` skips exactly
   those names in its Tests step and runs them on their own in a step that doesn't fail the job.
   Remove the lines of the tests that pass after the merge, and never add a test that the rebrand
   broke: fix that one. `scripts/upstream-test-filter.py` turns the list into the test filter, by
   package and exact name, so keep each test under its `# <package> --test <target>` section line.

`pigment-ci.yml` runs the tests with cargo-nextest (its `ci` profile in `.config/nextest.toml`), as
PhotoCraft's own gate does: one process per test, which its tests are written for. Under plain
`cargo test` a timing-sensitive test (automation's bridge authentication) failed now and then. The
gate also runs the engine's panic hunt (upstream's AGENTS.md rule 9): run it after adding or
changing a command, `cargo test -p photocraft-engine --test panic_hunt -- --ignored`.
