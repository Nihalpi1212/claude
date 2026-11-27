# Pigment and PhotoCraft

Pigment is a free, open-source image editor based on
[PhotoCraft](https://github.com/storytold/photocraft) by the ArtCraft team and the PhotoCraft
contributors (MIT OR Apache-2.0). This page says what Pigment changed, which upstream revision it
is built on, and how to bring in a later upstream revision without losing the rebrand.

- **Upstream revision:** `057297bb0b0872244ac0910e640db8d87e46572f` (PhotoCraft's `main` on
  19 November 2026), PhotoCraft workspace version 0.23.1. Pigment 0.5.0 was built on `abb30df`
  ([below](#upstream-after-the-import)). The current revision is always in [`UPSTREAM-REVISION`](../UPSTREAM-REVISION); the version
  Pigment names in `--version` and About is `UPSTREAM_VERSION` in
  [`crates/format/src/brand.rs`](../crates/format/src/brand.rs), followed by `UPSTREAM_REVISION`, the
  first 7 characters of `UPSTREAM-REVISION` (upstream's version moves slowly while its tree moves fast;
  a test checks the two agree).
- **Pigment's version:** 0.5.0 (`[workspace.package] version` in `Cargo.toml`). It follows the
  JavaScript Pigment 0.1 to 0.4 (an Electron app, released up to `pigment-v0.4.0`), which this
  version replaces. `pigment --version`, `pigment-cli --version` and Help › About print
  `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`.
- **Pigment's repository:** <https://github.com/Nihalpi1212/claude> (the app lives in `pigment/`).
  Issues: <https://github.com/Nihalpi1212/claude/issues>. Releases: tags `pigment-vX.Y.Z`, assets
  `pigment-*`, at <https://github.com/Nihalpi1212/claude/releases>.

## Upstream after the import

Pigment 0.5.0 was built on upstream `abb30df` (15 November 2026). PhotoCraft kept moving fast: by
19 November its `main` was at `057297b`, 1,856 files changed (about 132,000 lines added and 282,000
removed), most of it the interface rebuilt on the craft framework (`craft::ui`, `craft::menu`,
`craft::automation`, `craft::settings`, `craft::update`, `craft::theme_store`) from craft-libs
`18ffc07`. Pigment merged `057297b` after the 0.5.0 release, before the 0.6 work (the packages
listed on the [parity page](parity/README.md#the-06-packages)), following
[Merging a later upstream revision](#merging-a-later-upstream-revision): one commit with upstream's
change alone, then one per area that put Pigment's hooks back on the new code. The hook tables on
this page name the places they have now.

What the framework changed for Pigment's promises, and what Pigment does about it:

- **Updates.** Help › Check for Updates and its result window are craft-update's `Updater`
  (`crates/ui-egui/src/updates_ui.rs`); Pigment's `check` opens the releases page instead of
  `Updater::check_now`, and nothing calls `Updater::check_at_start` (the once-per-launch check) or
  `craft::update::self_update::finish` (`--finish-update`). Upstream's `apps/photocraft/src/updates.rs`
  and `crates/engine/src/cmd/updates_cmds.rs` are gone; the releases link lives in
  `crates/engine/src/build_info.rs` (`RELEASES`).
- **Agents.** The connection file, token, probe and the ArtCraft Launcher's switch moved into
  `craft::automation::agents`; Pigment's gate stays `crates/automation/src/agent_link.rs` (below),
  the app builds `AgentSwitch::fixed(false, false)` instead of upstream's `AgentSwitch::watch`
  (which polls the launcher's files), and Preferences › AI Integrations is Pigment's switch above
  the framework's `AgentsPage` drawn with `mcp_flag(true)` in Pigment's words
  ([below](#ai-agents-and-mcp)).
- **Settings.** Preferences are saved in `config.toml` (`craft::settings::SettingsStore`); a
  `preferences.json` of Pigment 0.5.0 is read once while no `config.toml` exists, with its
  `connectAgents`, `controlPort` and agent folders, and never written again.
- **Themes.** The framework keeps themes in the folder the Craft apps share
  (`ArtCraft/themes`, or `$CRAFT_SUITE_DIR`); Pigment opens its own, `Themes` in its settings
  folder (`SuiteDir::at`, `crates/ui-egui/src/app/framework.rs::open_suite`,
  `app/prefs.rs::THEME_FOLDER`).
- **Words that live in craft-libs.** The framework's agents page named the ArtCraft Launcher in
  `agents.intro` and `agents.off`; Pigment overrides those two rows
  (`prefs/prefs_ui/agents.rs::pigment_words`). The rest of the framework's words come from the same
  craft-i18n catalogs `build.rs` rebrands, and its host name is "Pigment"
  (`app/framework.rs`, `AppInfo`), so "When Pigment is closed", "About Pigment" and the alerts'
  titles name Pigment.
- **The version line** names the upstream revision too:
  `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`, since upstream's version 0.23.1 now names
  two very different trees.

The [parity page](parity/README.md) measures Pigment 0.5.0 (`abb30df`) and was not measured again
for the merge; PhotoCraft's own documents in `docs/` and `book/` came with the merge and describe
`057297b`.

Decisions on upstream's new product-name strings (the rebrand script wrote all of them; these are
the ones that needed a choice):

| String | Where | Decision |
|---|---|---|
| "PhotoCraft Basics", the new default actions set | `crates/engine/src/cmd/actions_edit_cmds/library_commands.rs` (`BASICS_SET`) | "Pigment Basics": a name people see; it is matched only against itself |
| A CUBE LUT's creator line, `write_cube_export("PhotoCraft", …)` | `crates/engine/src/cmd/file_cmds/export.rs` | "Pigment", as 0.5.0 wrote |
| "PhotoCraft Manages Colors" (print dialog) | `crates/ui-egui/src/dialogs/file_ui/print.rs` | "Pigment Manages Colors"; the stored id `photocraftManages` stays |
| "{n} steps have no PhotoCraft equivalent yet" (Actions panel, `.atn` import) | `crates/ui-egui/src/panels/actions/files.rs`, `crates/engine/src/cmd/atn_cmds.rs` | "Pigment" |
| The open and save type "PhotoCraft" with `pcraft` | `crates/ui-egui/src/file_dialog/filters.rs` (moved there from the app's `services.rs`) | "Pigment" with `pigment` first, then `pcraft` |
| The framework's host name, viewport title, `os_window::APP_ID`, the screen picker's owner | `app/framework.rs`, `apps/photocraft/src/main.rs`, `os_window.rs` | Pigment's name and id; the host id stays `photocraft` (an internal key) |
| Raw warnings "… not applied by PhotoCraft" | `crates/raw/src/shared.rs` | "Pigment" |
| "Save Full-Size Composite in .pcraft Files" (upstream moved the label into a table) | `prefs/prefs_ui/fields.rs` (`label_override`) | ".pigment", as 0.5.0 said and as the rebranded catalogs translate it |
| craft-update's `App::website()` (getartcraft.com) and suite apps | craft-libs | not called by Pigment |
| The built-in theme name "ArtCraft" (`craft.artcraft`), shown as a theme chip's tooltip and accessible name in Preferences › Interface | craft-libs (`craft-theme`, the theme store's `AppearancePage`) | left: craft-libs offers no override; Pigment's menus call it "Pro (Medium Gray)" ([below](#classification-of-the-remaining-upstream-names)) |

Labels of Pigment's own features (Generative Fill…, Generative Expand, …) are 0.5.0's. Upstream's
AGENTS.md rule 10 ("Our features use our own names") arrived with this revision; whether it applies
to them is a question for the project's owner, and ids never change either way.

Everything in PhotoCraft's docs (`docs/*.md` other than this page, the release notes and
`docs/parity/`, `book/`) describes PhotoCraft as it was at the upstream revision; read "PhotoCraft"
there as "Pigment" unless it names the upstream project. The user guide (`docs/user/`) is the
exception: it is rewritten for Pigment ([below](#the-user-guide)).

[`AGENTS.md`](../AGENTS.md) is PhotoCraft's agent guide: its engineering rules (Rust only, no panics or `unsafe` in shipped code, hostile input, clean room,
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
| Version | 0.23.1 | 0.5.0, shown as `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)` |
| Application id (Wayland/X11 app id, desktop entry, AppStream, MIME icon, macOS bundle id, Flatpak id) | `ai.storyteller.photocraft` | `io.github.nihalpi1212.pigment` |
| Packaging files | `packaging/linux/ai.storyteller.photocraft.*`, `packaging/linux/flatpak/ai.storyteller.photocraft*.yml`, `packaging/windows/photocraft.wxs`, `photocraft.en-us.wxl` | `…/io.github.nihalpi1212.pigment.*`, `packaging/windows/pigment.wxs`, `pigment.en-us.wxl` |
| Windows installer | UpgradeCode `D9660F32-…`, component GUID `A6DE41B7-…`, `Program Files\ArtCraft\PhotoCraft`, `Software\PhotoCraft`, ProgIds `Photocraft.*`, publisher Learning Machines LLC | new UpgradeCode `E3B35B0C-7545-464E-928A-546E924AC29F` and component GUID `267EC2F2-849F-4160-8162-83687268DDAB`, `Program Files\Pigment` (`Programs\Pigment` per user), `Software\Pigment`, ProgIds `Pigment.*`, `pigment.exe`, `pigment-cli.exe`, publisher "Pigment contributors" |
| Windows AppUserModelID | none set by PhotoCraft (Windows derives it from the exe) | none, so it follows `pigment.exe` |
| Release asset names | `photocraft-<ver>-…`, `photocraft-cli-<ver>-…` | `pigment-<ver>-…`, `pigment-cli-<ver>-…` |
| macOS app | `PhotoCraft.app` | `Pigment.app` (executable `Pigment`, volume `Pigment`; the CLI's signing identifier `io.github.nihalpi1212.pigment-cli`) |
| FreeBSD and Linux trees | `bin/photocraft`, `share/doc/photocraft`, `photocraft-<ver>-freebsd-<arch>.tar.gz` | `bin/pigment`, `share/doc/pigment`, `pigment-<ver>-freebsd-<arch>.tar.gz`; deb/rpm package `pigment` |
| Settings, logs, Data Recovery, presets folder | `Photocraft` (`~/.config/photocraft`, `%APPDATA%\Photocraft`, `~/Library/Application Support/Photocraft`; recovery in `%LOCALAPPDATA%\Photocraft` and `$XDG_STATE_HOME/photocraft`) | `Pigment` (`~/.config/pigment`, `%APPDATA%\Pigment`, `~/Library/Application Support/Pigment`; `%LOCALAPPDATA%\Pigment`, `$XDG_STATE_HOME/pigment`); nothing is read from PhotoCraft's or ArtCraft's folders |
| Brush and preset library in the settings folder | `Presets` | `Preset Library` (see [the clash check](#the-settings-folder-and-pigment-0104)) |
| Themes (Preferences › Interface, the theme editor) | the folder the Craft apps share: `~/.config/ArtCraft/themes`, `%LOCALAPPDATA%\ArtCraft\themes`, `~/Library/Application Support/ArtCraft/themes`, or `$CRAFT_SUITE_DIR` | `Themes` in Pigment's settings folder (`SuiteDir::at`); `CRAFT_SUITE_DIR` is not read |
| Portable mode | `portable.txt` beside the exe, `PhotoCraftData` | `portable.txt`, `PigmentData` |
| Log file | `logs/photocraft.log` (`photocraft.1.log` …), lock `photocraft.lock` | `logs/pigment.log` (`pigment.1.log` …), lock `pigment.lock` |
| Native file extension | `.pcraft` | `.pigment` (MIME `application/x-pigment`, "Pigment Image"; macOS type `io.github.nihalpi1212.pigment.document`); `.pcraft` still opens and can still be saved |
| Pigment 0.1–0.4 documents | — | a `.pigment` ZIP with `document.json` and `layers/<id>.png` is recognised by content and converted ([below](#documents-from-pigment-0104)) |
| Shortcut set and actions | "PhotoCraft Defaults", "PhotoCraft Actions", "PhotoCraft Basics" | "Pigment Defaults", "Pigment Actions", "Pigment Basics" |
| MCP server | `serverInfo.name` `photocraft` | `pigment` (title and instructions say Pigment) |
| Agent consent | the ArtCraft Launcher's switch, behind the suite's `AI-MCP` flag | Pigment's own preference ([below](#ai-agents-and-mcp)) |
| Windows version resources | ProductName PhotoCraft, CompanyName Learning Machines LLC | ProductName Pigment, CompanyName "Pigment contributors", copyright naming both |
| App icon | the engraved nine-tailed fox on blue | Pigment's palette-and-brush icon (the JavaScript app's `build/icon.svg`, [`assets/app-icon/`](../assets/app-icon/README.md)): hicolor PNGs, `.ico`, `.icns`, the runtime icons, the brand mark, the MSI art (drawn from it by `package.ps1`) |
| Help menu, About, start screen links | ArtCraft Discord, getartcraft.com, `storytold/photocraft` | Report an Issue, Pigment on GitHub, Pigment Releases, PhotoCraft (upstream project) |
| About (the framework's, `crates/ui-egui/src/dialogs/credits.rs::about_info`) | "Part of ArtCraft", Discord button | no community button; `Pigment 0.5.0 (based on PhotoCraft 0.23.1+057297b)`, "Pigment is based on PhotoCraft by the ArtCraft team and the PhotoCraft contributors (MIT OR Apache-2.0)", with the upstream contributors list kept |
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
`crates/io/src/legacy_pigment/` before any other importer. Its `import` converts the document
("Opening documents from Pigment 0.1–0.4" below says what). One that cannot be read at all fails
with `IoError::LegacyPigment`, whose message is "This Pigment 0.4 file is damaged: " and the reason.
The opened document keeps its file (`ImportResult::source_read_only` is false) and carries an
import report (`Metadata::import_conversion`, source format `pigment-0.1-0.4`) that says where it
came from and lists what was approximated or left out. In the interface, the first File › Save over
a file that is still a Pigment 0.1–0.4 document asks "Save in the new Pigment format? Pigment 0.4
will no longer be able to open this file." (Save / Save As… / Cancel, with "Don't show again",
which the framework's prompt keeps only with Save; `crates/ui-egui/src/dialogs/legacy_save_prompt.rs`,
a framework `StandardPrompt`). The engine's `file.save` (scripts, agents,
the CLI) and a Save step of an action being played write without asking.

### The settings folder and Pigment 0.1–0.4

Electron names the JavaScript app's userData folder after its product name, `Pigment`: on Windows
`%APPDATA%\Pigment` and on macOS `~/Library/Application Support/Pigment`, the folders Pigment 0.5
uses for its settings (on Linux Electron uses `~/.config/Pigment`, Pigment 0.5 `~/.config/pigment`,
two folders on case-sensitive file systems). What each writes there:

| Pigment 0.1–0.4 (`src/main/*.js` and Electron itself) | Pigment 0.5 (PhotoCraft's files) |
|---|---|
| `settings.json`, `recent.json`, `ai-credentials.json`, `presets/` (`<kind>.json` and `<kind>/<name>`) | `config.toml` (the preferences since the `057297b` merge; `config.toml.bak`, the last copy that parsed, and `config.broken-<time>.toml` for a damaged one set aside), `preferences.json` (Pigment 0.5.0's preferences: read once into `config.toml`, never written again), `Themes/` (`selection.json`, `selection.lock`, `library/<theme>.json`), `ai.json` and, on Linux, `ai-keys.json` (generative AI, Pigment's own), `ui.ron`, `gpu-compositor.json`, `gpu-starting.json`, `instance.lock`, `instance.json`, `agent-connection.json`, `agent-control.token`, `recovery-migration.lock`, `logs/` (`pigment.log`, `pigment.lock`, `rotate.lock`), `Recovery/` (macOS; Windows keeps it in `%LOCALAPPDATA%\Pigment`), `Presets` → `Preset Library/` (`index.json`, `actions.json`, `patterns.json` and tip bitmaps) |
| Electron and Chromium: `Preferences`, `Local State`, `Cache/`, `Code Cache/`, `GPUCache/`, `DawnGraphiteCache/`, `DawnWebGPUCache/`, `Local Storage/`, `Session Storage/`, `IndexedDB/`, `blob_storage/`, `Shared Dictionary/`, `SharedStorage`, `Network Persistent State`, `TransportSecurity`, `Trust Tokens`, `Cookies`, `Crashpad/` | — |

One name clashed: PhotoCraft's `Presets` folder and the JavaScript app's `presets` are the same
folder on the case-insensitive file systems Windows and macOS use by default, and both write
`<name>.json` files there with different contents. Pigment 0.5 names its folder `Preset Library`
(`PRESETS_DIR` in `apps/photocraft/src/services.rs`). Nothing else shares a name: Chromium's
`Preferences` has no extension, PhotoCraft's `preferences.json` has one, and Electron writes no
`logs`, `Recovery` or `ui.ron`. `com.pigmentapp.app` and `io.github.nihalpi1212.pigment` are
different application ids, and Pigment 0.5 reads none of the JavaScript app's files.

The `057297b` merge added `config.toml` (and its `.bak` and `.broken-…` copies) and `Themes/`:
neither name is one the JavaScript app or Electron writes. The framework's settings library can
also keep presets in `presets/<kind>/` and named settings profiles in `profiles/` beside
`config.toml` (`craft::settings::PresetFolder::new`, `Profiles`); Pigment calls neither at this
revision. `presets/` is the JavaScript app's folder: if a later merge starts using
`PresetFolder::new(config_dir, …)`, give it another folder (or `PresetFolder::in_settings`), as
`Preset Library` does for PhotoCraft's own presets.

**Install locations do clash.** The JavaScript app's installers used the same places Pigment 0.5's
use by default, so installing 0.5 there replaces 0.4 instead of installing beside it:

- Windows: electron-builder's assisted NSIS installer put Pigment 0.4 in
  `%LOCALAPPDATA%\Programs\Pigment` (for one user) or `C:\Program Files\Pigment` (for everyone),
  the folders the MSI picks for "Only for me" and "Everyone". The MSI then writes `pigment.exe` over
  0.4's `Pigment.exe` (Windows names ignore case), and 0.4's uninstaller later deletes the whole
  folder, Pigment 0.5's files included. Both also add a Start menu shortcut named `Pigment`.
- macOS: both DMGs hold `Pigment.app`; dragging 0.5 to Applications replaces 0.4.
- Linux: the AppImages have different file names and can be kept side by side.

The README, the install page of the user guide and the 0.5.0 release notes tell Windows users to
uninstall 0.4 before installing 0.5, or to install 0.5 in another folder to keep both (the MSI's
folder page, or another folder on macOS). Pigment 0.5 opens 0.4's `.pigment` documents, so nothing
needs exporting first. Changing the default install folder or the app bundle name is left as a decision
for a later release.

There are no separate fonts, plug-ins, scripts or templates folders: PhotoCraft reads system fonts,
loads plug-ins and scripts from where the user opens them, and keeps templates in its presets.

### AI agents and MCP

PhotoCraft lets agents use the open window only behind the suite's `AI-MCP` feature flag
(`ArtCraft/flags.toml` or `CRAFT_FLAGS`, read by `craft::automation::agents::mcp_flag`) and the
ArtCraft Launcher's switch (the launcher's app list, read by `agents::launcher_allows("photocraft")`
and watched by `AgentSwitch::watch`). Pigment reads neither: `agent_link::mcp_flag()` and
`agent_link::launcher_allows_agents()` in `crates/automation/src/agent_link.rs` are always false,
`agents_allowed_now` is the framework's rule with those two answers (so Pigment's switch alone), the
app builds `AgentSwitch::fixed(false, false)` (`apps/photocraft/src/main.rs`) and never starts the
watch, and the gate is Pigment's own preference, **Preferences › AI Integrations › Let AI apps use
this window** (`connectAgents`, also turned on by a Control Port saved in older preferences).
Allow Agent Control off still refuses agents. The connection file and token
(`agent-connection.json`, `agent-control.token` in the settings folder) are the framework's
(`craft::automation::agents`), written only while the switch is on; their `app` field reads the
version line.

The page (`crates/ui-egui/src/prefs/prefs_ui/agents.rs::page`, drawn from `custom_rows.rs`) is
Pigment's switch, then the framework's `AgentsPage` drawn with `mcp_flag(true)`, so that its two
agent folders and **When Pigment is closed** show, with its words `agents.intro` and `agents.off`
replaced by Pigment's (`pigment_words`: they named the ArtCraft Launcher), then generative AI's rows:
**AI Accounts…** and **Allow agents to run AI commands** (`ai_ui::preferences_rows`). Only the
person's click changes that permission, as in AI Accounts. `sync_agent_link` lets agents in on
`connect_agents` alone and never consults the app's `AgentSwitch`.

**Default: off.** That is what PhotoCraft gives a user without the launcher (no app list counts as
no), and it keeps the command line and the MCP server usable as upstream intends: `pigment-cli mcp`
serves a headless session with the folders given to it, exactly as before; with the switch on it
uses the open window and, while the app is closed, does what **When Pigment is closed** says
(start it, a headless session, or an error). `pigment --control` and `pigment-cli mcp --bridge` work
as before, whatever the switch. `pigment-cli` always calls its MCP server `pigment`
(`agent_link::SERVER_NAME`, read by `server/conventions.rs`).
Upstream's `pigment-cli mcp` asks `craft::automation::agents::mcp_flag()` before it reaches the open
window (and links `craft` for that alone); Pigment's asks only `--headless`
(`apps/photocraft-cli/src/automation.rs`) and its `Cargo.toml` has no `craft` dependency.

### Updates and the network

Pigment never downloads or installs anything and makes no network request on its own:

- **Check for Updates** (`help.checkForUpdates`) opens the releases page in the browser
  (`updates_ui::check` in `crates/ui-egui/src/updates_ui.rs`, through `links::open`); it is always
  enabled (`menus/state.rs`), and fetches nothing. The release window's Check Now and Check Again
  call the same `check`.
- The once-per-launch check is gone: upstream's checker is craft-update's `Updater`, kept in
  `updates_ui.rs` for its result window, and nothing calls `Updater::check_now` or
  `Updater::check_at_start`; `updates_ui::tick` only reads the last update's record, a local file
  that only craft-update's own installer writes, so Pigment never finds one
  (`self-update-done.txt` and `logs/self-update-error.txt` in craft-update's `Paths::for_app`:
  `pigment` in the per-user data folder, `Pigment` on macOS and Windows).
  **Automatically Check for Updates** is hidden from Preferences
  (`prefs::HIDDEN_UNTIL_IMPLEMENTED`; the setting still loads and saves). The release window is
  pointed at Pigment's repository and ids (`UPDATE_APP` in `crates/ui-egui/src/lib.rs`). The
  Windows update helper (`--finish-update`, `craft::update::self_update::finish`) is not wired into
  `apps/photocraft/src/main.rs`, and the app's `craft-update` dependency is kept only so that
  `Cargo.toml` and `Cargo.lock` stay upstream's.
- The AppImage carries no update information and no `.zsync`; the Flatpaks lost
  `--talk-name=org.freedesktop.Flatpak` and the ArtCraft Launcher folder
  (`--filesystem=xdg-data/ArtCraft/versions:ro`). The network stays for printing to a CUPS server and
  the `--control` server.

#### Outgoing endpoints

Every place in the shipped code that can reach another machine, and what Pigment does with it:

| Endpoint | Where | In PhotoCraft | In Pigment |
|---|---|---|---|
| GitHub releases API (`api.github.com/repos/storytold/photocraft/releases`) and release downloads | craft-update's `Updater` (`check_now`, `check_at_start`) in `crates/ui-egui/src/updates_ui.rs` | checked once per launch and from Help › Check for Updates; the installer downloads and runs updates | not called: the menu and the release window open <https://github.com/Nihalpi1212/claude/releases> |
| Windows self-update helper (`--finish-update`) | `craft::update::self_update::finish`, called from upstream's `main.rs` | finishes a downloaded update | not wired in |
| ArtCraft Launcher app list and suite flags | `craft::automation::agents::{launcher_allows, mcp_flag}` and `AgentSwitch::watch`, which polls them (local files under the launcher's data folder, `ArtCraft/flags.toml`, `CRAFT_FLAGS`) | decides whether agents may use the window | never read; `AgentSwitch::fixed(false, false)` |
| Font downloads: Google Fonts and Noto families, the craft-i18n language packs (`cdn.jsdelivr.net`, `raw.githubusercontent.com`, `notofonts.github.io`, `github.com/storytold/craft-i18n/releases`) | `craft-font-store`, linked through `craft-font-manager` | linked; PhotoCraft calls no install path at `057297b`, and the store downloads only after the person turns it on (`enable_network`, refused for agents) | not called (no installer is built, nothing turns downloads on); the font catalog only reads the suite's installed fonts, `~/.local/share/craft-fonts` (`Craft Fonts` on macOS and Windows, or `$CRAFT_FONT_STORE`) |
| Release pages in error messages and the release window | `crates/engine/src/build_info.rs` (`RELEASES`), `crates/engine/src/error.rs` | `storytold/photocraft/releases` | Pigment's releases; opened only when the user clicks |
| Help, About and start-screen links; contributor profiles (`github.com/<login>`) in About › Contributors; Learn (`pigment/docs/user` on GitHub) | `crates/ui-egui/src/links.rs`, `dialogs/credits.rs`, `canvas/start_screen.rs` | Discord, getartcraft.com, `storytold/photocraft` | Pigment's issues, repository and releases, and the upstream project; opened in the browser only when clicked |
| Printing (IPP to a printer or CUPS server, `lp`/`lpstat`, Avahi) | `crates/ipp`, the print commands | when the user prints | unchanged |
| Control server, MCP bridge, single-instance hand-off, agent connection | `craft::automation::{server, agents}` (built in `apps/photocraft/src/main.rs`), `crates/automation/src/{bridge,live,agent_link}.rs`, `apps/photocraft/src/single_instance.rs` | loopback (`127.0.0.1`) only | unchanged, loopback only |
| Web build: its own WebAssembly parts and served fonts | `apps/photocraft-web-boot`, `crates/text` (`fonts/manifest.txt`) | same origin as the page | unchanged (the web build is not part of Pigment's releases) |
| Telemetry, crash reports, model downloads | — | none: crash and start-up reports are local files and dialogs, fonts are system, embedded or already installed in the suite's font store, the face-detection weights are bundled | none |
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
- Environment variables (`PHOTOCRAFT_GPU`, `PHOTOCRAFT_NEW_INSTANCE`, `PHOTOCRAFT_BUILD_SHA`, …),
  except the six that choose a folder, a port or a token, which are Pigment's own so that one set
  for an installed PhotoCraft never shares its settings, single-instance lock, control port or
  agent access with Pigment: `PIGMENT_CONFIG_DIR` (`crates/automation/src/app_dirs.rs`),
  `PIGMENT_CONTROL_PORT` (`apps/photocraft/src/launch_args.rs`, `apps/photocraft-cli/src/args.rs`),
  `PIGMENT_CONTROL_TOKEN` and `PIGMENT_CONTROL_TOKEN_FILE` (`crates/automation/src/args.rs`),
  `PIGMENT_AUTOMATION_READ_ROOT` and `PIGMENT_AUTOMATION_WRITE_ROOT` (`launch_args.rs`); the
  `PHOTOCRAFT_*` names of those six are not read. PhotoCraft's docs and `book/` still use the old
  names. Of the framework's folder variables, `CRAFT_SUITE_DIR` (the themes the Craft apps share)
  is not read, since Pigment keeps its themes in its own folder; `CRAFT_FONT_STORE` (the suite's
  installed fonts, which every app's font list reads and none writes here) is read as upstream
  reads it.
- The library crates' log targets (`photocraft_engine::…`). The desktop binary is `pigment`, so
  its own modules log as `pigment::…` (`RUST_LOG=pigment=debug`); the default filter
  (`apps/photocraft/src/logging.rs`) shows `info` for both `photocraft*` and `pigment*`. A second
  instance's log is `pigment-<pid>.log`.
- The id the ArtCraft Launcher would know PhotoCraft by (`LAUNCHER_APP_ID` in
  `crates/automation/src/agent_link.rs`), unused, and the framework's host id `photocraft`
  (`AppInfo` in `crates/ui-egui/src/app/framework.rs`), an internal key; its name is "Pigment".
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
| `ArtCraft` in Rust code outside comments | 5 lines (2026-11-27) | keep: the credit line in About, tests that the launcher and its Flatpak folder are gone (`agents_tests.rs`, `tests/it/flatpak_updates.rs`) |
| The name of the craft framework's built-in theme `craft.artcraft`, "ArtCraft" (craft-theme's `themes/artcraft.json`, linked since `057297b`) | 1 (in craft-libs) | not changed, and not changeable from Pigment at craft-libs `18ffc07`: Preferences › Interface's theme chips (the framework's `AppearancePage`, drawn in `prefs/prefs_ui/custom_rows.rs`) take each built-in theme's own name as the chip's tooltip and accessible name, and the page has no name override, so that one chip reads "ArtCraft". Pigment's own Appearance menu and theme commands call the theme "Pro (Medium Gray)" (`theme.rs`, `AppTheme::palette_label`). A fix needs a name override in craft-libs' page or Pigment's own page instead of the framework's: a question for the project's owner |
| Packaging (`packaging/`) | 147 lines | keep: environment variables, `-p photocraft` package names, `apps/photocraft*` paths, WiX element ids (`PhotocraftExe`, …), the web build's `photocraft-web` file names and `photocraft-parts` marker, `.pcraft`'s own types (`application/x-photocraft`, `ai.storyteller.photocraft.document`, "PhotoCraft Document"), the craft-i18n and craft-fonts sources, credits and comments, the ArtCraft Launcher's own install-policy mode in `check-install-policy.ps1` (unused by Pigment) |
| README, NOTICE, ATTRIBUTION.md, this page, the release notes | 204 | keep: credits, upstream links, upstream notice and asset rows |
| `AGENTS.md`, `ROADMAP.md`, `SECURITY.md`, `Dockerfile`, `xtask/`, `scorecard/`, `perf/`, `tests/`, `examples/` | 169 | keep (upstream guides, roadmap and developer tooling) |
| `contributors/` | 1 | keep (credits) |
| User-visible strings, catalogues (rebranded at build time), packaging names, icons, links | 0 left in Pigment's tree (the framework's theme name above is in craft-libs) | changed to Pigment |

### The user guide

`docs/user/` is the guide Help › Learn and the README link to. Upstream publishes it at
getartcraft.com for PhotoCraft; in Pigment every page is rewritten for Pigment: the product name,
Pigment's downloads (unsigned, the three published platforms), its issue tracker instead of
Discord, its settings and log folders (`pigment.log`), the `.pigment` type in the file dialogs,
`verified: 0.5.0` after checking each page against the code, and the PhotoCraft fixes the old pages
told people to update for described as included. Pigment's own pages are
`guides/open-pigment-0-4-documents.md` and `guides/use-generative-ai.md`; the file names of the
upstream pages are kept (`faq/is-photocraft-free.md`, `troubleshooting/photocraft-does-not-start.md`)
so that upstream's changes still land on the right file. `docs/user/AGENTS.md` keeps upstream's
rules with a Pigment paragraph at the top. At a merge, read upstream's changes to these pages and
carry over by hand what applies to Pigment, instead of taking them as they are.

`docs/parity/README.md` (where Pigment stands against Photoshop) and `docs/RELEASE-NOTES-*.md` are
Pigment's own.

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
provider crate `crates/genai` (package `pigment-genai`, with its tests in `crates/genai/tests/it/`;
Sign in with ChatGPT is its `src/chatgpt.rs` and `tests/it/chatgpt.rs`),
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
| `crates/engine/src/jobs.rs` | `independent_of_document` keeps `VIEW_EDITS` (the `view.*` commands that edit the Document: guides, slices, the ruler origin) out of what a running job lets through, so they wait as other edits do and an AI request's paid answer is not discarded as "the document changed while it ran" |
| `crates/engine/Cargo.toml` | the `testgen` feature (the mock backend for other crates' tests) |
| `Cargo.toml` (workspace) | `pigment-genai = { path = "crates/genai" }` in `[workspace.dependencies]` (`Cargo.lock` gains it, `keyring` and keyring's macOS and Windows dependencies) |
| `crates/automation/Cargo.toml` | the `pigment-genai` dependency |
| `crates/automation/src/lib.rs` | `pub mod genai;` |
| `crates/automation/src/headless.rs` | `untrusted()` builds its session with `genai::session(Caller::Agent)`, `trusted_local()` with `genai::session(Caller::CommandLine { allow_ai: false })` |
| `apps/photocraft-cli/Cargo.toml` | the `pigment-genai` dependency; `rustix` (termios) under the Unix dependencies, for `ai set-key`'s no-echo prompt, and with `pty` under the Unix dev-dependencies for its test |
| `apps/photocraft-cli/src/args.rs` | the `Ai(crate::ai::AiArgs)` subcommand and `run`'s `--allow-ai` |
| `apps/photocraft-cli/src/lib.rs` | `mod ai;`, `Command::Ai(a) => ai::run(a, out, err)`, and `ai::hint(&e)` printed after a failed command's error (an `ai.*` step refused for the agreement or a key names `pigment-cli ai consent` or `ai set-key`) |
| `apps/photocraft-cli/src/document.rs` | `run_cmds` calls `crate::ai::install(&mut h, a)?` (refuses an `ai.*` step without `--allow-ai`, installs the backend that may send with it) |
| `apps/photocraft-cli/tests/it/main.rs` | `mod ai;` |
| `apps/photocraft-cli/tests/it/man_and_completions.rs` | the man pages `ai` and its subcommands add |
| `crates/ui-egui/Cargo.toml` | `pigment-genai` under the not-wasm target dependencies; the engine's `testgen` feature in the dev-dependencies |
| `crates/ui-egui/src/lib.rs` | `pub mod ai_ui;` and the `PhotocraftApp` field `ai: ai_ui::AiUi` |
| `crates/ui-egui/src/app.rs` | `ai: Default::default()` in `PhotocraftApp::new` |
| `crates/ui-egui/src/app/frame.rs` | `crate::ai_ui::show(self, ui)` right after `crate::dialogs::run(self, ui)` in `ui_body` (the windows, AI Accounts, and the Assistant's turn, moved on once a frame; egui windows over the hosted dialogs, not hosted dialogs themselves, so the Assistant reads the dialog host through `PhotocraftApp::dialog_count()`) |
| `crates/ui-egui/src/app/commands.rs` | `crate::ai_ui::gate(self, id, &params)?` after the automation check in `run_command_at_depth` (agents need "Allow agents to run AI commands") |
| `crates/ui-egui/src/control.rs` | `handle` runs `dispatch` inside `crate::ai_ui::as_agent` (generic over upstream's `Reply`) |
| `crates/ui-egui/src/menus/items.rs` | `is_live` asks `ai_ui::handles`; `menu_rows` adds `ai_ui::menu_items` (framework `craft::menu::Row`s) to the extras and asks `ai_ui::place_after` after `PLACE_AFTER` |
| `crates/ui-egui/src/menus/state.rs` | `is_enabled` asks `ai_ui::is_enabled` for the shell's AI commands (after `crate::analysis::handles`); `checked` asks `ai_ui::checked` (Window › Assistant's check mark, the native menus too) |
| `crates/ui-egui/src/menus/invoke.rs` | `crate::ai_ui::menu(app, id, params)` in `invoke_early_commands` (the windows, AI Accounts, Remove Background, Describe, Window › Assistant) |
| `crates/ui-egui/src/jobs_ui.rs` | `on_event` gives `ai_ui::on_job_event` the events first; the progress `dialog` leaves `ai.*` jobs to the status bar (no modal) |
| `crates/ui-egui/src/canvas/document_display.rs` | `crate::ai_ui::task_bars(app, ui, rect, space)` in `canvas_controls`, after the Frame tool's task bar, for the active document only (one bar per window; the bars are framework `TaskBar`s anchored to document points) |
| `crates/ui-egui/src/tools/crop_task_bar.rs` | `crate::ai_ui::crop_task_bar_item(app, ui)` inside the framework `TaskBar`'s body, in the slot kept for Generative Expand (before `preset_list`) |
| `crates/ui-egui/src/canvas/canvas_tool_menu.rs` | the `Generative Fill…` row of `SELECTION_MENU` (and its doc line); upstream dropped the test that listed the menu's rows, so `tests/it/ai.rs::menus_put_each_feature_in_its_photoshop_place` checks that it follows Content-Aware Fill |
| `crates/ui-egui/src/prefs/prefs_ui/agents.rs` | `page` takes `&ai_ui::PrefsAi` and calls `ai_ui::preferences_rows` after the framework's `AgentsPage`: AI Accounts… (opened by `ai_ui::show` on the next pass) and "Allow agents to run AI commands" |
| `crates/ui-egui/src/prefs/prefs_ui/custom_rows.rs` | the field `PrefsCustom.ai: ai_ui::PrefsAi` (`PrefsAi::of(app)`), handed to `agents::page` |
| `crates/ui-egui/tests/it/main.rs` | `mod ai;` and `mod ai_assistant;` (not on wasm), in upstream's regrouped module list |
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

### Opening documents from Pigment 0.1–0.4

The importer for the `.pigment` files of the JavaScript app, in `crates/io/src/legacy_pigment/`
(Pigment's own folder): `mod.rs` (the document and the import report), `container.rs` (the ZIP,
`document.json`, the size limits and the budget nested documents share), `layers.rs` (the layer
tree, masks, advanced blending, bit depth and image modes of the pixels), `adjust.rs` (adjustment
layers, with the app's Color Lookup looks), `gradient.rs` (the app's gradient model: midpoints,
smoothness, the five interpolation methods, noise), `paint.rs` (fills, shapes, vector masks and the
patterns they use), `styles.rs` (layer styles), `text.rs` (type layers), `smart.rs` (smart objects
and their sources), `filters.rs` (smart filters: the app's filter kinds and `adjust:<kind>` as
PhotoCraft commands with their parameters), `path.rs`, `blend.rs`, `info.rs` (File Info as an XMP
packet), `tests.rs`, `layer_kinds_tests.rs` and `text_smart_tests.rs`. Its fixtures were written by
the JavaScript app's own writer: `crates/io/tests/fixtures/pigment-0.4/` with `make-fixtures.mjs`,
`make-fixtures-layers.mjs`, `make-fixtures-l3.mjs` and a README that names the commits; next to
each fixture with adjustment, fill or shape layers, vector masks, styles, blending or smart objects
is `<name>.png`, the app's own picture of it, and the tests compare the opened document's picture
with it.

**Converted exactly** (the same settings): the document (size, resolution, the image modes Bitmap,
Grayscale, Duotone, Indexed Color and RGB, 8, 16 and 32 bits per channel, the profile the
unfinished 0.5 wrote), raster layers and groups (name, visibility, opacity, fill opacity, blend
mode, locks, clipping, folding), layer masks with density and feather (the mask is the PNG's alpha,
as the app masked with it), the bottom "Background" as the Background, adjustment layers (every
kind the app had), fill layers (solid, gradient with its geometry, pattern), shape layers (path
operations, fill, stroke with alignment, caps, joins and dashes, live rectangles, ellipses,
triangles, polygons, stars and lines where PhotoCraft has them; a pattern-filled shape is a pattern
fill layer with a vector mask), vector masks (Reveal All as an inverted path), layer styles (all
ten effects, several drop shadows, inner shadows, overlays and strokes, contours, Hide All
Effects), advanced blending (channels, knockout, the four options, Blend If with split points),
type layers as editable PhotoCraft type (0.4's rich text: runs over UTF-16 units become runs over
UTF-8 bytes, every character attribute PhotoCraft has, paragraph alignment, indents, spacing, auto
leading and hyphenation, point type, paragraph boxes, type on a path, stacked vertical type; 0.1–0.3's
one `font` read as 0.4 read it; sizes, leading and shifts from pixels to points), smart objects (a
nested document opened by this importer up to 8 deep and kept as a `.pcraft` source, as Convert to
Smart Object makes it; an image source keeps its PNG; instances sharing a source share one
`SmartContentsId`; the transform, Disable Smart Filters, Stack Mode), smart filters PhotoCraft has
(the table in `filters.rs`), colour labels and link sets, the selection, saved channels, guides
with their colours and the ruler origin, saved paths and the work path, the global light, and File
Info with the camera data.

**Approximated** (converted, drawn a little differently; each layer named in the import report):
adjustments PhotoCraft computes as Photoshop does, some effects, type (laid out by PhotoCraft's type
engine; the first baseline and the alignment of point type are placed where the app drew them,
measured with that engine; a stroke on the characters becomes an outside Stroke effect of half its
width, which is what showed under the glyphs' fill), turned and scaled smart objects (bicubic, the
app used the canvas's smoothing), smart filters (PhotoCraft's filters), CMYK and Lab documents in
RGB (the JavaScript app kept RGB pixels with a mode flag), Multichannel in RGB with its inks as spot
channels. 0.4's "vertical" type was horizontal type turned a quarter by its matrix and stays so.

**Reported as not converted** (a line each in the import warnings and the report): Color and
Vibrance, Clarity and Dehaze and Grain (kept as `pcJS` blocks that draw nothing until PhotoCraft has
them), smart filters PhotoCraft has no counterpart for, type settings it lacks (lists, hanging
punctuation, justification spacing, hyphenation settings, tab stops, No Break, Fractional Widths
off), a stroke on a pattern-filled shape, smart objects nested more than 8 deep, pieces missing from
a damaged file. The active layer is not carried: `ImportResult` has no place for it.

The file holds no pixels for type and smart objects. Type is drawn by
`text_import::prepare_within` (as for a PSD without type pixels). Smart objects are drawn by the
engine's own renderer, with its filters: `photocraft_io::legacy_pigment::set_smart_object_renderer`
takes `smart_cmds::refresh_layer_with`, run under a job context that a watcher thread cancels when
the import's interrupt is cancelled, installed by `crates/engine/src/legacy_pigment_render.rs` (Pigment's
own file) from `jobs::import_options` and `file_cmds::open::import_result_for_open`, which the app's
open paths call first, and from automation's `files::open_with_options` and
`files::open_bytes_with_options`, which the CLI, MCP and the headless sessions open through. Without
it (photocraft-io alone) the source is placed without its filters, and the import warnings and
report say so. Each placement is priced against the document's 2 GiB of pixel memory before it is
drawn, by the tiles of its unclipped placed stage, and charged once drawn; one that does not fit
stays undrawn, reported.

| Upstream file | Hook |
|---|---|
| `crates/io/src/lib.rs` | `pub mod legacy_pigment;`, the `IoError::LegacyPigment(String)` variant, `Route::LegacyPigment` with its line in `route`, `import_stages` (two) and `import_preflight` |
| `crates/io/Cargo.toml` | `craft-zip` under `[dependencies]` (it was a dev-dependency; `Cargo.lock` is unchanged) |
| `crates/engine/src/lib.rs` | `pub mod legacy_pigment_render;` (public for automation's open paths) |
| `crates/engine/src/jobs.rs` | one line at the top of `import_options`: `crate::legacy_pigment_render::install();` |
| `crates/engine/src/cmd/file_cmds/open.rs` | the same line in `import_result_for_open` |
| `crates/engine/src/cmd/smart_cmds/rendering.rs` | `refresh_layer_with`, `refresh_layer` under a caller's `JobCtx` (a cancellable smart object drawn when a 0.1–0.4 document opens) |
| `crates/engine/src/cmd/smart_cmds.rs` | `pub use rendering::refresh_layer_with;` |
| `crates/automation/src/files.rs` | one line at the top of `open_bytes_with_options` and of `open_with_options`: `photocraft_engine::legacy_pigment_render::install();`; and `&& !photocraft_format::brand::is_legacy_pigment(bytes)` on the native shortcut of `open_bytes_with_options`, so a 0.1–0.4 document named `.pcraft` (MCP's and `serve`'s workspace folders) is imported as `route` imports it |
| `crates/automation/tests/it/main.rs` | `mod legacy_pigment;` |
| `apps/photocraft-cli/tests/it/main.rs` | `mod legacy_pigment;` |
| `crates/ui-egui/src/app/files.rs` | `save_in_place` asks `legacy_save_prompt::intercept` first; its old body is `save_in_place_unasked`, which `replay_save` calls for a played Save (an action's Save step does not ask) |
| `crates/ui-egui/src/dialogs.rs` | `pub mod legacy_save_prompt;`; `legacy_save_prompt::answer` as the last row of `PROMPTS` (the framework prompt's answer: Save, Save As… or Cancel); `legacy_save_prompt::PREF` in `dont_show_again_keys()`, so the remembered "Don't show again" stays in `Preferences.dialogs` where `alerts::dismissed` reads it |
| `crates/ui-egui/src/lib.rs` | `pub use dialogs::legacy_save_prompt;` |
| `crates/ui-egui/tests/it/main.rs` | `mod legacy_pigment;` |
| `docs/user/guides/index.md` | the links to `open-pigment-0-4-documents.md` and `use-generative-ai.md` (Pigment's own pages); the rest of `docs/user/` is rewritten for Pigment ([the user guide](#the-user-guide)) |

### Adjustment presets

The JavaScript Pigment's adjustment presets (its Preset menu above every adjustment editor, the
built-in lists and Photoshop's preset files), rebuilt on PhotoCraft. The model is
`crates/engine/src/presets/adjustments.rs` (a preset is a name and the params of
`image.adjustments.<kind>`; the built-ins of Levels, Curves, Exposure, Brightness/Contrast,
Threshold, Hue/Saturation, Black & White, Channel Mixer and HDR Toning are the app's, generated in
code; saved under `presets.adjustments` in `config.toml` are the user's presets, the built-ins
deleted and the names given). The commands are `adjustment.presets.list`, `get`, `save`, `edit`
(rename, delete), `reset`, `load` and `export`, in `crates/engine/src/cmd/adjust_preset_cmds.rs`
with their tests in `crates/engine/src/cmd/adjust_preset_cmds/tests.rs`; none is journaled
(applying a preset is setting the dialog or layer to its params). Photoshop's files are
`crates/io/src/adjust_map/preset_files.rs` (`.alv`, `.acv`, `.ahu`, `.cha`, `.asv`, `.blw`: each
the PSD adjustment block of its kind, read and written through `adjust_map::parse` and
`adjust_map::write`, so no upstream encoder changed visibility) with its tests in
`crates/io/src/adjust_map/preset_files/tests.rs` and the fixtures the JavaScript app's own writers
made, `crates/io/tests/fixtures/adjust-presets/` (`make-fixtures.mjs` and a README that names the
commit).

The Preset row above every adjustment editor (Image › Adjustments dialogs and an adjustment layer's
Properties) is `crates/ui-egui/src/dialogs/adjust_editors/preset_row.rs` with its tests in
`preset_row/tests.rs`: the framework's `NamedPresetRow` around a `PresetPicker` (Default, the
built-ins, the user's groups, "Custom" when the settings match none, the app's `sameSettings` rule;
New…, Rename…, Delete, Load… and Save… of Photoshop's file for the six kinds that have one) and a
"Reset Presets" button. The Adjustments panel's presets (Photoshop's "Adjustment Presets" groups,
and "Your Presets" saved from the selected adjustment layers) are
`crates/engine/src/presets/adjustments/panel.rs` and `crates/engine/src/cmd/adjust_preset_cmds/panel.rs`
(`layer.adjustmentPreset`, journaled, one history step; `layer.saveAdjustmentPreset` and
`layer.deleteAdjustmentPreset`, not journaled), tested in `panel_tests.rs` beside it. Their
interface is `crates/ui-egui/src/panels/adjustment_presets.rs` (tests in
`adjustment_presets/tests.rs`): a section of collapsible groups under the Adjustments panel's grid,
one button per preset; hovering a button previews the preset on the canvas, built by the engine's
`panel::preview` exactly as the command builds it; the Properties panel menu's Save Adjustment
Preset… asks for a name and saves the selected adjustment layers.

| Upstream file | Hook |
|---|---|
| `crates/io/src/adjust_map.rs` | `pub mod preset_files;` beside `mod encode;` (a child module, so it reads the block helpers it shares with `parse`) |
| `crates/io/src/lib.rs` | `pub use adjust_map::preset_files as adjust_presets;` beside `ADJUSTMENT_KEYS` |
| `crates/engine/src/presets.rs` | `pub mod adjustments;`; the `PresetState` field `adjustments` and its `Default`; the `Persisted` field `adjustments` (a `Value`, read entry by entry by `AdjustmentPresets::load`), its line in `to_json` and in `load_presets_json`, and the three lines that load it |
| `crates/engine/src/cmd.rs` | `pub mod adjust_preset_cmds;` and `v.extend(adjust_preset_cmds::specs());` after `adjust_cmds::specs()` in `build()` |
| `crates/automation/src/workspace.rs` | `adjustment.presets.load` (a `path` without `data` reads the disk) and `adjustment.presets.export` (a `path` writes there) in `command_uses_ambient_path`, so agents reach files only through their workspace |
| `crates/ui-egui/src/dialogs/adjust_editors.rs` | `pub mod preset_row;`; the `AdjustAsk::Preset` variant; the `EditorSetup` fields `presets` and `presets_rev` and their `Default` |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | `build_setup`: the two `EditorSetup` fields; `shared_editor`: `preset_row::in_dialog` before the editor (two lines); `answer_asks`: `preset_row::follow_dialog` first, and the `AdjustAsk::Preset` arm |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | `layer_editor`: `preset_row::in_properties` before the editor, a pick committed through `commit` (one history step) |
| `crates/ui-egui/src/panels.rs` | `pub(crate) mod adjustment_presets;` |
| `crates/ui-egui/src/lib.rs`, `crates/ui-egui/src/app.rs` | the `PhotocraftApp` field `adjust_panel_hover` (the hovered panel preset) and its `None` |
| `crates/ui-egui/src/canvas/display.rs` | `display_doc_live`: the hovered panel preset's document, after the blend-mode preview |
| `crates/ui-egui/src/panels/properties/adjustments.rs` | the grid's pick is kept, `adjustment_presets::section` is drawn, then the pick runs |
| `crates/ui-egui/src/panels/registry.rs` | the Properties entry's `rows`, `states` and `run` (Save Adjustment Preset…; upstream's Properties menu has no rows) |
| `crates/ui-egui/src/dialogs.rs` | `adjustment_presets::SAVE_FAMILY` in `PARAM_FAMILIES` (the name dialog of Save Adjustment Preset…) |
| `crates/ui-egui/tests/it/tone_targets.rs` | `names` (the dialog's channel dropdowns) leaves out the Preset row's picker |

### Auto Color Correction Options

Photoshop's Auto Color Correction Options, as the JavaScript Pigment had them: the four algorithms
(Enhance Monochromatic Contrast, Enhance Per Channel Contrast, Find Dark & Light Colors, Enhance
Brightness and Contrast), Snap Neutral Midtones, the shadow and highlight clipping and the three
target colours. The algorithms are `crates/algo/src/tone/auto_options.rs`, ported line for line from
the app's `adjust-tonal.js` and checked against its own results on synthetic images
(`auto_options/js-cases.json`, written by `make-cases.mjs` with the app's functions; a README names
the commit). The engine side is `crates/engine/src/cmd/auto_options_cmds.rs` (tests beside it):
`Preferences.adjustments` (`autoOptions`, clamped as Photoshop's fields, and `autoOptionsSaved`, in
`config.toml`'s `[adjustments]`), `image.adjustments.autoOptions` (read, save as defaults, reset; not
journaled), `image.adjustments.auto` (the Levels, Curves or Brightness/Contrast settings Auto gives
for a layer, read as `image.adjustments.blackWhite.auto` reads it; nothing changes), and Image ›
Auto Tone, Auto Contrast and Auto Color with options: explicit option params (recorded by Actions),
else the saved clipping and targets with each command's own algorithm, else upstream's own Auto,
unchanged. The Levels and Curves eyedroppers map the sample to the target colours
(`crates/engine/src/adjust_params/targets.rs`, tests in `targets/tests.rs`); with Photoshop's default
targets they are upstream's eyedroppers exactly.

| Upstream file | Hook |
|---|---|
| `crates/algo/src/tone.rs` | `pub mod auto_options;` after `pub mod auto_levels;` |
| `crates/engine/src/prefs.rs` | the `Preferences` field `adjustments` (its type lives in `auto_options_cmds.rs`; its serde clamps the clips and refuses bad algorithms and colours, so `prefs.set` needs no validator) |
| `crates/engine/src/cmd.rs` | `pub mod auto_options_cmds;` and `v.extend(auto_options_cmds::specs());` after the adjustment presets' |
| `crates/engine/src/cmd/edit_cmds.rs` | `auto_adjust` takes the params and first calls `auto_options_cmds::auto_adjust` (which steps aside when no options apply); the three Image › Auto specs take `AUTO_PARAMS` (the option keys) instead of `"{}"` |
| `crates/engine/src/adjust_params.rs` | `pub mod targets;`; `eyedropper_from_params` and `layer_eyedropper` call `targets::adjustment_eyedropper_with` with `targets::of_param` (the `eyedropper.targets` param, else the saved targets) |

The interface is `crates/ui-egui/src/dialogs/adjust_editors/auto_row.rs` (the controls, drawn around the framework's
editors, which Pigment cannot change) and `crates/ui-egui/src/dialogs/auto_options_ui.rs` (the host side and the
dialog; tests in `auto_options_ui/tests.rs`). Levels keeps the framework's Auto button: its "Auto" edit is taken out of
the pass and the host keeps it (nothing saved or chosen this session) or replaces it with Auto Color Correction Options'
result, as one edit. Curves and Brightness/Contrast get an Auto button, and Levels and Curves an Options… button, in a
row below the editor (**a choice recorded**: Photoshop puts them beside the Channel select, inside the framework's
panel). Alt-click on Auto and Options… open the options dialog, a framework parameter dialog stacked over the
adjustment dialog (or alone over an adjustment layer's Properties) that previews Auto in its parent on every change;
Cancel puts the parent back, OK keeps it and saves the options when Save as defaults is ticked (else they stay for the
app session). The Levels and Curves eyedropper row is Pigment's copy of the framework's `TonePickerRow` (same labels,
icons and canvas pass-through) that also reports a double-click: the Color Picker for that target colour, then "Save
the new target colors as defaults?" (Yes saves; No keeps them for the session; "Don't show again" with Yes saves later
ones without asking).

| Upstream file | Hook |
|---|---|
| `crates/ui-egui/src/dialogs/adjust_editors.rs` | `pub mod auto_row;`; the `AdjustAsk::AutoOptions` variant; in `show`, the `brightnessContrast` arm draws Auto after the editor, the `levels` and `curves` arms draw `auto_row::pickers` instead of passing `.pickers(…)` (and Levels its `pickers_unavailable`) to the panel, Levels hands its Auto to `auto_row::levels_auto`, and both draw `auto_row::buttons` after the panel |
| `crates/ui-egui/src/dialogs/adjust_dialog.rs` | `answer_asks`: the `AdjustAsk::AutoOptions` arm, and `auto_options_ui::answer_target` first in the colour answers' loop; `pick`: the eyedropper takes `auto_options_ui::targets` through `targets::adjustment_eyedropper_with` |
| `crates/ui-egui/src/dialogs/adjust_editors/session.rs` | `layer_editor`: the `AdjustAsk::AutoOptions` arm (Auto committed through `commit`, one history step) |
| `crates/ui-egui/src/dialogs/layer_picker.rs` | `sample_at`: `auto_options_ui::with_targets` adds the session's target colours to the eyedropper |
| `crates/ui-egui/src/dialogs.rs` | `pub mod auto_options_ui;`; `auto_options_ui::FAMILY` in `PARAM_FAMILIES`; `auto_options_ui::take` last in `TAKERS`; `auto_options_ui::answer_prompt` in `PROMPTS`; `auto_options_ui::PREF` in `dont_show_again_keys` |
| `crates/ui-egui/src/lib.rs`, `crates/ui-egui/src/app.rs` | the `PhotocraftApp` field `auto_options` (the session's options, the open dialog) and its `Default` |

## Keeping the rebrand: `scripts/pigment-rebrand.py`

Most of the rebrand is mechanical and done by [`scripts/pigment-rebrand.py`](../scripts/pigment-rebrand.py):
the product name in Rust strings (not comments, not the kept markers; `///` doc comments in the
files clap and the MCP server turn into help), the binary names in the app's, CLI's, MCP's,
engine's and interface's text, and the application id in every text file (except PhotoCraft's own
document type, `ai.storyteller.photocraft.document`). It is idempotent; `--check` lists what it would
change and fails if anything is left. It also checks the user guide (`docs/user/`, which it does not
rewrite): a page that sends people to PhotoCraft's downloads, launcher, website or Discord, or links
the repository's `HEAD`, fails the run. Links to Pigment's tree and guide (`links.rs`, the AppStream
homepage and help, nfpm's homepage, WiX's `ARPURLINFOABOUT`) name the tag `pigment-v<version>`,
not `HEAD` or the bare repository: the default branch holds the JavaScript app (Pigment 0.1 to 0.4).

The interface catalogues are not in this tree: they come from craft-i18n at the commit in
`craft-i18n.rev`, and `crates/ui-egui/build.rs` (`rebrand_catalog`) rebrands them as it embeds them,
in the English and the translated column alike (so the rebranded English strings still find their
rows), with the case endings Finnish, Hungarian, Turkish and Korean put on the name adjusted for
"Pigment" and Tamil's transliteration replaced. Strings Pigment added (the four links, the credit
line, the agents switch) have no translations yet and show in English.

The rest was done by hand and is listed above: `crates/format/src/brand.rs` (names, versions,
application id, extension, the legacy check), `crates/io/src/legacy_pigment/`, the `.pigment`
extension (`crates/io/src/lib.rs`, `export_estimate.rs`, `crates/automation/src/{files,workspace}.rs`,
`crates/engine/src/cmd/file_cmds/{open,paths,batch_run}.rs`, `print_cmds.rs`, `video_cmds.rs`,
`crates/ui-egui/src/{app/files.rs, control/dispatch.rs, home_recent_ui.rs, file_dialog/filters.rs}`,
`crates/ui-egui/src/prefs/prefs_ui/fields.rs` (the File Handling label),
`apps/photocraft/src/services.rs`, `apps/photocraft-cli/src/batch.rs`, `apps/photocraft-web/src/web.rs`),
the version line (`crates/format/src/brand.rs`, `apps/photocraft/src/launch_args.rs`,
`apps/photocraft-cli/src/lib.rs`, About in `crates/ui-egui/src/dialogs/credits.rs`), the folders
(`crates/automation/src/app_dirs.rs`, `apps/photocraft/src/{app_dirs.rs, logging.rs, services.rs}`,
the theme folder in `crates/ui-egui/src/app/{framework,prefs}.rs`), the links
(`crates/ui-egui/src/links.rs`, `dialogs/credits.rs`, `canvas/start_screen.rs`,
`crates/engine/src/shell_commands.rs`, `crates/engine/src/build_info.rs`), updates
(`crates/ui-egui/src/updates_ui.rs`, `menus/state.rs`, `lib.rs`, `apps/photocraft/src/main.rs`),
the agents gate (`crates/automation/src/{agent_link,live}.rs`,
`crates/ui-egui/src/prefs/prefs_ui/{agents,custom_rows,fields}.rs`,
`apps/photocraft-cli/{src/automation.rs,Cargo.toml}`, `apps/photocraft/src/main.rs`), the `[[bin]]` names in
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
   `git apply` is all or nothing: an upstream deletion of a file Pigment changed fails as "patch does
   not apply" and stops the whole patch. Pass `--exclude=pigment/<path>` for each such file and `git rm`
   it after (the `057297b` merge had 13). For renamed files (the packaging files, `packaging/windows/photocraft.wxs` and `.wxl`, the icon
   files) apply their hunks to the Pigment names (`git apply --3way` follows a rename only when it
   can; otherwise apply the hunk by hand). Never take back PhotoCraft's icon files or `docs/brand/`.
4. Resolve the conflicts by keeping Pigment's names, ids, links, folders, update behaviour and
   agents gate from the tables above and taking upstream's other changes.
5. Run the rebrand pass, then check that it left nothing:
   ```sh
   cd pigment   # the globs below are relative to the folder searched
   python3 scripts/pigment-rebrand.py && python3 scripts/pigment-rebrand.py --check
   rg -n 'PhotoCraft' . --glob '*.rs' --glob '!target' | grep -v -E ':[0-9]+:\s*(//|\*)'   # only the kept markers
   rg -n -i 'getartcraft|discord\.gg|storytold/photocraft' . --glob '!target' --glob '!docs/**' --glob '!book/**'
   rg -n '\.pcraft' . --glob '*.rs' --glob '!target'   # new messages and labels should name .pigment too
   ```
   Compare each list with the previous revision's (`git grep` at the last release) rather than
   reading it whole: the new lines are the ones to decide.
   New upstream strings that name the product become "Pigment"; their catalogue rows are rebranded
   at build time. A new file-format marker that PhotoCraft reads back must keep its name: add it to
   `KEEP_LINE` in the script (or put `upstream-ok` on the line). Check new `///` doc comments in the
   clap and MCP files (`HELP_DOC_FILES`) and new packaging files by hand. Words the craft framework
   draws come from craft-libs: those in the craft-i18n catalogs are rebranded by `build.rs`, but an
   English default that names the suite (as the agents page's `agents.intro` and `agents.off` named
   the ArtCraft Launcher) needs an override on Pigment's side; look at every framework page or
   window upstream newly draws.
6. Update `UPSTREAM-REVISION`, `UPSTREAM_VERSION` and `UPSTREAM_REVISION` in
   `crates/format/src/brand.rs` and the tests that print the version line (`brand.rs`,
   `apps/photocraft-cli/tests/it/cli.rs`, `apps/photocraft/tests/it/command_line_usage.rs`), this page's upstream
   revision, and `craft-i18n.rev` if upstream moved it (the Flatpak manifests pin the same commit).
7. If upstream added an update path (a new craft-update call, an updater in a package format, a
   version check) or another outgoing request, point it at Pigment's releases or turn it into a link,
   and add it to the endpoint table above; Pigment makes no network request on its own. A craft-libs
   crate newly linked can bring a network path even when upstream's own code does not change
   (`cargo tree -p photocraft -i ureq` lists who links the HTTP client). If upstream or the framework
   added a file or folder to the settings folder, or a variable that chooses a folder, check it
   against the [clash table](#the-settings-folder-and-pigment-0104) and the variables above; the
   framework's defaults are the Craft apps' shared folders, so pass Pigment's own explicitly.
8. Build and test the packages the merge touched (`cargo build -p photocraft -p photocraft-cli`,
   `cargo test -p …`), and run `pigment --version` and `pigment-cli --version`.
9. Check `scripts/upstream-test-failures.txt`. It lists the integration tests that already fail on
   PhotoCraft's own tree at the imported revision through no change of Pigment's (0.5.0 listed 60
   in photocraft-format, photocraft-io and photocraft-raw, written for an earlier craft-libs than
   the one abb30df's Cargo.lock pinned; at `057297b` upstream deleted 7 and the other 53 pass, so
   the list is empty). `pigment-ci.yml` skips exactly those names in its Tests step and runs them on
   their own in a step that doesn't fail the job. Run that step's command after a merge, remove the
   lines of the tests that pass and of those upstream deleted, and add a test only when it fails on
   upstream's own tree too; never add one that the rebrand or a Pigment hook broke: fix that one.
   `scripts/upstream-test-filter.py` turns the list into the test filter, by package and exact
   name, so keep each test under its `# <package> --test <target>` section line. Also check the CI
   settings upstream's gate changed (`.github/` is left out of the patch): the craft-fonts commit
   in `pigment-ci.yml` and `pigment-release.yml` (`CRAFT_FONTS_REF`), the test build's
   environment (`CARGO_PROFILE_DEV_DEBUG`, `CARGO_PROFILE_TEST_STRIP`), and the checks of
   `cargo xtask ci lint` (Pigment's gate runs `egui-fork`, `layers`, `panel-commands`,
   `test-binaries` and `scorecard --check`).

`pigment-ci.yml` runs the tests with cargo-nextest (its `ci` profile in `.config/nextest.toml`), as
PhotoCraft's own gate does: one process per test, which its tests are written for. Under plain
`cargo test` a timing-sensitive test (automation's bridge authentication) failed now and then. The
gate also runs the engine's panic hunt (upstream's AGENTS.md rule 9): run it after adding or
changing a command, `cargo test -p photocraft-engine --test panic_hunt -- --ignored`.

Pigment 0.5.0 repaired one upstream test for nextest rather than skipping it:
`crates/ui-egui/src/tools/type_tool/panels_toggle_tests.rs`, whose `bare_app()` waited for the
installed fonts' scan (`photocraft_text::shared()`), since the Type options bar draws "Loading
fonts…" until that scan ends and then moves its buttons. Upstream rewrote those tests at `057297b`
and `bare_app()` is gone, so the line went with it. If a test that clicks in the Type options bar
without a type layer starts to miss now and then, that wait is the repair.
