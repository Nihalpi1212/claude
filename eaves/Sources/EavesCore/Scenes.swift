import Foundation

/// The scenes Eaves can show.
public enum SceneKind: String, CaseIterable {
    case snow, blizzard, rain, storm, mist, leaves, petals, fireflies, motes, embers

    public var title: String {
        switch self {
        case .snow: return "Snow"
        case .blizzard: return "Blizzard"
        case .rain: return "Rain"
        case .storm: return "Thunderstorm"
        case .mist: return "Mist"
        case .leaves: return "Falling Leaves"
        case .petals: return "Petals"
        case .fireflies: return "Fireflies"
        case .motes: return "Sun Motes"
        case .embers: return "Embers"
        }
    }

    /// Horizontal drift, in points per second, used when the scene was picked by hand.
    public var defaultWind: Float {
        switch self {
        case .snow: return 12
        case .blizzard: return 190
        case .rain: return 45
        case .storm: return 150
        case .leaves: return 35
        case .petals: return 22
        case .mist: return 9
        case .fireflies, .motes, .embers: return 6
        }
    }

    public var isSnowy: Bool { self == .snow || self == .blizzard }
    public var isRainy: Bool { self == .rain || self == .storm }
}

/// Where the weather appears relative to your windows.
public enum DepthMode: String, CaseIterable {
    /// Everything falls in front of every window.
    case front
    /// The window you are working in stays clear; weather lands on top of it.
    case behindActive
    /// Weather is only visible over the desktop, and lands on top of every window.
    case behindAll

    public var title: String {
        switch self {
        case .front: return "In Front of Everything"
        case .behindActive: return "Behind the Active Window"
        case .behindAll: return "Behind All Windows"
        }
    }
}
