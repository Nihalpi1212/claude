import AppKit
import SwiftUI

struct DetailView: View {
    @EnvironmentObject private var model: AppModel
    let preview: MetaPreview

    @State private var detail: MetaDetail?
    @State private var loading = true
    @State private var season: Int?
    @State private var sheetEpisode: MetaVideo?

    private var meta: MetaDetail { detail ?? MetaDetail(preview: preview) }
    private var videos: [MetaVideo] { meta.videos ?? [] }
    private var hasEpisodes: Bool { meta.type != "movie" && !videos.isEmpty }
    private var seasons: [Int] { Array(Set(videos.compactMap(\.season))).sorted() }
    private var currentSeason: Int? { season ?? seasons.first(where: { $0 > 0 }) ?? seasons.first }
    private var episodes: [MetaVideo] {
        guard let s = currentSeason, !seasons.isEmpty else { return videos }
        return videos.filter { $0.season == s }.sorted { ($0.episode ?? 0) < ($1.episode ?? 0) }
    }

    var body: some View {
        ScrollView {
            ZStack(alignment: .top) {
                backdrop
                VStack(alignment: .leading, spacing: 34) {
                    header
                    if hasEpisodes {
                        episodesSection
                    } else if !loading || detail != nil {
                        StreamsSection(type: meta.type, videoId: meta.id, meta: meta, episode: nil)
                    }
                    if let cast = meta.cast, !cast.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: "Cast")
                            FlowLayout { ForEach(cast.prefix(20), id: \.self) { Chip(text: $0) } }
                        }
                    }
                }
                .padding(.horizontal, 36)
                .padding(.top, 150)
                .padding(.bottom, 40)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle(meta.name)
        .task(id: preview.id) { await load() }
        .sheet(item: $sheetEpisode) { episode in
            EpisodeSourcesSheet(meta: meta, episode: episode)
                .environmentObject(model)
        }
    }

    // MARK: Pieces

    private var backdrop: some View {
        let hasBackground = meta.background != nil
        return Color.clear
            .frame(height: 440)
            .frame(maxWidth: .infinity)
            .overlay {
                RemoteImage(url: meta.background ?? meta.poster)
                    .blur(radius: hasBackground ? 0 : 40)
                    .opacity(hasBackground ? 0.9 : 0.5)
            }
            .overlay(
                LinearGradient(stops: [
                    .init(color: Color(nsColor: .windowBackgroundColor).opacity(0.15), location: 0),
                    .init(color: Color(nsColor: .windowBackgroundColor).opacity(0.7), location: 0.55),
                    .init(color: Color(nsColor: .windowBackgroundColor), location: 1),
                ], startPoint: .top, endPoint: .bottom)
            )
            .clipped()
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 30) {
            Color.clear
                .frame(width: 200, height: 300)
                .overlay { RemoteImage(url: meta.poster, placeholderTitle: meta.name) }
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .shadow(color: .black.opacity(0.5), radius: 18, y: 10)

            VStack(alignment: .leading, spacing: 14) {
                Text(meta.name)
                    .font(.system(size: 36, weight: .bold))
                    .lineLimit(3)
                facts
                if let description = meta.description, !description.isEmpty {
                    Text(description)
                        .font(.body)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(7)
                        .textSelection(.enabled)
                        .frame(maxWidth: 720, alignment: .leading)
                }
                if let director = meta.director, !director.isEmpty {
                    Text("Directed by \(director.prefix(3).joined(separator: ", "))")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                actions
            }
            .padding(.top, 60)
        }
    }

    private var facts: some View {
        HStack(spacing: 12) {
            if let year = meta.releaseInfo { Text(year) }
            if let runtime = meta.runtime { Text(runtime) }
            if let rating = meta.imdbRating, !rating.isEmpty {
                Label(rating, systemImage: "star.fill").labelStyle(.titleAndIcon)
            }
            if let genres = meta.genres, !genres.isEmpty {
                Text(genres.prefix(3).joined(separator: " · "))
            }
            if loading { ProgressView().controlSize(.small) }
        }
        .font(.callout.weight(.medium))
        .foregroundStyle(.secondary)
    }

    private var actions: some View {
        HStack(spacing: 10) {
            let saved = model.isInLibrary(meta.id)
            Button { model.toggleLibrary(meta.asPreview) } label: {
                Label(saved ? "In Library" : "Add to Library", systemImage: saved ? "checkmark" : "plus")
            }
            .controlSize(.large)
            if let yt = meta.trailerYouTubeID, let url = URL(string: "https://www.youtube.com/watch?v=\(yt)") {
                Button { NSWorkspace.shared.open(url) } label: {
                    Label("Trailer", systemImage: "play.rectangle")
                }
                .controlSize(.large)
            }
        }
        .padding(.top, 4)
    }

    private var episodesSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                SectionHeader(title: "Episodes")
                Spacer()
                if seasons.count > 1 {
                    Picker("Season", selection: Binding(get: { currentSeason ?? 1 }, set: { season = $0 })) {
                        ForEach(seasons, id: \.self) { s in
                            Text(s == 0 ? "Specials" : "Season \(s)").tag(s)
                        }
                    }
                    .frame(width: 160)
                }
            }
            LazyVStack(spacing: 8) {
                ForEach(episodes) { episode in
                    EpisodeRow(episode: episode,
                               progress: model.progress[episode.id]) { sheetEpisode = episode }
                }
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        let candidates = model.addons.filter { $0.supports("meta", type: preview.type, id: preview.id) }
        for addon in candidates {
            if let found = try? await AddonClient.meta(addon, type: preview.type, id: preview.id) {
                detail = found.merged(with: preview)
                return
            }
        }
    }
}

