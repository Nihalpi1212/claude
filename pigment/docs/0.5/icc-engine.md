# icc-engine: colour profiles (LittleCMS)

Package 4 of Pigment 0.5 (ARCHITECTURE.md "0.5 features", S6). Files: `src/renderer/lib/color/cmm.js` (the engine and
its install), `profiles.js` (reading and writing ICC profiles), `transforms.js`, `lcms.js`, `display.js`,
`doc-profile.js`, `library.js`, `scripts/vendor/lcms2.mjs`, `src/renderer/styles/color-management.css`.

## User guide

### Documents have a colour profile

A colour profile says what a document's numbers mean. Pigment reads the profile embedded in a JPEG, PNG, WebP, TIFF
or PSD file and keeps it with the document:

- The numbers in the file are kept exactly as they are. Pigment shows them converted for your screen, so a Display P3
  or Adobe RGB photo looks as it should instead of looking dull or oversaturated.
- The status bar and the Info panel (row "Profile") name the profile, for example "Display P3" or "Adobe RGB
  (1998)-compatible (16bpc)". A document without a profile is "Untagged RGB": Pigment treats its numbers as sRGB,
  as it always has.
- Saving embeds the profile again: File > Save, Save As, Export As, Quick Export as PNG, Export Layers to Files,
  Quick Export of layers, 16-bit PNG and TIFF, and PSD (in its colour profile resource). A `.pigment` file keeps it
  too.
- A file tagged with sRGB opens exactly as before and is recorded as sRGB; it is saved without a profile, as sRGB
  files usually are.
- A CMYK or Lab profile is not used yet: the file is converted as in earlier versions and a note says so when it
  opens. (Converting with these profiles comes with Color Settings.)
- A Gray profile is kept with the document. Because Pigment's files are RGB files, they carry an RGB version of the
  Gray profile (same tone curve), named "<profile> (RGB)"; the tones look the same.

### New Document

The New Document dialog's **Color Profile** list offers sRGB (the default), Display P3, Adobe RGB (1998)-compatible,
ProPhoto RGB-compatible, Gray Gamma 2.2, the profiles you added (below) and the ones your operating system has
installed, and "Don't Color Manage This Document".

### Edit > Assign Profile…

Assign Profile changes which profile the document's numbers are read in; it does not change the numbers, so the
picture can look different afterwards. Choose:

- **Don't Color Manage This Document**: no profile (Untagged RGB),
- **Working RGB: sRGB IEC61966-2.1**,
- **Profile**: any RGB profile in the list (Gray profiles too, for Grayscale and Duotone documents).

It is one step in the History panel ("Assign Profile"), and actions record the profile you chose.
(Edit > Convert to Profile…, which converts the numbers, comes with Color Settings.)

### Save for Web: Convert to sRGB

"Convert to sRGB" (on by default) converts a document in another profile to sRGB for the web, and writes no profile.
Untick it to keep the numbers and embed the document's profile instead. sRGB and untagged documents are written as
they are either way.

### Preferences > Color Management

- **Display**: "Automatic" shows wide-gamut documents (Display P3, Adobe RGB, ProPhoto and the like) in Display P3 on
  a screen that has it and in sRGB elsewhere; "sRGB" always shows them within sRGB; "Display P3" uses Display P3
  whatever the screen reports. sRGB and untagged documents are always drawn as sRGB, which costs nothing.
- **Your profiles**: "Add Profile…" adds `.icc` / `.icm` files; they are kept with your presets (the Preset Manager's
  "Color Profiles"), so the browser build has them too. "Remove" takes one out of the lists; documents that use it
  keep it.

## Release notes

- Colour management through LittleCMS 2 (WebAssembly): embedded ICC profiles are read from JPEG, PNG, WebP, TIFF and
  PSD and kept with the document; the canvas shows a tagged document converted for the display (Display P3 on wide-
  gamut screens); every format Pigment saves and exports embeds the profile again.
