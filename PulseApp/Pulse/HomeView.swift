import SwiftUI

struct HomeView: View {
    @EnvironmentObject var library: LibraryStore
    @EnvironmentObject var player: PlayerManager
    @State private var trending: [Track] = []
    @State private var loading = true
    @State private var error: String?

    private var greeting: String {
        let h = Calendar.current.component(.hour, from: Date())
        return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Text(greeting).font(.largeTitle.bold())

                    if !library.recent.isEmpty {
                        Text("Recently played").font(.title3.bold())
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 14) {
                                ForEach(Array(library.recent.prefix(12).enumerated()), id: \.element.id) { i, t in
                                    Button { player.play(Array(library.recent.prefix(12)), startAt: i) } label: {
                                        VStack(alignment: .leading, spacing: 6) {
                                            ArtworkView(url: t.artworkURL)
                                                .frame(width: 130, height: 130)
                                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                            Text(t.title).font(.footnote.weight(.semibold)).lineLimit(1)
                                            Text(t.artist).font(.caption).foregroundColor(.secondary).lineLimit(1)
                                        }
                                        .frame(width: 130, alignment: .leading)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                    }

                    Text("Browse genres").font(.title3.bold())
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible())], spacing: 12) {
                        ForEach(Genre.all) { g in
                            NavigationLink(value: g) {
                                Text(g.name)
                                    .font(.headline)
                                    .foregroundColor(.white)
                                    .padding(12)
                                    .frame(maxWidth: .infinity, minHeight: 84, alignment: .topLeading)
                                    .background(RoundedRectangle(cornerRadius: 10).fill(g.color))
                            }
                        }
                    }

                    Text("Trending this week").font(.title3.bold())
                    LoadingOrError(loading: loading, error: error)
                    ForEach(Array(trending.enumerated()), id: \.element.id) { i, t in
                        TrackRow(track: t, list: trending, index: i)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
            }
            .navigationDestination(for: Genre.self) { GenreView(genre: $0) }
            .toolbar(.hidden, for: .navigationBar)
            .miniPlayerSpacer()
            .task { await load() }
            .refreshable { await load() }
        }
    }

    private func load() async {
        loading = trending.isEmpty
        do {
            trending = try await Catalog.trending(genre: nil)
            error = nil
        } catch let e {
            error = e.localizedDescription
        }
        loading = false
    }
}

struct GenreView: View {
    let genre: Genre
    @State private var tracks: [Track] = []
    @State private var loading = true
    @State private var error: String?
    @EnvironmentObject var player: PlayerManager

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !tracks.isEmpty {
                    HStack(spacing: 10) {
                        Button { player.play(tracks, startAt: 0) } label: {
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
                }
                LoadingOrError(loading: loading, error: error)
                ForEach(Array(tracks.enumerated()), id: \.element.id) { i, t in
                    TrackRow(track: t, list: tracks, index: i)
                }
            }
            .padding(.horizontal, 16)
        }
        .navigationTitle(genre.name)
        .miniPlayerSpacer()
        .task {
            do { tracks = try await Catalog.trending(genre: genre) } catch let e { error = e.localizedDescription }
            loading = false
        }
    }
}
