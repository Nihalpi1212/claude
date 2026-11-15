# Pigment app icon

**Subject:** a paint palette with four colour wells and a brush, on a tile that runs from orange
through magenta to violet. It is the icon Pigment 0.1 to 0.4 shipped (`build/icon.svg` of the
Electron app), so Pigment keeps its look on PhotoCraft. It replaces PhotoCraft's fox, which Pigment
does not ship (docs/FORK.md).

**Style:** flat shapes, two linear gradients and one soft drop shadow, hand-written SVG (no tracing).
The shadow is written as `feGaussianBlur` + `feOffset` + `feFlood` + `feComposite` + `feMerge`
(what `feDropShadow` stands for), so every SVG renderer draws it the same.

**Palette:**

| Colour | Hex | Used for |
|---|---|---|
| Orange → Magenta → Violet | `#fb923c` → `#e11d74` → `#6d28d9` | the tile (top left to bottom right) |
| White → Lilac | `#ffffff` → `#f1ecff` | the palette |
| Orange, Yellow, Green, Blue | `#f97316`, `#facc15`, `#22c55e`, `#3b82f6` | the colour wells |
| Deep violet, Grey, Ink | `#3b0764`, `#e5e7eb`, `#111827` | the brush |
| Magenta (app accent) | `#e11d74` | the accent colour in `crates/ui-egui/src/lib.rs` (`UPDATE_APP`) |

## Geometry

A 512-unit tile (`viewBox="0 0 512 512"`), rounded square with `rx=112`, clipped. The Pigment 0.4
artwork (a 896-unit tile at 64,64 in a 1024 canvas) is scaled into it by 512/896. The macOS renders
pad it onto Apple's 824/1024 icon grid; the Windows and Linux renders use the whole tile.

## Provenance

Original artwork by the Pigment contributors; MIT OR Apache-2.0 (see `LICENSE.txt`).

## Files

- `pigment.svg`: canonical master.
- `pigment-small.svg`: the same artwork (it is already small); also the hicolor scalable icon.
- `pigment-1024.png`: 1024 px render on the macOS grid (the runtime Dock icon, `apps/photocraft/src/app_icon.rs`).
- `pigment.icns`: macOS bundle icon (`CFBundleIconFile`, copied as `Pigment.icns`).
- `pigment.ico`: Windows icon, 16–256 px, embedded in `pigment.exe` and `pigment-cli.exe` by
  `apps/photocraft/build.rs` and `apps/photocraft-cli/build.rs`.
- `hicolor/<size>/apps/io.github.nihalpi1212.pigment.png` (16–512) and `hicolor/scalable/...svg`:
  Linux icon theme. The 256 one is also the runtime icon on Windows and Linux, the 128 one the brand
  mark in the app bar and About box (`crates/ui-egui/src/panels/brand.rs`).

The app also sets the window icon and Wayland app ID at runtime (`apps/photocraft/src/app_icon.rs`,
`main.rs`). On Windows the taskbar shows the icon of the Start Menu shortcut that launches the
exe, so the MSI's `<Icon Id>` keeps the `.exe` extension (ICE50); `app_icon.rs` documents the
details and tests the `.ico` sizes and the WiX icon references.

## Regenerate

Edit `pigment.svg` (copy it to `pigment-small.svg`), then run `packaging/icons.sh`. It needs
`resvg`, plus `iconutil` on macOS; the `.ico` is packed by `cargo xtask ico`. Elsewhere Pillow writes
the `.icns` from a 1024 px render of the macOS variant:
`python3 -c "from PIL import Image; Image.open('mac-1024.png').save('pigment.icns')"`.

The committed files were rendered with librsvg 2.50 through cairo (the same 512 tile, the same
macOS margin as `icons.sh`), the `.ico` packed exactly as `cargo xtask ico` packs it, and the
`.icns` written by Pillow, with the 16 and 32 px entries Pillow leaves out (`icp4`, `icp5`, PNG,
from the macOS render) added to it, as `iconutil` writes them.
