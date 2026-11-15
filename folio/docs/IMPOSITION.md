# Imposition tools (the "Impose" menu)

Folio PDF includes a complete imposition toolbox modelled on the Quite Imposing Plus plug-in for
Acrobat: everything you need to turn a document into printable sheets, fix page geometry, number
pages and automate the whole thing. All tools are in the **Impose** menu and under the **Impose**
toolbar button. Measurements use the unit chosen in Preferences (mm, cm, inches or points).

Every dialog ends with a **Result** choice:

- **Replace the pages of this document** applies the change in place. Undo with Ctrl+Z (⌘Z).
- **Open in a new tab** leaves the document alone and opens the result as a new, unsaved document.

Booklets, n-up, step and repeat and manual impositions default to a new tab; everything else
defaults to in place.

## Imposing pages onto sheets

| Tool | What it does |
|---|---|
| **Create Booklet…** | Pairs pages onto two-up sheets so that printing double-sided and folding the stack gives a saddle-stitched booklet. Sheet size (automatic = two pages side by side, or any sheet size), left or right binding, scaling, signatures of N pages (perfect binding), creep (shifts the inner pages outwards to compensate for paper thickness), gap at the spine and a sheet margin. Page counts are padded to a multiple of four with blank pages. |
| **N-up Pages…** | Places pages on each sheet in a rows × columns grid, across or down, with optional rotation, gap, margin and scaling (fit, fill or 100 %). |
| **Step and Repeat…** | Repeats one page (or every selected page, one sheet each) across a sheet: business cards, labels, tickets. |
| **Manual Imposition…** | Build sheets by hand: any number of sheets of any size, each with pages placed at exact positions, scales and rotations. Drag pages in the preview, edit the numbers in the table, or use **Add all pages** and **Auto-arrange**. |

## Page order

| Tool | What it does |
|---|---|
| **Shuffle Pages…** | Reverse; booklet order (pairs, without imposing); cut and stack into N stacks; all odd pages then all even pages (optionally with the even pages reversed, for duplex scans); interleave the first and second halves; or a **custom rule** such as `4, 1, 2, 3` applied to every group of four pages. Pages a rule does not mention are dropped, so `1, 3` with a group of 4 keeps pages 1, 3, 5, 7, … |
| **Reverse Pages** | Last page first. |
| **Insert Blank Pages…** | At the start, the end, before or after a page, or after every N pages; any number of blanks; same size as the first page or any sheet size. |
| **Fill to a Multiple of Pages…** | Adds blanks at the end until the page count is a multiple of 4 (booklets), 8, 16, … |
| **Duplicate Pages…** | Extra copies of the selected pages, next to the original or at the end. |

## Page geometry

| Tool | What it does |
|---|---|
| **Trim and Shift…** | Trim each edge (shrinking the page) and/or move the content; separate shifts for odd and even pages make room for a binding margin. |
| **Adjust Page Sizes…** | Change the page size: scale to fit, scale to fill, keep the content unscaled, or stretch; orientation matched to each page or fixed; alignment. |
| **Mirror Pages…** | Flip left-to-right, top-to-bottom or both (transfer paper, film). |
| **Rotate Page Content…** | Rotates the content itself by 90°, 180° or 270° (Organize pages only changes the display rotation). |
| **Split Pages…** | Cut each page into left/right halves, top/bottom halves or four quarters, optionally discarding a gutter; right page first for right-to-left documents. |
| **Tile Pages…** | Cut large pages into printable tiles (posters) with an overlap and an optional enlargement. |
| **Page Boxes…** | Set the Crop, Trim, Bleed, Art or Media box by insetting the media box or with explicit values; or remove a box. |
| **Page Info…** | A table of every page's size, orientation, rotation and boxes; save it as CSV. |

## Stick-on text, tape and marks

| Tool | What it does |
|---|---|
| **Page Numbers…**, **Bates Numbers…**, **Stick On Text…** | Draws text on the pages at one of nine positions with offsets, font, size, colour, rotation and an optional white background; odd or even pages only. Tokens: `{page}` `{pages}` `{n}` (a counter from the start number) `{bates}` `{date}` `{time}` `{file}`, with `:roman`, `:ROMAN`, `:alpha`, `:ALPHA` or a digit count, e.g. `{page:roman}` or `{bates:8}`. Bates numbers have a prefix, start number and digit count. |
| **Masking Tape…** | Covers an edge (to a depth) or a rectangle with opaque colour. The content underneath stays in the file: flatten or export images to remove it for good. |
| **Printer's Marks…** | Enlarges the pages by a margin and draws crop marks, registration targets, fold marks, CMYK colour bars and a label (with the same tokens as above). |

## Documents and settings

| Tool | What it does |
|---|---|
| **Create Sample Document…** | A numbered test document (big page numbers, corner labels, coloured backgrounds) for checking impositions before using a real job. |
| **Sheet Sizes…** | Add your own sheet sizes; they appear in every sheet-size list next to A3–A6, B4, B5, SRA3, SRA4, Letter, Legal, Tabloid, Ledger, 12×18 in and 13×19 in. |
| **Automation Sequences…** | Record a sequence (**Record Sequence…**, then apply the impositions you need, then **Stop Recording**): every step you apply is stored and can be replayed on any document with one click, edited, exported to a `.json` file and imported on another computer. While recording, each dialog offers *Only add this step to the sequence* to record without applying. |

Sequences record page selections as explicit page lists (or "all pages"), so a sequence recorded
with "current page" applies to that page number on other documents.

## Notes

- Impositions embed the source pages as form XObjects, which keeps vector content and text intact;
  text remains selectable and searchable on the imposed sheets.
- Annotations and form fields are not carried onto imposed sheets (or onto split, tiled, trimmed and
  resized pages): flatten first (File › Export › Flattened PDF) to keep them visible.
- The engine is `src/shared/impose.js`; it runs in the renderer and in Node for the unit tests.
