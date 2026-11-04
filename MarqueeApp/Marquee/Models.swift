import Foundation

// MARK: - Catalog items

/// A title as it appears in a catalog row or grid (Stremio "meta preview").
struct MetaPreview: Codable, Hashable, Identifiable {
    var id: String
    var type: String
    var name: String
    var poster: String? = nil
    var background: String? = nil
    var logo: String? = nil
    var description: String? = nil
    var releaseInfo: String? = nil
    var imdbRating: String? = nil
    var genres: [String]? = nil
    var posterShape: String? = nil
}

/// Full details for one title, including episodes for series.
struct MetaDetail: Hashable {
    var id: String
    var type: String
    var name: String
    var poster: String? = nil
    var background: String? = nil
    var logo: String? = nil
    var description: String? = nil
    var releaseInfo: String? = nil
    var imdbRating: String? = nil
    var genres: [String]? = nil
    var runtime: String? = nil
    var cast: [String]? = nil
    var director: [String]? = nil
    var videos: [MetaVideo]? = nil
    var trailerYouTubeID: String? = nil

    init(id: String, type: String, name: String) {
        self.id = id
        self.type = type
        self.name = name
    }

    init(preview: MetaPreview) {
        self.init(id: preview.id, type: preview.type, name: preview.name)
        poster = preview.poster
        background = preview.background
        logo = preview.logo
        description = preview.description
        releaseInfo = preview.releaseInfo
        imdbRating = preview.imdbRating
        genres = preview.genres
    }

    var asPreview: MetaPreview {
        MetaPreview(id: id, type: type, name: name, poster: poster, background: background, logo: logo,
                    description: description, releaseInfo: releaseInfo, imdbRating: imdbRating, genres: genres)
    }

    /// Fills gaps in what an add-on returned with what the catalog already showed.
    func merged(with preview: MetaPreview) -> MetaDetail {
        var m = self
        if m.type.isEmpty { m.type = preview.type }
        if m.name.isEmpty { m.name = preview.name }
        m.poster = m.poster ?? preview.poster
        m.background = m.background ?? preview.background
        m.description = m.description ?? preview.description
        m.releaseInfo = m.releaseInfo ?? preview.releaseInfo
        m.imdbRating = m.imdbRating ?? preview.imdbRating
        m.genres = m.genres ?? preview.genres
        return m
    }
}

/// One episode (or one video of a channel).
struct MetaVideo: Hashable, Identifiable {
    var id: String
    var title: String
    var season: Int? = nil
    var episode: Int? = nil
    var released: Date? = nil
    var thumbnail: String? = nil
    var overview: String? = nil

    var label: String? {
        guard let season, let episode else { return nil }
        return "S\(season) · E\(episode)"
    }

    var isUpcoming: Bool { (released ?? .distantPast) > Date() }
}

/// A playable source for a title, returned by an add-on.
struct StreamItem: Hashable {
    var url: String? = nil
    var ytId: String? = nil
    var infoHash: String? = nil
    var externalUrl: String? = nil
    var name: String? = nil
    var title: String? = nil
    var description: String? = nil

    /// Marquee plays direct links itself and hands YouTube and web links to the browser.
    /// Torrent-only results are not supported.
    var isOpenable: Bool { url != nil || ytId != nil || externalUrl != nil }

    var primaryLine: String {
        let raw = name ?? "Stream"
        return raw.split(whereSeparator: \.isNewline).joined(separator: " · ")
    }

    var secondaryLine: String? { description ?? title }

    var iconName: String {
        if ytId != nil { return "play.rectangle" }
        if url == nil && externalUrl != nil { return "safari" }
        return "film"
    }
}

// MARK: - Add-ons

struct CatalogExtra: Codable, Hashable {
    var name: String
    var isRequired: Bool? = nil
    var options: [String]? = nil
}

struct AddonCatalog: Codable, Hashable {
    var type: String
    var id: String
    var name: String? = nil
    var extra: [CatalogExtra]? = nil
    var extraSupported: [String]? = nil
    var extraRequired: [String]? = nil

