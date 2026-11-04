import AppKit
import SwiftUI
import UniformTypeIdentifiers

enum Theme {
    static let accent = Color(red: 1.0, green: 0.64, blue: 0.24)
}

@main
struct MarqueeApp: App {
    @StateObject private var model = AppModel()

    init() {
        // Bigger image cache so posters don't reload as you scroll.
        URLCache.shared = URLCache(memoryCapacity: 96 << 20, diskCapacity: 768 << 20)
    }

    var body: some Scene {
        WindowGroup("Marquee", id: "main") {
            RootView()
                .environmentObject(model)
                .frame(minWidth: 980, minHeight: 640)
                .tint(Theme.accent)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1280, height: 820)
        .commands {
            SidebarCommands()
            CommandGroup(after: .newItem) { OpenFileCommand() }
        }

        WindowGroup("Player", id: "player", for: PlaybackRequest.self) { $request in
            Group {
                if let request {
                    PlayerWindow(request: request)
                } else {
                    Color.black
                }
            }
            .environmentObject(model)
            .tint(Theme.accent)
            .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1280, height: 720)
    }
}

/// File > Open Video… (⌘O): play any file on the Mac.
struct OpenFileCommand: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Open Video…") {
            let panel = NSOpenPanel()
            panel.canChooseFiles = true
            panel.canChooseDirectories = false
            panel.allowedContentTypes = [.movie, .video, .mpeg4Movie, .quickTimeMovie]
            guard panel.runModal() == .OK, let url = panel.url else { return }
            let video = LocalVideo(url: url, size: 0, modified: Date())
            if video.playsInApp {
                openWindow(id: "player", value: PlaybackRequest(
                    url: url.absoluteString, title: video.displayName,
                    metaId: url.absoluteString, videoId: url.absoluteString, type: "local"))
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        .keyboardShortcut("o")
    }
}
