import AppKit
import SwiftUI
import EavesCore

/// A menu item that runs a closure.
final class ActionItem: NSMenuItem {
    private var handler: (() -> Void)?

    convenience init(_ title: String, checked: Bool = false, key: String = "", handler: @escaping () -> Void) {
        self.init(title: title, action: #selector(run), keyEquivalent: key)
        self.handler = handler
        target = self
        state = checked ? .on : .off
    }

    @objc private func run() {
        handler?()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let settings = Settings.shared
    private let weather = WeatherController()
    private var overlay: OverlayController?
    private var statusItem: NSStatusItem?
    private var settingsWindow: NSWindow?
    private var applyScheduled = false

    /// Set by `--scene`: shows one scene regardless of the weather and the saved choice.
    private var forcedScene: SceneKind?
    /// Set by `--selftest`: run for this many seconds, print what happened, and quit.
    private var selfTestSeconds: Double?

    func applicationDidFinishLaunching(_ notification: Notification) {
        readArguments()
        NSApp.mainMenu = makeMainMenu()
        WindowTracker.shared.start()
        overlay = OverlayController()
        makeStatusItem()

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(somethingChanged(_:)), name: .settingsChanged, object: nil)
        center.addObserver(self, selector: #selector(somethingChanged(_:)), name: .weatherChanged, object: nil)

        apply()
        if let seconds = selfTestSeconds {
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.finishSelfTest() }
            return
        }
        weather.start()
        if settings.isFirstRun {
            settings.markWelcomed()
            showSettings()
        }
    }

    // MARK: What to show

    /// The scene to show now, and whether it comes from the live weather.
    private func currentPlan() -> (plan: ScenePlan, live: Bool) {
        if let forced = forcedScene {
            return (ScenePlan(scene: forced, intensity: 1.5, wind: forced.defaultWind), false)
        }
        if settings.followWeather, settings.hasLocation, let reading = weather.reading {
            let month = Calendar.current.component(.month, from: Date())
            let plan = WeatherMapping.plan(reading: reading, month: month, latitude: settings.latitude,
                                           ambience: settings.ambience)
            return (plan, true)
        }
        // Not following the weather, or nothing to follow yet: show the scene picked by hand.
        let scene = settings.scene
        return (ScenePlan(scene: scene, intensity: 1, wind: scene?.defaultWind ?? 0), false)
    }

    @objc private func somethingChanged(_ notification: Notification) {
        // Several settings often change together; apply them once.
        guard !applyScheduled else { return }
        applyScheduled = true
        DispatchQueue.main.async { [weak self] in
            self?.applyScheduled = false
            self?.apply()
        }
    }

    private func apply() {
        var plan = currentPlan().plan
        plan.intensity *= Float(settings.density)
        overlay?.show(plan)
        if selfTestSeconds == nil { weather.settingsChanged() }
        updateStatusButton()
    }

    // MARK: Menu bar

    private func makeStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
        updateStatusButton()
    }

    private func symbol(for scene: SceneKind?) -> String {
        guard let scene = scene else { return "cloud" }
        switch scene {
        case .snow: return "snowflake"
        case .blizzard: return "wind.snow"
        case .rain: return "cloud.rain.fill"
        case .storm: return "cloud.bolt.rain.fill"
        case .mist: return "cloud.fog.fill"
        case .leaves: return "leaf.fill"
        case .petals: return "camera.macro"
        case .fireflies: return "sparkles"
        case .motes: return "sun.max.fill"
        case .embers: return "flame.fill"
        }
    }

