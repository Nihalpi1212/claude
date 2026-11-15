import Foundation
import SwiftUI

enum Source: String, Codable {
    case audius, jamendo
}

struct Track: Identifiable, Codable, Hashable {
    let id: String            // "audius:123" or "jamendo:456"
    let source: Source
    let rawID: String
    var title: String
    var artist: String
    var artworkURL: URL?
    var duration: Double
    var directURL: URL?       // Jamendo supplies a direct audio URL
}

struct Playlist: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var tracks: [Track] = []
}

struct Genre: Identifiable, Hashable {
    let name: String
    let audius: String        // genre name used by Audius
    let jamendo: String       // tag used by Jamendo
    let hex: UInt32
    var id: String { name }
    var color: Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    static let all: [Genre] = [
        Genre(name: "Electronic", audius: "Electronic", jamendo: "electronic", hex: 0x0D73EC),
        Genre(name: "Hip-Hop", audius: "Hip-Hop/Rap", jamendo: "hiphop", hex: 0xBA5D07),
        Genre(name: "Pop", audius: "Pop", jamendo: "pop", hex: 0xE8115B),
        Genre(name: "Rock", audius: "Rock", jamendo: "rock", hex: 0xE61E32),
        Genre(name: "Lo-Fi", audius: "Lo-Fi", jamendo: "lofi", hex: 0x7358FF),
        Genre(name: "R&B / Soul", audius: "R&B/Soul", jamendo: "rnb", hex: 0x8C1932),
        Genre(name: "Jazz", audius: "Jazz", jamendo: "jazz", hex: 0x477D95),
        Genre(name: "Ambient", audius: "Ambient", jamendo: "ambient", hex: 0x503750),
        Genre(name: "House", audius: "House", jamendo: "house", hex: 0xDC148C),
        Genre(name: "Latin", audius: "Latin", jamendo: "latin", hex: 0xE13300),
        Genre(name: "Classical", audius: "Classical", jamendo: "classical", hex: 0x7D4B32),
        Genre(name: "Folk", audius: "Folk", jamendo: "folk", hex: 0x4B6E30),
        Genre(name: "Metal", audius: "Metal", jamendo: "metal", hex: 0x2A2A2A),
        Genre(name: "Reggae", audius: "Reggae", jamendo: "reggae", hex: 0x1E8A4C),
        Genre(name: "Country", audius: "Country", jamendo: "country", hex: 0xA56A00),
        Genre(name: "Trap", audius: "Trap", jamendo: "trap", hex: 0x8D67AB),
    ]
}

enum Theme {
    static let accent = Color(red: 0.12, green: 0.84, blue: 0.38)
}

func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds > 0 else { return "0:00" }
    let s = Int(seconds)
    return "\(s / 60):" + String(format: "%02d", s % 60)
}
