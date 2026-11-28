# Review of group FU (F3, F2, F1, U4, U2, U1, U3): AVIF, Targa, GIF, LUT formats, File Info, Similar Layers, OS recent documents, Default Actions, Insert Conditional, the Info panel, pen tablets

Reviewed on branch `claude/pigment-photocraft` from `fb7ecac0` (the end of group P's review) to `34c22348` (U3's last
commit), against PORTS.md, PORTS-A.md sections 4.1 to 4.5, 5.1 to 5.5, 6.1 and 6.2, and REBASE-FU.md (which wins
where they differ). The engineers' notes are `PKG-port-F3.md` … `PKG-port-U3.md` beside this file.

## Verdict

The group is sound. Every row the spec gives these packages (27 to 46, row 39 dropped by REBASE because upstream built
it) is built or recorded with a reason: AVIF writing (spec §8), the web build's AVIF (native-only decoder), 16-bit Targa
writing, an abstract Lab ICC for CMYK/Lab documents, the .xmp templates (optional), Photoshop's two Audio/Video tabs
(one tab), IIM in TIFF exports, Save As Photoshop PDF and the Mixer Brush tool switch in Default Actions, translated
action names (framework-drawn), the eyedropper-icon readout menus (framework grid), the hardware sign-off of the pen
work, and macOS/Windows clearing of OS recent documents. The hooks into upstream files are small and every upstream file
the group modified is named in `docs/FORK.md` (checked mechanically over `git diff --diff-filter=M fb7ecac0..34c22348`).

