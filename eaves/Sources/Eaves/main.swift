import AppKit

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
// A menu bar app: no Dock icon and no app menu.
application.setActivationPolicy(.accessory)
application.run()
