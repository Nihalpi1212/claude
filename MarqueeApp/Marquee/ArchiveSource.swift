import Foundation

/// Built-in source for the Internet Archive (archive.org): public-domain and openly licensed
/// films, cartoons and old TV. Answers the same catalog / meta / stream questions as a remote add-on.
enum ArchiveSource {
    static let transportURL = "builtin://internet-archive"
    static let idPrefix = "ia:"
    static let pageSize = 40

    /// archive.org collections shown as rows on Discover. A collection that returns nothing
    /// is simply hidden.
    static let collections: [(id: String, name: String)] = [
        ("feature_films", "Public Domain Films"),
        ("SciFi_Horror", "Sci-Fi & Horror"),
        ("Film_Noir", "Film Noir"),
        ("comedy_films", "Comedy Classics"),
        ("classic_cartoons", "Classic Cartoons"),
        ("silent_films", "Silent Films"),
        ("classic_tv", "Classic TV"),
    ]

    static var manifest: AddonManifest {
        var catalogs = collections.map {
            AddonCatalog(type: "movie", id: "ia_\($0.id)", name: $0.name, extra: [CatalogExtra(name: "skip")])
        }
        catalogs.append(AddonCatalog(type: "movie", id: "ia_search", name: "Internet Archive",
                                     extra: [CatalogExtra(name: "search", isRequired: true), CatalogExtra(name: "skip")]))
        return AddonManifest(
            id: "builtin.internetarchive",
            version: "1.0.0",
            name: "Internet Archive",
            description: "Public-domain and openly licensed films, cartoons and classic TV from archive.org. Free and ad-free.",
            logo: nil,
            types: ["movie"],
            resources: [AddonResource(name: "catalog"), AddonResource(name: "meta"), AddonResource(name: "stream")],
            catalogs: catalogs,
            idPrefixes: [idPrefix]
        )
    }

    static func identifier(from id: String) -> String {
        id.hasPrefix(idPrefix) ? String(id.dropFirst(idPrefix.count)) : id
    }

    static func thumbnail(_ identifier: String) -> String {
        "https://archive.org/services/img/\(AddonClient.encode(identifier))"
    }

    // MARK: Catalog and search

    fileprivate struct SearchResponse: Decodable {
        struct Inner: Decodable { var docs: LossyArray<Doc> }
        var response: Inner
    }