    var supportedExtras: [String] { (extra ?? []).map(\.name) + (extraSupported ?? []) }
    var requiredExtras: [String] {
        (extra ?? []).filter { $0.isRequired == true }.map(\.name) + (extraRequired ?? [])
    }
    /// Catalogs that need no input (like a search term) are shown on Discover.
    var isBrowsable: Bool { requiredExtras.isEmpty }
    var supportsSearch: Bool { supportedExtras.contains("search") }
    var supportsSkip: Bool { supportedExtras.contains("skip") }
    var genreOptions: [String] { extra?.first(where: { $0.name == "genre" })?.options ?? [] }
    var displayName: String { name ?? id.capitalized }
}

struct AddonResource: Codable, Hashable {
    var name: String
    var types: [String]? = nil
    var idPrefixes: [String]? = nil
}

struct AddonManifest: Codable, Hashable {
    var id: String
    var version: String? = nil
    var name: String
    var description: String? = nil
    var logo: String? = nil
    var types: [String]
    var resources: [AddonResource]
    var catalogs: [AddonCatalog]
    var idPrefixes: [String]? = nil
}

struct InstalledAddon: Codable, Hashable, Identifiable {
    /// The manifest URL, or a builtin:// address for sources compiled into the app.
    var transportURL: String
    var manifest: AddonManifest

    var id: String { transportURL }
    var isBuiltIn: Bool { transportURL.hasPrefix("builtin://") }

    func supports(_ resource: String, type: String, id: String) -> Bool {
        guard let res = manifest.resources.first(where: { $0.name == resource }) else { return false }
        let types = res.types ?? manifest.types
        guard types.contains(type) else { return false }
        if let prefixes = res.idPrefixes ?? manifest.idPrefixes, !prefixes.isEmpty {
            return prefixes.contains { id.hasPrefix($0) }
        }
        return true
    }
}

// MARK: - Playback and progress

struct PlaybackRequest: Codable, Hashable {
    var url: String
    var title: String
    var episodeLabel: String? = nil
    var episodeTitle: String? = nil
    var metaId: String
    var videoId: String
    var type: String
    var poster: String? = nil
    var streamTitle: String? = nil

    var windowTitle: String {
        [title, episodeLabel, episodeTitle].compactMap { $0 }.joined(separator: " — ")
    }
}

struct WatchProgress: Codable, Hashable, Identifiable {
    var metaId: String
    var videoId: String
    var type: String
    var name: String
    var poster: String? = nil
    var episodeLabel: String? = nil
    var episodeTitle: String? = nil
    var streamURL: String
    var streamTitle: String? = nil
    var position: Double
    var duration: Double
    var updated: Date

    var id: String { videoId }
    var fraction: Double { duration > 0 ? min(1, max(0, position / duration)) : 0 }
    var isFinished: Bool { fraction >= 0.92 }

    var playbackRequest: PlaybackRequest {
        PlaybackRequest(url: streamURL, title: name, episodeLabel: episodeLabel, episodeTitle: episodeTitle,
                        metaId: metaId, videoId: videoId, type: type, poster: poster, streamTitle: streamTitle)
    }
}

// MARK: - Lenient decoding
// Add-ons are written by many people and disagree on types (a year can be 1999 or "1999",
// genres a string or a list). These helpers accept either, and skip bad list items
// instead of failing the whole response.

extension KeyedDecodingContainer {
    func lenientString(_ key: K) -> String? {
        if let v = try? decode(String.self, forKey: key) { return v }
        if let v = try? decode(Int.self, forKey: key) { return String(v) }
        if let v = try? decode(Double.self, forKey: key) {
            return v.rounded() == v && abs(v) < 1e15 ? String(Int(v)) : String(v)
        }
        return nil
    }

