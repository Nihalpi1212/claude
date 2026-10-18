// Imposition tools, modelled on the Quite Imposing Plus feature set: booklets, n-up, step and
// repeat, manual imposition with a preview, shuffles, blank pages, duplicates, trim and shift,
// page sizes, mirror / rotate / split / tile, page boxes and page info, stick-on text (page
// numbers, Bates numbers, headers), masking tape, printer's marks, sample documents, custom sheet
// sizes and recorded automation sequences. The engine lives in src/shared/impose.js; this module
// only builds dialogs, converts units and routes results to a new tab or to app.edit.apply.
import * as impose from "../../shared/impose.js";
import { bridge } from "./bridge.js";
import { icon } from "./icons.js";
import { parsePageRanges, formatPageRanges } from "../../shared/page-ranges.js";

const PER_PT = { mm: 25.4 / 72, cm: 2.54 / 72, in: 1 / 72, pt: 1 };
const NEW_TAB_OPS = new Set(["booklet", "nup", "step-repeat", "manual"]);
const JSON_FILTERS = [{ name: "Sequence files", extensions: ["json"] }];
const CSV_FILTERS = [{ name: "CSV files", extensions: ["csv"] }];
const OP_LABELS = {
  booklet: "Create booklet",
  nup: "N-up pages",
  "step-repeat": "Step and repeat",
  manual: "Manual imposition",
  shuffle: "Shuffle pages",
  "shuffle-preset": "Shuffle pages",
  reverse: "Reverse pages",
  "insert-blank": "Insert blank pages",
  "fill-multiple": "Fill to a multiple of pages",
  duplicate: "Duplicate pages",
  "trim-shift": "Trim and shift",
  "adjust-size": "Adjust page sizes",
  mirror: "Mirror pages",
  "rotate-content": "Rotate page content",
  split: "Split pages",
  tile: "Tile pages",
  "page-boxes": "Page boxes",
  "stick-text": "Stick on text",
  tape: "Masking tape",
  marks: "Printer's marks",
};
let seq = 0;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const clone = (v) => JSON.parse(JSON.stringify(v));

export function install(app) {
  if (app.impose) return;
  const has = () => !!app.session;
  const state = { recording: null };

  const api = {
    get recording() {
      return state.recording;
    },
    OP_LABELS,
    runOp: (op, params, opts) => runOp(app, state, op, params, opts),
    startRecording: (name) => startRecording(app, state, name),
    stopRecording: () => stopRecording(app, state),
  };
  app.impose = api;

  app.commands.registerAll({
    "impose:booklet": { enabled: has, run: () => bookletDialog(app, state) },
    "impose:nup": { enabled: has, run: () => nUpDialog(app, state) },
    "impose:step-repeat": {
      enabled: has,
      run: () => stepRepeatDialog(app, state),
    },
    "impose:manual": { enabled: has, run: () => manualDialog(app, state) },
    "impose:shuffle": { enabled: has, run: () => shuffleDialog(app, state) },
    "impose:reverse": {
      enabled: has,
      run: () =>
        runOp(
          app,
          state,
          "reverse",
          {},
          { output: "inplace", label: "Reverse pages" },
        ),
    },
    "impose:insert-blank": {
      enabled: has,
      run: () => insertBlankDialog(app, state),
    },
    "impose:fill-multiple": {
      enabled: has,
      run: () => fillMultipleDialog(app, state),
    },
    "impose:duplicate": {
      enabled: has,
      run: () => duplicateDialog(app, state),
    },
    "impose:trim-shift": {
      enabled: has,
      run: () => trimShiftDialog(app, state),
    },
    "impose:adjust-size": {
      enabled: has,
      run: () => adjustSizeDialog(app, state),
    },
    "impose:mirror": { enabled: has, run: () => mirrorDialog(app, state) },
    "impose:rotate-content": {
      enabled: has,
      run: () => rotateContentDialog(app, state),
    },
    "impose:split": { enabled: has, run: () => splitDialog(app, state) },
    "impose:tile": { enabled: has, run: () => tileDialog(app, state) },
    "impose:page-boxes": {
      enabled: has,
      run: () => pageBoxesDialog(app, state),
    },
    "impose:page-info": { enabled: has, run: () => pageInfoDialog(app) },
    "impose:stick-text": {
      enabled: has,
      run: (arg) => stickTextDialog(app, state, arg?.preset ?? "text"),
    },
    "impose:page-numbers": {
      enabled: has,
      run: () => stickTextDialog(app, state, "numbers"),
    },
    "impose:bates": {
      enabled: has,
      run: () => stickTextDialog(app, state, "bates"),
    },
    "impose:tape": { enabled: has, run: () => tapeDialog(app, state) },
    "impose:marks": { enabled: has, run: () => marksDialog(app, state) },
    "impose:sample": { run: () => sampleDialog(app) },
    "impose:sheet-sizes": { run: () => sheetSizesDialog(app) },
    "impose:sequences": { run: () => sequencesDialog(app, state) },
    "impose:record": {
      checked: () => !!state.recording,
      run: async () => {
        if (state.recording) return stopRecording(app, state);
        const name = await app.dialogs.prompt("Name of the new sequence", {
          title: "Record a sequence",
          value: `Sequence ${(app.settings.imposeSequences?.length ?? 0) + 1}`,
          okLabel: "Start recording",
        });
        if (name === null || !name.trim()) return;
        startRecording(app, state, name.trim());
      },
    },
    "impose:run-sequence": {
      enabled: has,
      run: (arg) => runSequence(app, state, arg),
    },
  });

  const menuItem = (label, cmd, arg) => ({
    label,
    disabled: !app.commands.isEnabled(cmd),
    onSelect: () => app.commands.run(cmd, arg, "toolbar"),
  });
  app.toolbar.addButton({
    id: "impose",
    group: "tools",
    icon: "impose",
    title: "Impose (booklets, n-up, page numbers…)",
    menu: () => [
      { type: "title", label: "Impose" },
      menuItem("Create Booklet…", "impose:booklet"),
      menuItem("N-up Pages…", "impose:nup"),
      menuItem("Step and Repeat…", "impose:step-repeat"),
      menuItem("Manual Imposition…", "impose:manual"),
      { type: "separator" },
      menuItem("Shuffle Pages…", "impose:shuffle"),
      menuItem("Reverse Pages", "impose:reverse"),
      menuItem("Insert Blank Pages…", "impose:insert-blank"),
      menuItem("Fill to a Multiple of Pages…", "impose:fill-multiple"),
      menuItem("Duplicate Pages…", "impose:duplicate"),
      { type: "separator" },
      menuItem("Trim and Shift…", "impose:trim-shift"),
      menuItem("Adjust Page Sizes…", "impose:adjust-size"),
      menuItem("Mirror Pages…", "impose:mirror"),
      menuItem("Rotate Page Content…", "impose:rotate-content"),
      menuItem("Split Pages…", "impose:split"),
      menuItem("Tile Pages…", "impose:tile"),
      menuItem("Page Boxes…", "impose:page-boxes"),
      menuItem("Page Info…", "impose:page-info"),
      { type: "separator" },
      menuItem("Page Numbers…", "impose:page-numbers"),
      menuItem("Bates Numbers…", "impose:bates"),
      menuItem("Stick On Text…", "impose:stick-text"),
      menuItem("Masking Tape…", "impose:tape"),
      menuItem("Printer's Marks…", "impose:marks"),
      { type: "separator" },
      menuItem("Create Sample Document…", "impose:sample"),
      menuItem("Sheet Sizes…", "impose:sheet-sizes"),
      menuItem("Automation Sequences…", "impose:sequences"),
      {
        label: state.recording
          ? `Stop Recording “${state.recording.name}”`
          : "Record Sequence…",
        icon: state.recording ? "stop" : "record",
        onSelect: () => app.commands.run("impose:record", undefined, "toolbar"),
      },
    ],
  });
}

// ---- units, fields and forms ------------------------------------------------------------------------------

function units(app) {
  const unit = PER_PT[app.settings.measureUnit]
    ? app.settings.measureUnit
    : "mm";
  const perPt = PER_PT[unit];
  const digits = unit === "pt" ? 1 : unit === "in" ? 3 : 2;
  const round = (n) => Math.round(n * 10 ** digits) / 10 ** digits;
  return {
    unit,
    perPt,
    toPt: (v) => (Number(v) || 0) / perPt,
    fromPt: (pt) => round((Number(pt) || 0) * perPt),
    fmt: (pt) => String(round((Number(pt) || 0) * perPt)),
  };
}

/**
 * Builds a form from field specs and returns { el, values(), get(name), set(name, value), on(fn) }.
 * Field types: number (unit: true converts between the user's unit and points; percent: true
 * divides by 100), text, textarea, select (options [[value, label]]), checkbox, color, sheet
 * (auto?, allowCustom?), pages (all / current / range), section, note.
 */
