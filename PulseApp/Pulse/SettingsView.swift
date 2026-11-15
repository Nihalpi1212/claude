import SwiftUI

struct SettingsView: View {
    @AppStorage("jamendoClientID") private var jamendoID = ""
    @EnvironmentObject var library: LibraryStore
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            Form {
                Section(header: Text("Music sources"),
                        footer: Text("Audius works out of the box and has a huge catalog of full-length tracks. Jamendo adds free Creative Commons music; paste a free client ID from devportal.jamendo.com to enable it.")) {
                    HStack { Text("Audius"); Spacer(); Text("On").foregroundColor(Theme.accent) }
                    TextField("Jamendo client ID (optional)", text: $jamendoID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                }
                Section(header: Text("Playback")) {
                    Text("Music keeps playing in the background and on the lock screen. Use the lock-screen controls to pause, skip and seek.")
                        .font(.footnote).foregroundColor(.secondary)
                }
                Section(header: Text("Your data")) {
                    Text("\(library.liked.count) liked songs · \(library.playlists.count) playlists")
                        .foregroundColor(.secondary)
                    Button("Clear listening history", role: .destructive) { confirmClear = true }
                }
            }
            .navigationTitle("Settings")
            .confirmationDialog("Clear listening history?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Clear", role: .destructive) { library.recent = [] }
            }
            .miniPlayerSpacer()
        }
    }
}
