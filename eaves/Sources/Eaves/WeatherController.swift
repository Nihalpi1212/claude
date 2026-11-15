import AppKit
import CoreLocation
import EavesCore

enum LocationError: LocalizedError {
    case denied
    case unavailable

    var errorDescription: String? {
        switch self {
        case .denied:
            return "Location access is off for Eaves. Allow it in System Settings › Privacy & Security › "
                + "Location Services, or search for a city instead."
        case .unavailable:
            return "Your Mac could not work out where it is. Search for a city instead."
        }
    }
}

/// Asks macOS for the Mac's position once, on request.
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    typealias Found = (name: String, latitude: Double, longitude: Double)

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private var completion: ((Result<Found, Error>) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func request(_ completion: @escaping (Result<Found, Error>) -> Void) {
        self.completion = completion
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finish(.failure(LocationError.denied))
        default:
            manager.requestLocation()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard completion != nil else { return }
        switch manager.authorizationStatus {
        case .notDetermined:
            break
        case .denied, .restricted:
            finish(.failure(LocationError.denied))
        default:
            manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard completion != nil, let location = locations.last else { return }
        // Two decimals is about a kilometre: enough for weather, and all that is kept or sent.
        let latitude = (location.coordinate.latitude * 100).rounded() / 100
        let longitude = (location.coordinate.longitude * 100).rounded() / 100
        geocoder.reverseGeocodeLocation(location) { [weak self] placemarks, _ in
            let name = placemarks?.first?.locality ?? "Current Location"
            DispatchQueue.main.async {
                self?.finish(.success((name: name, latitude: latitude, longitude: longitude)))
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        finish(.failure(denied ? LocationError.denied : LocationError.unavailable))
    }

    private func finish(_ result: Result<Found, Error>) {
        let done = completion
        completion = nil
        done?(result)
    }
}

/// Fetches the current weather for the chosen place and keeps it fresh.
final class WeatherController: ObservableObject {
    @Published private(set) var reading: WeatherReading?
    /// A line for the Settings window: progress, or what went wrong.
    @Published private(set) var status = ""
    /// A line about finding the Mac's own position.
    @Published private(set) var locationStatus = ""

    private let session: URLSession
    private let locator = LocationProvider()
    private var task: URLSessionDataTask?
    private var timer: Timer?
    private var fetchedFor = ""
    private var wakeObserver: NSObjectProtocol?

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    func start() {
        let timer = Timer(timeInterval: 15 * 60, repeats: true) { [weak self] _ in
            self?.update()
        }
        timer.tolerance = 60
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            // Give the network a moment to come back after sleep.
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { self?.update() }
        }
        update()
    }

    /// Fetches again if the chosen place has changed.
    func settingsChanged() {
        let settings = Settings.shared
        guard settings.hasLocation else { return }
        if key(settings.latitude, settings.longitude) != fetchedFor { refresh() }
    }

    /// The regular update: find the Mac again if it is following its own position, then fetch.
    func update() {
        if Settings.shared.useCurrentLocation {
            locate()
        } else {
            refresh()
        }
    }

    /// Asks macOS where the Mac is, stores that as the place to follow, and fetches its weather.
    func locate() {
        locationStatus = "Finding your location…"
        locator.request { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success(let found):
                let settings = Settings.shared
                settings.useCurrentLocation = true
                settings.setLocation(name: found.name, latitude: found.latitude, longitude: found.longitude)
                self.locationStatus = ""
                self.refresh()
            case .failure(let error):
                Settings.shared.useCurrentLocation = false
                self.locationStatus = error.localizedDescription
                self.refresh()
            }
        }
    }

    func refresh() {
        let settings = Settings.shared
        guard settings.hasLocation else { return }
        let latitude = settings.latitude
        let longitude = settings.longitude
        fetchedFor = key(latitude, longitude)
        task?.cancel()
        let request = session.dataTask(with: OpenMeteo.forecastURL(latitude: latitude, longitude: longitude)) {
            [weak self] data, response, error in
            let result: Result<WeatherReading, Error>
            if let data = data, (response as? HTTPURLResponse)?.statusCode == 200 {
                result = Result { try OpenMeteo.parseCurrent(data) }
            } else {
                result = .failure(error ?? URLError(.badServerResponse))
            }
            DispatchQueue.main.async { self?.finish(result) }
        }
        task = request
        request.resume()
    }

    func search(_ query: String, completion: @escaping (Result<[Place], Error>) -> Void) {
        let request = session.dataTask(with: OpenMeteo.searchURL(query: query)) { data, response, error in
            let result: Result<[Place], Error>
            if let data = data, (response as? HTTPURLResponse)?.statusCode == 200 {
                result = Result { try OpenMeteo.parsePlaces(data) }
            } else {
                result = .failure(error ?? URLError(.badServerResponse))
            }
            DispatchQueue.main.async { completion(result) }
        }
        request.resume()
    }

    private func key(_ latitude: Double, _ longitude: Double) -> String {
        String(format: "%.2f,%.2f", latitude, longitude)
    }

    private func finish(_ result: Result<WeatherReading, Error>) {
        switch result {
        case .success(let reading):
            self.reading = reading
            status = ""
        case .failure(let error):
            // A newer request replacing this one is not a failure.
            if (error as? URLError)?.code == .cancelled { return }
            status = "Could not reach the weather service: \(error.localizedDescription)"
        }
        NotificationCenter.default.post(name: .weatherChanged, object: self)
    }
}
