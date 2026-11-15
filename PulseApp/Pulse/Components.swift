import SwiftUI

struct ArtworkView: View {
    let url: URL?
    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            default:
                ZStack {
                    LinearGradient(colors: [Color(white: 0.24), Color(white: 0.12)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    Image(systemName: "music.note").foregroundColor(.secondary)
                }
            }
        }
        .clipped()
    }
}

struct TrackRow: View {
    let track: Track
    let list: [Track]
    let index: Int
    var onRemove: (() -> Void)? = nil

    @EnvironmentObject var player: PlayerManager
    @EnvironmentObject var library: LibraryStore

    private var isCurrent: Bool { player.current?.id == track.id }

    var body: some View {
        HStack(spacing: 8) {
            Button {
                player.play(list, startAt: index)
            } label: {
                HStack(spacing: 12) {
                    ArtworkView(url: track.artworkURL)
                        .frame(width: 50, height: 50)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title)
                            .fontWeight(.semibold)
                            .lineLimit(1)
                            .foregroundColor(isCurrent ? Theme.accent : .white)
                        Text(track.artist)
                            .font(.subheadline)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Button {
                library.toggleLike(track)
            } label: {
                Image(systemName: library.isLiked(track) ? "heart.fill" : "heart")
                    .foregroundColor(library.isLiked(track) ? Theme.accent : .secondary)
                    .frame(width: 34, height: 34)
            }
            .buttonStyle(.plain)

            Menu {
                Button { player.playNext(track) } label: { Label("Play next", systemImage: "text.insert") }
                Button { player.addToQueue(track) } label: { Label("Add to queue", systemImage: "text.append") }
                Menu {
                    if library.playlists.isEmpty {
                        Text("Create a playlist in Your Library first")
                    }
                    ForEach(library.playlists) { p in
                        Button(p.name) { library.add(track, to: p.id) }
                    }
                } label: { Label("Add to playlist", systemImage: "plus") }
                if let onRemove = onRemove {
                    Button(role: .destructive, action: onRemove) { Label("Remove from playlist", systemImage: "trash") }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundColor(.secondary)
                    .frame(width: 34, height: 34)
            }
        }
    }
}

/// Reserves room at the bottom of scrolling screens so the mini player never hides content.
struct MiniPlayerSpacer: ViewModifier {
    @EnvironmentObject var player: PlayerManager
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: player.current == nil ? 0 : 66)
        }
    }
}

extension View {
    func miniPlayerSpacer() -> some View { modifier(MiniPlayerSpacer()) }
}

struct MiniPlayerBar: View {
    @EnvironmentObject var player: PlayerManager
    @EnvironmentObject var library: LibraryStore

    var body: some View {
        if let t = player.current {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    ArtworkView(url: t.artworkURL)
                        .frame(width: 46, height: 46)
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(t.title).font(.subheadline).fontWeight(.semibold).lineLimit(1)
                        Text(t.artist).font(.caption).foregroundColor(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Button { library.toggleLike(t) } label: {
                        Image(systemName: library.isLiked(t) ? "heart.fill" : "heart")
                            .foregroundColor(library.isLiked(t) ? Theme.accent : .white)
                            .frame(width: 36, height: 36)
                    }
                    Button { player.togglePlay() } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title3)
                            .frame(width: 36, height: 36)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 7)
                GeometryReader { geo in
                    Rectangle().fill(Color.white.opacity(0.15))
                        .overlay(alignment: .leading) {
                            Rectangle().fill(Color.white)
                                .frame(width: geo.size.width * CGFloat(min(1, player.currentTime / max(player.duration, 1))))
                        }
                }
                .frame(height: 2)
            }
            .background(Color(white: 0.16))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 8)
            .shadow(color: .black.opacity(0.4), radius: 8, y: 2)
            .onTapGesture { player.showNowPlaying = true }
            .buttonStyle(.plain)
        }
    }
}

struct MessageBanner: View {
    @EnvironmentObject var player: PlayerManager
    var body: some View {
        if let m = player.message {
            Text(m)
                .font(.subheadline.weight(.semibold))
                .foregroundColor(.black)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Capsule().fill(Color.white))
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: m) {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    withAnimation { player.message = nil }
                }
        }
    }
}

struct LoadingOrError: View {
    let loading: Bool
    let error: String?
    var body: some View {
        if loading {
            ProgressView().padding(.top, 40).frame(maxWidth: .infinity)
        } else if let e = error {
            VStack(spacing: 6) {
                Image(systemName: "wifi.exclamationmark").font(.largeTitle)
                Text("Couldn't load music").fontWeight(.semibold)
                Text(e).font(.footnote).foregroundColor(.secondary).multilineTextAlignment(.center)
            }
            .padding(.top, 40).frame(maxWidth: .infinity)
        }
    }
}
