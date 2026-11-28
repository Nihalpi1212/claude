# PKG-port-U3: Pen tablets: Windows Ink tilt and rotation, the tip turning with the pen (#1301), the stylus wheel (rows 43, 44)

Built on `claude/pigment-photocraft` after `b7ea01f` (U1; PhotoCraft 057297b, craft-libs 18ffc07). Spec: PORTS-A §5.5
and §9 U3; REBASE-FU "U3" (it wins, except where the code said otherwise: see "Found in the code"). Seventh and last
package of group FU.

**Nothing here is confirmed on a real pen.** There is no tablet, Windows or Mac in this container. What runs here: the
pure mappings, the whole-app pipeline test for #1301 with AppKit values, the synthetic tests. The Windows-only and
macOS-only code was compiled for those targets (see "The other platforms"). The hardware checks are listed in
`docs/hardware-parity.md` ("Pigment: to check on hardware") and below.

**CI first.** At the start (about 09:20 UTC) the newest finished run was 46123186831 (`58a4854`, U2's last), **green**;
46129580711 (`b7ea01f`, U1) was in progress. Nothing red, so no CI commit. **The next engineer checks 46129580711 and
the runs on this package's commits first** (not waited for, as the brief says).

**REBASE-FU's line numbers** checked against the tree: `windows.rs` `POINTER_PEN_INFO` :90-98, `read_pen_flags` :219,
`handle_pointer_message` :204, `next_state` :178, `Monitor::install` :275 (all matched; U4's shell32 section is at the
end, kept); `apps/photocraft/src/tablet.rs` `sink` :33, `install_windows` :40, macOS install :111 (matched);
`main.rs` install calls :711/:715, WinTab :718-725 (shifted by U4/U2 lines by a few); `macos.rs` `read` :76-91 (matched);
`stylus.rs` `PenSample` :37-90, `record_point` :287, `stroke_points` :312 (matched); `dynamics.rs` :461-463 and
`control_angle` :477-494 (matched); `hardware-parity.md` :36-38, :42-46, :74-83 (matched).

## Commits (pushed)

(filled in below)

## Found in the code (where the spec and REBASE-FU were wrong)

1. **Feeding Windows Ink samples into the stylus feed would do nothing.** REBASE-FU's plan was a sink from the hooks
   into `StylusFeed` (`install_with_sink`, `install_windows(feed)`). But winit delivers a Windows Ink pen as touch
   events, and the framework (`craft-libs ui-contract/src/runtime/egui/input.rs` `pointer_read`, pinned, not ours to
   change) gives any pass with touch events the touch's force as the pointer's reading (`_ if touched =>
   touch_sample`), whatever the pen source holds. Upstream's own `Services::pen_end` doc says the same ("the feed
   carries no pen samples there"). So instead: the hooks keep the last reading (`windows::pen_pose`), the app hands
   it to the UI through a new `Services::pen_extras`, read once per frame, and `Stylus::record_pointer` adds its tilt and
   rotation to a reading that has none (`pen_extras::merge`). The pressure stays winit's (the same `POINTER_PEN_INFO`
   field, `/ 1024`), which also covers "keep winit's pressure when `PEN_MASK_PRESSURE` is clear". `install_windows`
   and `main.rs:715` are unchanged; the one new `main.rs` line sets `pen_extras`.