The new readers bound their input: `tga_more` hands craft-tga the import limits and keeps the `image` crate's error when
both fail; `iptc_iim::datasets` stops at the first malformed tag, takes extended lengths of 1 to 4 bytes only and
slices with `get`; the xbel editor leaves alone a file over 32 MiB or without GLib's namespaces; AVIF is craft-libs'
decoder behind `decode_limits` (F3's truncation test covers every prefix of four files). I found no panic. One history
step per File Info edit holds (resource 1028 changes inside the same edit, so undo restores both); PSD round trips of
File Info, LUT export at 8, 16 and 32 bits, and the Info readouts at 8, 16 and 32 bits are tested.

CI on arrival: the newest finished Pigment CI run (46141006052 on `7594595`) was green; the runs on `65f1dcc` and
`34c2234` were in progress.

## Found and fixed

1. **Editing a structure in File Info dropped the fields and items it does not show** (major, F1, engine).
   `info_more::write` rebuilt Location Shown / Location Created / Licensor / Image Supplier / Artwork or Object / Creator
   Contact Info from the JSON of the fields File Info edits. Changing a location's City in the dialog therefore deleted
   that location's `exif:GPSLatitude`/`GPSLongitude`, `Iptc4xmpExt:LocationName` and `LocationId`; editing a licensor's
   name deleted its address; and list items with no field File Info shows (a location given only by its identifier)
   vanished. That contradicts the module's own promise ("keeps every property it does not own"). Now each edited item
   keeps the stored fields File Info does not edit (`extras`, typed by `kept`: the IPTC language alternatives and
   ordered lists by name, other arrays as bags), the items it cannot show are written back after the shown ones, and
   `normalize` tracks which stored item each written item came from (the dialog's single object and an API caller's
   whole list). `exif:`/`exifEX:` are now declared by `file_info_xmp::packet` so the GPS fields can be written.
   Test: `cmd::file_cmds::info_more_tests::editing_a_structure_keeps_its_fields_and_items_file_info_does_not_show`.
2. **A rewritten IPTC-IIM stream kept its stale MD5 digest** (minor, F1, io). `iptc_iim::sync_resource` replaced
   resource 1028 but left 1061 (Photoshop's IPTC-NAA digest of 1028). Readers that follow the Metadata Working Group's
   guidance (Photoshop, ExifTool) read a mismatching digest as "an older application changed the IIM" and prefer the
   IIM to the XMP. The digest is now dropped whenever 1028 is rewritten; an unchanged File Info still leaves every
   resource byte for byte. Test: `iptc_iim::tests::a_rewritten_stream_drops_its_stale_digest_and_an_unchanged_one_keeps_it`.
3. **One LUT format with "Use lowercase file extensions" off still wrote `.cube`** (minor, F2, engine).
   `lut_writers::file_paths` returned the path as given whenever it already had the one format's extension, which is
   what the save dialog always gives, so the check box did nothing for a single format. With it off the extension is now
   uppercase; with it on (upstream's default) the path stays as given. Test:
   `cmd::file_cmds::lut_writers::tests::one_format_with_lowercase_off_takes_the_uppercase_extension`.
4. **The DeviceLink ICC had no profile sequence tag** (minor, F2, engine). ICC.1:2010 §8.2.6 requires `pseq` in a
   DeviceLink; craft-cms writes none, so strict consumers can refuse the profile. `write_icc` now adds an empty `pseq`
   (tag table grown by one entry, data moved 12 bytes, size and profile ID stamped again). Test: `check_icc` in
   `lut_writers_tests.rs` (used by four tests) asserts the tag, its alignment and the header size.
5. **The Info panel read a linear composite as sRGB** (minor, U1, interface). For an OpenEXR or Radiance file (a linear
   profile), Grayscale, Lab, HSB, Web, CMYK and Total Ink took the linear values as sRGB-encoded: mid grey read
   `363636`, B 21 %, L 22. `Space` now knows the composite is linear (`CanvasDisplay::encode_srgb`, as Proof Color
   already did) and those readouts go through the sRGB curve first; RGB still shows the stored floats, as Photoshop's
   32-bit readout does. Test: `panels::info_readout::tests::a_linear_composite_reads_through_the_srgb_curve_except_rgb`.

## Minor, recorded, not fixed

- **Info panel Actual Color in a CMYK document is the composite's round trip, not the stored inks** (U1). Upstream
  composites CMYK documents in RGB (`sample_cmds::averaging_model`), so a 0/0/0/100 K-only black reads as a rich black.
  Upstream's own CMYK readout has the same limit; fixing it needs a native-channel sample command in the engine.
  Lab, HSB, Web and Grayscale also read the composite as sRGB rather than through the document's RGB profile (the U1
  notes record this).
- **File Info language alternatives keep only `x-default`** when Pigment writes them (`usageTerms`, `altText`,
  `event`, a kept `LocationName`), as upstream's `description` does. The struct reader keeps no array kind, so an
  unknown array field inside an edited structure is written back as a bag (the IPTC ones are typed by name).
- **Fields in a namespace File Info does not declare** (anything but dc, xmp, xmpRights, photoshop, Iptc4xmpCore,
  Iptc4xmpExt, plus, xmpDM, DICOM, exif, exifEX) inside an edited structure are still dropped: the reader gives
  prefixes, not URIs.
- **Seeding IIM into XMP only happens for files without XMP.** A file whose IIM and XMP disagree keeps the XMP; the next
  File Info edit of a mapped field rewrites IIM from XMP (Photoshop's direction when the digest matches).
- **OS recent documents on Linux ignore GNOME's "remember recent files" switch** (U4): GTK honours
  `gtk-recent-files-enabled`/`remember-recent-files`; Pigment writes the xbel whenever its own recent list is on. A
  symlinked `recently-used.xbel` is replaced by the atomic write, as GLib's `g_file_set_contents` does.
- **A replaced conditional step loses its own include and dialog flags** (U2, recorded by the engineer).
- **LUT export without `path` keeps every format's text in the result** (F2): about 450 MB per text format at 256
  points; recorded by the engineer (no streaming).
- **Pen work is unconfirmed on hardware** (U3): the 8 checks in `docs/hardware-parity.md`. The rotation sign assumes
  `NSEvent.rotation` and X11's Art Pen rotation are clockwise; the macOS one follows Chromium, the X11 one is untested.

## Checks run

(filled in below)

## For the next group

- The File Info struct tables (`info_more::{CONTACT, LOCATION, LICENSOR, …}`) list what the dialog shows; the other
  fields of a stored structure are kept by `extras`/`kept`. Add a field to a table to show it, not to keep it.
- `file_info_xmp::DECLARED` is the list of namespaces File Info can write; add a namespace there before writing a field
  in it.
- `iptc_iim::DIGEST` (1061) is dropped whenever 1028 is rewritten; a later package that writes IIM elsewhere (TIFF)
  should do the same or write a real MD5 (craft-cms has an MD5 only for profile IDs).
- Info panel readouts take `Space::linear`; any new readout of the composite should use the `encoded` values.
