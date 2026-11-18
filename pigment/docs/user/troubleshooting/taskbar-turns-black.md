---
title: The Windows taskbar turns black when Pigment is maximized
description: On Windows 11, an older PhotoCraft release could turn the taskbar black when maximized. Pigment includes the fix; if you still see it, switch on the system title bar and report it.
order: 10
verified: 0.5.0
---

Pigment 0.5 includes the fix for this problem. If the Windows taskbar still turns black or hides while Pigment is maximized, switch on the system title bar (below) and report it.

## Symptoms

- You maximize the Pigment window, or switch it to full screen, and the Windows taskbar turns completely black or is hidden.
- After you resize the window and maximize it again, a black bar the height of the taskbar stays at the bottom of the screen.

## Fix

1. Check your version with **Help › System Info…**, which starts with "Pigment" and the version. Pigment 0.5.0 and later include the fix.
2. If you still see the black taskbar, switch on **System title bar** under **Edit › Preferences › Interface…**, click **Apply** and restart Pigment. Windows then draws the title bar itself.

## Why this happens

Pigment draws its own title bar. When such a window was maximized, Windows sized it to cover the whole screen, taskbar included, took it for a full-screen app and dropped the taskbar's background. PhotoCraft, which Pigment is built on, fixed this by keeping a maximized window clear of the taskbar ([PhotoCraft issue 3144](https://github.com/storytold/photocraft/issues/3144)).

## Still stuck?

Report it with your Windows version and Pigment version; see [Get help with a problem](get-help.md).
