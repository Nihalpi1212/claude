import SwiftUI

struct RootView: View {
    @EnvironmentObject var player: PlayerManager

    var body: some View {
        ZStack(alignment: .bottom) {
            TabView {
                HomeView().tabItem { Label("Home", systemImage: "house.fill") }
                SearchView().tabItem { Label("Search", systemImage: "magnifyingglass") }
                LibraryView().tabItem { Label("Your Library", systemImage: "books.vertical.fill") }
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape.fill") }
            }
            VStack(spacing: 10) {
                MessageBanner()
                MiniPlayerBar()
            }
            .padding(.bottom, 52)   // sits just above the tab bar
            .animation(.easeInOut(duration: 0.2), value: player.message)
        }
        .fullScreenCover(isPresented: $player.showNowPlaying) {
            NowPlayingView()
        }
    }
}