- New: Edit > Assign Profile… (Don't Color Manage, Working RGB, any profile; one history step; recordable).
- New: generated profiles Display P3, Adobe RGB (1998)-compatible, ProPhoto RGB-compatible and Gray Gamma 2.2 next to
  sRGB, in New Document and Assign Profile; the operating system's profiles and profiles you add in Preferences.
- New: Preferences > Color Management (display space, your profiles).
- Changed: a file with an embedded RGB or Gray profile (other than sRGB) now opens with its own numbers instead of
  numbers converted to sRGB by the browser, and keeps the profile; 0.4 converted it and dropped the profile.
- Changed: files saved from a tagged document now carry its profile (0.4 wrote none). Untagged and sRGB documents are
  written byte for byte as 0.4 wrote them.
- Changed: the status bar and the Info panel show the document profile; an untagged document reads "Untagged RGB".
- Changed: Save for Web's "Convert to sRGB" now converts tagged documents (it had nothing to convert in 0.4).
- Changed: a tagged CMYK or Lab file opens as before, with a note that its profile was not used.
- No key or menu changes beyond the skeleton's (Edit > Assign Profile… was placed by the skeleton).

## Third-party notices

- **LittleCMS 2.16** (Little CMS, colour engine), MIT License, Copyright (c) 2023 Marti Maria Saguer. Compiled to
  WebAssembly by the npm package below; the wasm in `src/renderer/vendor/lcms2/lcms.wasm` is LittleCMS's code. Licence
  text: `src/renderer/vendor/lcms2/LICENSE-littlecms.txt` (written by `scripts/vendor/lcms2.mjs`).
- **lcms-wasm 1.0.5** (npm, https://github.com/mattdesl/lcms-wasm), MIT License, Copyright (c) 2024 Matt DesLauriers:
  the Emscripten build of LittleCMS 2.16 and its JavaScript bindings (`dist/lcms.js`, `dist/lcms.wasm`), copied by
  `scripts/vendor/lcms2.mjs` into `src/renderer/vendor/lcms2/` with its licence (`LICENSE-lcms-wasm.md`). The package
  ships its build script and binding sources (`build.sh`, `lib/api.js`, `lib/export.txt`); the LittleCMS C sources are
  the upstream repository's (github.com/mm2/Little-CMS, a git submodule of lcms-wasm, not in the npm package).
- It is a devDependency (as harfbuzzjs and ag-psd): only the two copied files ship. lcms-wasm declares `tape` (a test
  runner) as a runtime dependency, so `npm ci` also installs tape and its dependencies (about 100 small packages,
  development only; nothing of them is packaged).
- The generated profiles (sRGB, Display P3, Adobe RGB (1998)-compatible, ProPhoto RGB-compatible, Gray Gamma 2.2) are
  written by Pigment's own code from the published primaries, white points and tone curves; they carry "No copyright,
  use freely". "Adobe RGB (1998)" and "ProPhoto RGB" name the colour spaces; the profiles are compatible
  re-creations, not Adobe's or Kodak's files.

## Known gaps

- Convert to Profile, Color Settings (working spaces, policies, warnings on open and paste), soft-proofing and CMYK
  profiles are later releases (0.6, 0.10). Pasting or placing pixels from a document in another profile copies the
  numbers.
- The display stage converts 8-bit composites; 16- and 32-bit documents are shown through their 8-bit display proxy,
  as in 0.4.
- LUT-based RGB profiles (A2B/B2A tables, many camera and printer profiles) convert through LittleCMS on the main
  thread: correct, but slower than the matrix/TRC profiles, which convert in a JavaScript kernel that gives
  LittleCMS's own numbers. A 2000 × 2000 change of a Display P3 document converts in about 55–70 ms on the development
  machine (S6.4's target is 60 ms).
- Layer thumbnails, the Layers panel and other panel images are not colour managed (info-histogram-properties, 0.6);
  the Navigator is.
- A smart object whose own document has another profile shows its numbers unconverted (linked-smart-objects, 0.7).
- `settings.colorManagement.userProfiles` stays empty: the user's profiles live in the `color-profiles` preset kind
  (S10.5), which also travels with preset exports.
- The operating system's profile folders are read once per launch (up to 300 files of up to 8 MB); profiles
  installed while Pigment runs appear after a restart.
