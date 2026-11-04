import AppKit
import SwiftUI

// MARK: - My Files

struct LocalFilesView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.openWindow) private var openWindow

    @State private var files: [LocalVideo] = []
    @State private var scanning = false
    @State private var filter = ""
    @State private var link = ""

    private var shown: [LocalVideo] {
        let f = filter.trimmingCharacters(in: .whitespaces)
        guard !f.isEmpty else { return files }
        return files.filter { $0.displayName.localizedCaseInsensitiveContains(f) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    Image(systemName: "link").foregroundStyle(.secondary)
                    TextField("Paste a direct video link (MP4, MOV or HLS .m3u8) to play it", text: $link)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit(playLink)
                    Button("Play", action: playLink)
                        .disabled(URL(string: link.trimmingCharacters(in: .whitespaces))?.scheme == nil)
                }

                HStack(spacing: 8) {
                    ForEach(model.localFolders, id: \.self) { folder in
                        HStack(spacing: 6) {
                            Image(systemName: "folder.fill").foregroundStyle(Theme.accent)
                            Text((folder as NSString).lastPathComponent)
                            Button { model.removeLocalFolder(folder) } label: {
                                Image(systemName: "xmark.circle.fill")
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                            .help("Stop showing videos from \(folder)")
                        }
                        .font(.callout)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.white.opacity(0.06), in: Capsule())
                        .help(folder)
                    }
                    Button { addFolder() } label: { Label("Add Folder", systemImage: "plus") }
                    Spacer()
                    if scanning { ProgressView().controlSize(.small) }
                }
            }
            .padding(20)

            Divider()

            if shown.isEmpty && !scanning {
                ContentUnavailableView(
                    files.isEmpty ? "No videos found" : "No matches",
                    systemImage: "externaldrive",
                    description: Text(files.isEmpty
                        ? "Add a folder that contains your own videos. MP4 and MOV play in Marquee; MKV, AVI and other formats open in your default video app."
                        : "Try a different search."))
                    .frame(maxHeight: .infinity)
            } else {
                List(shown) { video in
                    LocalVideoRow(video: video, progress: model.progress[video.url.absoluteString]) { play(video) }
                        .contextMenu {
                            Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([video.url]) }
                            Button("Open in Default App") { NSWorkspace.shared.open(video.url) }
                        }
                }
                .listStyle(.inset)
            }
        }
        .navigationTitle("My Files")
        .searchable(text: $filter, placement: .toolbar, prompt: "Filter files")
        .toolbar {
            ToolbarItem {
                Button { Task { await rescan() } } label: { Label("Rescan", systemImage: "arrow.clockwise") }
            }
        }
        .task(id: model.localFolders) { await rescan() }
    }

    private func rescan() async {
        scanning = true
        files = await LocalVideo.scan(model.localFolders)
        scanning = false
    }

    private func addFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.prompt = "Add"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { model.addLocalFolder(url.path) }
    }

    private func play(_ video: LocalVideo) {
        guard video.playsInApp else {
            NSWorkspace.shared.open(video.url)
            return
        }
        let id = video.url.absoluteString
        openWindow(id: "player", value: PlaybackRequest(url: id, title: video.displayName,
                                                        metaId: id, videoId: id, type: "local"))
    }

    private func playLink() {
        let raw = link.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              ["http", "https", "file"].contains(scheme) else { return }
        let name = url.deletingPathExtension().lastPathComponent
        openWindow(id: "player", value: PlaybackRequest(url: raw, title: name.isEmpty ? (url.host ?? "Video") : name,
                                                        metaId: raw, videoId: raw, type: "link"))
        link = ""
    }
}

