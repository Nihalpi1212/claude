---
title: Install Pigment
description: Download Pigment for Windows 10 or 11, macOS or Linux from its GitHub releases, and open it the first time although the builds are not code-signed.
order: 10
verified: 0.5.0
---

Download Pigment from the [releases page](https://github.com/Nihalpi1212/claude/releases) on GitHub. Pigment's releases are the ones named "Pigment", with tags such as `pigment-v0.5.0`. In the file names below, `<version>` stands for the version number, for example `0.5.0`.

The builds are not code-signed, so your system warns you the first time you open Pigment. The steps for each system are below.

## Windows

Pigment needs Windows 10 or 11 on a 64-bit Intel or AMD PC.

1. Download `pigment-<version>-windows-x64.msi`.
2. Run it. If SmartScreen says "Windows protected your PC", choose **More info**, then **Run anyway**.
3. Follow the installer.

To run without installing, download `pigment-<version>-windows-x64-portable.zip` instead and unzip it. The portable copy keeps its settings in a `PigmentData` folder next to `pigment.exe`.

If Pigment 0.4 is installed, uninstall it first in **Settings › Apps**. The installer would put Pigment 0.5 in 0.4's folder but leave 0.4 in the list of installed apps, and 0.4's uninstaller, run later, deletes that folder with Pigment 0.5 in it. To keep 0.4, choose another folder on the installer's folder page instead.

## macOS

Pigment needs macOS 11 or later and runs on Apple silicon and Intel Macs.

1. Download `pigment-<version>-macos-universal.dmg`.
2. Open it and drag **Pigment** to Applications. This replaces Pigment 0.4 if it is there; move the old `Pigment.app` somewhere else first to keep it.
3. The app is not notarized by Apple. The first time, right-click (or Control-click) **Pigment** in Applications, choose **Open**, then **Open** again in the dialog. Or run once in Terminal: `xattr -dr com.apple.quarantine /Applications/Pigment.app`

The command-line tool is a separate download, `pigment-cli-<version>-macos-universal.zip`.

## Linux

Pigment runs on 64-bit Intel and AMD PCs with glibc 2.35 or later (for example Ubuntu 22.04 or later). Pick one file:

| Format | File | Notes |
|---|---|---|
| AppImage | `pigment-<version>-linux-x86_64.AppImage` | Needs no install: make it executable with `chmod +x` and run it. |
| Debian and Ubuntu | `pigment-<version>-linux-x86_64.deb` | Install with `sudo apt install ./pigment-<version>-linux-x86_64.deb`. |
| Tarball | `pigment-<version>-linux-x86_64.tar.gz` | Unpack it anywhere. |

The first time you run the AppImage, it adds its icon and menu entry under `~/.local/share`. Set `PHOTOCRAFT_NO_DESKTOP_INTEGRATION=1` to skip that. Run the AppImage with `--cli` to use the command-line tool.

On a Wayland session, files dropped on the Pigment window do not open yet. Use **File › Open…** instead, or copy the image in your file manager and paste it with Ctrl+V. To drag and drop, start Pigment under XWayland with `WAYLAND_DISPLAY= pigment`. Pigment shows the right command for your install in a notice until you dismiss it.

Other builds (Arm, Flatpak, RPM, FreeBSD, a web version) are not published yet.

## Check your download

`SHA256SUMS.txt` on the release lists a checksum for every file. On Linux or macOS, run `sha256sum -c SHA256SUMS.txt --ignore-missing` in the folder you downloaded to.

## Updates

Pigment never updates itself and makes no network request on its own. **Help › Check for Updates** opens the releases page in your browser.

## Next step

Open an image: [Open and save files](../guides/open-and-save-files.md).
