# Nib app icon

**Subject:** a stylised fountain-pen nib drawing a vector curve that ends in an anchor point.

**Style:** flat shapes with two soft gradients, hand-written SVG (no tracing), readable down to 16 px:
the nib's outline, breather hole and slit stay distinct at the smallest sizes.

**Palette:**

| Colour | Hex | Used for |
|---|---|---|
| Teal | `#16707a` → `#0a2f3a` | the tile (top to bottom) |
| Ink | `#0d3e48` | the nib's slit and breather hole |
| Paper | `#fbf3df` → `#e9d6a8` | the nib |
| Aqua | `#62e3d1` | the curve and its anchor |

**Tile:** `viewBox="0 0 512 512"`, a rounded square with `rx=112`, clipped. The macOS files add Apple's
transparent margin (tile = 824/1024 of the canvas); Windows and Linux use the tile edge to edge.

**Provenance:** original artwork drawn by hand for Nib by the Nib contributors; MIT OR Apache-2.0
(see `LICENSE.txt`). It replaces VectorCraft's icon, which Nib does not ship.

## Files

| File | What | Used by |
|---|---|---|
| `nib.svg` | master vector | source for everything below |
| `nib-small.svg` | the same artwork (it is already small) | `hicolor/scalable` |
| `nib-1024.png` | full tile, 1024 px | docs, store listings |
| `nib-macos-512.png` | tile with Apple margin, 512 px | runtime Dock icon (`apps/vectorcraft/src/titlebar.rs`) |
| `nib.icns` | macOS icon set, 16 to 1024 px | `cargo xtask bundle`, `packaging/macos/package.sh` (`CFBundleIconFile`) |
| `nib.ico` | Windows icon, 16 to 256 px | `apps/vectorcraft/build.rs` (embedded in `nib.exe`) |
| `hicolor/<size>/apps/io.github.nihalpi1212.nib.png` | Linux theme icons, 16 to 512 px; the 256 one is also the runtime icon on Windows and Linux, the 128 one the brand mark in the app bar and About box (`crates/ui-egui/src/brand.rs`) | `packaging/linux/io.github.nihalpi1212.nib.desktop` |
| `hicolor/scalable/apps/io.github.nihalpi1212.nib.svg` | Linux scalable icon | as above |

## How it reaches each OS

- **macOS:** the app sets the Dock / app-switcher icon at runtime (`ViewportBuilder::with_icon`); the
  `.app` carries `nib.icns`.
- **Windows:** `build.rs` embeds `nib.ico` and VERSIONINFO with `winresource` (taskbar, Start
  menu, Explorer, Alt-Tab); the runtime icon covers the title bar.
- **Linux:** install `packaging/linux/io.github.nihalpi1212.nib.desktop` to `share/applications/` and
  `hicolor/` to `share/icons/`. The app sets its Wayland app ID / X11 class to
  `io.github.nihalpi1212.nib`, so the dock matches the window to the launcher.

## Regenerate

Edit `nib.svg` (copy it to `nib-small.svg`), then run `packaging/icons.sh` (needs `resvg`;
`iconutil` on macOS for the `.icns`; elsewhere Pillow writes it:
`python3 -c "from PIL import Image; Image.open('mac-1024.png').save('nib.icns')"` from a 1024 px
render of the macOS variant). It writes every PNG and the `.ico` (via `cargo xtask ico`).