    func lenientStrings(_ key: K) -> [String]? {
        if let v = try? decode([String].self, forKey: key) { return v }
        if let v = try? decode(LossyArray<LenientString>.self, forKey: key) {
            let strings = v.elements.map(\.value)
            return strings.isEmpty ? nil : strings
        }
        if let v = try? decode(String.self, forKey: key) { return [v] }
        return nil
    }

    func lenientInt(_ key: K) -> Int? {
        if let v = try? decode(Int.self, forKey: key) { return v }
        if let v = try? decode(String.self, forKey: key) { return Int(v) }
        if let v = try? decode(Double.self, forKey: key), abs(v) < 1e9 { return Int(v) }
        return nil
    }

    func lossy<T: Decodable>(_ type: T.Type, _ key: K) -> [T]? {
        (try? decode(LossyArray<T>.self, forKey: key))?.elements
    }
}

struct LenientString: Decodable {
    var value: String
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self) { value = s }
        else if let i = try? c.decode(Int.self) { value = String(i) }
        else if let d = try? c.decode(Double.self) { value = String(d) }
        else { throw DecodingError.typeMismatch(String.self, .init(codingPath: c.codingPath, debugDescription: "Not a string")) }
    }
}

/// Decodes an array, dropping elements that fail to decode.
struct LossyArray<Element: Decodable>: Decodable {
    var elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var out: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                out.append(element)
            } else {
                _ = try? container.decode(Skip.self)
            }
        }
        elements = out
    }

    private struct Skip: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

enum DateParsing {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
}

extension MetaPreview {
    private enum Keys: String, CodingKey {
        case id, imdb_id, type, name, title, poster, background, logo, description
        case releaseInfo, year, imdbRating, genres, genre, posterShape
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard let id = c.lenientString(.id) ?? c.lenientString(.imdb_id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "Missing id"))
        }
        self.init(
            id: id,
            type: c.lenientString(.type) ?? "",
            name: c.lenientString(.name) ?? c.lenientString(.title) ?? id,
            poster: c.lenientString(.poster),
            background: c.lenientString(.background),
            logo: c.lenientString(.logo),
            description: c.lenientString(.description),
            releaseInfo: c.lenientString(.releaseInfo) ?? c.lenientString(.year),
            imdbRating: c.lenientString(.imdbRating),
            genres: c.lenientStrings(.genres) ?? c.lenientStrings(.genre),
            posterShape: c.lenientString(.posterShape)
        )
    }
}

extension MetaDetail: Decodable {
    private enum Keys: String, CodingKey {
        case id, imdb_id, type, name, title, poster, background, logo, description
        case releaseInfo, year, imdbRating, genres, genre, runtime, cast, director
        case videos, trailers, trailerStreams, links
    }

    private struct Trailer: Decodable {
        var source: String?
        var ytId: String?
    }

    private struct Link: Decodable {
        var name: String?
        var category: String?
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard let id = c.lenientString(.id) ?? c.lenientString(.imdb_id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "Missing id"))
        }
        self.init(id: id, type: c.lenientString(.type) ?? "",
                  name: c.lenientString(.name) ?? c.lenientString(.title) ?? "")
        poster = c.lenientString(.poster)
        background = c.lenientString(.background)
        logo = c.lenientString(.logo)
        description = c.lenientString(.description)
        releaseInfo = c.lenientString(.releaseInfo) ?? c.lenientString(.year)
        imdbRating = c.lenientString(.imdbRating)
        genres = c.lenientStrings(.genres) ?? c.lenientStrings(.genre)
        runtime = c.lenientString(.runtime)
        videos = c.lossy(MetaVideo.self, .videos)

        let links = c.lossy(Link.self, .links) ?? []
        func fromLinks(_ category: String) -> [String]? {
            let names = links.filter { $0.category == category }.compactMap(\.name)
            return names.isEmpty ? nil : names
        }
        cast = c.lenientStrings(.cast) ?? fromLinks("Cast")
        director = c.lenientStrings(.director) ?? fromLinks("Directors")

        let trailers = (c.lossy(Trailer.self, .trailerStreams) ?? []) + (c.lossy(Trailer.self, .trailers) ?? [])
        trailerYouTubeID = trailers.lazy.compactMap { $0.ytId ?? $0.source }.first
    }
}

