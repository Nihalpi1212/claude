---
title: Pigment does not start
description: Pigment closes or crashes at startup on Windows PCs with Intel graphics (it picks a safer graphics mode after a crash) or on some older Intel Macs (no fix yet for Macs patched with OpenCore Legacy Patcher).
order: 30
verified: 0.5.0
---

On Windows, if Pigment closed while it was starting, start it again: it picks a safer graphics mode after a crash. On an older Intel Mac that shows a `Device(Lost)` error and was patched with OpenCore Legacy Patcher, there is no fix yet.

## Symptoms

- Windows with Intel graphics (for example Intel UHD Graphics 630): Pigment closes or crashes right after you start it. Windows Event Viewer shows an application error in `igvk64.dll` with exception `0xc0000005`.
- Intel Mac: the app icon bounces in the Dock and the app disappears. Started from Terminal, it prints `Error: Wgpu(RequestDeviceError(RequestDeviceError { inner: Core(Device(Lost)) }))`.

## Fix

### Windows

1. Start Pigment again. Double-clicking its icon or a `.pigment` file works. Pigment notes that the last start did not finish and uses the next safer graphics mode this time:
   - A start on Vulkan is followed by one on DirectX 12.
   - A start on DirectX 12 is followed by one on the CPU. The CPU mode does not depend on the graphics driver.
2. If it started, nothing more to do. Pigment remembers the mode that worked. You can see or reset it under **Edit › Preferences › Performance…**.

If Pigment still closes on every start, force DirectX 12 from PowerShell:

1. Open PowerShell in the folder that contains `pigment.exe`.
2. Run these three lines:

        $env:WGPU_BACKEND = "dx12"
        & .\pigment.exe
        Remove-Item Env:WGPU_BACKEND

The last line clears the setting so later launches use the default again. You need the first two lines each time you start Pigment this way. While `WGPU_BACKEND` is set, Pigment uses it and does not step down to a safer mode by itself.

### Intel Mac

Pigment already skips a set of graphics checks that macOS could not compile on older Intel graphics, such as Intel Iris Pro on macOS Monterey. If it still fails, there is no fix yet. This is the case reported to PhotoCraft on Macs patched with OpenCore Legacy Patcher, where setting `WGPU_BACKEND`, `--safe-gpu` and `PHOTOCRAFT_CPU_CANVAS=1` did not change the error ([PhotoCraft issue 1859](https://github.com/storytold/photocraft/issues/1859)).

## Why this happens

On Windows, Pigment draws with your graphics driver. Intel's Vulkan driver (`igvk64.dll`) can crash on some PCs, and DirectX 12 avoids it, so Pigment prefers DirectX 12 on Intel graphics. Before it opens the window, it writes a small file called `gpu-starting.json` in its settings folder and deletes it once the first frames are drawn. A start that crashed leaves the file behind, and the next start reads it and moves to the next safer mode.

## Still stuck?

See [Get help with a problem](get-help.md). Say which graphics card you have, which Pigment version you use and how you started it. Add one of these:

- If you can open Pigment: the text from **Help › System Info…**.
- If Pigment does not open at all: the log file `pigment.log`, plus the faulting module and exception code from Event Viewer on Windows. Pigment keeps it in a `logs` folder inside its settings folder:
  - Windows: `%APPDATA%\Pigment\logs\pigment.log`
  - macOS: `~/Library/Application Support/Pigment/logs/pigment.log`
  - Linux: `~/.config/pigment/logs/pigment.log`
  - Portable copy (a `portable.txt` file next to the program): the `PigmentData\logs` folder next to the program.

  Every start moves the previous log to `pigment.1.log`. If you already started Pigment again after the crash, attach `pigment.1.log` too, because it holds the run that crashed.
