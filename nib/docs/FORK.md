# Nib and VectorCraft

Nib is a free, open-source vector graphics editor based on
[VectorCraft](https://github.com/storytold/vectorcraft) by the ArtCraft team and the VectorCraft
contributors (MIT OR Apache-2.0). This page says what Nib changed, which upstream revision it is
built on, and how to bring in a later upstream revision without losing the rebrand.

- **Upstream revision:** `a47d7eec9120e6487a0049600aa34e22a530013b` (2026-11-14), VectorCraft
  workspace version 0.24.1. The current revision is always in [`UPSTREAM-REVISION`](../UPSTREAM-REVISION);
  the version Nib names in `--version` and About is `UPSTREAM_VERSION` in
  [`crates/format/src/brand.rs`](../crates/format/src/brand.rs).
- **Nib's version:** 0.1.0 (`[workspace.package] version` in `Cargo.toml`). `nib --version`,
  `nib-cli --version` and Help › About print `Nib 0.1.0 (based on VectorCraft 0.24.1)`.
- **Nib's repository:** <https://github.com/Nihalpi1212/claude> (the app lives in `nib/`). Issues:
  <https://github.com/Nihalpi1212/claude/issues>. Releases: tags `nib-vX.Y.Z`, assets `nib-*`, at
  <https://github.com/Nihalpi1212/claude/releases>.

Everything in VectorCraft's docs (`docs/*.md` other than this page) describes VectorCraft as it was at
the upstream revision; read "VectorCraft" there as "Nib" unless it names the upstream project.
[`upstream-agents.md`](upstream-agents.md) is VectorCraft's agent guide: its engineering rules (no
panics or `unsafe` in shipped code, hostile input, clean room, asset and licence policy) apply to
Nib; its process rules (pull requests, issues, contributor credits) are VectorCraft's own.

## What Nib changed: the rebrand

The rebrand keeps every crate, package and module name (`vectorcraft-*`, `vectorcraft_*`,
`VectorcraftApp`), the native format's content and its `"format": "vectorcraft"` member, command ids
and environment variables, so upstream changes still apply. What a user sees is Nib's.

### Renamed

| What | VectorCraft | Nib |
|---|---|---|
| Product name in the interface, messages, logs, CLI help, MCP | VectorCraft | Nib |
| Desktop binary (`[[bin]]` of package `vectorcraft`) | `vectorcraft` | `nib` |
| CLI binary (`[[bin]]` of package `vectorcraft-cli`) | `vectorcraft-cli` | `nib-cli` |
| Version | 0.24.1 | 0.1.0, shown as `Nib 0.1.0 (based on VectorCraft 0.24.1)` |
| Application id (Wayland/X11 app id, desktop file, AppStream, MIME icon, macOS bundle id, Flatpak id) | `ai.storyteller.vectorcraft` | `io.github.nihalpi1212.nib` |
| Packaging files | `packaging/linux/ai.storyteller.vectorcraft.*`, `packaging/linux/flatpak/ai.storyteller.vectorcraft*.yml`, `packaging/windows/vectorcraft.wxs`, `vectorcraft.en-us.wxl` | `…/io.github.nihalpi1212.nib.*`, `packaging/windows/nib.wxs`, `nib.en-us.wxl` |
| Windows installer | UpgradeCode `601C6437-…`, component GUIDs of VectorCraft, `Program Files\ArtCraft\VectorCraft`, `Software\VectorCraft` | new UpgradeCode `521C1411-3286-4824-9597-0C2D4EECC5C7` and new component GUIDs, `Program Files\Nib`, `Software\Nib`, `nib.exe`, `nib-cli.exe` |
| Release asset names | `vectorcraft-<ver>-…`, `vectorcraft-cli-<ver>-…` | `nib-<ver>-…`, `nib-cli-<ver>-…` |
| macOS app | `VectorCraft.app` | `Nib.app` (volume `Nib`, DMG background regenerated) |
| Settings, logs, Data Recovery, fonts, plug-ins, scripts folders | `VectorCraft` (`~/.config/vectorcraft`) | `Nib` (`~/.config/nib`); nothing is read from VectorCraft's or DrawCraft's folders |
| Portable mode | `VectorCraft.portable`, `VectorCraftData` | `Nib.portable` (or `portable.txt`), `NibData` |
| Log file | `vectorcraft.log` | `nib.log` |
| Templates folder in Documents | `VectorCraft Templates` | `Nib Templates` |
| PDF preset | `VectorCraft Default` | `Nib Default` |
| Native file extension | `.vectorcraft` (and `.drawcraft`) | `.nibart` (MIME `application/x-nib-art`, "Nib Artwork"); `.vectorcraft` and `.drawcraft` still open |
| Native file `generator` | `VectorCraft <version>` | `VectorCraft 0.24.1 (Nib 0.1.0)`: VectorCraft and Nib read Twist angles by the VectorCraft release named first |
| PDF Creator/Producer, EPS `%%Creator`, EMF description, glTF generator, `$.engineName` | VectorCraft | Nib |
| MCP server | `serverInfo.name` `vectorcraft`, title VectorCraft | `nib`, Nib |
| Web build | page title VectorCraft | Nib |
| App icon | the engraved dragon on red | an original fountain-pen nib on a deep-teal tile ([`assets/app-icon/`](../assets/app-icon/README.md)) |
| Help menu, About, Home links | ArtCraft Discord, getartcraft.com, `storytold/vectorcraft` | Report an Issue, Nib on GitHub, Nib Releases, VectorCraft (upstream project) |
| About | "Part of ArtCraft" | "Nib is based on VectorCraft by the ArtCraft team and the VectorCraft contributors (MIT OR Apache-2.0)", with the upstream contributors list kept |

