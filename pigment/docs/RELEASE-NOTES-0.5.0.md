## Pigment 0.5.0: Pigment on PhotoCraft

Pigment 0.5.0 is a new Pigment. Versions 0.1 to 0.4 were an Electron app written in JavaScript;
0.5.0 is built on [PhotoCraft](https://github.com/storytold/photocraft) 0.23.1, the open-source,
clean-room Photoshop reimplementation in pure Rust by the ArtCraft team and the PhotoCraft
contributors (MIT OR Apache-2.0). It keeps the name Pigment and its icon, and takes PhotoCraft's
editor almost unchanged: a native app with layers, masks, adjustment layers, layer styles, smart
objects and filters, type, vectors, brushes, real PSD/PSB files and a GPU compositor.

`pigment --version` prints `Pigment 0.5.0 (based on PhotoCraft 0.23.1)`.

### What changed from PhotoCraft

- **Pigment's name, icon and ids everywhere:** the binaries are `pigment` and `pigment-cli`, the
  application id is `io.github.nihalpi1212.pigment`, and settings, logs and crash recovery live in
  a `Pigment` folder (`~/.config/pigment` on Linux). Nothing is read from PhotoCraft's or ArtCraft's
  folders.
- **`.pigment` is the native extension.** It holds PhotoCraft's native format, so `.pcraft` files
  open too.
- **No network request on its own.** There is no update check at launch; Help › Check for Updates
  opens the releases page. The AppImage carries no update information.
- **AI agents:** Preferences › AI Integrations › **Let AI apps use this window** is Pigment's own
  switch (off by default; `pigment-cli mcp` then serves a session without a window, as before).
- Help, About and the start screen link to Pigment's issues, repository and releases, and to the
  upstream project.

The full list is in [`docs/FORK.md`](FORK.md).

### Known issues

- **Documents from Pigment 0.1 to 0.4 don't open yet.** Pigment recognises them and says "This file
  was saved by Pigment 0.4 or earlier. Opening these files is coming in a later update." Export them
  as PSD or PNG from Pigment 0.4 to bring them over now.
- The generative AI features and the other additions of Pigment 0.2 to 0.4 are not in 0.5.0 yet.
- Interface strings Pigment added (the new links, the credit line in About, the agents switch) are
  in English in every language.
- The builds are not code-signed (see the first-launch steps below).
- Everything PhotoCraft 0.23.1 lists as missing or in progress applies (its `ROADMAP.md`).