function buildForm(app, fields, ctx = {}) {
  const u = units(app);
  const el = document.createElement("div");
  el.className = "impose-form";
  const readers = new Map();
  const setters = new Map();
  const listeners = [];
  const spanClass = (f) =>
    f.span === 2 ? " span-2" : f.span === "all" ? " span-all" : "";
  const id = `f${++seq}`;
  for (const f of fields) {
    let node;
    switch (f.type) {
      case "section": {
        node = document.createElement("div");
        node.className = "impose-section";
        node.textContent = f.label;
        break;
      }
      case "note": {
        node = document.createElement("p");
        node.className = "impose-note";
        node.textContent = f.label;
        break;
      }
      case "checkbox": {
        node = document.createElement("label");
        node.className = "checkbox" + spanClass(f);
        node.innerHTML = `<input type="checkbox" data-f="${f.name}"> ${esc(f.label)}`;
        const input = node.querySelector("input");
        input.checked = !!f.value;
        readers.set(f.name, () => input.checked);
        setters.set(f.name, (v) => (input.checked = !!v));
        break;
      }
      case "select": {
        node = document.createElement("label");
        node.className = "field" + spanClass(f);
        node.innerHTML = `<span>${esc(f.label)}</span><select class="select" data-f="${f.name}">${f.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select>`;
        const select = node.querySelector("select");
        if (f.value !== undefined) select.value = String(f.value);
        readers.set(f.name, () => select.value);
        setters.set(f.name, (v) => (select.value = String(v)));
        break;
      }
      case "sheet": {
        node = sheetField(app, f, u, spanClass(f));
        readers.set(f.name, node.read);
        setters.set(f.name, node.set);
        break;
      }
      case "pages": {
        node = pagesField(f, ctx, `${id}-${f.name}`, spanClass(f));
        readers.set(f.name, node.read);
        setters.set(f.name, node.set);
        break;
      }
      case "textarea": {
        node = document.createElement("label");
        node.className = "field" + spanClass(f);
        node.innerHTML = `<span>${esc(f.label)}</span><textarea class="textarea" data-f="${f.name}" rows="${f.rows ?? 3}"></textarea>`;
        const input = node.querySelector("textarea");
        input.value = f.value ?? "";
        readers.set(f.name, () => input.value);
        setters.set(f.name, (v) => (input.value = v ?? ""));
        break;
      }
      default: {
        // number | text | color
        node = document.createElement("label");
        node.className = "field" + spanClass(f);
        const label =
          f.type === "number" && f.unit
            ? `${f.label} (${u.unit})`
            : f.type === "number" && f.percent
              ? `${f.label} (%)`
              : f.label;
        const attrs =
          f.type === "number"
            ? ` step="${f.step ?? "any"}"${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""}`
            : "";
        node.innerHTML = `<span>${esc(label)}</span><input class="input" type="${f.type === "color" ? "color" : f.type}" data-f="${f.name}"${attrs}${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""}>`;
        const input = node.querySelector("input");
        const display = (v) =>
          f.type === "number" && f.unit
            ? u.fromPt(v)
            : f.type === "number" && f.percent
              ? Math.round((Number(v) || 0) * 100)
              : v;
        input.value = f.value === undefined ? "" : String(display(f.value));
        readers.set(f.name, () => {
          if (f.type !== "number") return input.value;
          const n = Number(input.value);
          if (input.value === "" || !Number.isFinite(n)) {
            if (f.required === false) return undefined;
            throw new Error(`Enter a value for “${f.label}”`);
          }
          if (f.min !== undefined && n < f.min)
            throw new Error(`“${f.label}” must be at least ${f.min}`);
          if (f.max !== undefined && n > f.max)
            throw new Error(`“${f.label}” must be at most ${f.max}`);
          return f.unit ? u.toPt(n) : f.percent ? n / 100 : n;
        });
        setters.set(
          f.name,
          (v) => (input.value = v === undefined ? "" : String(display(v))),
        );
      }
    }
    if (f.hint) node.title = f.hint;
    el.appendChild(node);
  }
  el.addEventListener("input", () => listeners.forEach((fn) => fn()));
  el.addEventListener("change", () => listeners.forEach((fn) => fn()));
  return {
    el,
    values() {
      const out = {};
      for (const [name, read] of readers) out[name] = read();
      return out;
    },
    get: (name) => readers.get(name)?.(),
    set: (name, v) => setters.get(name)?.(v),
    on: (fn) => listeners.push(fn),
  };
}

function sheetField(app, f, u, extraClass = "") {
  const wrap = document.createElement("div");
  wrap.className = "field" + extraClass;
  const custom = (app.settings.customSheetSizes ?? []).filter(
    (s) => s && Number.isFinite(s.width) && Number.isFinite(s.height),
  );
  const opts = [];
  if (f.auto) opts.push(["auto", f.autoLabel ?? "Automatic"]);
  if (f.same) opts.push(["same", f.sameLabel ?? "Same as the page"]);
  for (const name of Object.keys(impose.SHEET_SIZES))
    opts.push([
      name,
      `${name} — ${u.fmt(impose.SHEET_SIZES[name][0])} × ${u.fmt(impose.SHEET_SIZES[name][1])} ${u.unit}`,
    ]);
  custom.forEach((s, i) =>
    opts.push([
      `custom:${i}`,
      `${s.name} — ${u.fmt(Math.min(s.width, s.height))} × ${u.fmt(Math.max(s.width, s.height))} ${u.unit}`,
    ]),
  );
  if (f.allowCustom !== false) opts.push(["custom", "Custom size…"]);
  wrap.innerHTML = `<span>${esc(f.label ?? "Sheet size")}</span>
    <div class="impose-inline"><select class="select" data-f="${f.name}">${opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("")}</select><select class="select" data-f="${f.name}-orient" title="Orientation"><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></div>
    <div class="impose-inline" data-custom hidden><input class="input" type="number" step="any" min="0" data-f="${f.name}-w" placeholder="Width (${u.unit})" title="Width (${u.unit})"><span>×</span><input class="input" type="number" step="any" min="0" data-f="${f.name}-h" placeholder="Height (${u.unit})" title="Height (${u.unit})"></div>`;
  const select = wrap.querySelector(`[data-f="${f.name}"]`);
  const orient = wrap.querySelector(`[data-f="${f.name}-orient"]`);
  const customRow = wrap.querySelector("[data-custom]");
  const wIn = wrap.querySelector(`[data-f="${f.name}-w"]`);
  const hIn = wrap.querySelector(`[data-f="${f.name}-h"]`);
  const sync = () => {
    customRow.hidden = select.value !== "custom";
    orient.disabled =
      select.value === "auto" ||
      select.value === "same" ||
      select.value === "custom";
  };
  select.addEventListener("change", sync);
  select.value = f.value ?? (f.auto ? "auto" : f.same ? "same" : "A4");
  if (!select.value) select.value = opts[0][0];
  orient.value = f.orientation ?? "portrait";
  sync();
  wrap.read = () => {
    const v = select.value;
    if (v === "auto" || v === "same") return v;
    if (v === "custom") {
      const w = u.toPt(wIn.value),
        h = u.toPt(hIn.value);
      if (!(w > 0 && h > 0))
        throw new Error("Enter a custom sheet width and height");
      return [w, h];
    }
    const landscape = orient.value === "landscape";
    if (v.startsWith("custom:")) {
      const s = custom[Number(v.slice(7))];
      const [a, b] = [Math.min(s.width, s.height), Math.max(s.width, s.height)];
      return landscape ? [b, a] : [a, b];
    }
    return `${v}-${orient.value}`;
  };
  wrap.set = (v) => {
    if (Array.isArray(v)) {
      select.value = "custom";
      wIn.value = String(u.fromPt(v[0]));
      hIn.value = String(u.fromPt(v[1]));
    } else if (typeof v === "string") {
      const m = /^(.*?)(?:-(landscape|portrait))?$/.exec(v);
      select.value = m[1];
      if (m[2]) orient.value = m[2];
    }
    sync();
  };
  return wrap;
}

function pagesField(f, ctx, name, extraClass = "") {
  const wrap = document.createElement("div");
  wrap.className = "field" + extraClass;
  const current = ctx.page ?? 1;
  wrap.innerHTML = `<span>${esc(f.label ?? "Pages")}</span>
    <div class="impose-inline" style="flex-wrap:wrap">
      <label class="checkbox"><input type="radio" name="${name}" value="all"> All</label>
      <label class="checkbox"><input type="radio" name="${name}" value="current"> Current (page ${current})</label>
      <label class="checkbox"><input type="radio" name="${name}" value="range"> Pages</label>
      <input class="input" type="text" data-f="${f.name}-range" placeholder="e.g. 1-3, 7" style="width:120px">
    </div>`;
  const radios = [...wrap.querySelectorAll('input[type="radio"]')];
  const range = wrap.querySelector('input[type="text"]');
  radios.find((r) => r.value === (f.value ?? "all")).checked = true;
  range.addEventListener(
    "focus",
    () => (radios.find((r) => r.value === "range").checked = true),
  );
  wrap.read = () => {
    const mode = radios.find((r) => r.checked)?.value ?? "all";
    if (mode === "all") return undefined;
    if (mode === "current") return [current - 1];
    const idx = parsePageRanges(range.value, ctx.numPages ?? 1);
    if (!idx.length) throw new Error("Enter the pages to use");
    return idx;
  };
  wrap.set = (v) => {
    if (!v) radios.find((r) => r.value === "all").checked = true;
    else {
      radios.find((r) => r.value === "range").checked = true;
      range.value = formatPageRanges(v);
    }
  };
  return wrap;
}

function outputSection(def, recording) {
  const el = document.createElement("div");
  el.className = "impose-output";
  const name = `out${++seq}`;
  el.innerHTML = `<span>Result:</span>
    <label class="checkbox"><input type="radio" name="${name}" value="inplace"> Replace the pages of this document (undo with Ctrl+Z)</label>
    <label class="checkbox"><input type="radio" name="${name}" value="new"> Open in a new tab</label>
    ${recording ? `<label class="checkbox"><input type="checkbox" data-record-only> Only add this step to “${esc(recording.name)}”</label>` : ""}`;
  el.querySelector(`input[value="${def}"]`).checked = true;
  return {
    el,
    value: () =>
      el.querySelector(`input[name="${name}"]:checked`)?.value ?? def,
    recordOnly: () => !!el.querySelector("[data-record-only]")?.checked,
  };
}

/**
 * Generic imposition dialog: form -> build({values, form}) returns { op, params } -> runOp.
 */
