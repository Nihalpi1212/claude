import SwiftUI

@main
struct PulseApp: App {
    @StateObject private var player = PlayerManager()
    @StateObject private var library = LibraryStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(player)
                .environmentObject(library)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
                .onAppear { player.library = library }
        }
    }
}
