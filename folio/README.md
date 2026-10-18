# Folio PDF

A free, open-source PDF reader for **Windows** and **macOS** (Linux too) that covers what people use
Adobe Acrobat Reader for: viewing, searching, commenting, filling forms, signing and organizing pages.
No account, no ads, no telemetry.

Built with [Electron](https://www.electronjs.org/), [pdf.js](https://mozilla.github.io/pdf.js/) and
[pdf-lib](https://pdf-lib.js.org/). MIT licensed.

## Features

**View**
- Tabs for several documents, drag and drop to open, "Open with" from the file manager, recent files
- Continuous, single-page, horizontal and wrapped layouts; two-page spreads
- Zoom (fit page, fit width, custom, Ctrl+wheel, pinch), rotate, night mode, presentation mode, full screen
- Bookmarks (outline), page thumbnails, attachments, layers, document properties
- Find with match case, whole word, highlight all, and a list of every match
- Password-protected documents, reload when a file changes on disk, read out loud (text to speech)

**Comment**
- Highlight, underline, strikethrough and squiggly text markup
- Sticky notes with popups and threaded replies, text boxes, freehand drawing
- Rectangles, ellipses, lines and arrows, text stamps (APPROVED, DRAFT, …) and image stamps
- Comments panel listing everything with edit, reply, delete and jump-to
- Eraser, undo/redo, measure distances, snapshot a region to the clipboard

**Fill & Sign**
- Fill interactive forms (text, check boxes, radio buttons, drop-downs, lists), including calculated fields
- Highlight fields, jump between fields, reset, export form data as JSON
- Draw, type or upload a signature or initials; keep them for later; place and resize them on any page

**Organize and export**
- Organize pages: reorder by dragging, rotate, delete, insert from another PDF, extract
- Split a document, combine files, create a PDF from images, crop pages
- Export text, export pages as PNG/JPEG, flatten forms and comments
- Print with page ranges and quality options

Everything is written straight into the PDF as standard annotations and form data, so the results open in
Acrobat and other readers.

## Download

Installers are produced by the **Folio release** GitHub Actions workflow and attached to each GitHub
Release tagged `folio-v*`:

| Platform | File |
|---|---|
| Windows 10/11 (x64, Arm) | `Folio PDF-<version>-win-<arch>.exe` (installer) or `Folio PDF-<version>-portable.exe` |
| macOS 11+ (Apple silicon and Intel) | `Folio PDF-<version>-mac-universal.dmg` |
| Linux (x64) | `Folio PDF-<version>-linux-x86_64.AppImage` |

The builds are **not code-signed** (signing certificates cost money and are not part of this repository), so:

- **macOS**: the first time, right-click (or Control-click) *Folio PDF.app* and choose **Open**, then **Open**
  again. Alternatively run `xattr -dr com.apple.quarantine "/Applications/Folio PDF.app"`.
- **Windows**: in the SmartScreen prompt choose **More info** and then **Run anyway**.

## Build it yourself

Requirements: Node.js 22 and npm.

```bash
cd folio
npm ci                 # installs dependencies and copies the pdf.js / pdf-lib browser builds
npm start              # run the app in development
npm test               # unit tests (node:test)
npm run test:e2e       # browser end-to-end tests (Playwright, Chromium)
npm run test:electron  # tests that launch the real Electron app (Linux: xvfb-run -a npm run test:electron)
npm run dist:win       # Windows installer + portable exe   (run on Windows)
npm run dist:mac       # macOS universal .dmg and .zip      (run on macOS)
npm run dist:linux     # Linux AppImage
```

Installers land in `folio/dist/`. To cut a release from GitHub, push a tag such as `folio-v0.1.0`;
the workflow builds all three platforms and publishes the Release.

## How it works

See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and [docs/USER-GUIDE.md](docs/USER-GUIDE.md) for a feature-by-feature guide. In short: the Electron main process owns windows, menus,
dialogs and files; a plain ES-module renderer (no bundler) renders documents with pdf.js' viewer
components, which also handle forms and its own annotation editors; and a pure-function engine built on
pdf-lib performs page operations and writes annotation types pdf.js cannot create (notes, shapes,
underlines, stamps, …), complete with appearance streams for other viewers.

The renderer runs in a normal browser as well (`npm run dev:web`), which is how the end-to-end tests drive it.

## What it does not do (yet)

- Create or remove **password protection** (opening protected files works)
- Redaction, OCR, editing the existing text of a page, comparing documents (Acrobat Pro features)
- Digital (certificate) signatures and signature validation: Folio signs visually, like Acrobat's Fill & Sign
- XFA forms are shown through pdf.js' XFA support but cannot be saved back

Issues and contributions are welcome.
