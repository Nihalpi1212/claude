import Foundation

// MARK: - Audius (free, open music network with full-length streaming)

final class AudiusAPI {
    static let shared = AudiusAPI()
    private let appName = "PulseApp"
    private let fallbackHost = URL(string: "https://api.audius.co")!
    private var hosts: [URL]
    private var resolved = false

    private init() { hosts = [URL(string: "https://api.audius.co")!] }

    private struct HostList: Decodable { let data: [String] }
    private struct Response<T: Decodable>: Decodable { let data: T }
    private struct RawTrack: Decodable {
        let id: String
        let title: String
        let duration: Double?
        let is_streamable: Bool?
        let user: User
        let artwork: Artwork?
        struct User: Decodable { let name: String }
        struct Artwork: Decodable {
            let small: String?
            let medium: String?
            let large: String?
            enum CodingKeys: String, CodingKey {
                case small = "150x150", medium = "480x480", large = "1000x1000"
            }
        }
    }

    /// Picks a healthy discovery node. Falls back to the public gateway if the list can't be loaded.
    private func resolveHosts() async {
        if resolved { return }
        resolved = true
        do {
            let (data, _) = try await URLSession.shared.data(from: fallbackHost)
            let list = try JSONDecoder().decode(HostList.self, from: data)
            let urls = list.data.compactMap { URL(string: $0) }
            if !urls.isEmpty { hosts = urls.shuffled() + [fallbackHost] }
        } catch {
            hosts = [fallbackHost]
        }
    }

    private func get<T: Decodable>(_ path: String, _ query: [URLQueryItem]) async throws -> T {
        await resolveHosts()
        var lastError: Error = URLError(.badServerResponse)
        for host in Array(hosts.prefix(4)) {
            var comps = URLComponents(url: host.appendingPathComponent(path), resolvingAgainstBaseURL: false)
            comps?.queryItems = query + [URLQueryItem(name: "app_name", value: appName)]
            guard let url = comps?.url else { continue }
            do {
                let (data, resp) = try await URLSession.shared.data(from: url)
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { continue }
                let decoded = try JSONDecoder().decode(T.self, from: data)
                if let first = hosts.first, first != host {   // remember the node that worked
                    hosts.removeAll { $0 == host }
                    hosts.insert(host, at: 0)
                }
                return decoded
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    private func map(_ raw: RawTrack) -> Track? {
        if raw.is_streamable == false { return nil }
        let art = raw.artwork?.medium ?? raw.artwork?.small ?? raw.artwork?.large
        return Track(id: "audius:\(raw.id)", source: .audius, rawID: raw.id, title: raw.title,
                     artist: raw.user.name, artworkURL: art.flatMap { URL(string: $0) },
                     duration: raw.duration ?? 0, directURL: nil)
    }

    func trending(genre: String?) async throws -> [Track] {
        var q = [URLQueryItem(name: "time", value: "week"), URLQueryItem(name: "limit", value: "40")]
        if let g = genre { q.append(URLQueryItem(name: "genre", value: g)) }
        let r: Response<[RawTrack]> = try await get("v1/tracks/trending", q)
        return r.data.compactMap(map)
    }

    func search(_ text: String) async throws -> [Track] {
        let q = [URLQueryItem(name: "query", value: text), URLQueryItem(name: "limit", value: "40")]
        let r: Response<[RawTrack]> = try await get("v1/tracks/search", q)
        return r.data.compactMap(map)
    }

    /// AVPlayer follows the redirect to the actual audio file.
    func streamURL(rawID: String) -> URL? {
        var comps = URLComponents(url: (hosts.first ?? fallbackHost).appendingPathComponent("v1/tracks/\(rawID)/stream"),
                                  resolvingAgainstBaseURL: false)
        comps?.queryItems = [URLQueryItem(name: "app_name", value: appName)]
        return comps?.url
    }
}

// MARK: - Jamendo (optional: free Creative Commons music, needs a free client id)

final class JamendoAPI {
    static let shared = JamendoAPI()
    private init() {}

    var clientID: String {
        (UserDefaults.standard.string(forKey: "jamendoClientID") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var isConfigured: Bool { !clientID.isEmpty }

    private struct Response: Decodable { let results: [Item] }
    private struct Item: Decodable {
        let id: String
        let name: String
        let artist_name: String
        let image: String?
        let audio: String?
        let duration: Double?
    }

    private func fetch(_ extra: [URLQueryItem]) async throws -> [Track] {
        guard isConfigured else { return [] }
        var comps = URLComponents(string: "https://api.jamendo.com/v3.0/tracks/")!
        comps.queryItems = [
            URLQueryItem(name: "client_id", value: clientID), URLQueryItem(name: "format", value: "json"),
            URLQueryItem(name: "limit", value: "30"), URLQueryItem(name: "audioformat", value: "mp32"),
            URLQueryItem(name: "imagesize", value: "300"),
        ] + extra
        guard let url = comps.url else { return [] }
        let (data, _) = try await URLSession.shared.data(from: url)
        let r = try JSONDecoder().decode(Response.self, from: data)
        return r.results.compactMap { item in
            guard let audio = item.audio, let aURL = URL(string: audio) else { return nil }
            return Track(id: "jamendo:\(item.id)", source: .jamendo, rawID: item.id, title: item.name,
                         artist: item.artist_name, artworkURL: item.image.flatMap { URL(string: $0) },
                         duration: item.duration ?? 0, directURL: aURL)
        }
    }

    func trending(tag: String?) async throws -> [Track] {
        var q = [URLQueryItem(name: "order", value: "popularity_week")]
        if let t = tag { q.append(URLQueryItem(name: "tags", value: t)) }
        return try await fetch(q)
    }

    func search(_ text: String) async throws -> [Track] {
        try await fetch([URLQueryItem(name: "search", value: text)])
    }
}

// MARK: - Combined catalog

enum Catalog {
    static func streamURL(for track: Track) -> URL? {
        switch track.source {
        case .audius: return AudiusAPI.shared.streamURL(rawID: track.rawID)
        case .jamendo: return track.directURL
        }
    }

    private static func interleave(_ a: [Track], _ b: [Track]) -> [Track] {
        var out: [Track] = []
        var seen = Set<String>()
        for i in 0..<max(a.count, b.count) {
            for t in [i < a.count ? a[i] : nil, i < b.count ? b[i] : nil] {
                if let t = t, seen.insert(t.id).inserted { out.append(t) }
            }
        }
        return out
    }

    static func trending(genre: Genre?) async throws -> [Track] {
        var audius: [Track] = []
        var failure: Error?
        do { audius = try await AudiusAPI.shared.trending(genre: genre?.audius) } catch { failure = error }
        let jamendo = (try? await JamendoAPI.shared.trending(tag: genre?.jamendo)) ?? []
        if audius.isEmpty && jamendo.isEmpty, let f = failure { throw f }
        return interleave(audius, jamendo)
    }

    static func search(_ text: String) async throws -> [Track] {
        var audius: [Track] = []
        var failure: Error?
        do { audius = try await AudiusAPI.shared.search(text) } catch { failure = error }
        let jamendo = (try? await JamendoAPI.shared.search(text)) ?? []
        if audius.isEmpty && jamendo.isEmpty, let f = failure { throw f }
        return interleave(audius, jamendo)
    }
}