    fileprivate struct Doc: Decodable {
        var identifier: String
        var title: String?
        var year: String?
        var description: String?
        var subject: [String]?

        enum Keys: String, CodingKey { case identifier, title, year, date, description, subject }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            guard let ident = c.lenientString(.identifier) else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "No identifier"))
            }
            identifier = ident
            title = c.lenientStrings(.title)?.first
            year = c.lenientString(.year) ?? c.lenientString(.date).map { String($0.prefix(4)) }
            description = c.lenientStrings(.description)?.joined(separator: "\n")
            subject = c.lenientStrings(.subject)
        }
    }

    static func catalog(id: String, extra: [(String, String)]) async throws -> [MetaPreview] {
        let skip = Int(extra.first(where: { $0.0 == "skip" })?.1 ?? "") ?? 0
        let search = extra.first(where: { $0.0 == "search" })?.1

        let query: String
        var sortByPopularity = true
        if let search, !search.isEmpty {
            let words = search.components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
            guard !words.isEmpty else { return [] }
            let all = collections.map(\.id).joined(separator: " OR ")
            query = "title:(\(words.joined(separator: " AND "))) AND mediatype:(movies) AND collection:(\(all))"
            sortByPopularity = false
        } else {
            let collection = id.hasPrefix("ia_") ? String(id.dropFirst(3)) : id
            query = "collection:(\(collection)) AND mediatype:(movies)"
        }

        var components = URLComponents(string: "https://archive.org/advancedsearch.php")!
        var items: [URLQueryItem] = [URLQueryItem(name: "q", value: query)]
        for field in ["identifier", "title", "year", "date", "description", "subject"] {
            items.append(URLQueryItem(name: "fl[]", value: field))
        }
        if sortByPopularity { items.append(URLQueryItem(name: "sort[]", value: "downloads desc")) }
        items += [
            URLQueryItem(name: "rows", value: String(pageSize)),
            URLQueryItem(name: "page", value: String(skip / pageSize + 1)),
            URLQueryItem(name: "output", value: "json"),
        ]
        components.queryItems = items
        guard let url = components.url else { throw AddonError.badURL }

        let response = try await AddonClient.getJSON(SearchResponse.self, from: url)
        return response.response.docs.elements.map { doc in
            MetaPreview(
                id: idPrefix + doc.identifier,
                type: "movie",
                name: doc.title ?? doc.identifier,
                poster: thumbnail(doc.identifier),
                description: doc.description.map(stripHTML),
                releaseInfo: doc.year,
                genres: doc.subject.map { Array($0.prefix(3)) }
            )
        }
    }

    // MARK: Item details and files

    struct Item: Sendable {
        var metadata: Metadata?
        var files: [File]
    }

    struct Metadata: Sendable {
        var title: String?
        var description: String?
        var year: String?
        var runtime: String?
        var creator: [String]?
        var subject: [String]?
    }

    struct File: Sendable {
        var name: String
        var format: String?
        var size: Int64
        var height: Int?

        var isPlayableVideo: Bool {
            let n = name.lowercased()
            return n.hasSuffix(".mp4") || n.hasSuffix(".m4v") || n.hasSuffix(".mov")
        }

        /// Prefer the modern h.264 copies over the old low-bitrate "512Kb" ones.
        var rank: Int {
            let f = (format ?? "").lowercased()
            if f.contains("512kb") { return 0 }
            if f.contains("h.264") { return 2 }
            return 1
        }
    }

    static func fetchItem(_ identifier: String) async throws -> Item {
        try await ArchiveItemCache.shared.item(identifier)
    }

    static func meta(id: String) async throws -> MetaDetail? {
        let ident = identifier(from: id)
        let item = try await fetchItem(ident)
        guard let md = item.metadata else { return nil }
        var detail = MetaDetail(id: id, type: "movie", name: md.title ?? ident)
        detail.poster = thumbnail(ident)
        detail.description = md.description.map(stripHTML)
        detail.releaseInfo = md.year
        detail.runtime = md.runtime
        detail.genres = md.subject.map { Array($0.prefix(4)) }
        detail.director = md.creator
        return detail
    }

    static func streams(id: String) async throws -> [StreamItem] {
        let ident = identifier(from: id)
        let item = try await fetchItem(ident)
        let videos = item.files.filter(\.isPlayableVideo)
            .sorted { ($0.rank, $0.size) > ($1.rank, $1.size) }
            .prefix(12)
        let pathAllowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "+&=;"))
        return videos.compactMap { (file: File) -> StreamItem? in
            guard let encodedName = file.name.addingPercentEncoding(withAllowedCharacters: pathAllowed) else { return nil }
            let url = "https://archive.org/download/\(AddonClient.encode(ident))/\(encodedName)"
            var details: [String] = []
            if let h = file.height, h > 0 { details.append("\(h)p") }
            if let format = file.format { details.append(format) }
            if file.size > 0 { details.append(ByteCountFormatter.string(fromByteCount: file.size, countStyle: .file)) }
            let baseName = (file.name as NSString).lastPathComponent
            return StreamItem(url: url, name: "Internet Archive\n\(file.height.map { "\($0)p" } ?? "SD")",
                              title: baseName, description: ([baseName] + [details.joined(separator: " · ")]).joined(separator: "\n"))
        }
    }

    static func stripHTML(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "<br\\s*/?>", with: "\n", options: [.regularExpression, .caseInsensitive])
        t = t.replacingOccurrences(of: "</p>", with: "\n\n", options: .caseInsensitive)
        t = t.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (entity, char) in ["&amp;": "&", "&quot;": "\"", "&#39;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " "] {
            t = t.replacingOccurrences(of: entity, with: char)
        }
        t = t.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Raw archive.org metadata responses, decoded leniently.
private struct ArchiveItemResponse: Decodable {
    struct RawMetadata: Decodable {
        var value: ArchiveSource.Metadata
        enum Keys: String, CodingKey { case title, description, year, date, runtime, creator, subject }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            value = ArchiveSource.Metadata(
                title: c.lenientStrings(.title)?.first,
                description: c.lenientStrings(.description)?.joined(separator: "\n"),
                year: c.lenientString(.year) ?? c.lenientString(.date).map { String($0.prefix(4)) },
                runtime: c.lenientString(.runtime),
                creator: c.lenientStrings(.creator),
                subject: c.lenientStrings(.subject)
            )
        }
    }

    struct RawFile: Decodable {
        var value: ArchiveSource.File
        enum Keys: String, CodingKey { case name, format, size, height }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            guard let name = c.lenientString(.name) else {
                throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "No name"))
            }
            value = ArchiveSource.File(name: name, format: c.lenientString(.format),
                                       size: Int64(c.lenientString(.size) ?? "") ?? 0,
                                       height: c.lenientInt(.height))
        }
    }

    var item: ArchiveSource.Item

    enum Keys: String, CodingKey { case metadata, files }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        item = ArchiveSource.Item(
            metadata: (try? c.decode(RawMetadata.self, forKey: .metadata))?.value,
            files: (c.lossy(RawFile.self, .files) ?? []).map(\.value)
        )
    }
}

/// Details and streams for the same title use one archive.org request.
actor ArchiveItemCache {
    static let shared = ArchiveItemCache()
    private var items: [String: ArchiveSource.Item] = [:]

    func item(_ identifier: String) async throws -> ArchiveSource.Item {
        if let cached = items[identifier] { return cached }
        guard let url = URL(string: "https://archive.org/metadata/\(AddonClient.encode(identifier))") else {
            throw AddonError.badURL
        }
        let item = try await AddonClient.getJSON(ArchiveItemResponse.self, from: url).item
        items[identifier] = item
        return item
    }
}