async function imposeDialog(
  app,
  state,
  {
    title,
    fields,
    build,
    defaultOutput,
    width = 640,
    okLabel = "Apply",
    intro,
    extra,
  },
) {
  const session = app.session;
  if (!session) return null;
  const v = session.view;
  const form = buildForm(app, fields, { numPages: v.numPages, page: v.page });
  const content = document.createElement("div");
  if (intro) {
    const p = document.createElement("p");
    p.className = "muted";
    p.style.margin = "0";
    p.textContent = intro;
    content.appendChild(p);
  }
  content.appendChild(form.el);
  if (extra) content.appendChild(extra(form));
  let step = null;
  const out = outputSection(defaultOutput ?? "inplace", state.recording);
  content.appendChild(out.el);
  const ok = await app.dialogs.open({
    title,
    content,
    className: "impose-dialog",
    width,
    buttons: [
      { label: "Cancel", value: null },
      { label: okLabel, value: true, primary: true },
    ],
    validate: () => {
      try {
        step = build(form.values(), form);
        if (!step) return false;
        return true;
      } catch (err) {
        app.dialogs.toast(err.message, { kind: "error" });
        return false;
      }
    },
  });
  if (!ok || !step) return null;
  return runOp(app, state, step.op, step.params, {
    output: out.value(),
    label: title.replace(/…$/, ""),
    recordOnly: out.recordOnly(),
    session,
  });
}

/** Records (when a sequence is being recorded) and executes one engine operation. */
async function runOp(
  app,
  state,
  op,
  params,
  {
    output = "inplace",
    label = OP_LABELS[op] ?? op,
    record = true,
    recordOnly = false,
    session = app.session,
  } = {},
) {
  const fn = impose.OPS[op];
  if (!fn) throw new Error(`Unknown operation "${op}"`);
  const clean = compactParams(params);
  if (state.recording && record) {
    state.recording.steps.push({ op, params: clone(clean) });
    updateRecordingStatus(app, state);
  }
  if (recordOnly) {
    app.dialogs.toast(`Added “${label}” to the sequence`, {
      kind: "success",
      timeout: 1800,
    });
    return null;
  }
  if (!session) return null;
  if (output === "new") {
    let bytes;
    try {
      bytes = await fn(await session.flush(), clean);
    } catch (err) {
      app.reportError(err, label);
      return null;
    }
    const name = `${session.name.replace(/\.pdf$/i, "")}-${op}.pdf`;
    const tab = await app.tabs.open({ bytes, name });
    if (tab) {
      tab.opsDirty = true;
      app.emit("doc:dirty", { session: tab, dirty: true });
      app.dialogs.toast(
        `${label}: ${tab.view.numPages} page${tab.view.numPages === 1 ? "" : "s"} in a new tab`,
        { kind: "success", timeout: 2500 },
      );
    }
    return tab;
  }
  const result = await app.edit.apply(
    async (bytes) => {
      const outBytes = await fn(bytes, clean);
      return outBytes === bytes ? null : outBytes;
    },
    { label, keepPosition: false, session },
  );
  return result;
}

function compactParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params ?? {}))
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

// ---- booklet, n-up, step and repeat -----------------------------------------------------------------------

function bookletDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Create booklet…",
    okLabel: "Create",
    defaultOutput: "new",
    intro:
      "Pages are paired onto two-up sheets so that printing them double-sided and folding the stack gives a saddle-stitched booklet.",
    fields: [
      {
        type: "sheet",
        name: "sheet",
        label: "Sheet size",
        auto: true,
        autoLabel: "Automatic (two pages side by side)",
        value: "auto",
        orientation: "landscape",
        span: 2,
      },
      {
        type: "select",
        name: "binding",
        label: "Binding edge",
        options: [
          ["left", "Left (left-to-right languages)"],
          ["right", "Right"],
        ],
        value: "left",
      },
      {
        type: "select",
        name: "scale",
        label: "Page scaling",
        options: [
          ["fit", "Fit each page in its half"],
          ["none", "Do not scale (100 %)"],
        ],
        value: "fit",
      },
      {
        type: "number",
        name: "signatureSize",
        label: "Pages per signature (0 = one booklet)",
        min: 0,
        step: 4,
        value: 0,
        hint: "Split into signatures of this many pages for perfect binding",
      },
      {
        type: "number",
        name: "creep",
        label: "Creep per sheet",
        unit: true,
        min: 0,
        value: 0,
        hint: "Shifts inner pages outwards to compensate for the paper thickness",
      },
      {
        type: "number",
        name: "gap",
        label: "Gap at the spine",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "margin",
        label: "Sheet margin",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "pages",
        name: "pageIndices",
        label: "Pages to include",
        span: "all",
      },
      {
        type: "note",
        label:
          "Tip: documents whose page count is not a multiple of four get blank pages at the end. Use Fill to a Multiple of Pages first to control where blanks go.",
      },
    ],
    build: (v) => ({
      op: "booklet",
      params: {
        sheet: v.sheet,
        binding: v.binding,
        scale: v.scale,
        signatureSize: v.signatureSize,
        creep: v.creep,
        gap: v.gap,
        margin: v.margin,
        pageIndices: v.pageIndices,
      },
    }),
  });
}

function nUpDialog(app, state) {
  return imposeDialog(app, state, {
    title: "N-up pages…",
    okLabel: "Create",
    defaultOutput: "new",
    intro: "Places several pages on each sheet in a grid, in reading order.",
    fields: [
      {
        type: "sheet",
        name: "sheet",
        label: "Sheet size",
        value: "A4",
        orientation: "landscape",
        span: 2,
      },
      {
        type: "number",
        name: "rows",
        label: "Rows",
        min: 1,
        max: 50,
        step: 1,
        value: 1,
      },
      {
        type: "number",
        name: "cols",
        label: "Columns",
        min: 1,
        max: 50,
        step: 1,
        value: 2,
      },
      {
        type: "select",
        name: "order",
        label: "Fill order",
        options: [
          ["across", "Across (left to right, then down)"],
          ["down", "Down (top to bottom, then across)"],
        ],
        value: "across",
      },
      {
        type: "select",
        name: "scale",
        label: "Page scaling",
        options: [
          ["fit", "Fit each page in its cell"],
          ["fill", "Fill the cell (may crop)"],
          ["none", "Do not scale (100 %)"],
        ],
        value: "fit",
      },
      {
        type: "select",
        name: "rotate",
        label: "Rotate pages",
        options: [
          ["0", "No"],
          ["90", "90° counter-clockwise"],
          ["180", "180°"],
          ["270", "90° clockwise"],
        ],
        value: "0",
      },
      {
        type: "number",
        name: "gap",
        label: "Gap between pages",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "margin",
        label: "Sheet margin",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "pages",
        name: "pageIndices",
        label: "Pages to include",
        span: "all",
      },
    ],
    build: (v) => ({
      op: "nup",
      params: {
        sheet: v.sheet,
        rows: v.rows,
        cols: v.cols,
        order: v.order,
        scale: v.scale,
        rotate: Number(v.rotate),
        gap: v.gap,
        margin: v.margin,
        pageIndices: v.pageIndices,
      },
    }),
  });
}

function stepRepeatDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Step and repeat…",
    okLabel: "Create",
    defaultOutput: "new",
    intro: "Repeats a page across a sheet (business cards, labels, tickets).",
    fields: [
      {
        type: "sheet",
        name: "sheet",
        label: "Sheet size",
        value: "A4",
        orientation: "portrait",
        span: 2,
      },
      {
        type: "number",
        name: "rows",
        label: "Rows",
        min: 1,
        max: 100,
        step: 1,
        value: 5,
      },
      {
        type: "number",
        name: "cols",
        label: "Columns",
        min: 1,
        max: 100,
        step: 1,
        value: 2,
      },
      {
        type: "select",
        name: "scale",
        label: "Page scaling",
        options: [
          ["none", "Do not scale (100 %)"],
          ["fit", "Fit each copy in its cell"],
          ["fill", "Fill the cell (may crop)"],
        ],
        value: "none",
      },
      {
        type: "select",
        name: "each",
        label: "Which pages",
        options: [
          ["false", "Only the first selected page, one sheet"],
          ["true", "Every selected page, one sheet each"],
        ],
        value: "false",
      },
      {
        type: "number",
        name: "gap",
        label: "Gap between copies",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "margin",
        label: "Sheet margin",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "pages",
        name: "pageIndices",
        label: "Pages",
        value: "current",
        span: "all",
      },
    ],
    build: (v) => ({
      op: "step-repeat",
      params: {
        sheet: v.sheet,
        rows: v.rows,
        cols: v.cols,
        scale: v.scale,
        each: v.each === "true",
        gap: v.gap,
        margin: v.margin,
        pageIndices: v.pageIndices,
      },
    }),
  });
}

// ---- manual imposition ------------------------------------------------------------------------------------------

