import SwiftUI

struct LibraryView: View {
    @EnvironmentObject var library: LibraryStore
    @State private var showNew = false
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                NavigationLink(value: PlaylistRef.liked) {
                    HStack(spacing: 12) {
                        ZStack {
                            LinearGradient(colors: [Color(red: 0.27, green: 0, blue: 0.88), Color(red: 0.6, green: 0.69, blue: 0.96)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                            Image(systemName: "heart.fill").foregroundColor(.white)
                        }
                        .frame(width: 54, height: 54).clipShape(RoundedRectangle(cornerRadius: 6))
                        VStack(alignment: .leading) {
                            Text("Liked Songs").fontWeight(.semibold)
                            Text("Playlist · \(library.liked.count) songs").font(.subheadline).foregroundColor(.secondary)
                        }
                    }
                }
                ForEach(library.playlists) { p in
                    NavigationLink(value: PlaylistRef.custom(p.id)) {
                        HStack(spacing: 12) {
                            ZStack {
                                Color(white: 0.2)
                                Image(systemName: "music.note").foregroundColor(.secondary)
                            }
                            .frame(width: 54, height: 54).clipShape(RoundedRectangle(cornerRadius: 6))
                            VStack(alignment: .leading) {
                                Text(p.name).fontWeight(.semibold)
                                Text("Playlist · \(p.tracks.count) songs").font(.subheadline).foregroundColor(.secondary)
                            }
                        }
                    }
                }
                .onDelete { library.deletePlaylists(at: $0) }

                if !library.recent.isEmpty {
                    Section("Recently played") {
                        ForEach(Array(library.recent.prefix(15).enumerated()), id: \.element.id) { i, t in
                            TrackRow(track: t, list: Array(library.recent.prefix(15)), index: i)
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Your Library")
            .navigationDestination(for: PlaylistRef.self) { PlaylistDetailView(ref: $0) }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { newName = ""; showNew = true } label: { Image(systemName: "plus") }
                }
            }
            .alert("New playlist", isPresented: $showNew) {
                TextField("Name", text: $newName)
                Button("Create") { library.createPlaylist(named: newName.trimmingCharacters(in: .whitespaces)) }
                Button("Cancel", role: .cancel) {}
            }
            .miniPlayerSpacer()
        }
    }
}

enum PlaylistRef: Hashable {
    case liked
    case custom(UUID)
}

struct PlaylistDetailView: View {
    let ref: PlaylistRef
    @EnvironmentObject var library: LibraryStore
    @EnvironmentObject var player: PlayerManager
    @Environment(\.dismiss) private var dismiss
    @State private var showRename = false
    @State private var showDelete = false
    @State private var nameField = ""

    private var title: String {
        switch ref {
        case .liked: return "Liked Songs"
        case .custom(let id): return library.playlists.first { $0.id == id }?.name ?? "Playlist"
        }
    }
    private var tracks: [Track] {
        switch ref {
        case .liked: return library.liked
        case .custom(let id): return library.playlists.first { $0.id == id }?.tracks ?? []
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(tracks.count) songs").foregroundColor(.secondary)
                if !tracks.isEmpty {
                    HStack(spacing: 10) {
                        Button { player.shuffle = false; player.play(tracks, startAt: 0) } label: {
                            Label("Play", systemImage: "play.fill").fontWeight(.bold)
                                .padding(.horizontal, 22).padding(.vertical, 10)
                                .background(Capsule().fill(Theme.accent)).foregroundColor(.black)
                        }
                        Button {
                            player.shuffle = true
                            player.play(tracks, startAt: Int.random(in: 0..<tracks.count))
                        } label: {
                            Label("Shuffle", systemImage: "shuffle").fontWeight(.semibold)
                                .padding(.horizontal, 20).padding(.vertical, 10)
                                .background(Capsule().fill(Color(white: 0.2)))
                        }
                    }
                    .buttonStyle(.plain)
                } else {
                    Text("Nothing here yet. Use the ⋯ menu on any song to add it.")
                        .foregroundColor(.secondary).padding(.top, 30).frame(maxWidth: .infinity)
                }
                ForEach(Array(tracks.enumerated()), id: \.element.id) { i, t in
                    TrackRow(track: t, list: tracks, index: i, onRemove: removeAction(for: t))
                }
            }
            .padding(.horizontal, 16)
        }
        .navigationTitle(title)
        .toolbar {
            if case .custom = ref {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button { nameField = title; showRename = true } label: { Label("Rename", systemImage: "pencil") }
                        Button(role: .destructive) { showDelete = true } label: { Label("Delete playlist", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
        .alert("Rename playlist", isPresented: $showRename) {
            TextField("Name", text: $nameField)
            Button("Save") { if case .custom(let id) = ref { library.rename(id, to: nameField.trimmingCharacters(in: .whitespaces)) } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Delete this playlist?", isPresented: $showDelete) {
            Button("Delete", role: .destructive) {
                if case .custom(let id) = ref { library.deletePlaylist(id); dismiss() }
            }
            Button("Cancel", role: .cancel) {}
        }
        .miniPlayerSpacer()
    }

    private func removeAction(for t: Track) -> (() -> Void)? {
        if case .custom(let id) = ref { return { library.remove(t, from: id) } }
        return nil
    }
}