private struct LocalVideoRow: View {
    let video: LocalVideo
    let progress: WatchProgress?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: video.playsInApp ? "play.rectangle.fill" : "arrow.up.forward.app")
                    .font(.title3)
                    .foregroundStyle(video.playsInApp ? Theme.accent : .secondary)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 3) {
                    Text(video.displayName).lineLimit(1)
                    HStack(spacing: 8) {
                        Text(video.url.pathExtension.uppercased())
                        Text(ByteCountFormatter.string(fromByteCount: video.size, countStyle: .file))
                        Text(video.url.deletingLastPathComponent().lastPathComponent)
                        if !video.playsInApp { Text("Opens in default app") }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                if let progress, progress.position > 0 {
                    if progress.isFinished {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        ProgressView(value: progress.fraction).frame(width: 80).tint(Theme.accent)
                    }
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Add-ons

struct AddonsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var urlText = ""
    @State private var installing = false
    @State private var errorText: String?
    @State private var pendingRemoval: InstalledAddon?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: "Install an add-on")
                    Text("Marquee speaks the open Stremio add-on protocol. Paste the address of an add-on's manifest.json.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    HStack {
                        TextField("https://example.com/manifest.json", text: $urlText)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { Task { await install() } }
                        Button {
                            Task { await install() }
                        } label: {
                            if installing { ProgressView().controlSize(.small) } else { Text("Install") }
                        }
                        .disabled(installing || urlText.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    if let errorText {
                        Label(errorText, systemImage: "exclamationmark.triangle.fill")
                            .font(.callout)
                            .foregroundStyle(.orange)
                    }
                }

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        SectionHeader(title: "Installed", subtitle: "\(model.addons.count)")
                        Spacer()
                        Button("Restore Defaults") { model.restoreDefaultAddons() }
                    }
                    Text("Order matters: Discover rows and sources follow this list.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(model.addons) { addon in
                        AddonRow(addon: addon,
                                 canMoveUp: model.addons.first != addon,
                                 canMoveDown: model.addons.last != addon,
                                 onMove: { model.moveAddon(addon, by: $0) },
                                 onRemove: { pendingRemoval = addon })
                    }
                }

                Text("Only install add-ons for content you have the right to watch. Marquee doesn't include a torrent engine, so torrent-only add-ons won't show any sources.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(28)
            .frame(maxWidth: 860, alignment: .leading)
        }
        .navigationTitle("Add-ons")
        .confirmationDialog("Remove \(pendingRemoval?.manifest.name ?? "add-on")?",
                            isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
                            presenting: pendingRemoval) { addon in
            Button("Remove", role: .destructive) { model.removeAddon(addon) }
        } message: { _ in
            Text("Its catalogs and sources will disappear from Marquee.")
        }
    }

    private func install() async {
        let raw = urlText
        guard !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        installing = true
        errorText = nil
        defer { installing = false }
        do {
            try await model.installAddon(from: raw)
            urlText = ""
        } catch {
            errorText = "Couldn't install: \(error.localizedDescription)"
        }
    }
}

private struct AddonRow: View {
    let addon: InstalledAddon
    let canMoveUp: Bool
    let canMoveDown: Bool
    let onMove: (Int) -> Void
    let onRemove: () -> Void

    private var resources: String {
        addon.manifest.resources.map(\.name).filter { ["catalog", "meta", "stream", "subtitles"].contains($0) }
            .map { $0 == "meta" ? "details" : ($0 == "stream" ? "sources" : $0) }
            .joined(separator: ", ")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Color.clear
                .frame(width: 44, height: 44)
                .overlay {
                    if addon.manifest.logo != nil {
                        RemoteImage(url: addon.manifest.logo)
                    } else {
                        Image(systemName: addon.isBuiltIn ? "building.columns.fill" : "puzzlepiece.extension.fill")
                            .font(.title2)
                            .foregroundStyle(Theme.accent)
                    }
                }
                .background(Color.white.opacity(0.06))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(addon.manifest.name).font(.headline)
                    if let version = addon.manifest.version { Text("v\(version)").font(.caption).foregroundStyle(.secondary) }
                    if addon.isBuiltIn { Chip(text: "Built in") }
                }
                if let description = addon.manifest.description {
                    Text(description).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                }
                HStack(spacing: 6) {
                    ForEach(addon.manifest.types, id: \.self) { Chip(text: typeLabel($0)) }
                    if !resources.isEmpty {
                        Text("Provides \(resources)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if !addon.isBuiltIn {
                    Text(addon.transportURL)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
            }
            Spacer()
            HStack(spacing: 4) {
                Button { onMove(-1) } label: { Image(systemName: "chevron.up") }
                    .disabled(!canMoveUp).help("Move up")
                Button { onMove(1) } label: { Image(systemName: "chevron.down") }
                    .disabled(!canMoveDown).help("Move down")
                Button(role: .destructive, action: onRemove) { Image(systemName: "trash") }
                    .help("Remove")
            }
            .buttonStyle(.borderless)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
    }
}
