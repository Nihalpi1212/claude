import AppKit
import SpriteKit
import EavesCore

/// One transparent, click-through window covering a screen.
private final class Overlay {
    let window: NSWindow
    let view: SKView
    let scene: WeatherScene

    init(screen: NSScreen, primaryHeight: CGFloat, sheet: TextureSheet) {
        let frame = screen.frame
        let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        // Above windows and the Dock, below the menu bar and anything that pops up.
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.mainMenuWindow)) - 1)
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.setFrame(frame, display: false)

        let view = SKView(frame: NSRect(origin: .zero, size: frame.size))
        view.allowsTransparency = true
        view.ignoresSiblingOrder = true
        view.autoresizingMask = [.width, .height]
        window.contentView = view

        let menuBar = max(0, frame.maxY - screen.visibleFrame.maxY)
        let scene = WeatherScene(screenFrame: frame, topInset: menuBar, primaryHeight: primaryHeight, sheet: sheet)
        view.presentScene(scene)

        self.window = window
        self.view = view
        self.scene = scene
    }

    func close() {
        view.presentScene(nil)
        window.orderOut(nil)
        window.close()
    }
}

/// Owns the overlay windows, one per screen, and hands them what to show.
final class OverlayController {
    private var overlays: [Overlay] = []
    private let sheet = TextureSheet()
    private var plan = ScenePlan(scene: nil, intensity: 1, wind: 0)
    private var asleep = false
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                            object: nil, queue: .main) { [weak self] _ in
            self?.rebuild()
        })
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidSleepNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.asleep = true
            self?.refresh()
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidWakeNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            self?.asleep = false
            self?.refresh()
        })
        rebuild()
    }

    /// Recreates the overlays, for example after a display is connected or the resolution changes.
    func rebuild() {
        for overlay in overlays { overlay.close() }
        let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
        overlays = NSScreen.screens.map { Overlay(screen: $0, primaryHeight: primaryHeight, sheet: sheet) }
        refresh()
    }

    func show(_ plan: ScenePlan) {
        self.plan = plan
        refresh()
    }

    func clearSnow() {
        for overlay in overlays { overlay.scene.clearSnow() }
        refresh()
    }

    /// Totals over every screen, for the self-test.
    var totals: (screens: Int, frames: Int, spawned: Int, landed: Int, alive: Int, ledges: Int, snow: Float) {
        var result = (screens: overlays.count, frames: 0, spawned: 0, landed: 0, alive: 0, ledges: 0, snow: Float(0))
        for overlay in overlays {
            let world = overlay.scene.world
            result.frames += overlay.scene.frames
            result.spawned += world.stats.spawned
            result.landed += world.stats.landed
            result.alive += world.particles.count
            result.ledges += world.ledges.count
            for ledge in world.ledges { result.snow = max(result.snow, world.pile(for: ledge.id)?.peak ?? 0) }
        }
        return result
    }

    private func refresh() {
        let settings = Settings.shared
        let hidden = settings.paused || asleep
        for overlay in overlays {
            let world = overlay.scene.world
            world.depthMode = settings.depth
            world.pilesEnabled = settings.pilesEnabled
            world.lightningEnabled = settings.lightning
            world.hideInFullScreen = settings.hideInFullScreen
            world.configure(scene: plan.scene, intensity: plan.intensity, wind: plan.wind)
            overlay.scene.opacity = CGFloat(settings.opacity)
            overlay.view.preferredFramesPerSecond = settings.smooth ? 60 : 30
            overlay.view.isPaused = hidden
            if hidden {
                overlay.window.orderOut(nil)
            } else {
                overlay.window.orderFrontRegardless()
            }
        }
    }
}
