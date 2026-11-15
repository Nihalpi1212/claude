import Foundation

/// Current conditions, as reported by the weather service.
public struct WeatherReading: Equatable {
    /// WMO weather interpretation code (0 clear ... 99 thunderstorm with hail).
    public var code: Int
    public var temperatureC: Double
    public var windKmh: Double
    /// Direction the wind is coming from, in degrees clockwise from north.
    public var windFromDegrees: Double
    public var isDay: Bool

    public init(code: Int, temperatureC: Double, windKmh: Double, windFromDegrees: Double, isDay: Bool) {
        self.code = code
        self.temperatureC = temperatureC
        self.windKmh = windKmh
        self.windFromDegrees = windFromDegrees
        self.isDay = isDay
    }
}

public enum Season: Equatable {
    case spring, summer, autumn, winter
}

/// What to show: a scene (nil for nothing), how much of it, and the horizontal wind in points per second.
public struct ScenePlan: Equatable {
    public var scene: SceneKind?
    public var intensity: Float
    public var wind: Float

    public init(scene: SceneKind?, intensity: Float, wind: Float) {
        self.scene = scene
        self.intensity = intensity
        self.wind = wind
    }
}

public enum WeatherMapping {
    /// A short description of a WMO weather code.
    public static func summary(code: Int) -> String {
        switch code {
        case 0: return "Clear"
        case 1: return "Mostly clear"
        case 2: return "Partly cloudy"
        case 3: return "Overcast"
        case 45: return "Fog"
        case 48: return "Freezing fog"
        case 51: return "Light drizzle"
        case 53: return "Drizzle"
        case 55: return "Heavy drizzle"
        case 56, 57: return "Freezing drizzle"
        case 61: return "Light rain"
        case 63: return "Rain"
        case 65: return "Heavy rain"
        case 66, 67: return "Freezing rain"
        case 71: return "Light snow"
        case 73: return "Snow"
        case 75: return "Heavy snow"
        case 77: return "Snow grains"
        case 80: return "Light showers"
        case 81: return "Showers"
        case 82: return "Heavy showers"
        case 85: return "Light snow showers"
        case 86: return "Heavy snow showers"
        case 95: return "Thunderstorm"
        case 96, 99: return "Thunderstorm with hail"
        default: return "Unknown"
        }
    }

    /// The SF Symbol that stands for a WMO weather code in the menu bar.
    public static func symbolName(code: Int, isDay: Bool) -> String {
        switch code {
        case 0: return isDay ? "sun.max.fill" : "moon.stars.fill"
        case 1, 2: return isDay ? "cloud.sun.fill" : "cloud.moon.fill"
        case 3: return "cloud.fill"
        case 45, 48: return "cloud.fog.fill"
        case 51, 53, 55: return "cloud.drizzle.fill"
        case 56, 57, 66, 67: return "cloud.sleet.fill"
        case 61, 63, 80, 81: return "cloud.rain.fill"
        case 65, 82: return "cloud.heavyrain.fill"
        case 71, 73, 75, 77, 85, 86: return "cloud.snow.fill"
        case 95, 96, 99: return "cloud.bolt.rain.fill"
        default: return "cloud.fill"
        }
    }

    public static func season(month: Int, latitude: Double) -> Season {
        let northern: Season
        switch month {
        case 3, 4, 5: northern = .spring
        case 6, 7, 8: northern = .summer
        case 9, 10, 11: northern = .autumn
        default: northern = .winter
        }
        guard latitude < 0 else { return northern }
        switch northern {
        case .spring: return .autumn
        case .summer: return .winter
        case .autumn: return .spring
        case .winter: return .summer
        }
    }

    /// Horizontal wind on screen, in points per second: positive blows to the right (eastwards).
    public static func windPoints(kmh: Double, fromDegrees: Double) -> Float {
        let radians = fromDegrees * .pi / 180
        // Wind from the west (270 degrees) blows towards the east, to the right on screen.
        let across = -sin(radians)
        let direction: Double = across >= 0 ? 1 : -1
        let share = max(0.35, abs(across))
        return Float(direction * share * min(260, max(0, kmh) * 4.5))
    }