2. **#1301 is a sign error, not a dropped value.** The pipeline test showed the rotation reaching `paint.stroke` and
   the engine intact on macOS. Every platform reports the barrel rotation clockwise (W3C `twist`, Windows Ink's
   `rotation`, WinTab's `orTwist`, `photocraft_tablet::Sample`'s doc); the brush engine's angles are counter-clockwise
   (`control_angle`'s doc, the tip raster, Direction and Pen Tilt). `control_angle` added `p.rotation` as is, so the tip
   turned against the pen, which reads as "rotation not applied". Fixed: `Control::Rotation => -p.rotation`, and the
   same for Brush Projection in `dynamics.rs` and in the brush cursor (`brush_cursor.rs` `pose`). Two upstream tests
   asserted the old sign (+30°, +90°) and now expect −30°, −90°. The tablet-point-only read of `macos.rs:84` (REBASE's
   second candidate) is fine: a Wacom's mouse events carry the tablet-point subtype.
3. **Also found:** `lerp_pt` (the path walker between two stroke points) interpolated the rotation linearly, so 350° to
   10° swept through 180° (a 4:1 tip turned crosswise mid-segment). Now the shorter way round, as `pull` (smoothing)
   already did. The Mixer Brush's live interpolation (`engine/src/cmd/brush_cmds/mixer_live.rs:276`) has the same
   linear lerp; not changed (an engine file, and the Mixer Brush has no Rotation control path test here): a one-line
   follow-up.
4. **The wheel column already existed.** `paint.stroke`'s points already read an 8th value, `wheel` (default 1), and
   the params string already named it (`brush_cmds.rs:55`, `:1455`). So no engine format change: only the UI writes it
   now. The panic hunt was run anyway (the paint crate changed).
5. **The wheel cannot travel with the samples.** Neither `photocraft_tablet::Sample` (whose struct literals are in ~25
   upstream lines) nor the framework's `PointerSample` (`#[non_exhaustive]`, craft-libs) has a wheel. So the readers
   store the latest wheel in `photocraft_tablet::wheel` (an atomic), read with the Windows Ink pose through the same
   `pen_extras` service, once per frame. A wheel value is per frame, not per pointer move (the framework pairs pressure
   per move); an airbrush wheel moves slowly, so this is enough, but it is a difference from Photoshop.

## What was built

### `crates/tablet`

- `src/ink.rs` (new, pure, every platform): `PenInfo { flags, mask, pressure, rotation, tilt_x, tilt_y }`, the four
  `PEN_MASK_*` bits, `sample_from_pen_info(&PenInfo, eraser) -> Option<Sample>` (pressure `/1024` or 1 without the bit,
  tilt in degrees as given (Windows' sense is W3C's), rotation clockwise as given, absent fields neutral, sanitized;
  `None` when no bit is set), `PoseInput` and `next_pose` (the kept reading: a pen's down/update/enter replaces it, a
  non-pen pointer's clears it, the pen leaving clears it, up and another pointer leaving keep it).
- `src/windows.rs`: `read_pen_info` (the `GetPointerPenInfo` call; `read_pen_flags` now wraps it, `#[allow(dead_code)]`:
  nothing calls it, kept as REBASE asked), `POSE` (a `Mutex<Option<Sample>>`), `handle_pen_message` (calls upstream's
  `handle_pointer_message` with a flags reader that also keeps the info, then `next_pose`), `pen_pose()`. The two hooks
  call `handle_pen_message` with `read_pen_info`; `Monitor::drop` clears the reading.
- `src/wheel.rs` (new, pure): `set`/`get` of the latest wheel (NaN bits = none), `AppKitWheel` (a pen counts as having a
  wheel once its `tangentialPressure` was non-zero since it entered proximity: every pen reports 0 otherwise; a mouse
  or proximity event resets it; clamped to 0..1 as an airbrush wheel reports 0..1 of the -1..1 range).
- `src/appkit.rs`: `RawEvent::tangential`. `src/macos.rs`: `read` reads `tangentialPressure` on tablet point events;
  the monitor stores the wheel; the macOS test sets `TabletEventTangentialPressure` and reads it back.
- `src/wintab.rs`: `WheelPacket` (orientation and `tangent_pressure`), `Backend::Wheel`, opened only when the device
  has orientation axes **and** `DVC_TPRESSURE` (an airbrush), so a plain pen's context is opened exactly as before;
  its arms in the overlap calls, `poll` and `on_message`; `wheel_sample`; `poll` clears the wheel when no pen is in use.
- `src/lib.rs`: `pub mod ink; pub mod wheel;`.

### `crates/paint`

- `dynamics.rs`: the sign fix (`control_angle`, Brush Projection) and `lerp_pt`'s shorter-way rotation.
- `pen_rotation_tests.rs` (new).

### `crates/ui-egui`

- `pen_extras.rs` (new, `pub mod`): `PenExtras { pose: Option<[tilt_x, tilt_y, rotation]>, wheel: Option<f32> }`,
  `PenExtrasFn`, `PenState { extras, wheels }` (on `Stylus`, field `pigment`), `merge`, `refresh`.
- `input/stylus.rs`: `record_pointer` merges; `begin_stroke` clears and `record_point` records the wheel (1 for a mouse,
  a pen without a wheel, or Use Tablet Pressure off); `stroke_points` adds the 8th column (and so the pose and time
  columns) when any point's wheel is not 1. Strokes without a wheel are byte-for-byte what they were.
- `canvas/strokes.rs`: the live stroke's points get `sp.wheel` (two places: the feed and the release's rest).
- `canvas.rs`: `pen_extras::refresh(app)` beside the Use Tablet Pressure line.
- `tools/brush_cursor.rs`: Brush Projection's cursor turns the same way as the dabs.
- `services.rs`: `Services::pen_extras`.

### `apps/photocraft`

- `src/tablet.rs`: `pen_extras_service(wintab)` (Windows Ink's pose unless WinTab runs, as REBASE asked, plus the wheel),
  `ink_pose`, `extras`; `#[cfg(test)] mod rotation_tests;`.
- `src/main.rs`: `app.services.pen_extras = tablet::pen_extras_service(app.services.tablet_poll.is_some());`.

### Docs

- `docs/hardware-parity.md`: Tilt and Barrel rotation rows (Windows Ink yes, macOS #1301, all "not yet confirmed on
  hardware"), a new Stylus wheel row, the Windows paragraph, a rotation paragraph, the hardware check list, the
  summary line, a revision row, the header.
- `docs/parity/README.md`: the two pen rows ("Done in 0.6, not yet confirmed on hardware").
- `docs/FORK.md`: "Pen tablets: Windows Ink tilt and rotation, the tip turning with the pen, the stylus wheel".

## Spec rows

- **Row 43 / 44, Windows Ink tilt and rotation**: done (not confirmed on hardware).
- **#1301 macOS rotation**: done: the sign fix applies to every platform (macOS, Windows, X11, WinTab, the web), with
  the pipeline test. Hardware: the macOS direction depends on `NSEvent.rotation` being clockwise, as Chromium (the
  JavaScript app's runtime) treats it; Qt reads it as `360 − r` (counter-clockwise). If a Mac turns the tip the wrong
  way, negate the rotation in `appkit.rs` `State::sample` (one line) and flip the AppKit cases of the pipeline test.
- **Stylus wheel** (step 3): done for macOS and WinTab airbrushes (not confirmed on hardware). Windows Ink has none
  (`POINTER_PEN_INFO` has no field); X11 not done (the Wacom X driver's airbrush wheel is an "Abs Wheel" valuator:
  `xi.rs` could map it the same way; not asked); the web runner not done (`craft::behavior::PointerSample` has no wheel;
  `apps/photocraft-web` could call `photocraft_tablet::wheel::set` from `tangentialPressure`, but the tablet crate
  is desktop-only in that build: check before doing it). Took well under half a day once the engine column was found.
- **Native Wayland**: dropped (spec §8.1).
- **Hardware sign-off**: not done (no hardware). The list is below and in `docs/hardware-parity.md`.

## Hardware checks (not yet confirmed on hardware)

1. Windows Ink tilt (Wacom with Windows Ink on, or a Surface pen): the tip follows Pen Tilt; a finger stroke right
   after a pen stroke paints upright; after the pen leaves range a mouse stroke paints upright.
2. Windows Ink rotation (Art Pen, Windows Ink on): turning the barrel clockwise turns the tip clockwise.
3. Windows Ink pressure unchanged (winit's), including a pen that reports no pressure bit.
4. Windows WinTab mode: tilt and rotation as before; Windows Ink's reading stays out.
5. Windows WinTab with an airbrush: the wheel drives Stylus Wheel; a plain pen paints at a full wheel; the context still
   opens (a driver refusing the wheel packet would fail WinTab for airbrush owners: then fall back to `Oriented`).
6. macOS rotation (#1301): Art Pen barrel clockwise → tip clockwise (see the Qt note above).
7. macOS airbrush wheel: drives Stylus Wheel once turned; a plain pen paints at a full wheel.
8. The brush cursor with Brush Projection turns the same way as the dabs.

## Tests

New:
- `crates/tablet/src/ink.rs` (4): every field in degrees and the W3C sense; mask bits (garbage in unreported fields is
  never read, no pressure → neutral, nothing reported → `None`); out-of-range values clamped; the kept reading's life
  (pen, lift, finger, pen leaving, eraser, a pen with no axes).
- `crates/tablet/src/wheel.rs` (2): the stored wheel clamped, NaN/∞ = none; `AppKitWheel` (a plain pen has none, an
  airbrush once turned, back to 0, negative clamped, unrelated events keep, mouse and proximity reset).
- `crates/tablet/src/windows.rs` (1, **Windows only**, compiled not run): the hooks with a synthetic `POINTER_PEN_INFO`
  (enter, contact with the barrel flag, lift keeps, eraser end, a finger clears, a finger leaving keeps, the pen leaving
  clears).
- `crates/tablet/src/wintab.rs` (1, **Windows only**, compiled not run): the airbrush packet's sample and wheel.
- `crates/tablet/src/macos.rs` (an assertion in the existing test, **macOS only**, compiled not run): the
  tangential pressure read back.
- `crates/paint/src/pen_rotation_tests.rs` (3): a real dab's pixels lie down-right for 45° clockwise and up-right for
  315°, with the Rotation control and with Brush Projection; 350°→10° along a stroke stays within 10° of horizontal;
  the scalar Rotation control value is unchanged (a quarter turn = 0.25). The first fails without the fix (checked).
- `crates/ui-egui/src/pen_extras/tests.rs` (5): `merge` (winit's pressure stays; a reading with its own tilt keeps it;
  wild values sanitized); the wheel per point (mouse, NaN, out of range, none); **Windows Ink through the tool host**
  (the service's tilt and rotation land in `paint.stroke`'s points, no wheel column, a mouse after the pen paints
  upright); **the wheel as the 8th column** and the engine painting with it (Opacity on Stylus Wheel: the 0.25 end
  fainter than the 0.75 end); no service, Use Tablet Pressure off.
- `apps/photocraft/src/tablet/rotation_tests.rs` (1): **the #1301 pipeline**: AppKit mouse-down/up `RawEvent`s with
  rotation 45° and 315° → `appkit::State` → `sink` → the stylus feed → window pointer input on the whole app (egui_kittest,
  as upstream's pressure test) → `paint.stroke` (the committed points carry the rotation) → the painted 4:1 tip's
  pixels on the two diagonals, with the Rotation control and with Brush Projection. Fails without the fix (checked:
  "45° clockwise: down-right 0, up-right 1").
- `apps/photocraft/src/tablet.rs` `pen_extras_carry_the_pose_and_the_wheel` (1).

Changed upstream tests: `crates/paint/src/brush_tests.rs` `tilt_direction_and_rotation_drive_angle` (+30° → −30°) and
`brush_projection_foreshortens_along_tilt_and_turns_with_rotation` (+90° → −90°).

Results (nextest `--profile ci`, `TMPDIR=/dev/shm/pt`, CI's font and i18n dirs):
- `-p photocraft -p photocraft-tablet -p photocraft-paint` (whole) and `-p photocraft-ui-egui` filtered to
  `pen_extras|stylus|paint_tool|brush_cursor|brush_panel|brush_sections|strokes`, `--features heif --lib --bins --tests`:
  572 run, 571 passed; the one failure was my own pipeline test's assertion for the 0° case (it expected a rotation
  column a 0° stroke rightly has not), fixed; then `rotation_tests|tablet::` 9 passed.
- `-p photocraft-paint --lib --tests`: 247 passed (earlier run, before the ui work).
- `-p photocraft-engine --features photocraft-io/heif --lib --tests -E 'test(/brush|paint|stroke|mixer|retouch|pencil|eraser|smudge|tool_presets|tpl/)'`: 661 passed.
- Panic hunt (`cargo test -p photocraft-engine --features photocraft-io/heif --test panic_hunt -- --ignored`): 1 passed.
- Whole ui-egui suite (`-j 3 -p photocraft-ui-egui --features photocraft-io/heif --lib --bins --tests`): see below.
- `cargo fmt --all -- --check`; `cargo clippy --locked --features heif -p photocraft-tablet -p photocraft-paint
  -p photocraft-ui-egui -p photocraft --all-targets -- -D warnings`; `python3 scripts/pigment-rebrand.py --check`:
  clean. No crate, preference or panel command added, so `cargo xtask layers`/`panel-commands`/`scorecard` were not
  required (see below for what was run).

## Hooks into upstream files (all in FORK.md, "Pen tablets: …")

- `crates/tablet/src/lib.rs`: `pub mod ink;`, `pub mod wheel;`.
- `crates/tablet/src/windows.rs`: `read_pen_info`, `POSE`, `pose_slot`, `handle_pen_message`, `pen_pose` (new); the
  two hook lines; `read_pen_flags` wraps `read_pen_info`; `Monitor::drop` one line; one test.
- `crates/tablet/src/wintab.rs`: `WheelPacket`, `Backend::Wheel`, its install arm, four match arms, `wheel_sample`,
  the clear at the end of `poll`; one test.
- `crates/tablet/src/appkit.rs`: `RawEvent::tangential`.
- `crates/tablet/src/macos.rs`: `read`'s tangential line and literal; the monitor's wheel state and store; two test lines.
- `crates/paint/src/dynamics.rs`: `control_angle` Rotation, Brush Projection, `lerp_pt` rotation.
- `crates/paint/src/brush_tests.rs`: two expected angles.
- `crates/paint/src/lib.rs`: `#[cfg(test)] mod pen_rotation_tests;`.
- `crates/ui-egui/src/tools/brush_cursor.rs`: one line.
- `crates/ui-egui/src/input/stylus.rs`: field + constructor line, `record_pointer`, `begin_stroke`, `record_point`,
  `stroke_points` (the wheel column).
- `crates/ui-egui/src/canvas.rs`: one line. `crates/ui-egui/src/canvas/strokes.rs`: two lines.
- `crates/ui-egui/src/services.rs`: one field. `crates/ui-egui/src/lib.rs`: `pub mod pen_extras;`.
- `apps/photocraft/src/tablet.rs`: three functions, a test module line, one test. `apps/photocraft/src/main.rs`: one line.
- Docs: `docs/hardware-parity.md`, `docs/parity/README.md`, `docs/FORK.md`.

## The other platforms

(filled in below)

## For the next package

- **CI**: check 46129580711 (`b7ea01f`, U1) and the runs on this package's commits first.
- **Group FU is complete.** The group's review should run the hardware list above on the release dry run's machines if
  any have a pen; otherwise it stays "not yet confirmed on hardware" in the docs.
- `photocraft_tablet::wheel` is a process-wide latest value: anything else that reports a wheel (X11 "Abs Wheel", the
  web's `tangentialPressure`) only has to call `wheel::set` and clear it with `None` when the pen leaves.
- `Services::pen_extras` is the place for any other per-frame pen value the framework's `PointerSample` lacks.
- If the macOS rotation turns out counter-clockwise on hardware, the fix is one line in `appkit.rs` (negate in
  `State::sample`) plus the expected diagonals in `apps/photocraft/src/tablet/rotation_tests.rs`'s AppKit cases.
- Building the app's tests (`-p photocraft --bins`) after a ui-egui change takes about 10 minutes here; a test-only
  change in the app crate rebuilds in under a minute.