async function manualDialog(app, state) {
  const session = app.session;
  if (!session) return;
  const v = session.view;
  const u = units(app);
  let info;
  try {
    info = await impose.pageInfo(await session.flush());
  } catch (err) {
    app.reportError(err, "Manual imposition");
    return;
  }
  const sheets = [{ size: "A4-landscape", placements: [] }];
  let cur = 0;
  let selected = -1;
  const thumbs = new Map();
  const thumb = (index) => {
    if (!thumbs.has(index))
      thumbs.set(
        index,
        v
          .renderPage(index, { width: 160, dpr: 1, ignoreViewRotation: true })
          .catch(() => null),
      );
    return thumbs.get(index);
  };

  const content = document.createElement("div");
  content.className = "impose-manual";
  content.innerHTML = `
    <div class="impose-toolbar">
      <span class="muted">Sheet</span>
      <select class="select" data-sheet-select style="width:auto"></select>
      <button class="btn quiet" data-act="add-sheet" title="Add a sheet">${icon("plus")} Sheet</button>
      <button class="btn quiet" data-act="remove-sheet" title="Remove this sheet">${icon("trash")}</button>
      <span class="spacer"></span>
      <button class="btn" data-act="add-page">${icon("plus")} Add page ${v.page}</button>
      <button class="btn" data-act="add-all">Add all pages</button>
      <button class="btn" data-act="arrange">Auto-arrange</button>
    </div>
    <div data-sheet-field></div>
    <div class="impose-preview">
      <div class="impose-sheet" data-preview></div>
      <div class="impose-placements">
        <table><thead><tr><th>Page</th><th>X (${u.unit})</th><th>Y (${u.unit})</th><th>Scale %</th><th>Rotation</th><th></th></tr></thead><tbody data-rows></tbody></table>
        <div class="muted" style="font-size:12px">X/Y are measured from the bottom-left corner of the sheet to the bottom-left corner of the placed page. Drag a page on the preview to move it.</div>
      </div>
    </div>`;
  const sheetSelect = content.querySelector("[data-sheet-select]");
  const sheetFieldHost = content.querySelector("[data-sheet-field]");
  const preview = content.querySelector("[data-preview]");
  const rowsEl = content.querySelector("[data-rows]");
  let sheetForm = null;

  const sheetSize = () => impose.resolveSheet(sheets[cur].size);
  const placedSize = (pl) => {
    const p = info[pl.page] ?? info[0];
    const w = p.width * pl.scale,
      h = p.height * pl.scale;
    return pl.rotation % 180
      ? { w: h, h: w, pw: w, ph: h }
      : { w, h, pw: w, ph: h };
  };

  function renderSheetSelect() {
    sheetSelect.replaceChildren(
      ...sheets.map((s, i) =>
        Object.assign(document.createElement("option"), {
          value: String(i),
          textContent: `Sheet ${i + 1} of ${sheets.length} (${s.placements.length} page${s.placements.length === 1 ? "" : "s"})`,
        }),
      ),
    );
    sheetSelect.value = String(cur);
  }
  function renderSheetField() {
    sheetForm = buildForm(app, [
      {
        type: "sheet",
        name: "size",
        label: "Sheet size",
        value:
          typeof sheets[cur].size === "string" ? sheets[cur].size : undefined,
        span: "all",
      },
    ]);
    if (Array.isArray(sheets[cur].size))
      sheetForm.set("size", sheets[cur].size);
    sheetForm.on(() => {
      try {
        sheets[cur].size = sheetForm.get("size");
      } catch {
        /* incomplete custom size */
      }
      renderPreview();
    });
    sheetFieldHost.replaceChildren(sheetForm.el);
  }
  function renderPreview() {
    const [W, H] = sheetSize();
    const scale = Math.min(380 / W, 320 / H);
    preview.style.width = `${Math.round(W * scale)}px`;
    preview.style.height = `${Math.round(H * scale)}px`;
    preview.replaceChildren();
    sheets[cur].placements.forEach((pl, i) => {
      const { w, h, pw, ph } = placedSize(pl);
      const cell = document.createElement("div");
      cell.className = "cell" + (i === selected ? " selected" : "");
      cell.style.left = `${pl.x * scale}px`;
      cell.style.top = `${(H - pl.y - h) * scale}px`;
      cell.style.width = `${w * scale}px`;
      cell.style.height = `${h * scale}px`;
      cell.title = `Page ${pl.page + 1}`;
      const inner = document.createElement("div");
      inner.style.cssText = `position:absolute;left:50%;top:50%;width:${pw * scale}px;height:${ph * scale}px;transform:translate(-50%,-50%) rotate(${-pl.rotation}deg);display:grid;place-items:center;overflow:hidden`;
      const num = document.createElement("span");
      num.className = "cell-num";
      num.textContent = String(pl.page + 1);
      inner.appendChild(num);
      cell.appendChild(inner);
      thumb(pl.page).then((canvas) => {
        if (!canvas || !cell.isConnected) return;
        const img = canvas.cloneNode(true);
        img.getContext("2d").drawImage(canvas, 0, 0);
        img.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;opacity:0.9";
        inner.insertBefore(img, num);
        num.style.position = "relative";
      });
      cell.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        selected = i;
        renderRows();
        renderPreview();
        const startX = event.clientX,
          startY = event.clientY,
          ox = pl.x,
          oy = pl.y;
        const move = (e) => {
          pl.x = Math.round((ox + (e.clientX - startX) / scale) * 100) / 100;
          pl.y = Math.round((oy - (e.clientY - startY) / scale) * 100) / 100;
          const c = preview.children[i];
          if (c) {
            c.style.left = `${pl.x * scale}px`;
            c.style.top = `${(H - pl.y - h) * scale}px`;
          }
          const row = rowsEl.children[i];
          if (row) {
            row.querySelector('[data-k="x"]').value = String(u.fromPt(pl.x));
            row.querySelector('[data-k="y"]').value = String(u.fromPt(pl.y));
          }
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      });
      preview.appendChild(cell);
    });
  }
  function renderRows() {
    rowsEl.replaceChildren();
    const list = sheets[cur].placements;
    if (!list.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="muted" style="text-align:center;padding:10px">No pages on this sheet yet. Use “Add page” or “Add all pages”.</td>`;
      rowsEl.appendChild(tr);
      return;
    }
    list.forEach((pl, i) => {
      const tr = document.createElement("tr");
      tr.className = i === selected ? "selected" : "";
      tr.innerHTML = `<td><input class="input" type="number" min="1" max="${info.length}" step="1" data-k="page" value="${pl.page + 1}"></td>
        <td><input class="input" type="number" step="any" data-k="x" value="${u.fromPt(pl.x)}"></td>
        <td><input class="input" type="number" step="any" data-k="y" value="${u.fromPt(pl.y)}"></td>
        <td><input class="input" type="number" step="any" min="1" data-k="scale" value="${Math.round(pl.scale * 1000) / 10}"></td>
        <td><select class="select" data-k="rotation" style="height:26px;padding:0 4px"><option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option></select></td>
        <td><button class="tb-button" data-remove title="Remove">${icon("close")}</button></td>`;
      tr.querySelector('[data-k="rotation"]').value = String(pl.rotation);
      tr.addEventListener("focusin", () => {
        if (selected !== i) {
          selected = i;
          for (const r of rowsEl.children)
            r.classList.toggle("selected", r === tr);
          renderPreview();
        }
      });
      tr.addEventListener("input", (event) => {
        const k = event.target.dataset.k;
        if (!k) return;
        const val = event.target.value;
        if (k === "page")
          pl.page =
            Math.min(info.length, Math.max(1, Math.round(Number(val) || 1))) -
            1;
        else if (k === "x") pl.x = u.toPt(val);
        else if (k === "y") pl.y = u.toPt(val);
        else if (k === "scale")
          pl.scale = Math.max(0.01, (Number(val) || 100) / 100);
        else if (k === "rotation") pl.rotation = Number(val) || 0;
        renderPreview();
      });
      tr.querySelector("[data-remove]").addEventListener("click", () => {
        list.splice(i, 1);
        selected = -1;
        renderAll();
      });
      rowsEl.appendChild(tr);
    });
  }
  function renderAll() {
    renderSheetSelect();
    renderRows();
    renderPreview();
  }
  function arrange() {
    const list = sheets[cur].placements;
    if (!list.length) return;
    const [W, H] = sheetSize();
    const n = list.length;
    let cols = Math.max(1, Math.round(Math.sqrt((n * W) / H)));
    let rows = Math.ceil(n / cols);
    while (cols > 1 && (cols - 1) * rows >= n) cols--;
    rows = Math.ceil(n / cols);
    const cellW = W / cols,
      cellH = H / rows;
    list.forEach((pl, i) => {
      const p = info[pl.page];
      const pw = pl.rotation % 180 ? p.height : p.width,
        ph = pl.rotation % 180 ? p.width : p.height;
      const sc = Math.min(cellW / pw, cellH / ph, 1);
      pl.scale = Math.round(sc * 1000) / 1000;
      const w = pw * pl.scale,
        h = ph * pl.scale;
      const c = i % cols,
        r = Math.floor(i / cols);
      pl.x = Math.round((c * cellW + (cellW - w) / 2) * 100) / 100;
      pl.y = Math.round((H - (r + 1) * cellH + (cellH - h) / 2) * 100) / 100;
    });
  }
  content
    .querySelector(".impose-toolbar")
    .addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      const list = sheets[cur].placements;
      if (act === "add-page")
        list.push({ page: v.page - 1, x: 0, y: 0, scale: 1, rotation: 0 });
      else if (act === "add-all") {
        for (let i = 0; i < info.length; i++)
          list.push({ page: i, x: 0, y: 0, scale: 1, rotation: 0 });
        arrange();
      } else if (act === "arrange") arrange();
      else if (act === "add-sheet") {
        sheets.push({ size: sheets[cur].size, placements: [] });
        cur = sheets.length - 1;
        selected = -1;
        renderSheetField();
      } else if (act === "remove-sheet") {
        if (sheets.length === 1) {
          list.length = 0;
        } else {
          sheets.splice(cur, 1);
          cur = Math.min(cur, sheets.length - 1);
          renderSheetField();
        }
        selected = -1;
      }
      renderAll();
    });
  sheetSelect.addEventListener("change", () => {
    cur = Number(sheetSelect.value) || 0;
    selected = -1;
    renderSheetField();
    renderAll();
  });
  renderSheetField();
  renderAll();

  const out = outputSection("new", state.recording);
  content.appendChild(out.el);
  const ok = await app.dialogs.open({
    title: "Manual imposition",
    content,
    className: "wide impose-dialog",
    buttons: [
      { label: "Cancel", value: null },
      { label: "Create", value: true, primary: true },
    ],
    validate: () => {
      if (!sheets.some((s) => s.placements.length)) {
        app.dialogs.toast("Add at least one page to a sheet", {
          kind: "error",
        });
        return false;
      }
      return true;
    },
  });
  if (!ok) return;
  const params = {
    sheets: sheets
      .filter((s) => s.placements.length)
      .map((s) => ({
        size: s.size,
        placements: s.placements.map((pl) => ({
          page: pl.page,
          x: pl.x,
          y: pl.y,
          scale: pl.scale,
          rotation: pl.rotation,
        })),
      })),
  };
  await runOp(app, state, "manual", params, {
    output: out.value(),
    label: "Manual imposition",
    recordOnly: out.recordOnly(),
    session,
  });
}

// ---- page order ----------------------------------------------------------------------------------------------

function shuffleDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Shuffle pages…",
    intro:
      "Reorders pages for printing: reverse, booklet order, cut-and-stack, separate or interleave fronts and backs, or a custom rule.",
    fields: [
      {
        type: "select",
        name: "preset",
        label: "Shuffle",
        span: 2,
        options: [
          ["reverse", "Reverse the page order"],
          [
            "booklet",
            "Booklet order (pairs for saddle stitching, without imposing)",
          ],
          ["cut-and-stack", "Cut and stack (deal pages into stacks)"],
          ["even-odd-separate", "All odd pages, then all even pages"],
          [
            "even-odd-separate-reverse",
            "All odd pages, then even pages reversed (duplex scans)",
          ],
          [
            "even-odd-interleave",
            "Interleave: first half and second half alternately",
          ],
          ["custom", "Custom rule…"],
        ],
        value: "reverse",
      },
      {
        type: "number",
        name: "stacks",
        label: "Stacks (cut and stack)",
        min: 2,
        max: 100,
        step: 1,
        value: 2,
      },
      {
        type: "number",
        name: "groupSize",
        label: "Group size (custom rule)",
        min: 1,
        max: 1000,
        step: 1,
        value: 4,
      },
      {
        type: "text",
        name: "rule",
        label: "Rule: positions within each group, in the new order",
        placeholder: "e.g. 4, 1, 2, 3",
        value: "4, 1, 2, 3",
        span: "all",
      },
      {
        type: "note",
        label:
          "A rule lists which page of every group comes first, second, … Pages the rule does not mention are left out, so “1, 3” with a group of 4 keeps only pages 1, 3, 5, 7, …",
      },
    ],
    build: (v) => {
      if (v.preset === "custom") {
        const rule = String(v.rule)
          .split(/[\s,;]+/)
          .filter(Boolean)
          .map(Number);
        if (
          !rule.length ||
          rule.some((n) => !Number.isInteger(n) || n < 1 || n > v.groupSize)
        )
          throw new Error(
            `The rule must list whole numbers between 1 and ${v.groupSize}`,
          );
        return { op: "shuffle", params: { rule, groupSize: v.groupSize } };
      }
      return {
        op: "shuffle-preset",
        params: { preset: v.preset, stacks: v.stacks },
      };
    },
  });
}

function insertBlankDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Insert blank pages…",
    okLabel: "Insert",
    fields: [
      {
        type: "select",
        name: "at",
        label: "Where",
        options: [
          ["end", "At the end"],
          ["start", "At the beginning"],
          ["before", "Before page…"],
          ["after", "After page…"],
          ["every", "After every N pages"],
        ],
        value: "end",
      },
      {
        type: "number",
        name: "pageNumber",
        label: "Page number (for before / after)",
        min: 1,
        step: 1,
        value: app.session?.view.page ?? 1,
      },
      {
        type: "number",
        name: "afterEvery",
        label: "N (for after every N pages)",
        min: 1,
        step: 1,
        value: 1,
      },
      {
        type: "number",
        name: "count",
        label: "Number of blank pages",
        min: 1,
        max: 1000,
        step: 1,
        value: 1,
      },
      {
        type: "sheet",
        name: "size",
        label: "Blank page size",
        same: true,
        sameLabel: "Same as the first page",
        value: "same",
        span: 2,
      },
    ],
    build: (v) => ({
      op: "insert-blank",
      params: {
        at: v.at === "every" ? "end" : v.at,
        pageIndex: Math.max(0, Math.round(v.pageNumber) - 1),
        count: v.count,
        size: v.size,
        afterEvery: v.at === "every" ? v.afterEvery : 0,
      },
    }),
  });
}

function fillMultipleDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Fill to a multiple of pages…",
    okLabel: "Fill",
    intro:
      "Adds blank pages at the end until the page count is a multiple of the number below (4 for booklets, 8 or 16 for signatures).",
    fields: [
      {
        type: "number",
        name: "multiple",
        label: "Multiple of",
        min: 1,
        max: 128,
        step: 1,
        value: 4,
      },
    ],
    build: (v) => ({ op: "fill-multiple", params: { multiple: v.multiple } }),
  });
}

function duplicateDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Duplicate pages…",
    okLabel: "Duplicate",
    fields: [
      {
        type: "pages",
        name: "pageIndices",
        label: "Pages to duplicate",
        value: "current",
        span: "all",
      },
      {
        type: "number",
        name: "copies",
        label: "Extra copies of each page",
        min: 1,
        max: 500,
        step: 1,
        value: 1,
      },
      {
        type: "select",
        name: "together",
        label: "Place the copies",
        options: [
          ["true", "Right after the original"],
          ["false", "At the end of the document"],
        ],
        value: "true",
      },
    ],
    build: (v) => ({
      op: "duplicate",
      params: {
        pageIndices: v.pageIndices,
        copies: v.copies,
        together: v.together === "true",
      },
    }),
  });
}

// ---- page geometry ---------------------------------------------------------------------------------------------

function trimShiftDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Trim and shift…",
    intro:
      "Trims the page edges (making the pages smaller) and/or moves the content. Use different shifts for odd and even pages to make room for a binding margin.",
    fields: [
      { type: "section", label: "Trim" },
      {
        type: "number",
        name: "top",
        label: "Top",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "bottom",
        label: "Bottom",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "left",
        label: "Left",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "right",
        label: "Right",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "checkbox",
        name: "resize",
        label:
          "Make the pages smaller by the trimmed amount (otherwise only the content moves)",
        value: true,
        span: "all",
      },
      { type: "section", label: "Shift content" },
      {
        type: "select",
        name: "mode",
        label: "Shift",
        options: [
          ["same", "Same for all pages"],
          ["oddeven", "Different for odd and even pages"],
        ],
        value: "same",
        span: 2,
      },
      {
        type: "number",
        name: "x",
        label: "Horizontal (+ right)",
        unit: true,
        value: 0,
      },
      {
        type: "number",
        name: "y",
        label: "Vertical (+ up)",
        unit: true,
        value: 0,
      },
      {
        type: "number",
        name: "ex",
        label: "Even pages: horizontal",
        unit: true,
        value: 0,
      },
      {
        type: "number",
        name: "ey",
        label: "Even pages: vertical",
        unit: true,
        value: 0,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "trim-shift",
      params: {
        pageIndices: v.pageIndices,
        trim: { top: v.top, right: v.right, bottom: v.bottom, left: v.left },
        resize: v.resize,
        ...(v.mode === "oddeven"
          ? { oddShift: { x: v.x, y: v.y }, evenShift: { x: v.ex, y: v.ey } }
          : { shift: { x: v.x, y: v.y } }),
      },
    }),
  });
}

function adjustSizeDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Adjust page sizes…",
    intro: "Changes the page size, scaling or centring the existing content.",
    fields: [
      {
        type: "sheet",
        name: "size",
        label: "New page size",
        value: "A4",
        span: 2,
      },
      {
        type: "select",
        name: "orientation",
        label: "Orientation",
        options: [
          ["auto", "Match each page (portrait or landscape)"],
          ["fixed", "As chosen above"],
        ],
        value: "auto",
      },
      {
        type: "select",
        name: "mode",
        label: "Content",
        options: [
          ["fit", "Scale to fit (keep proportions)"],
          ["fill", "Scale to fill (may crop)"],
          ["center", "Do not scale"],
          ["stretch", "Stretch to the new size"],
        ],
        value: "fit",
      },
      {
        type: "select",
        name: "align",
        label: "Align",
        options: [
          ["center", "Centre"],
          ["left", "Left"],
          ["right", "Right"],
          ["top", "Top"],
          ["bottom", "Bottom"],
        ],
        value: "center",
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "adjust-size",
      params: {
        pageIndices: v.pageIndices,
        size: v.size,
        mode: v.mode,
        orientation: v.orientation === "auto" ? "auto" : "fixed",
        align: v.align,
      },
    }),
  });
}

function mirrorDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Mirror pages…",
    intro:
      "Flips the page content, for example for printing on transfer paper or film.",
    fields: [
      {
        type: "select",
        name: "axis",
        label: "Mirror",
        options: [
          ["horizontal", "Left to right"],
          ["vertical", "Top to bottom"],
          ["both", "Both (same as rotating 180°)"],
        ],
        value: "horizontal",
        span: 2,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "mirror",
      params: { pageIndices: v.pageIndices, axis: v.axis },
    }),
  });
}

function rotateContentDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Rotate page content…",
    intro:
      "Rotates the content itself (unlike Organize pages, which only sets a display rotation).",
    fields: [
      {
        type: "select",
        name: "angle",
        label: "Rotate",
        options: [
          ["90", "90° counter-clockwise"],
          ["270", "90° clockwise"],
          ["180", "180°"],
        ],
        value: "270",
        span: 2,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "rotate-content",
      params: { pageIndices: v.pageIndices, angle: Number(v.angle) },
    }),
  });
}

function splitDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Split pages…",
    intro:
      "Cuts each page into two or four pages, for example to separate scanned spreads.",
    fields: [
      {
        type: "select",
        name: "mode",
        label: "Split",
        options: [
          ["vertical", "Into left and right halves"],
          ["horizontal", "Into top and bottom halves"],
          ["quad", "Into four quarters"],
        ],
        value: "vertical",
      },
      {
        type: "select",
        name: "order",
        label: "Order (left/right)",
        options: [
          ["ltr", "Left page first"],
          ["rtl", "Right page first"],
        ],
        value: "ltr",
      },
      {
        type: "number",
        name: "gutter",
        label: "Gutter to discard in the middle",
        unit: true,
        min: 0,
        value: 0,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "split",
      params: {
        pageIndices: v.pageIndices,
        mode: v.mode,
        order: v.order,
        gutter: v.gutter,
      },
    }),
  });
}

function tileDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Tile pages…",
    intro:
      "Cuts large pages into tiles of a printable size (posters), with an overlap for gluing.",
    fields: [
      { type: "sheet", name: "tile", label: "Tile size", value: "A4", span: 2 },
      {
        type: "number",
        name: "overlap",
        label: "Overlap",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "scale",
        label: "Enlarge the page first",
        percent: true,
        min: 1,
        max: 10000,
        value: 1,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "tile",
      params: {
        pageIndices: v.pageIndices,
        tile: v.tile,
        overlap: v.overlap,
        scale: v.scale,
      },
    }),
  });
}

function pageBoxesDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Page boxes…",
    intro:
      "Sets the crop, trim, bleed, art or media box, either by insetting the media box or with explicit values.",
    fields: [
      {
        type: "select",
        name: "box",
        label: "Box",
        options: [
          ["crop", "CropBox (what viewers show)"],
          ["trim", "TrimBox (finished page)"],
          ["bleed", "BleedBox"],
          ["art", "ArtBox"],
          ["media", "MediaBox"],
        ],
        value: "crop",
      },
      {
        type: "select",
        name: "mode",
        label: "Set",
        options: [
          ["insets", "By insetting the MediaBox"],
          ["values", "To explicit values"],
          ["remove", "Remove the box"],
        ],
        value: "insets",
      },
      { type: "section", label: "Insets from the media box" },
      {
        type: "number",
        name: "top",
        label: "Top",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "bottom",
        label: "Bottom",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "left",
        label: "Left",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "right",
        label: "Right",
        unit: true,
        min: 0,
        value: 0,
      },
      { type: "section", label: "Explicit values" },
      { type: "number", name: "x", label: "X", unit: true, value: 0 },
      { type: "number", name: "y", label: "Y", unit: true, value: 0 },
      {
        type: "number",
        name: "w",
        label: "Width",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "h",
        label: "Height",
        unit: true,
        min: 0,
        value: 0,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => {
      if (v.mode === "values" && !(v.w > 0 && v.h > 0))
        throw new Error("Enter the width and height of the box");
      return {
        op: "page-boxes",
        params: {
          pageIndices: v.pageIndices,
          box: v.box,
          remove: v.mode === "remove",
          ...(v.mode === "values"
            ? { values: [v.x, v.y, v.w, v.h] }
            : v.mode === "insets"
              ? {
                  insets: {
                    top: v.top,
                    right: v.right,
                    bottom: v.bottom,
                    left: v.left,
                  },
                }
              : {}),
        },
      };
    },
  });
}

async function pageInfoDialog(app) {
  const session = app.session;
  if (!session) return;
  const u = units(app);
  let info;
  try {
    info = await impose.pageInfo(await session.flush());
  } catch (err) {
    app.reportError(err, "Page info");
    return;
  }
  const box = (b) => (b ? b.map((n) => u.fmt(n)).join(" ") : "—");
  const content = document.createElement("div");
  content.innerHTML = `<div class="impose-toolbar"><span class="muted">${info.length} page${info.length === 1 ? "" : "s"}; sizes in ${u.unit}, boxes as x y width height</span><span class="spacer"></span><button class="btn" data-csv>${icon("download")} Save as CSV…</button></div>
    <div class="impose-table-wrap"><table class="impose-table"><thead><tr><th>Page</th><th>Width</th><th>Height</th><th>Orientation</th><th>Rotation</th><th>MediaBox</th><th>CropBox</th><th>TrimBox</th><th>BleedBox</th><th>ArtBox</th></tr></thead><tbody></tbody></table></div>`;
  const tbody = content.querySelector("tbody");
  for (const p of info) {
    const tr = document.createElement("tr");
    if (p.index === session.view.page - 1) tr.className = "current";
    tr.innerHTML = `<td>${p.index + 1}</td><td>${u.fmt(p.width)}</td><td>${u.fmt(p.height)}</td><td>${p.orientation}</td><td>${p.rotation}°</td><td>${box(p.mediaBox)}</td><td>${box(p.cropBox)}</td><td>${box(p.trimBox)}</td><td>${box(p.bleedBox)}</td><td>${box(p.artBox)}</td>`;
    tbody.appendChild(tr);
  }
  content.querySelector("[data-csv]").addEventListener("click", async () => {
    const target = await bridge.saveFileDialog({
      defaultPath: session.name.replace(/\.pdf$/i, "") + "-pages.csv",
      title: "Save page info",
      filters: CSV_FILTERS,
    });
    if (!target) return;
    const rows = [
      [
        "page",
        `width_${u.unit}`,
        `height_${u.unit}`,
        "orientation",
        "rotation",
        "mediabox",
        "cropbox",
        "trimbox",
        "bleedbox",
        "artbox",
      ],
    ];
    for (const p of info)
      rows.push([
        p.index + 1,
        u.fmt(p.width),
        u.fmt(p.height),
        p.orientation,
        p.rotation,
        box(p.mediaBox),
        box(p.cropBox),
        box(p.trimBox),
        box(p.bleedBox),
        box(p.artBox),
      ]);
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    try {
      await bridge.writeFile(target, new TextEncoder().encode(csv));
      app.dialogs.toast("Page info saved", { kind: "success", timeout: 1800 });
    } catch (err) {
      app.reportError(err, "Could not save the CSV file");
    }
  });
  await app.dialogs.open({
    title: `Page info — ${session.name}`,
    content,
    className: "wide impose-dialog",
    buttons: [{ label: "Close", value: true, primary: true }],
  });
}

// ---- stick-on text, tape, marks ------------------------------------------------------------------------------------

const TEXT_PRESETS = {
  numbers: {
    title: "Page numbers…",
    text: "{page}",
    position: "bottom-center",
    size: 11,
  },
  bates: {
    title: "Bates numbers…",
    text: "{bates}",
    position: "bottom-right",
    size: 9,
  },
  text: { title: "Stick on text…", text: "", position: "top-center", size: 11 },
};

function stickTextDialog(app, state, presetName) {
  const preset = TEXT_PRESETS[presetName] ?? TEXT_PRESETS.text;
  const positions = [
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ].map((p) => [p, p.replace("-", " ")]);
  return imposeDialog(app, state, {
    title: preset.title,
    intro:
      "Tokens: {page} {pages} {n} (a counter from the start number) {bates} {date} {time} {file}; add :roman, :ROMAN, :alpha, :ALPHA or a digit count, e.g. {page:roman} or {bates:8}.",
    fields: [
      {
        type: "text",
        name: "text",
        label: "Text",
        value: preset.text,
        placeholder: "Page {page} of {pages}",
        span: 2,
      },
      {
        type: "select",
        name: "position",
        label: "Position",
        options: positions,
        value: preset.position,
      },
      {
        type: "select",
        name: "oddEven",
        label: "Apply to",
        options: [
          ["all", "All selected pages"],
          ["odd", "Odd pages only"],
          ["even", "Even pages only"],
        ],
        value: "all",
      },
      {
        type: "number",
        name: "margin",
        label: "Distance from the edge",
        unit: true,
        min: 0,
        value: 18,
      },
      {
        type: "number",
        name: "offsetX",
        label: "Horizontal offset (+ right)",
        unit: true,
        value: 0,
      },
      {
        type: "number",
        name: "offsetY",
        label: "Vertical offset (+ up)",
        unit: true,
        value: 0,
      },
      {
        type: "select",
        name: "font",
        label: "Font",
        options: Object.keys(impose.FONTS).map((f) => [f, f]),
        value: "Helvetica",
      },
      {
        type: "number",
        name: "size",
        label: "Size (pt)",
        min: 1,
        max: 500,
        value: preset.size,
      },
      { type: "color", name: "color", label: "Colour", value: "#000000" },
      {
        type: "select",
        name: "rotation",
        label: "Rotation",
        options: [
          ["0", "0°"],
          ["90", "90°"],
          ["180", "180°"],
          ["270", "270°"],
        ],
        value: "0",
      },
      {
        type: "checkbox",
        name: "bg",
        label: "White background behind the text",
        value: false,
      },
      { type: "section", label: "Numbering" },
      {
        type: "number",
        name: "startNumber",
        label: "Start {n} at",
        min: -1000000,
        step: 1,
        value: 1,
      },
      {
        type: "text",
        name: "batesPrefix",
        label: "Bates prefix",
        value: "",
        placeholder: "e.g. ABC-",
      },
      {
        type: "number",
        name: "batesStart",
        label: "Bates start number",
        min: 0,
        step: 1,
        value: 1,
      },
      {
        type: "number",
        name: "batesDigits",
        label: "Bates digits",
        min: 1,
        max: 12,
        step: 1,
        value: 6,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => {
      if (!String(v.text).trim()) throw new Error("Enter the text to place");
      return {
        op: "stick-text",
        params: {
          pageIndices: v.pageIndices,
          text: v.text,
          position: v.position,
          oddEven: v.oddEven,
          margin: v.margin,
          offsetX: v.offsetX,
          offsetY: v.offsetY,
          font: v.font,
          size: v.size,
          color: v.color,
          rotation: Number(v.rotation),
          startNumber: v.startNumber,
          batesPrefix: v.batesPrefix,
          batesStart: v.batesStart,
          batesDigits: v.batesDigits,
          background: v.bg ? "#ffffff" : null,
          file: app.session?.name ?? "",
        },
      };
    },
  });
}

function tapeDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Masking tape…",
    intro:
      "Covers part of the page with an opaque rectangle (the content underneath stays in the file; flatten or export images to remove it for good).",
    fields: [
      {
        type: "select",
        name: "mode",
        label: "Tape",
        options: [
          ["edge", "Along an edge"],
          ["rect", "A rectangle"],
        ],
        value: "edge",
        span: 2,
      },
      {
        type: "select",
        name: "edge",
        label: "Edge",
        options: [
          ["top", "Top"],
          ["bottom", "Bottom"],
          ["left", "Left"],
          ["right", "Right"],
        ],
        value: "top",
      },
      {
        type: "number",
        name: "depth",
        label: "Depth from the edge",
        unit: true,
        min: 0,
        value: 36,
      },
      { type: "section", label: "Rectangle (from the bottom-left corner)" },
      { type: "number", name: "x", label: "X", unit: true, value: 0 },
      { type: "number", name: "y", label: "Y", unit: true, value: 0 },
      {
        type: "number",
        name: "w",
        label: "Width",
        unit: true,
        min: 0,
        value: 0,
      },
      {
        type: "number",
        name: "h",
        label: "Height",
        unit: true,
        min: 0,
        value: 0,
      },
      { type: "color", name: "color", label: "Colour", value: "#ffffff" },
      { type: "pages", name: "pageIndices", value: "current", span: "all" },
    ],
    build: (v) => {
      if (v.mode === "edge" && !(v.depth > 0))
        throw new Error("Enter how deep the tape reaches from the edge");
      if (v.mode === "rect" && !(v.w > 0 && v.h > 0))
        throw new Error("Enter the width and height of the rectangle");
      return {
        op: "tape",
        params: {
          pageIndices: v.pageIndices,
          color: v.color,
          ...(v.mode === "edge"
            ? { fromEdges: { edge: v.edge, depth: v.depth } }
            : { rect: [v.x, v.y, v.w, v.h] }),
        },
      };
    },
  });
}

function marksDialog(app, state) {
  return imposeDialog(app, state, {
    title: "Printer's marks…",
    intro:
      "Enlarges the pages by a margin and draws crop marks, registration targets, fold marks, colour bars and a label in it.",
    fields: [
      {
        type: "number",
        name: "margin",
        label: "Margin added around the page",
        unit: true,
        min: 0,
        value: 36,
      },
      {
        type: "checkbox",
        name: "grow",
        label: "Enlarge the pages (otherwise draw inside the page)",
        value: true,
      },
      { type: "checkbox", name: "cropMarks", label: "Crop marks", value: true },
      {
        type: "checkbox",
        name: "registration",
        label: "Registration marks",
        value: true,
      },
      {
        type: "checkbox",
        name: "colorBars",
        label: "Colour bars",
        value: true,
      },
      {
        type: "checkbox",
        name: "foldMarks",
        label: "Fold marks (centre)",
        value: false,
      },
      {
        type: "text",
        name: "label",
        label: "Label",
        value: "{file} — page {page} of {pages} — {date} {time}",
        span: 2,
      },
      {
        type: "number",
        name: "length",
        label: "Mark length",
        unit: true,
        min: 0,
        value: 18,
      },
      {
        type: "number",
        name: "offset",
        label: "Mark offset from the page",
        unit: true,
        min: 0,
        value: 6,
      },
      {
        type: "number",
        name: "lineWidth",
        label: "Line width (pt)",
        min: 0.1,
        max: 10,
        value: 0.5,
      },
      { type: "pages", name: "pageIndices", span: "all" },
    ],
    build: (v) => ({
      op: "marks",
      params: {
        pageIndices: v.pageIndices,
        margin: v.margin,
        grow: v.grow,
        cropMarks: v.cropMarks,
        registration: v.registration,
        colorBars: v.colorBars,
        foldMarks: v.foldMarks,
        label: v.label,
        length: v.length,
        offset: v.offset,
        lineWidth: v.lineWidth,
        file: app.session?.name ?? "",
      },
    }),
  });
}

// ---- sample document, sheet sizes --------------------------------------------------------------------------------------

async function sampleDialog(app) {
  const form = buildForm(app, [
    {
      type: "number",
      name: "pages",
      label: "Number of pages",
      min: 1,
      max: 2000,
      step: 1,
      value: 16,
    },
    { type: "sheet", name: "size", label: "Page size", value: "A4" },
    {
      type: "text",
      name: "label",
      label: "Label on each page",
      value: "Page {page} of {pages}",
      span: 2,
    },
    {
      type: "checkbox",
      name: "colored",
      label: "Coloured backgrounds",
      value: true,
      span: "all",
    },
  ]);
  let values;
  const ok = await app.dialogs.open({
    title: "Create sample document",
    content: form.el,
    className: "impose-dialog",
    width: 560,
    buttons: [
      { label: "Cancel", value: null },
      { label: "Create", value: true, primary: true },
    ],
    validate: () => {
      try {
        values = form.values();
        return true;
      } catch (err) {
        app.dialogs.toast(err.message, { kind: "error" });
        return false;
      }
    },
  });
  if (!ok) return;
  try {
    const bytes = await impose.createSampleDocument(values);
    const session = await app.tabs.open({
      bytes,
      name: `Sample ${values.pages} pages.pdf`,
    });
    if (session) {
      session.opsDirty = true;
      app.emit("doc:dirty", { session, dirty: true });
    }
  } catch (err) {
    app.reportError(err, "Could not create the sample document");
  }
}

async function sheetSizesDialog(app) {
  const u = units(app);
  const sizes = (app.settings.customSheetSizes ?? []).map((s) => ({ ...s }));
  const content = document.createElement("div");
  content.innerHTML = `<p class="muted" style="margin:0 0 8px">Custom sheet sizes appear in every sheet-size list next to the built-in ones (${Object.keys(impose.SHEET_SIZES).join(", ")}).</p>
    <div class="impose-list" data-list></div>
    <div class="impose-form" style="margin-top:10px">
      <label class="field"><span>Name</span><input class="input" type="text" data-name placeholder="e.g. Poster"></label>
      <label class="field"><span>Width (${u.unit})</span><input class="input" type="number" step="any" min="0" data-w></label>
      <label class="field"><span>Height (${u.unit})</span><input class="input" type="number" step="any" min="0" data-h></label>
      <button class="btn" data-add style="height:32px">${icon("plus")} Add size</button>
    </div>`;
  const list = content.querySelector("[data-list]");
  const render = () => {
    list.replaceChildren();
    if (!sizes.length)
      list.innerHTML =
        '<div class="impose-list-empty">No custom sizes yet.</div>';
    sizes.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "impose-list-row";
      row.innerHTML = `<span class="grow"></span><span class="muted"></span><button class="tb-button" data-remove title="Remove">${icon("close")}</button>`;
      row.querySelector(".grow").textContent = s.name;
      row.querySelector(".muted").textContent =
        `${u.fmt(s.width)} × ${u.fmt(s.height)} ${u.unit}`;
      row.querySelector("[data-remove]").addEventListener("click", () => {
        sizes.splice(i, 1);
        render();
      });
      list.appendChild(row);
    });
  };
  content.querySelector("[data-add]").addEventListener("click", () => {
    const name = content.querySelector("[data-name]").value.trim();
    const w = u.toPt(content.querySelector("[data-w]").value),
      h = u.toPt(content.querySelector("[data-h]").value);
    if (!name)
      return app.dialogs.toast("Enter a name for the size", { kind: "error" });
    if (!(w > 0 && h > 0))
      return app.dialogs.toast("Enter a width and a height", { kind: "error" });
    const existing = sizes.findIndex(
      (s) => s.name.toLowerCase() === name.toLowerCase(),
    );
    const entry = {
      name,
      width: Math.round(w * 100) / 100,
      height: Math.round(h * 100) / 100,
    };
    if (existing >= 0) sizes[existing] = entry;
    else sizes.push(entry);
    content.querySelector("[data-name]").value = "";
    content.querySelector("[data-w]").value = "";
    content.querySelector("[data-h]").value = "";
    render();
  });
  render();
  const ok = await app.dialogs.open({
    title: "Sheet sizes",
    content,
    className: "impose-dialog",
    width: 560,
    buttons: [
      { label: "Cancel", value: null },
      { label: "Save", value: true, primary: true },
    ],
  });
  if (!ok) return;
  await app.saveSettings({ customSheetSizes: sizes });
  app.dialogs.toast("Sheet sizes saved", { kind: "success", timeout: 1500 });
}

// ---- automation sequences ------------------------------------------------------------------------------------------------

function startRecording(app, state, name) {
  state.recording = { name, steps: [] };
  updateRecordingStatus(app, state);
  app.dialogs.toast(
    `Recording “${name}”: every imposition you apply is added to it`,
    { timeout: 3000 },
  );
  app.commands.invalidate();
  app.syncUiState?.();
}

async function stopRecording(app, state) {
  const rec = state.recording;
  if (!rec) return;
  state.recording = null;
  updateRecordingStatus(app, state);
  app.commands.invalidate();
  app.syncUiState?.();
  if (!rec.steps.length) {
    app.dialogs.toast("Recording stopped: nothing was recorded", {
      timeout: 2500,
    });
    return;
  }
  const list = (app.settings.imposeSequences ?? []).filter(
    (s) => s && s.name !== rec.name,
  );
  list.push({ name: rec.name, steps: rec.steps });
  await app.saveSettings({ imposeSequences: list });
  app.dialogs.toast(
    `Saved “${rec.name}” with ${rec.steps.length} step${rec.steps.length === 1 ? "" : "s"}`,
    {
      kind: "success",
      timeout: 3000,
      action: {
        label: "Sequences…",
        run: () => app.commands.run("impose:sequences", undefined, "toolbar"),
      },
    },
  );
}

function updateRecordingStatus(app, state) {
  if (!state.recording) {
    app.statusbar.clear("impose-rec");
    return;
  }
  const el = document.createElement("span");
  el.className = "impose-rec";
  el.innerHTML = `<span class="dot"></span><span></span>`;
  el.lastChild.textContent = `Recording “${state.recording.name}” (${state.recording.steps.length} step${state.recording.steps.length === 1 ? "" : "s"})`;
  el.title = "Click to stop recording";
  el.style.cursor = "pointer";
  el.addEventListener("click", () =>
    app.commands.run("impose:record", undefined, "statusbar"),
  );
  app.statusbar.set("impose-rec", el, { right: true });
}

function describeStep(step) {
  const label = OP_LABELS[step.op] ?? step.op;
  const p = step.params ?? {};
  const bits = [];
  if (p.pageIndices) bits.push(`pages ${formatPageRanges(p.pageIndices)}`);
  if (p.preset) bits.push(p.preset);
  if (p.text) bits.push(`“${p.text}”`);
  if (p.rows && p.cols) bits.push(`${p.rows}×${p.cols}`);
  if (p.multiple) bits.push(`of ${p.multiple}`);
  if (typeof p.sheet === "string" && p.sheet !== "auto") bits.push(p.sheet);
  if (p.size && typeof p.size === "string" && p.size !== "same")
    bits.push(p.size);
  return bits.length ? `${label} (${bits.join(", ")})` : label;
}

async function runSequence(app, state, arg) {
  const session = app.session;
  if (!session) return null;
  let steps, name;
  if (Array.isArray(arg?.steps)) {
    steps = arg.steps;
    name = arg.name ?? "Sequence";
  } else {
    const wanted = typeof arg === "string" ? arg : arg?.name;
    const found = (app.settings.imposeSequences ?? []).find(
      (s) => s.name === wanted,
    );
    if (!found) {
      app.dialogs.toast(`No sequence named “${wanted}”`, { kind: "error" });
      return null;
    }
    steps = found.steps;
    name = found.name;
  }
  if (!steps.length) return null;
  return app.edit.apply((bytes) => impose.runSequence(bytes, steps), {
    label: `Sequence: ${name}`,
    keepPosition: false,
    session,
  });
}

async function sequencesDialog(app, state) {
  const content = document.createElement("div");
  content.innerHTML = `<p class="muted" style="margin:0 0 8px">A sequence is a recorded list of imposition steps that can be replayed on any document. Start recording, apply the impositions you need, then stop recording to save them.</p>
    <div class="impose-toolbar" style="margin-bottom:8px">
      <button class="btn" data-act="record"></button>
      <button class="btn quiet" data-act="import">${icon("open")} Import…</button>
      <span class="spacer"></span>
      <span class="muted" data-count></span>
    </div>
    <div class="impose-list" data-list></div>`;
  const list = content.querySelector("[data-list]");
  const recordBtn = content.querySelector('[data-act="record"]');
  let closeFn = null;
  const sequences = () => app.settings.imposeSequences ?? [];
  const render = () => {
    recordBtn.innerHTML = state.recording
      ? `${icon("stop")} Stop recording “${esc(state.recording.name)}”`
      : `${icon("record")} Record new sequence…`;
    content.querySelector("[data-count]").textContent =
      `${sequences().length} saved`;
    list.replaceChildren();
    if (!sequences().length)
      list.innerHTML = '<div class="impose-list-empty">No sequences yet.</div>';
    sequences().forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "impose-list-row";
      row.innerHTML = `<span class="grow"></span><span class="muted"></span>
        <button class="btn" data-run ${app.session ? "" : "disabled"} title="Run on the current document">${icon("play")} Run</button>
        <button class="tb-button" data-edit title="Edit steps">${icon("edit")}</button>
        <button class="tb-button" data-export title="Export to a file">${icon("download")}</button>
        <button class="tb-button" data-delete title="Delete">${icon("trash")}</button>`;
      row.querySelector(".grow").textContent = s.name;
      row.querySelector(".muted").textContent =
        `${s.steps.length} step${s.steps.length === 1 ? "" : "s"}`;
      row.querySelector("[data-run]").addEventListener("click", async () => {
        closeFn?.(null);
        await runSequence(app, state, { name: s.name });
      });
      row.querySelector("[data-edit]").addEventListener("click", async () => {
        const edited = await editSequenceDialog(app, s);
        if (!edited) return;
        const next = sequences().slice();
        next[i] = edited;
        await app.saveSettings({ imposeSequences: next });
        render();
      });
      row.querySelector("[data-export]").addEventListener("click", async () => {
        const target = await bridge.saveFileDialog({
          defaultPath: `${s.name.replace(/[\\/:*?"<>|]+/g, "_")}.json`,
          title: "Export sequence",
          filters: JSON_FILTERS,
        });
        if (!target) return;
        try {
          await bridge.writeFile(
            target,
            new TextEncoder().encode(
              JSON.stringify(
                { folioSequence: 1, name: s.name, steps: s.steps },
                null,
                2,
              ),
            ),
          );
          app.dialogs.toast("Sequence exported", {
            kind: "success",
            timeout: 1800,
          });
        } catch (err) {
          app.reportError(err, "Could not export the sequence");
        }
      });
      row.querySelector("[data-delete]").addEventListener("click", async () => {
        const ok = await app.dialogs.confirm(
          `Delete the sequence “${s.name}”?`,
          { title: "Delete sequence", okLabel: "Delete", danger: true },
        );
        if (!ok) return;
        await app.saveSettings({
          imposeSequences: sequences().filter((x) => x !== s),
        });
        render();
      });
      list.appendChild(row);
    });
  };
  recordBtn.addEventListener("click", async () => {
    closeFn?.(null);
    await app.commands.run("impose:record", undefined, "dialog");
  });
  content
    .querySelector('[data-act="import"]')
    .addEventListener("click", async () => {
      const [path] = await bridge.openFileDialog({
        filters: JSON_FILTERS,
        title: "Import sequence",
      });
      if (!path) return;
      try {
        const data = JSON.parse(
          new TextDecoder().decode(await bridge.readFile(path)),
        );
        const steps = Array.isArray(data?.steps) ? data.steps : null;
        if (!steps || steps.some((st) => !impose.OPS[st?.op]))
          throw new Error("This file is not a Folio sequence");
        const name = String(
          data.name ||
            path
              .split(/[\\/]/)
              .pop()
              .replace(/\.json$/i, ""),
        );
        const next = sequences().filter((s) => s.name !== name);
        next.push({
          name,
          steps: steps.map((st) => ({ op: st.op, params: st.params ?? {} })),
        });
        await app.saveSettings({ imposeSequences: next });
        render();
      } catch (err) {
        app.reportError(err, "Could not import the sequence");
      }
    });
  render();
  await app.dialogs.open({
    title: "Automation sequences",
    content,
    className: "impose-dialog",
    width: 600,
    buttons: [{ label: "Close", value: true, primary: true }],
    onOpen: (_d, close) => {
      closeFn = close;
    },
  });
}

