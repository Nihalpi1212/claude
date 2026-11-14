import Foundation

/// Liked songs, playlists and history, saved as JSON in the app's Documents folder.
final class LibraryStore: ObservableObject {
    @Published var liked: [Track] = [] { didSet { save() } }
    @Published var playlists: [Playlist] = [] { didSet { save() } }
    @Published var recent: [Track] = [] { didSet { save() } }

    private struct Snapshot: Codable {
        var liked: [Track]
        var playlists: [Playlist]
        var recent: [Track]
    }

    private let fileURL: URL = FileManager.default
        .urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("library.json")

    init() { load() }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let snap = try? JSONDecoder().decode(Snapshot.self, from: data) else { return }
        liked = snap.liked
        playlists = snap.playlists
        recent = snap.recent
    }

    private func save() {
        let snap = Snapshot(liked: liked, playlists: playlists, recent: recent)
        if let data = try? JSONEncoder().encode(snap) { try? data.write(to: fileURL, options: .atomic) }
    }

    func isLiked(_ t: Track) -> Bool { liked.contains { $0.id == t.id } }

    func toggleLike(_ t: Track) {
        if let i = liked.firstIndex(where: { $0.id == t.id }) { liked.remove(at: i) } else { liked.insert(t, at: 0) }
    }

    func addRecent(_ t: Track) {
        recent.removeAll { $0.id == t.id }
        recent.insert(t, at: 0)
        if recent.count > 30 { recent.removeLast(recent.count - 30) }
    }

    @discardableResult
    func createPlaylist(named name: String) -> Playlist {
        let p = Playlist(name: name.isEmpty ? "My playlist" : name)
        playlists.append(p)
        return p
    }

    func rename(_ id: UUID, to name: String) {
        if let i = playlists.firstIndex(where: { $0.id == id }), !name.isEmpty { playlists[i].name = name }
    }

    func deletePlaylists(at offsets: IndexSet) { playlists.remove(atOffsets: offsets) }
    func deletePlaylist(_ id: UUID) { playlists.removeAll { $0.id == id } }

    func add(_ t: Track, to id: UUID) {
        guard let i = playlists.firstIndex(where: { $0.id == id }) else { return }
        if !playlists[i].tracks.contains(where: { $0.id == t.id }) { playlists[i].tracks.append(t) }
    }

    func remove(_ t: Track, from id: UUID) {
        guard let i = playlists.firstIndex(where: { $0.id == id }) else { return }
        playlists[i].tracks.removeAll { $0.id == t.id }
    }
}
