import AppKit
import CoreGraphics

/// One on-screen window in Core Graphics global coordinates (origin top left of the primary display).
struct TrackedWindow {
    let id: Int
    let bounds: CGRect
}

/// Keeps a front-to-back list of the ordinary windows on screen. It only reads window positions and
/// sizes, which needs no permission; it never reads window titles or contents.
final class WindowTracker {
    static let shared = WindowTracker()

    private(set) var windows: [TrackedWindow] = []
    /// Goes up every time the list is refreshed.
    private(set) var generation = 0

    private var timer: Timer?
    private var ticks = 0
    private let ownPID = Int(ProcessInfo.processInfo.processIdentifier)

    func start() {
        guard timer == nil else { return }
        refresh()
        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
            self?.tick()
        }
        timer.tolerance = 0.01
        // The common modes keep it running while a menu is open or a window is being dragged.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Ten times a second is plenty, except while something is being dragged: then snow has to
    /// keep up with the window under the cursor.
    private func tick() {
        ticks &+= 1
        if NSEvent.pressedMouseButtons != 0 || ticks % 3 == 0 { refresh() }
    }

    func refresh() {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return
        }
        var result: [TrackedWindow] = []
        result.reserveCapacity(list.count)
        for info in list {
            // Layer 0 is where ordinary app windows live; the Dock, menu bar and overlays are elsewhere.
            guard let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
                  let number = info[kCGWindowNumber as String] as? Int,
                  let pid = info[kCGWindowOwnerPID as String] as? Int, pid != ownPID,
                  let boundsInfo = info[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsInfo as CFDictionary) else { continue }
            let alpha = info[kCGWindowAlpha as String] as? Double ?? 1
            guard alpha > 0.05, bounds.width >= 120, bounds.height >= 60 else { continue }
            result.append(TrackedWindow(id: number, bounds: bounds))
        }
        windows = result
        generation &+= 1
    }
}
