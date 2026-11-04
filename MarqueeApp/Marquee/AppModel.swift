import AppKit
import Foundation

private struct PersistedState: Codable {
    var addons: [InstalledAddon] = []
    var library: [MetaPreview] = []
    var progress: [String: WatchProgress] = [:]
    var localFolders: [String] = []
}

/// Everything the app remembers, saved to ~/Library/Application Support/Marquee/state.json.
@MainActor
final class AppModel: ObservableObject {
    @Published var addons: [InstalledAddon] = [] { didSet { scheduleSave() } }
    @Published var library: [MetaPreview] = [] { didSet { scheduleSave() } }
    @Published var progress: [String: WatchProgress] = [:] { didSet { scheduleSave() } }
    @Published var localFolders: [String] = [] { didSet { scheduleSave() } }

    private let fileURL: URL
    private var saveTask: Task<Void, Never>?

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Marquee", isDirectory: true)
        try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        fileURL = support.appendingPathComponent("state.json")

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let data = try? Data(contentsOf: fileURL),
           let state = try? decoder.decode(PersistedState.self, from: data) {
            addons = state.addons
            library = state.library
            progress = state.progress
            localFolders = state.localFolders
        } else {
            addons = DefaultAddons.all
            if let movies = FileManager.default.urls(for: .moviesDirectory, in: .userDomainMask).first {
                localFolders = [movies.path]
            }
        }

        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.saveNow() }
        }

        Task { await refreshManifests() }
    }

    // MARK: Saving

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            self?.saveNow()
        }
    }

    func saveNow() {
        let state = PersistedState(addons: addons, library: library, progress: progress, localFolders: localFolders)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(state) {
            try? data.write(to: fileURL, options: .atomic)
        }
    }

    // MARK: Add-ons

    func installAddon(from raw: String) async throws {
        let addon = try await AddonClient.fetchManifest(raw)
        if let i = addons.firstIndex(where: { $0.transportURL == addon.transportURL || $0.manifest.id == addon.manifest.id }) {
            addons[i] = addon
        } else {
            addons.append(addon)
        }
    }

    func removeAddon(_ addon: InstalledAddon) {
        addons.removeAll { $0.transportURL == addon.transportURL }
    }

    func moveAddon(_ addon: InstalledAddon, by offset: Int) {
        guard let i = addons.firstIndex(of: addon) else { return }
        let j = i + offset
        guard addons.indices.contains(j) else { return }
        addons.swapAt(i, j)
    }

    func restoreDefaultAddons() {
        for addon in DefaultAddons.all.reversed() where !addons.contains(where: { $0.transportURL == addon.transportURL }) {
            addons.insert(addon, at: 0)
        }
    }

    /// Picks up catalog changes from remote add-ons, and the current built-in manifest.
    func refreshManifests() async {
        for i in addons.indices where addons[i].transportURL == ArchiveSource.transportURL {
            addons[i].manifest = ArchiveSource.manifest
        }
        for addon in addons where !addon.isBuiltIn {
            guard let fresh = try? await AddonClient.fetchManifest(addon.transportURL),
                  let i = addons.firstIndex(where: { $0.transportURL == addon.transportURL }),
                  fresh.manifest != addons[i].manifest else { continue }
            addons[i].manifest = fresh.manifest
        }
    }

    func addon(withURL url: String) -> InstalledAddon? {
        addons.first { $0.transportURL == url }
    }

    // MARK: Library

    func isInLibrary(_ id: String) -> Bool { library.contains { $0.id == id } }

    func toggleLibrary(_ meta: MetaPreview) {
        if let i = library.firstIndex(where: { $0.id == meta.id }) {
            library.remove(at: i)
        } else {
            library.insert(meta, at: 0)
        }
    }

    // MARK: Progress

    func updateProgress(for request: PlaybackRequest, position: Double, duration: Double) {
        guard position.isFinite, duration.isFinite, duration > 0 else { return }
        progress[request.videoId] = WatchProgress(
            metaId: request.metaId, videoId: request.videoId, type: request.type, name: request.title,
            poster: request.poster, episodeLabel: request.episodeLabel, episodeTitle: request.episodeTitle,
            streamURL: request.url, streamTitle: request.streamTitle,
            position: position, duration: duration, updated: Date())
    }

    func removeProgress(_ videoId: String) {
        progress[videoId] = nil
    }

    func isWatched(_ videoId: String) -> Bool { progress[videoId]?.isFinished ?? false }

    /// The latest unfinished video for each title, newest first.
    var continueWatching: [WatchProgress] {
        var seen = Set<String>()
        return progress.values
            .sorted { $0.updated > $1.updated }
            .filter { seen.insert($0.metaId).inserted }
            .filter { !$0.isFinished && $0.position > 15 }
    }

    // MARK: Local folders

    func addLocalFolder(_ path: String) {
        guard !localFolders.contains(path) else { return }
        localFolders.append(path)
    }

    func removeLocalFolder(_ path: String) {
        localFolders.removeAll { $0 == path }
    }
}

// MARK: - Local files

struct LocalVideo: Identifiable, Hashable {
    var url: URL
    var size: Int64
    var modified: Date

    var id: String { url.absoluteString }

    var displayName: String {
        url.deletingPathExtension().lastPathComponent
            .replacingOccurrences(of: ".", with: " ")
            .replacingOccurrences(of: "_", with: " ")
    }

    /// Formats the built-in player (AVFoundation) handles. Others open in the default app.
    var playsInApp: Bool { LocalVideo.nativeExtensions.contains(url.pathExtension.lowercased()) }

    static let nativeExtensions: Set<String> = ["mp4", "m4v", "mov"]
    static let allExtensions: Set<String> = nativeExtensions.union(["mkv", "avi", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts", "3gp", "ogv"])

    static func scan(_ folders: [String]) async -> [LocalVideo] {
        await Task.detached(priority: .userInitiated) { LocalVideo.scanSync(folders) }.value
    }

    // Synchronous on purpose: directory enumerators can't be iterated from async code.
    private static func scanSync(_ folders: [String]) -> [LocalVideo] {
        var found: [LocalVideo] = []
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
        for folder in folders {
            let root = URL(fileURLWithPath: folder, isDirectory: true)
            guard let walker = FileManager.default.enumerator(
                at: root, includingPropertiesForKeys: keys,
                options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            while let url = walker.nextObject() as? URL {
                guard LocalVideo.allExtensions.contains(url.pathExtension.lowercased()),
                      let values = try? url.resourceValues(forKeys: Set(keys)),
                      values.isRegularFile == true else { continue }
                found.append(LocalVideo(url: url, size: Int64(values.fileSize ?? 0),
                                        modified: values.contentModificationDate ?? .distantPast))
            }
        }
        var seen = Set<URL>()
        return found.filter { seen.insert($0.url).inserted }.sorted { $0.modified > $1.modified }
    }
}