async function editSequenceDialog(app, sequence) {
  const steps = clone(sequence.steps);
  const content = document.createElement("div");
  content.innerHTML = `<label class="field"><span>Name</span><input class="input" type="text" data-name></label>
    <div class="impose-list" data-steps></div>
    <details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Advanced: edit as JSON</summary><textarea class="textarea" data-json rows="8" style="font-family:var(--mono);font-size:12px;margin-top:6px"></textarea></details>`;
  content.querySelector("[data-name]").value = sequence.name;
  const stepsEl = content.querySelector("[data-steps]");
  const json = content.querySelector("[data-json]");
  const render = () => {
    stepsEl.replaceChildren();
    if (!steps.length)
      stepsEl.innerHTML = '<div class="impose-list-empty">No steps.</div>';
    steps.forEach((st, i) => {
      const row = document.createElement("div");
      row.className = "impose-list-row";
      row.innerHTML = `<span class="muted">${i + 1}.</span><span class="grow"></span><button class="tb-button" data-up title="Move up">${icon("up")}</button><button class="tb-button" data-down title="Move down">${icon("down")}</button><button class="tb-button" data-remove title="Remove">${icon("close")}</button>`;
      row.querySelector(".grow").textContent = describeStep(st);
      row.querySelector("[data-up]").addEventListener("click", () => {
        if (i > 0) [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        render();
      });
      row.querySelector("[data-down]").addEventListener("click", () => {
        if (i < steps.length - 1)
          [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]];
        render();
      });
      row.querySelector("[data-remove]").addEventListener("click", () => {
        steps.splice(i, 1);
        render();
      });
      stepsEl.appendChild(row);
    });
    json.value = JSON.stringify(steps, null, 2);
  };
  json.addEventListener("change", () => {
    try {
      const parsed = JSON.parse(json.value);
      if (!Array.isArray(parsed) || parsed.some((st) => !impose.OPS[st?.op]))
        throw new Error('Each step needs a known "op"');
      steps.splice(
        0,
        steps.length,
        ...parsed.map((st) => ({ op: st.op, params: st.params ?? {} })),
      );
      render();
    } catch (err) {
      app.dialogs.toast(`Invalid JSON: ${err.message}`, { kind: "error" });
    }
  });
  render();
  const ok = await app.dialogs.open({
    title: `Edit sequence — ${sequence.name}`,
    content,
    className: "impose-dialog",
    width: 600,
    buttons: [
      { label: "Cancel", value: null },
      { label: "Save", value: true, primary: true },
    ],
  });
  if (!ok) return null;
  const name =
    content.querySelector("[data-name]").value.trim() || sequence.name;
  return { name, steps };
}
