import SwiftUI

struct NowPlayingView: View {
    @EnvironmentObject var player: PlayerManager
    @EnvironmentObject var library: LibraryStore
    @State private var scrubbing = false
    @State private var scrubValue = 0.0
    @State private var showQueue = false

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.2, green: 0.25, blue: 0.42), .black], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            VStack(spacing: 22) {
                HStack {
                    Button { player.showNowPlaying = false } label: {
                        Image(systemName: "chevron.down").font(.title3.bold()).frame(width: 44, height: 44)
                    }
                    Spacer()
                    Text("NOW PLAYING").font(.caption.bold()).foregroundColor(.secondary)
                    Spacer()
                    Button { showQueue = true } label: {
                        Image(systemName: "list.bullet").font(.title3).frame(width: 44, height: 44)
                    }
                }
                Spacer(minLength: 0)

                ArtworkView(url: player.current?.artworkURL)
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .shadow(color: .black.opacity(0.5), radius: 24, y: 10)

                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(player.current?.title ?? "Nothing playing")
                            .font(.title2.bold()).lineLimit(2)
                        Text(player.current?.artist ?? "")
                            .foregroundColor(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if let t = player.current {
                        Button { library.toggleLike(t) } label: {
                            Image(systemName: library.isLiked(t) ? "heart.fill" : "heart")
                                .font(.title2)
                                .foregroundColor(library.isLiked(t) ? Theme.accent : .white)
                        }
                    }
                }

                VStack(spacing: 2) {
                    Slider(
                        value: Binding(
                            get: { scrubbing ? scrubValue : min(player.currentTime, max(player.duration, 1)) },
                            set: { scrubValue = $0 }),
                        in: 0...max(player.duration, 1),
                        onEditingChanged: { editing in
                            if editing { scrubValue = player.currentTime }
                            if !editing { player.seek(to: scrubValue) }
                            scrubbing = editing
                        })
                    .tint(.white)
                    HStack {
                        Text(formatTime(scrubbing ? scrubValue : player.currentTime))
                        Spacer()
                        Text(formatTime(player.duration))
                    }
                    .font(.caption).foregroundColor(.secondary)
                }

                HStack {
                    Button { player.shuffle.toggle() } label: {
                        Image(systemName: "shuffle").font(.title3)
                            .foregroundColor(player.shuffle ? Theme.accent : .white)
                    }
                    Spacer()
                    Button { player.previous() } label: { Image(systemName: "backward.fill").font(.title) }
                    Spacer()
                    Button { player.togglePlay() } label: {
                        ZStack {
                            Circle().fill(Color.white).frame(width: 70, height: 70)
                            if player.isBuffering {
                                ProgressView().tint(.black)
                            } else {
                                Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                                    .font(.title).foregroundColor(.black)
                            }
                        }
                    }
                    Spacer()
                    Button { player.next() } label: { Image(systemName: "forward.fill").font(.title) }
                    Spacer()
                    Button { player.cycleRepeat() } label: {
                        Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat").font(.title3)
                            .foregroundColor(player.repeatMode == .off ? .white : Theme.accent)
                    }
                }
                .foregroundColor(.white)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 12)
        }
        .sheet(isPresented: $showQueue) { QueueView() }
    }
}

struct QueueView: View {
    @EnvironmentObject var player: PlayerManager
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(player.queue.enumerated()), id: \.offset) { i, t in
                    Button {
                        player.jump(to: i)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            ArtworkView(url: t.artworkURL).frame(width: 44, height: 44)
                                .clipShape(RoundedRectangle(cornerRadius: 5))
                            VStack(alignment: .leading) {
                                Text(t.title).lineLimit(1)
                                    .foregroundColor(i == player.index ? Theme.accent : .white)
                                Text(t.artist).font(.caption).foregroundColor(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle("Queue")
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