    /// Picks the scene for the current conditions. `ambience` adds a quiet seasonal scene when the
    /// sky is dry (petals in spring, motes and fireflies in summer, leaves in autumn).
    public static func plan(reading: WeatherReading, month: Int, latitude: Double, ambience: Bool) -> ScenePlan {
        let wind = windPoints(kmh: reading.windKmh, fromDegrees: reading.windFromDegrees)
        let sign: Float = wind >= 0 ? 1 : -1
        func gentle(_ factor: Float, atLeast: Float) -> Float {
            sign * max(atLeast, abs(wind) * factor)
        }

        switch reading.code {
        case 71, 73, 75, 77, 85, 86:
            let amount: Float
            switch reading.code {
            case 71, 77, 85: amount = 0.6
            case 73: amount = 1.0
            default: amount = 1.7
            }
            let heavy = reading.code == 75 || reading.code == 86
            if reading.windKmh >= 45 || (heavy && reading.windKmh >= 35) {
                return ScenePlan(scene: .blizzard, intensity: max(1, amount * 0.8), wind: gentle(1, atLeast: 150))
            }
            return ScenePlan(scene: .snow, intensity: amount, wind: gentle(0.35, atLeast: 6))
        case 51, 56:
            return ScenePlan(scene: .rain, intensity: 0.35, wind: gentle(0.5, atLeast: 10))
        case 53:
            return ScenePlan(scene: .rain, intensity: 0.5, wind: gentle(0.5, atLeast: 10))
        case 55, 57, 61, 66, 80:
            return ScenePlan(scene: .rain, intensity: 0.7, wind: gentle(0.5, atLeast: 15))
        case 63, 81:
            return ScenePlan(scene: .rain, intensity: 1.0, wind: gentle(0.5, atLeast: 20))
        case 65, 67, 82:
            return ScenePlan(scene: .rain, intensity: 1.7, wind: gentle(0.6, atLeast: 30))
        case 95:
            return ScenePlan(scene: .storm, intensity: 1.0, wind: gentle(0.8, atLeast: 80))
        case 96, 99:
            return ScenePlan(scene: .storm, intensity: 1.4, wind: gentle(0.8, atLeast: 100))
        case 45, 48:
            return ScenePlan(scene: .mist, intensity: 1.0, wind: gentle(0.05, atLeast: 6))
        default:
            guard ambience else { return ScenePlan(scene: nil, intensity: 1, wind: 0) }
            switch season(month: month, latitude: latitude) {
            case .spring:
                return ScenePlan(scene: .petals, intensity: 0.7, wind: gentle(0.3, atLeast: 15))
            case .summer:
                let scene: SceneKind = reading.isDay ? .motes : .fireflies
                return ScenePlan(scene: scene, intensity: 1, wind: gentle(0.05, atLeast: 4))
            case .autumn:
                return ScenePlan(scene: .leaves, intensity: 0.8, wind: gentle(0.3, atLeast: 20))
            case .winter:
                return ScenePlan(scene: reading.isDay ? .motes : nil, intensity: 0.6, wind: gentle(0.05, atLeast: 4))
            }
        }
    }
}

/// A place returned by the city search.
public struct Place: Equatable, Hashable, Identifiable {
    public let id: Int
    public let name: String
    public let region: String?
    public let country: String?
    public let latitude: Double
    public let longitude: Double

    public init(id: Int, name: String, region: String?, country: String?, latitude: Double, longitude: Double) {
        self.id = id
        self.name = name
        self.region = region
        self.country = country
        self.latitude = latitude
        self.longitude = longitude
    }

    /// "Lisbon, Lisboa, Portugal", leaving out parts that repeat or are missing.
    public var label: String {
        var parts = [name]
        if let region = region, !region.isEmpty, region != name { parts.append(region) }
        if let country = country, !country.isEmpty { parts.append(country) }
        return parts.joined(separator: ", ")
    }
}

/// The Open-Meteo requests Eaves makes, and how their answers are read. No account or key is needed.
public enum OpenMeteo {
    /// Coordinates are rounded to two decimals (about a kilometre) before they leave the Mac.
    public static func forecastURL(latitude: Double, longitude: Double) -> URL {
        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        components.queryItems = [
            URLQueryItem(name: "latitude", value: String(format: "%.2f", latitude)),
            URLQueryItem(name: "longitude", value: String(format: "%.2f", longitude)),
            URLQueryItem(name: "current",
                         value: "temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day"),
            URLQueryItem(name: "wind_speed_unit", value: "kmh"),
            URLQueryItem(name: "timezone", value: "auto"),
        ]
        return components.url!
    }

    public static func searchURL(query: String) -> URL {
        var components = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        components.queryItems = [
            URLQueryItem(name: "name", value: query),
            URLQueryItem(name: "count", value: "6"),
            URLQueryItem(name: "language", value: "en"),
            URLQueryItem(name: "format", value: "json"),
        ]
        return components.url!
    }

    private struct ForecastResponse: Decodable {
        struct Current: Decodable {
            let temperature_2m: Double
            let weather_code: Int
            let wind_speed_10m: Double
            let wind_direction_10m: Double
            let is_day: Int
        }
        let current: Current
    }

    private struct SearchResponse: Decodable {
        struct Item: Decodable {
            let id: Int
            let name: String
            let latitude: Double
            let longitude: Double
            let country: String?
            let admin1: String?
        }
        let results: [Item]?
    }

    public static func parseCurrent(_ data: Data) throws -> WeatherReading {
        let current = try JSONDecoder().decode(ForecastResponse.self, from: data).current
        return WeatherReading(code: current.weather_code, temperatureC: current.temperature_2m,
                              windKmh: current.wind_speed_10m, windFromDegrees: current.wind_direction_10m,
                              isDay: current.is_day != 0)
    }

    public static func parsePlaces(_ data: Data) throws -> [Place] {
        let response = try JSONDecoder().decode(SearchResponse.self, from: data)
        return (response.results ?? []).map {
            Place(id: $0.id, name: $0.name, region: $0.admin1, country: $0.country,
                  latitude: $0.latitude, longitude: $0.longitude)
        }
    }
}