The command ids behind the links stay VectorCraft's: `help.discord` opens Nib's issue tracker,
`help.github` Nib's repository, `help.appPage` Nib's releases and `help.website` the upstream project
(see `crates/engine/src/cmd/help.rs`).

### Updates and the network

Nib never downloads or installs anything and makes no network request on its own:

- **Check for Updates** (`help.checkForUpdates`) opens the releases page in the browser.
- craft-update's update prompt and installer stay compiled in (`crates/ui-egui/src/updates_ui.rs`), pointed
  at Nib's repository and ids (`UPDATE_APP` in `crates/ui-egui/src/lib.rs`), but no check is started:
  not at start, not from the menu. The Windows update helper (`--finish-update`) is not wired in.
- The AppImage carries no update information and no `.zsync`; the Flatpaks lost
  `--talk-name=org.freedesktop.Flatpak` and the ArtCraft Launcher folder (network stays for printing
  to a CUPS server).

Outgoing endpoints left in the app, all opened only when the user asks: the links above (opened in the
browser), URLs of a document's objects (Attributes › Open URL, `http`/`https` only), the control channel
and MCP's `--connect` (localhost only), and the documentation links in a few tooltips and error
messages. Developer tooling (`cargo xtask corpus`, `test262`, packaging scripts) downloads pinned test
corpora and tools.

### Not renamed (internal identifiers, kept for upstream merges)

- Crate and package names, Rust paths and types (`vectorcraft_engine`, `VectorcraftApp`), the source
  folders `apps/vectorcraft*`, the web build's binary `vectorcraft-web` and its DOM ids.
- The native format: `"format": "vectorcraft"`, `craft-vectorcraft-format`'s `EXTENSION`, the format id
  `vectorcraft` in the command API (`document.save {format: "vectorcraft"}`), MCP resource URIs
  (`vectorcraft://…`), the JavaScript page API `window.vectorcraft` of the web build.
- Markers other files carry and VectorCraft reads back: the PDF editing-data description
  (`VectorCraft editing data; page hash`), the EPS/AI data sections (`%VectorCraft_BeginData`,
  `VectorCraft_Legacy`), the `.ai` editing-data creator line, separation markers (`VectorCraft plate`,
  `VectorCraft clip`), the colour profile name `VectorCraft Generic CMYK (SWOP-like)` that documents
  store, the PostScript `product` of the EPS interpreter.
- The "VectorCraft *x.y* and later (version *n*)" labels of the native Save Options (those versions
  are VectorCraft releases).
- Environment variables (`VECTORCRAFT_CONFIG_DIR`, `VECTORCRAFT_NO_PREFS`, `VECTORCRAFT_CONTROL_PORT`, …).
- Symbol and brush user libraries keep the `.vectorcraft` extension inside Nib's own settings folder.
- Comments, VectorCraft's docs and changelogs, the contributor credits (`contributors/`, Help › About ›
  Contributors), `NOTICE`'s upstream text and the licence files.

### Classification of the remaining upstream names

`rg -n -i 'vectorcraft|drawcraft|artcraft|storyteller|getartcraft|storytold' nib --glob '!target'`
after the rebrand (counts of matches, 2026-11-14):

| Kind | Matches | Decision |
|---|---|---|
| Crate, package and type identifiers (`vectorcraft_*`, `vectorcraft-*`, `VectorcraftApp`) in code and manifests | ~30,700 | keep (internal) |
| VectorCraft's own docs (`docs/*.md` but this page) | ~1,800 | keep (upstream history) |
| Comments in Rust code | ~1,400 lines | keep (internal) |
| Environment variables `VECTORCRAFT_*` | ~280 | keep (internal interface) |
| `VectorCraft` as a word in Rust code outside comments | 54 lines | keep: file-format markers and generators (above), the upstream link and credits, version-line tests, developer tooling's user agent |
| Native format id and extensions (`"vectorcraft"`, `.vectorcraft`, `.drawcraft`) | many, mostly tests | keep (format; still opened) |
| `storytold/craft-libs`, `storytold/egui`, `storytold/craft-fonts` dependency sources | in `Cargo.toml`, `Cargo.lock`, NOTICE, xtask | keep (dependencies) |
| User-visible strings, catalogues, packaging, icons, links | 0 left | changed to Nib |

