import SwiftUI

enum LoadState: Equatable {
    case loading, loaded, failed(String)
}

/// A remote image that fills its frame, with a titled placeholder while loading or on failure.
struct RemoteImage: View {
    let url: String?
    var placeholderTitle: String? = nil

    var body: some View {
        AsyncImage(url: url.flatMap { URL(string: $0) }, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFill()
            case .empty:
                placeholder
            default:
                placeholder
            }
        }
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(colors: [Color(white: 0.18), Color(white: 0.1)], startPoint: .top, endPoint: .bottom)
            if let placeholderTitle {
                Text(placeholderTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(10)
            }
        }
    }
}

struct PosterCard: View {
    let meta: MetaPreview
    var width: CGFloat = 150
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Color.clear
                .frame(width: width, height: width * 1.5)
                .overlay { RemoteImage(url: meta.poster, placeholderTitle: meta.name) }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(hovering ? Theme.accent : Color.white.opacity(0.08), lineWidth: hovering ? 2 : 1)
                )
                .shadow(color: .black.opacity(0.35), radius: hovering ? 12 : 4, y: hovering ? 8 : 2)
                .scaleEffect(hovering ? 1.03 : 1)
            Text(meta.name)
                .font(.callout.weight(.medium))
                .lineLimit(1)
            Text(meta.releaseInfo ?? " ")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(width: width)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hovering = h } }
    }
}

/// Wide card used for Continue Watching.
struct ProgressCard: View {
    let progress: WatchProgress
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Color.clear
                .frame(width: 260, height: 146)
                .overlay { RemoteImage(url: progress.poster, placeholderTitle: progress.name) }
                .overlay(LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom))
                .overlay {
                    Image(systemName: "play.fill")
                        .font(.system(size: 26))
                        .padding(16)
                        .background(.ultraThinMaterial, in: Circle())
                        .opacity(hovering ? 1 : 0)
                }
                .overlay(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(formatTime(progress.duration - progress.position)) left")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.white.opacity(0.85))
                        ProgressView(value: progress.fraction)
                            .progressViewStyle(.linear)
                            .tint(Theme.accent)
                    }
                    .padding(10)
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(hovering ? Theme.accent : Color.white.opacity(0.08), lineWidth: hovering ? 2 : 1)
                )
            Text(progress.name)
                .font(.callout.weight(.medium))
                .lineLimit(1)
            Text([progress.episodeLabel, progress.episodeTitle].compactMap { $0 }.joined(separator: " · ").ifEmpty(" "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(width: 260)
        .contentShape(Rectangle())
        .onHover { h in withAnimation(.easeOut(duration: 0.15)) { hovering = h } }
    }
}

struct ContinueWatchingRow: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        let items = model.continueWatching
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("Continue Watching")
                    .font(.title2.weight(.bold))
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 18) {
                        ForEach(items) { item in
                            Button { openWindow(id: "player", value: item.playbackRequest) } label: {
                                ProgressCard(progress: item)
                            }
                            .buttonStyle(.plain)
                            .contextMenu {
                                Button("Mark as Watched") {
                                    var done = item
                                    done.position = done.duration
                                    model.progress[item.videoId] = done
                                }
                                Button("Remove from Continue Watching", role: .destructive) {
                                    model.removeProgress(item.videoId)
                                }
                            }
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
    }
}

struct SectionHeader: View {
    let title: String
    var subtitle: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(title).font(.title2.weight(.bold))
            if let subtitle {
                Text(subtitle).font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}

struct Chip: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(Color.white.opacity(0.08), in: Capsule())
    }
}

/// Simple wrapping layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
