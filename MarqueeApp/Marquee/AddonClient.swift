import Foundation

enum AddonError: LocalizedError {
    case badURL
    case badResponse(Int)

    var errorDescription: String? {
        switch self {
        case .badURL: return "That doesn't look like an add-on address."
        case .badResponse(let code): return "The add-on answered with an error (HTTP \(code))."
        }
    }
}

/// Talks to add-ons over the open Stremio add-on protocol:
///   {base}/manifest.json
///   {base}/catalog/{type}/{id}[/{extra}].json  -> { metas: [...] }
///   {base}/meta/{type}/{id}.json               -> { meta: {...} }
///   {base}/stream/{type}/{id}.json             -> { streams: [...] }
/// Built-in sources (builtin://) are answered in-process instead.
enum AddonClient {
    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.httpAdditionalHeaders = ["Accept": "application/json"]
        return URLSession(configuration: config)
    }()

    static func getJSON<T: Decodable>(_ type: T.Type, from url: URL) async throws -> T {
        let (data, response) = try await session.data(from: url)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw AddonError.badResponse(http.statusCode)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// Accepts "https://host/manifest.json", "stremio://host/manifest.json" or just "host/path".
    static func normalizeManifestURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if s.lowercased().hasPrefix("stremio://") {
            s = "https://" + s.dropFirst("stremio://".count)
        }
        if !s.contains("://") { s = "https://" + s }
        if !s.hasSuffix("/manifest.json") {
            while s.hasSuffix("/") { s.removeLast() }
            s += "/manifest.json"
        }
        guard let url = URL(string: s), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host != nil else { return nil }
        return url
    }

    static func fetchManifest(_ raw: String) async throws -> InstalledAddon {
        guard let url = normalizeManifestURL(raw) else { throw AddonError.badURL }
        let manifest = try await getJSON(AddonManifest.self, from: url)
        return InstalledAddon(transportURL: url.absoluteString, manifest: manifest)
    }

    private static let unreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func encode(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s
    }

    static func resourceURL(_ addon: InstalledAddon, resource: String, type: String, id: String,
                            extra: [(String, String)] = []) -> URL? {
        var base = addon.transportURL
        if base.hasSuffix("/manifest.json") { base.removeLast("/manifest.json".count) }
        var path = "\(base)/\(resource)/\(encode(type))/\(encode(id))"
        if !extra.isEmpty {
            path += "/" + extra.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
        }
        return URL(string: path + ".json")
    }

    // MARK: Resources

    private struct CatalogResponse: Decodable {
        var metas: [MetaPreview]
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            metas = c.lossy(MetaPreview.self, .metas) ?? []
        }
        enum Keys: String, CodingKey { case metas }
    }

    private struct MetaResponse: Decodable {
        var meta: MetaDetail?
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            meta = try? c.decode(MetaDetail.self, forKey: .meta)
        }
        enum Keys: String, CodingKey { case meta }
    }

    private struct StreamResponse: Decodable {
        var streams: [StreamItem]
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            streams = c.lossy(StreamItem.self, .streams) ?? []
        }
        enum Keys: String, CodingKey { case streams }
    }

    static func catalog(_ addon: InstalledAddon, type: String, id: String,
                        extra: [(String, String)] = []) async throws -> [MetaPreview] {
        let metas: [MetaPreview]
        if addon.transportURL == ArchiveSource.transportURL {
            metas = try await ArchiveSource.catalog(id: id, extra: extra)
        } else {
            guard let url = resourceURL(addon, resource: "catalog", type: type, id: id, extra: extra) else {
                throw AddonError.badURL
            }
            metas = try await getJSON(CatalogResponse.self, from: url).metas
        }
        return metas.map { meta in
            var m = meta
            if m.type.isEmpty { m.type = type }
            return m
        }
    }

    static func meta(_ addon: InstalledAddon, type: String, id: String) async throws -> MetaDetail? {
        if addon.transportURL == ArchiveSource.transportURL {
            return try await ArchiveSource.meta(id: id)
        }
        guard let url = resourceURL(addon, resource: "meta", type: type, id: id) else { throw AddonError.badURL }
        return try await getJSON(MetaResponse.self, from: url).meta
    }

    static func streams(_ addon: InstalledAddon, type: String, id: String) async throws -> [StreamItem] {
        if addon.transportURL == ArchiveSource.transportURL {
            return try await ArchiveSource.streams(id: id)
        }
        guard let url = resourceURL(addon, resource: "stream", type: type, id: id) else { throw AddonError.badURL }
        return try await getJSON(StreamResponse.self, from: url).streams
    }
}

enum DefaultAddons {
    static let cinemetaURL = "https://v3-cinemeta.strem.io/manifest.json"

    /// The public metadata catalog Stremio uses (posters, descriptions, episode lists).
    /// It lists titles but has no video. This copy is used until the live manifest loads.
    static var cinemeta: InstalledAddon {
        let genres = ["Action", "Adventure", "Animation", "Biography", "Comedy", "Crime", "Documentary",
                      "Drama", "Family", "Fantasy", "History", "Horror", "Mystery", "Romance", "Sci-Fi",
                      "Sport", "Thriller", "War", "Western"]
        let extras = [CatalogExtra(name: "genre", options: genres), CatalogExtra(name: "search"), CatalogExtra(name: "skip")]
        let manifest = AddonManifest(
            id: "com.linvo.cinemeta",
            version: nil,
            name: "Cinemeta",
            description: "Movie and series information: posters, descriptions, cast and episode lists.",
            logo: nil,
            types: ["movie", "series"],
            resources: [AddonResource(name: "catalog"), AddonResource(name: "meta")],
            catalogs: [
                AddonCatalog(type: "movie", id: "top", name: "Popular", extra: extras),
                AddonCatalog(type: "series", id: "top", name: "Popular", extra: extras),
            ],
            idPrefixes: ["tt"]
        )
        return InstalledAddon(transportURL: cinemetaURL, manifest: manifest)
    }

    static var archive: InstalledAddon {
        InstalledAddon(transportURL: ArchiveSource.transportURL, manifest: ArchiveSource.manifest)
    }

    /// Internet Archive first: its titles can actually be played.
    static var all: [InstalledAddon] { [archive, cinemeta] }
}
