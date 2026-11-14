# Photoshop conventions: shortcuts, Search, temporary tools, numeric fields, dialogs (0.4)

Package 16 of 0.4 (conventions-shortcuts-fields). The key changes themselves (Ctrl+F, Alt+Ctrl+F, Ctrl+Y, Alt+Ctrl+Z,
the export and stamp keys and the rest) are the skeleton's and listed in `docs/0.4/skeleton.md`; this file covers what
the package adds on top of them.

## User guide

### Edit > Toggle Last State (Alt+Ctrl+Z)

Undoes the last step. Pressed again right away, it redoes that step, so repeated presses flip between the last two
states to compare them (Photoshop's Alt+Ctrl+Z). After any other change it undoes that change first. In a text field it
undoes typing; in Select and Mask it is that workspace's own undo. It is never recorded into an action.

### Edit > Search… (Ctrl+F)

Opens a search box over the menus, the tools and the panels. Type a few letters of a command, a menu or a tool
("gaus blur", "adjust lev", "brush tool", "layers panel"); each result shows its menu path and shortcut, and results
that cannot run right now are dimmed. Up and Down move through the results, Enter or a click runs the selected one
(the search box closes first), Esc closes it. With nothing typed, the last ten choices are listed. A command run from
Search is recorded into an action like the menu item itself; Search is not.

### Numeric fields everywhere

Every number field of the app (dialogs, panels, the options bar) takes:

- **Arithmetic**: `100+50`, `200/4`, `3*12`, `(10+5)*2`. Type an operator after the number; Enter, Tab or clicking
  elsewhere works it out. Esc while typing an expression puts back what the field had.
- **Percentages**: `50%` is half of what the field had (or, in fields that say so, half of a reference such as the
  document size). In a field measured in % it is just 50.
- **Units**: in a field measured in pixels, `2in`, `5cm`, `30mm`, `72pt` are converted at the document's resolution
  (`2in` at 300 ppi is 600 px), and the other way round in fields measured in a length unit. Mixed entries such as
  `1in+10px` work.
- **Arrow keys**: Up and Down change the value by one step, with Shift by ten steps.
- **The mouse wheel** over the field being edited changes it by one step (Shift: ten).
- **Scrubby labels**: drag a field's label left or right to change the value (Shift: ten times faster, Alt: ten times
  finer). The cursor shows a double arrow over labels that scrub.
- An entry that is not valid leaves the field as it was.

Some fields also have a small ▾ button that shows a slider under the field.

### Temporary and spring-loaded tools

- **Space**: the Hand tool while held (as before). **Ctrl+Space**: the Zoom tool zooming in; **Alt+Space**: zooming
  out (Cmd+Space and Option+Space on macOS).
- **Ctrl** (Cmd) held: the Move tool, with any tool that does not use Ctrl itself (the type, pen, path and shape tools
  keep Ctrl for their own use; the Hand, Zoom and Rotate View tools keep theirs).
- **Alt** (Option) held with the Brush, Pencil, Color Replacement or Gradient tool: the Eyedropper, which picks the
  foreground colour. Tools that use Alt themselves (Clone Stamp and Healing Brush set their source, Dodge and Burn swap,
  the selection tools subtract) keep it.
- **Hold a tool's key** (for example V while painting): the tool is active while the key is held, and the previous tool
  comes back when you let go. A short press switches tools as before. Turn this off in Preferences > Tools and
  shortcuts > Spring-loaded tools (Ctrl and Alt then do not spring either).

### Tool switching

- A tool key picks the tool last used in its toolbox slot; Shift+key steps through the slot's tools.
- Preferences > Tools and shortcuts > **Use Shift key for tool switch**: when off, pressing the same key again steps
  through the slot's tools, as in Photoshop with that preference off.
- Alt-click on a toolbox button steps through its tools; a long press or a right-click shows them all (the flyout),
  with the slot's key.

### Dialogs

- **Move a dialog** by dragging its title bar. It opens there again next time (each dialog remembers its own place);
  double-click the title bar to put it back in the middle. Preferences > Tools and shortcuts > "Open moved dialogs in
  the middle again" forgets all the places.
- **The canvas stays visible** under a dialog (it is no longer dimmed) and can be navigated while the dialog is open:
  the mouse wheel over the canvas zooms or scrolls it, Space-drag pans it, and the zoom shortcuts (Ctrl+=, Ctrl+-,
  Ctrl+0, Ctrl+1) work, also from the View menu.
- A click on the canvas beside a dialog no longer cancels it (Photoshop's behaviour; the dialog shakes to show it is
  still open). Without an open document a click outside still closes the dialog.
- **Alt turns Cancel into Reset**: hold Alt and the Cancel button reads Reset; clicking it puts every setting back to
  what it was when the dialog opened, and the dialog stays open.

## Release notes (changed defaults and keys)

- Number fields evaluate arithmetic (`100+50`), percentages and units, step with Shift+arrow (×10) and the wheel, and
  their labels scrub.
- Holding Ctrl (Cmd) gives the Move tool and holding Alt with a painting tool the Eyedropper; holding a tool key
  switches to it only while held. Preferences > Tools and shortcuts turns this off.
- Ctrl+Space and Alt+Space zoom in and out (0.3 panned with Space whatever the modifiers).
- New preference: "Use Shift key for tool switch" (on by default, Pigment's 0.3 behaviour).
- Dialogs can be moved and remember where; the canvas under them is not dimmed any more and can be zoomed and panned;
  a click beside a dialog over a document no longer cancels it.
- Holding Alt in a dialog turns Cancel into Reset.
- Edit > Toggle Last State (Alt+Ctrl+Z) and Edit > Search… (Ctrl+F) work.

## Known gaps

- Search does not list open documents, help topics beyond the Help menu's items, or Photoshop's Stock and Learn
  results.
- The temporary Eyedropper does not draw its sampling ring (the canvas draws the active tool's overlay only;
  `canvas-view.js` belongs to guides-snapping).
- Typed units need a unit label the field declares (`unit`, `units`, or a `.opt-unit` label right after the input); a
  field without one reads `2in` as inches converted to pixels at the document's resolution.
- Hand-built number inputs in other packages' files (Color, Brushes, Layers, Properties, Warp, Liquify, Lens
  Correction, Content-Aware Scale, Image Size, Preferences, Levels, Curves, Contour, Blending Options) get arithmetic,
  Shift+arrow, the wheel and label scrubbing from the enhancer, but no popup slider and no unit list of their own.
- The spring-loaded tool key switches the real tool (the options bar shows it while it is held) rather than a
  temporary one.