    private func updateStatusButton() {
        guard let button = statusItem?.button else { return }
        let current = currentPlan()
        var name = symbol(for: current.plan.scene)
        var title = ""
        var description = current.plan.scene?.title ?? "Clear"
        if settings.paused {
            name = "pause.circle"
            description = "Paused"
        } else if current.live, let reading = weather.reading {
            name = WeatherMapping.symbolName(code: reading.code, isDay: reading.isDay)
            description = WeatherMapping.summary(code: reading.code)
            if settings.showTemperature { title = " " + settings.temperatureText(celsius: reading.temperatureC) }
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: description)
            ?? NSImage(systemSymbolName: "cloud", accessibilityDescription: description)
        image?.isTemplate = true
        button.image = image
        button.title = title
        button.toolTip = "Eaves: \(description)"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let settings = self.settings
        let current = currentPlan()

        // What is happening outside, and what is on screen.
        let headline: String
        if settings.hasLocation, let reading = weather.reading {
            headline = "\(settings.locationName): \(settings.temperatureText(celsius: reading.temperatureC)), "
                + WeatherMapping.summary(code: reading.code).lowercased()
        } else if settings.hasLocation {
            headline = weather.status.isEmpty ? "\(settings.locationName): fetching the weather…"
                                               : "\(settings.locationName): weather unavailable"
        } else {
            headline = "No location set"
        }
        menu.addItem(disabled(headline))
        menu.addItem(disabled("Showing: \(current.plan.scene?.title ?? "Nothing")"))
        menu.addItem(.separator())

        if settings.hasLocation {
            menu.addItem(ActionItem("Follow Live Weather", checked: settings.followWeather) {
                settings.followWeather.toggle()
            })
        } else {
            menu.addItem(ActionItem("Choose a Location to Follow Live Weather…") { [weak self] in
                self?.showSettings()
            })
        }

        let scenes = NSMenu()
        let manual = !current.live
        for scene in SceneKind.allCases {
            scenes.addItem(ActionItem(scene.title, checked: manual && settings.manualScene == scene.rawValue) {
                [weak self] in self?.pick(scene.rawValue)
            })
        }
        scenes.addItem(.separator())
        scenes.addItem(ActionItem("Nothing", checked: manual && settings.scene == nil) {
            [weak self] in self?.pick("none")
        })
        menu.addItem(submenu("Scene", scenes))

        let amount = NSMenu()
        for (title, value) in [("Light", 0.5), ("Medium", 1.0), ("Heavy", 1.8)] {
            amount.addItem(ActionItem(title, checked: abs(settings.density - value) < 0.01) {
                settings.density = value
            })
        }
        menu.addItem(submenu("Amount", amount))

        let depth = NSMenu()
        for mode in DepthMode.allCases {
            depth.addItem(ActionItem(mode.title, checked: settings.depth == mode) {
                settings.depthMode = mode.rawValue
            })
        }
        menu.addItem(submenu("Weather Appears", depth))
        menu.addItem(.separator())

        menu.addItem(ActionItem("Snow Piles Up on Windows", checked: settings.pilesEnabled) {
            settings.pilesEnabled.toggle()
        })
        menu.addItem(ActionItem("Clear Away the Snow") { [weak self] in
            self?.overlay?.clearSnow()
        })
        menu.addItem(ActionItem(settings.paused ? "Resume" : "Pause") {
            settings.paused.toggle()
        })
        menu.addItem(.separator())
        menu.addItem(ActionItem("Settings…", key: ",") { [weak self] in
            self?.showSettings()
        })
        menu.addItem(ActionItem("Quit Eaves", key: "q") {
            NSApp.terminate(nil)
        })
    }

    private func pick(_ scene: String) {
        settings.manualScene = scene
        settings.followWeather = false
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func submenu(_ title: String, _ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    /// Never shown (Eaves has no menu bar of its own), but it is what makes Copy, Paste and
    /// Close Window work from the keyboard in the Settings window.
    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        let edit = NSMenu(title: "Edit")
        edit.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
        edit.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
        edit.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
        edit.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
        edit.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
        main.addItem(submenu("Edit", edit))
        let window = NSMenu(title: "Window")
        window.addItem(NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
        main.addItem(submenu("Window", window))
        return main
    }

    // MARK: Settings window

    private func showSettings() {
        if settingsWindow == nil {
            let host = NSHostingController(rootView: SettingsView(weather: weather))
            let window = NSWindow(contentViewController: host)
            window.title = "Eaves Settings"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            window.center()
            settingsWindow = window
        }
        NSApp.activate(ignoringOtherApps: true)
        settingsWindow?.makeKeyAndOrderFront(nil)
    }

    // MARK: Command line

    private func readArguments() {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--scene"), index + 1 < arguments.count {
            forcedScene = SceneKind(rawValue: arguments[index + 1])
        }
        if let index = arguments.firstIndex(of: "--selftest") {
            let seconds = index + 1 < arguments.count ? Double(arguments[index + 1]) : nil
            selfTestSeconds = seconds ?? 15
            if forcedScene == nil { forcedScene = .blizzard }
        }
    }

    /// Reports whether the overlay really ran: frames drawn, particles made, particles landed.
    private func finishSelfTest() {
        let totals = overlay?.totals ?? (screens: 0, frames: 0, spawned: 0, landed: 0, alive: 0, ledges: 0, snow: Float(0))
        let windows = WindowTracker.shared.windows.count
        print("eaves selftest: screens=\(totals.screens) windows=\(windows) ledges=\(totals.ledges) "
            + "frames=\(totals.frames) spawned=\(totals.spawned) landed=\(totals.landed) "
            + "alive=\(totals.alive) deepestSnow=\(totals.snow)")
        let passed = totals.screens > 0 && totals.frames > 30 && totals.spawned > 0
        print(passed ? "eaves selftest: PASS" : "eaves selftest: FAIL")
        fflush(stdout)
        exit(passed ? 0 : 1)
    }
}