## What Nib added

- **Generative AI** (`crates/genai`, package `nib-genai`, new code with no upstream counterpart):
  the user's own OpenAI or Google Gemini key, called from the user's machine. It adds the only
  outgoing requests besides the links the user opens: `api.openai.com` and
  `generativelanguage.googleapis.com`, and only when the person runs an AI command or presses Test
  Connection after agreeing once in AI Accounts. See [generative-ai.md](generative-ai.md). A merge
  of upstream never touches it; check that the engine commands it drives (listed there) keep their
  parameters.

## Keeping the rebrand: `scripts/nib-rebrand.py`

Most of the rebrand is mechanical and done by [`scripts/nib-rebrand.py`](../scripts/nib-rebrand.py):
the product name in Rust strings (not comments, not the kept markers) and in the interface catalogues
(with the case endings Finnish, Hungarian, Korean and Turkish put on the name), the binary names in
the app's, CLI's, MCP's, engine's and interface's text, and the application id in every text file. It
is idempotent; `--check` lists what it would change and fails if anything is left.

The rest was done by hand and is listed above: `crates/format/src/brand.rs` (name, versions,
extension), `crates/engine/src/cmd/help.rs` (links), `crates/ui-egui/src/{community.rs, dialogs/about.rs,
menus/tree.rs, updates_ui.rs, lib.rs}`, `apps/vectorcraft/src/{main.rs, profile.rs, prefs*.rs,
logging.rs, build.rs}`, the `[[bin]]` names in `apps/*/Cargo.toml`, the `.nibart` extension
(`crates/engine/src/cmd/fileio/formats.rs`, `crates/format/src/lib.rs`, `crates/ui-egui/src/{place.rs,
io/open.rs}`, `crates/engine/src/cmd/package.rs`), packaging (Info.plist document types, MIME package,
desktop entry, AppStream, WiX, Flatpak, AppImage), the icon (`assets/app-icon/`,
`packaging/macos/dmg/`), README, NOTICE, ASSETS.md and the new interface strings' translations.

## Merging a later upstream revision

1. Fetch VectorCraft and note the new revision `NEW` (`git ls-remote https://github.com/storytold/vectorcraft main`).
   `OLD` is the revision in `UPSTREAM-REVISION`.
2. Diff upstream between the two revisions, leaving out what Nib doesn't ship:
   ```sh
   git clone https://github.com/storytold/vectorcraft /tmp/vc && cd /tmp/vc
   git diff --binary OLD NEW -- . ':!docs/brand' > /tmp/upstream.patch
   ```
3. Apply it to `nib/` with a three-way merge, so hunks that touch rebranded lines become conflicts
   instead of failures:
   ```sh
   cd /path/to/claude && git apply --3way --directory=nib /tmp/upstream.patch
   ```
   For renamed files (the packaging files, `packaging/windows/vectorcraft.wxs`, the icon files) apply
   their hunks to the Nib names (`git apply --3way` follows a rename only when it can; otherwise
   apply the hunk by hand). Never take back VectorCraft's icon files or `docs/brand/`.
4. Resolve the conflicts by keeping Nib's names, ids, links and update behaviour from the tables
   above and taking upstream's other changes.
5. Run the rebrand pass, then check that it left nothing:
   ```sh
   python3 nib/scripts/nib-rebrand.py && python3 nib/scripts/nib-rebrand.py --check
   rg -n 'VectorCraft' nib --glob '*.rs' --glob '!target' | grep -v -E ':\s*//'   # only the kept markers
   rg -n -i 'getartcraft|discord\.gg|storytold/vectorcraft' nib --glob '!target' --glob '!docs/**'
   ```
   New upstream strings that name the product become "Nib"; new `tl!` strings that name it get the
   catalogue rows rebranded the same way. A new file-format marker that VectorCraft reads back must
   keep its name: add it to `KEEP_LINE` in the script (or put `upstream-ok` on the line).
6. Update `UPSTREAM-REVISION`, `UPSTREAM_VERSION` in `crates/format/src/brand.rs` and the tests
   that print the version line (`apps/vectorcraft/tests/it/automation_args.rs`), and this page's
   upstream revision.
7. If upstream added an update path (a new craft-update call, an updater in a package format, a
   version check), point it at Nib's releases or turn it into a link, as above; Nib makes no network
   request on start-up.
8. Build and test the packages the merge touched (`cargo build -p vectorcraft -p vectorcraft-cli`,
   `cargo test -p …`), and run `nib --version` and `nib-cli --version`.
