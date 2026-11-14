**Nib 0.1.0 is the first release of Nib, and an alpha.** It is VectorCraft 0.24.1 under a new name
and icon, plus generative AI features that run with your own OpenAI or Google Gemini API key. Save
often and keep copies of files that matter.

## Highlights

- **An Illustrator-class vector editor** for Windows, macOS and Linux, free and open source
  (MIT OR Apache-2.0), written in pure Rust: Pen and shape tools, Pathfinder and Shape Builder,
  gradients and mesh, live effects, type, artboards, symbols, Image Trace, print and export, SVG,
  PDF, EPS and PDF-compatible `.ai`.
- **Generative AI with your own key:** Text to Vector Graphic, Generative Shape Fill, Generative
  Pattern, Generative Expand, Generative Recolor and Rewrite Text. Requests go straight from your
  computer to OpenAI or Google; no Nib server, account or telemetry, and nothing is sent until you
  agree once in **Edit › AI Accounts…**.
- **No background network traffic:** Nib makes no request on its own. **Help › Check for Updates**
  opens the releases page.
- **Opens VectorCraft files:** `.vectorcraft` and `.drawcraft` open as before; Nib saves `.nibart`,
  the same documented JSON format.

## What is new in Nib

**Generative AI** (new crate `nib-genai` and its interface; see the
[user guide](https://github.com/Nihalpi1212/claude/blob/nib-v0.1.0/nib/docs/USER-GUIDE.md#the-generative-features)):

| Feature | Menu | Result |
|---|---|---|
| Text to Vector Graphic | Object › Generative | Editable vector art from a prompt: an SVG written by the model, or an image traced with Image Trace |
| Generative Shape Fill | Object › Generative | Art clipped into the selected closed shape |
| Generative Pattern | Object › Generative | A seamless pattern swatch, optionally applied to the selection |
| Generative Expand | Object › Generative | A placed image extended beyond its edges, original pixels kept |
| Generative Recolor | Edit › Edit Colors | Palettes proposed by the model, applied through Recolor Artwork |
| Rewrite Text | Type | The selected text rewritten in a tone, keeping its styles |

- One **Generate** window for all six (Window › Generate): it runs off the interface thread, shows
  1–4 results, and places a click on a result as one undo step. For Shape Fill, Expand, Recolor and
  Rewrite a click on another result swaps it in.
- **AI Accounts** (Edit › AI Accounts…, or Preferences): keys for OpenAI and Gemini, Test Connection,
  model choice, request timeout and the one-time agreement. Keys are stored in the macOS Keychain,
  Windows Credential Manager, or on Linux in a file only you can read; never in documents, settings,
  logs or automation output.
- Model answers are treated as hostile: SVGs are rebuilt from an allowlist (scripts, links, images,
  CSS and animation are dropped) with element, depth and expansion limits; JSON, images and answer
  sizes are bounded.
- Contextual Task Bar items (Generate Vectors, Generative Expand, Generative Shape Fill) once a key
  is saved.

**The rebrand** (details in
[FORK.md](https://github.com/Nihalpi1212/claude/blob/nib-v0.1.0/nib/docs/FORK.md)):

- New name, original fountain-pen-nib icon, app id `io.github.nihalpi1212.nib`, binaries `nib` and
  `nib-cli`, version line `Nib 0.1.0 (based on VectorCraft 0.24.1)`.
- Own settings folder (`Nib`, `~/.config/nib`), log `nib.log`, portable mode with `NibData`; nothing
  is read from VectorCraft's folders.
- Native extension `.nibart` (MIME `application/x-nib-art`), registered with macOS and the Linux
  desktop.
- Help menu: Report an Issue, Nib on GitHub, Nib Releases, and a link to the upstream VectorCraft
  project; About credits VectorCraft and keeps its contributors list.
- No self-updater: the update check, Windows update helper, AppImage update information and the
  Flatpak's host-access permission are removed.

## Inherited from VectorCraft 0.24.1

Nib 0.1.0 is built on VectorCraft revision `a47d7eec9120e6487a0049600aa34e22a530013b`
(2026-11-14). From VectorCraft's
[roadmap](https://github.com/Nihalpi1212/claude/blob/nib-v0.1.0/nib/ROADMAP.md) at that revision:

- **Stage: alpha.** VectorCraft's self-assessment against Illustrator 2026's public documentation
  (2026-10-10): feature breadth about 88% (92.8% of menu items wired, 89 of 92 tools, all 57
  Photoshop-style effects), feature depth about 75%, ready for real work about 62% (about 65% for a
  mainstream illustrator).
- **Core workflows work end to end:** path drawing and editing, paint and style, type, layers,
  artboards and export, print production, and file exchange (the last one partial).
- **Strong areas:** appearance, transparency and masks; colour, gradients, patterns, mesh and
  recolor; symbols, blends, envelopes, Repeat and the Perspective Grid; strokes and brushes;
  Export for Screens; print and separations; the full Effect Gallery.
- **Beyond Illustrator:** exact curve booleans, rendering on all cores off the interface thread,
  unlimited undo, a documented JSON format, Affinity document import, and every command drivable by
  scripts and agents (MCP server, CLI, JSON control channel).
- **Interface languages:** English and more than 20 translations.

VectorCraft's known gaps, ranked in its
[gaps.md](https://github.com/Nihalpi1212/claude/blob/nib-v0.1.0/nib/docs/gaps.md), still apply:

- an interaction-fidelity pass over every tool's modifiers and small behaviours;
- real Illustrator `.ai` files (layer structure in real files; live effects survive a save only in
  simple cases);
- launch and stability on more real machines, and hardening at scale;
- correctness bugs in core tools (Shape Builder regions, Asset Export borders);
- advanced type (CJK composition for vertical type, Touch Type);
- 3D and Materials beyond the initial live Revolve;
- scripting and the rest of Variables;
- pen hardware beyond Windows pressure, accessibility beyond egui's defaults.

Nib's comparison with Illustrator, and what can't be built (Adobe's cloud services), is in
[PARITY.md](https://github.com/Nihalpi1212/claude/blob/nib-v0.1.0/nib/docs/PARITY.md).

## Known issues

**Generative AI**

- **Stop doesn't cancel billing:** stopping a request (Stop, closing the window or the document)
  discards the answer, but the provider still finishes and bills a request already sent.
- **Unchecking Window › Generate** hides the window but keeps its request running; the window's close
  button stops it.
- An error message stays in the Generate window after you open another document or reopen the same
  feature.
- **Generate isn't dimmed** when "Use the selection as a style reference" is on with nothing
  selected; it refuses with a message when pressed.
- Generative Expand leaves the Eyedropper's remembered sample set to the original image.
- The AI strings are in English in every interface language.
- The AI features can't be driven by automation yet: the control-protocol methods, MCP tools and
  `nib-cli ai` commands are specified but not built. There are no canvas right-click items for them,
  and Concept to Vector, Prompt to Edit and Mockup aren't there.
- Linux and BSD keep keys in a private file in the settings folder, not in the system keyring. A key
  saved in a portable copy on a FAT or exFAT drive can be read by anyone with the drive.
- The features were tested against a local mock of the OpenAI and Gemini APIs, not against the live
  services; Gemini was exercised for Text to Vector Graphic and Test Connection only. The macOS and
  Windows key stores were not exercised before release.

**Rebrand and packaging**

- **The builds are not code-signed** (see First launch below).
- The interface's accent colour is still VectorCraft's orange, and the screenshots (README,
  AppStream) show VectorCraft's interface.
- Help › Copy Troubleshooting Info is headed "Nib 0.1.0" without the VectorCraft version.
- Help › About doesn't close with Escape (as in VectorCraft).
- The example files' artwork still says "Made in VectorCraft".
- The `.deb` package's Maintainer field is the project URL, not an email address.
- Only Windows x64, macOS universal and Linux x86_64 builds are published; ARM64 Windows and Linux,
  Flatpak, RPM, FreeBSD and the web version can be built from source with the scripts in
  `packaging/`.
- No in-app updates: check the releases page (Help › Check for Updates).
- This is the first run of the release workflow: the Windows installer and the macOS disk image
  were not built and tried before it, and some test suites inherited from VectorCraft (engine,
  PDF, SVG, EPS) were not run locally after the rebrand; CI runs the whole workspace.

Please report problems at <https://github.com/Nihalpi1212/claude/issues> (Help › Report an Issue),
and never paste an API key into an issue.

## Downloads

| Platform | File |
|---|---|
| Windows 10/11, x64 | `nib-0.1.0-windows-x64.msi` (installer) · `nib-0.1.0-windows-x64-portable.zip` (no install, portable mode) |
| macOS 11 or later, Apple silicon and Intel | `nib-0.1.0-macos-universal.dmg` (app) · `nib-cli-0.1.0-macos-universal.zip` (command-line tool) |
| Linux x86_64 (glibc 2.35+, e.g. Ubuntu 22.04+) | `nib-0.1.0-linux-x86_64.AppImage` · `nib-0.1.0-linux-x86_64.deb` · `nib-0.1.0-linux-x86_64.tar.gz` |

`SHA256SUMS.txt` lists the SHA-256 of every file (`sha256sum -c SHA256SUMS.txt --ignore-missing`).

## First launch: these builds are not code-signed

- **macOS:** the app is signed ad hoc and not notarized. Drag **Nib** to Applications, then
  right-click (or Control-click) it, choose **Open**, and **Open** again in the dialog. Or run once in
  Terminal: `xattr -dr com.apple.quarantine /Applications/Nib.app`
- **Windows:** SmartScreen may say "Windows protected your PC". Choose **More info**, then **Run
  anyway**.
- **Linux:** make the AppImage executable (`chmod +x nib-0.1.0-linux-x86_64.AppImage`) and run it,
  or install the package with `sudo apt install ./nib-0.1.0-linux-x86_64.deb`.

Getting started, setting up AI Accounts and troubleshooting:
[USER-GUIDE.md](https://github.com/Nihalpi1212/claude/blob/nib-v0.1.0/nib/docs/USER-GUIDE.md).

## Credits

Nib is based on [VectorCraft](https://github.com/storytold/vectorcraft) by the ArtCraft team and the
VectorCraft contributors (MIT OR Apache-2.0); nearly all of this editor is their work. Nib is
licensed under the same terms.