extension MetaVideo: Decodable {
    private enum Keys: String, CodingKey {
        case id, title, name, season, episode, number, released, firstAired, thumbnail, overview, description
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        guard let id = c.lenientString(.id) else {
            throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "Missing id"))
        }
        let season = c.lenientInt(.season)
        let episode = c.lenientInt(.episode) ?? c.lenientInt(.number)
        let fallbackTitle = episode.map { "Episode \($0)" } ?? "Video"
        self.init(
            id: id,
            title: c.lenientString(.name) ?? c.lenientString(.title) ?? fallbackTitle,
            season: season,
            episode: episode,
            released: DateParsing.parse(c.lenientString(.released) ?? c.lenientString(.firstAired)),
            thumbnail: c.lenientString(.thumbnail),
            overview: c.lenientString(.overview) ?? c.lenientString(.description)
        )
    }
}

extension StreamItem: Decodable {
    private enum Keys: String, CodingKey {
        case url, ytId, infoHash, externalUrl, name, title, description
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(
            url: c.lenientString(.url),
            ytId: c.lenientString(.ytId),
            infoHash: c.lenientString(.infoHash),
            externalUrl: c.lenientString(.externalUrl),
            name: c.lenientString(.name),
            title: c.lenientString(.title),
            description: c.lenientString(.description)
        )
    }
}

extension AddonResource {
    private enum Keys: String, CodingKey { case name, types, idPrefixes }

    // Resources are either a plain name ("stream") or an object with filters.
    init(from decoder: Decoder) throws {
        if let name = try? decoder.singleValueContainer().decode(String.self) {
            self.init(name: name)
            return
        }
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(name: try c.decode(String.self, forKey: .name),
                  types: c.lenientStrings(.types),
                  idPrefixes: c.lenientStrings(.idPrefixes))
    }
}

extension AddonCatalog {
    private enum Keys: String, CodingKey { case type, id, name, extra, extraSupported, extraRequired }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(type: try c.decode(String.self, forKey: .type),
                  id: try c.decode(String.self, forKey: .id),
                  name: c.lenientString(.name),
                  extra: c.lossy(CatalogExtra.self, .extra),
                  extraSupported: c.lenientStrings(.extraSupported),
                  extraRequired: c.lenientStrings(.extraRequired))
    }
}

extension CatalogExtra {
    private enum Keys: String, CodingKey { case name, isRequired, options }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(name: try c.decode(String.self, forKey: .name),
                  isRequired: try? c.decode(Bool.self, forKey: .isRequired),
                  options: c.lenientStrings(.options))
    }
}

extension AddonManifest {
    private enum Keys: String, CodingKey { case id, version, name, description, logo, types, resources, catalogs, idPrefixes }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  version: c.lenientString(.version),
                  name: c.lenientString(.name) ?? "Unnamed add-on",
                  description: c.lenientString(.description),
                  logo: c.lenientString(.logo),
                  types: c.lenientStrings(.types) ?? [],
                  resources: c.lossy(AddonResource.self, .resources) ?? [],
                  catalogs: c.lossy(AddonCatalog.self, .catalogs) ?? [],
                  idPrefixes: c.lenientStrings(.idPrefixes))
    }
}

// MARK: - Formatting

func typeLabel(_ type: String) -> String {
    switch type {
    case "movie": return "Movies"
    case "series": return "Series"
    case "channel": return "Channels"
    case "tv": return "TV"
    default: return type.capitalized
    }
}

func formatTime(_ seconds: Double) -> String {
    guard seconds.isFinite, seconds >= 0 else { return "0:00" }
    let total = Int(seconds)
    let h = total / 3600, m = (total % 3600) / 60, s = total % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}