private struct EpisodeRow: View {
    let episode: MetaVideo
    let progress: WatchProgress?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 16) {
                Color.clear
                    .frame(width: 160, height: 90)
                    .overlay { RemoteImage(url: episode.thumbnail) }
                    .overlay(alignment: .bottom) {
                        if let progress, progress.position > 0 {
                            ProgressView(value: progress.fraction).tint(Theme.accent).padding(6)
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        if let label = episode.label {
                            Text(label).font(.caption.weight(.bold)).foregroundStyle(Theme.accent)
                        }
                        if let released = episode.released {
                            Text(released.formatted(date: .abbreviated, time: .omitted))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if episode.isUpcoming {
                            Text("Upcoming").font(.caption.weight(.semibold)).foregroundStyle(.orange)
                        }
                        if progress?.isFinished == true {
                            Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                        }
                    }
                    Text(episode.title).font(.headline).lineLimit(1)
                    if let overview = episode.overview {
                        Text(overview).font(.callout).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(hovering ? 0.08 : 0.03)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

private struct EpisodeSourcesSheet: View {
    @Environment(\.dismiss) private var dismiss
    let meta: MetaDetail
    let episode: MetaVideo

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text([meta.name, episode.label].compactMap { $0 }.joined(separator: " · "))
                        .font(.callout).foregroundStyle(.secondary)
                    Text(episode.title).font(.title2.weight(.bold))
                }
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(22)
            Divider()
            ScrollView {
                StreamsSection(type: meta.type, videoId: episode.id, meta: meta, episode: episode) { dismiss() }
                    .padding(22)
            }
        }
        .frame(width: 640, height: 540)
    }
}

// MARK: - Sources

struct StreamGroup: Identifiable {
    var id: String
    var addonName: String
    var streams: [StreamItem]
}

/// Asks every installed add-on for sources of one movie or episode, and plays the chosen one.
struct StreamsSection: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow

    let type: String
    let videoId: String
    let meta: MetaDetail
    let episode: MetaVideo?
    var onPlay: (() -> Void)? = nil

    @State private var groups: [StreamGroup] = []
    @State private var unsupportedCount = 0
    @State private var loading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                SectionHeader(title: "Sources")
                if loading { ProgressView().controlSize(.small) }
            }

            if let saved = model.progress[videoId], !saved.isFinished, saved.position > 10 {
                Button { play(url: saved.streamURL, streamTitle: saved.streamTitle) } label: {
                    Label("Resume from \(formatTime(saved.position))", systemImage: "play.fill")
                        .padding(.horizontal, 8)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }

            ForEach(groups) { group in
                VStack(alignment: .leading, spacing: 8) {
                    Text(group.addonName.uppercased())
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(Array(group.streams.enumerated()), id: \.offset) { _, stream in
                        StreamRow(stream: stream) { play(stream) }
                    }
                }
            }

            if !loading && groups.isEmpty {
                NoSourcesView()
            }
            if unsupportedCount > 0 {
                Text("\(unsupportedCount) result\(unsupportedCount == 1 ? "" : "s") hidden: torrent links aren't supported.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: 820, alignment: .leading)
        .task(id: videoId) { await load() }
    }

    private func load() async {
        loading = true
        groups = []
        unsupportedCount = 0
        let type = self.type
        let videoId = self.videoId
        let addons = model.addons.filter { $0.supports("stream", type: type, id: videoId) }

        var collected: [(Int, StreamGroup)] = []
        await withTaskGroup(of: (Int, [StreamItem]).self) { taskGroup in
            for (index, addon) in addons.enumerated() {
                taskGroup.addTask {
                    (index, (try? await AddonClient.streams(addon, type: type, id: videoId)) ?? [])
                }
            }
            for await (index, streams) in taskGroup {
                let openable = streams.filter(\.isOpenable)
                unsupportedCount += streams.count - openable.count
                guard !openable.isEmpty else { continue }
                collected.append((index, StreamGroup(id: addons[index].transportURL,
                                                     addonName: addons[index].manifest.name,
                                                     streams: openable)))
                groups = collected.sorted { $0.0 < $1.0 }.map(\.1)
            }
        }
        loading = false
    }

    private func play(_ stream: StreamItem) {
        if let url = stream.url {
            play(url: url, streamTitle: stream.primaryLine)
        } else if let yt = stream.ytId, let url = URL(string: "https://www.youtube.com/watch?v=\(yt)") {
            NSWorkspace.shared.open(url)
        } else if let external = stream.externalUrl, let url = URL(string: external) {
            NSWorkspace.shared.open(url)
        }
    }

    private func play(url: String, streamTitle: String?) {
        let request = PlaybackRequest(
            url: url, title: meta.name, episodeLabel: episode?.label, episodeTitle: episode?.title,
            metaId: meta.id, videoId: videoId, type: meta.type, poster: meta.poster, streamTitle: streamTitle)
        openWindow(id: "player", value: request)
        onPlay?()
    }
}

private struct StreamRow: View {
    let stream: StreamItem
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: stream.iconName)
                    .font(.title3)
                    .foregroundStyle(Theme.accent)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 3) {
                    Text(stream.primaryLine)
                        .font(.body.weight(.semibold))
                    if let secondary = stream.secondaryLine {
                        Text(secondary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "play.circle.fill")
                    .font(.title2)
                    .foregroundStyle(hovering ? Theme.accent : .secondary)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(hovering ? 0.1 : 0.04)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu {
            if let link = stream.url ?? stream.externalUrl {
                Button("Copy Link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(link, forType: .string)
                }
                if let url = URL(string: link) {
                    Button("Open in Default App") { NSWorkspace.shared.open(url) }
                }
            }
        }
    }
}

private struct NoSourcesView: View {
    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "film.stack")
                .font(.title2)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("No sources for this title")
                    .font(.headline)
                Text("Marquee gets video from add-ons. Cinemeta only lists titles, it has no video. The built-in Internet Archive add-on plays public-domain films, and you can install other add-ons in Add-ons.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
    }
}
