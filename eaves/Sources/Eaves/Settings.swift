import Foundation
import EavesCore

extension Notification.Name {
    static let settingsChanged = Notification.Name("EavesSettingsChanged")
    static let weatherChanged = Notification.Name("EavesWeatherChanged")
}

/// Everything the user can choose, stored in the app's preferences.
final class Settings: ObservableObject {
    static let shared = Settings()

    private let defaults = UserDefaults.standard

    @Published var followWeather: Bool { didSet { save(followWeather, "followWeather") } }
    /// Raw value of a `SceneKind`, or "none" for an empty sky.
    @Published var manualScene: String { didSet { save(manualScene, "manualScene") } }
    @Published var density: Double { didSet { save(density, "density") } }
    @Published var opacity: Double { didSet { save(opacity, "opacity") } }
    @Published var depthMode: String { didSet { save(depthMode, "depthMode") } }
    @Published var pilesEnabled: Bool { didSet { save(pilesEnabled, "pilesEnabled") } }
    @Published var lightning: Bool { didSet { save(lightning, "lightning") } }
    @Published var hideInFullScreen: Bool { didSet { save(hideInFullScreen, "hideInFullScreen") } }
    @Published var ambience: Bool { didSet { save(ambience, "ambience") } }
    @Published var smooth: Bool { didSet { save(smooth, "smooth") } }
    @Published var showTemperature: Bool { didSet { save(showTemperature, "showTemperature") } }
    @Published var fahrenheit: Bool { didSet { save(fahrenheit, "fahrenheit") } }
    @Published var useCurrentLocation: Bool { didSet { save(useCurrentLocation, "useCurrentLocation") } }
    @Published var locationName: String { didSet { save(locationName, "locationName") } }
    @Published var latitude: Double { didSet { save(latitude, "latitude") } }
    @Published var longitude: Double { didSet { save(longitude, "longitude") } }
    @Published var hasLocation: Bool { didSet { save(hasLocation, "hasLocation") } }
    /// Not stored: Eaves always starts unpaused.
    @Published var paused = false { didSet { announce() } }

    private init() {
        let store = UserDefaults.standard
        store.register(defaults: [
            "followWeather": true,
            "manualScene": SceneKind.snow.rawValue,
            "density": 1.0,
            "opacity": 1.0,
            "depthMode": DepthMode.behindActive.rawValue,
            "pilesEnabled": true,
            "lightning": true,
            "hideInFullScreen": true,
            "ambience": true,
            "smooth": true,
            "showTemperature": true,
            "fahrenheit": Locale.current.measurementSystem == .us,
            "useCurrentLocation": false,
            "locationName": "",
            "latitude": 0.0,
            "longitude": 0.0,
            "hasLocation": false,
        ])
        followWeather = store.bool(forKey: "followWeather")
        manualScene = store.string(forKey: "manualScene") ?? SceneKind.snow.rawValue
        density = store.double(forKey: "density")
        opacity = store.double(forKey: "opacity")
        depthMode = store.string(forKey: "depthMode") ?? DepthMode.behindActive.rawValue
        pilesEnabled = store.bool(forKey: "pilesEnabled")
        lightning = store.bool(forKey: "lightning")
        hideInFullScreen = store.bool(forKey: "hideInFullScreen")
        ambience = store.bool(forKey: "ambience")
        smooth = store.bool(forKey: "smooth")
        showTemperature = store.bool(forKey: "showTemperature")
        fahrenheit = store.bool(forKey: "fahrenheit")
        useCurrentLocation = store.bool(forKey: "useCurrentLocation")
        locationName = store.string(forKey: "locationName") ?? ""
        latitude = store.double(forKey: "latitude")
        longitude = store.double(forKey: "longitude")
        hasLocation = store.bool(forKey: "hasLocation")
    }

    var depth: DepthMode { DepthMode(rawValue: depthMode) ?? .behindActive }
    var scene: SceneKind? { SceneKind(rawValue: manualScene) }
    var isFirstRun: Bool { !defaults.bool(forKey: "welcomed") }

    func markWelcomed() {
        defaults.set(true, forKey: "welcomed")
    }

    func setLocation(name: String, latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
        locationName = name
        hasLocation = true
    }

    func temperatureText(celsius: Double) -> String {
        let value = fahrenheit ? celsius * 9 / 5 + 32 : celsius
        return "\(Int(value.rounded()))°"
    }

    private func save(_ value: Any, _ key: String) {
        defaults.set(value, forKey: key)
        announce()
    }

    private func announce() {
        NotificationCenter.default.post(name: .settingsChanged, object: self)
    }
}
