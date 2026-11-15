import SwiftUI

struct SearchView: View {
    @State private var query = ""
    @State private var results: [Track] = []
    @State private var loading = false
    @State private var error: String?
    @State private var searched = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    LoadingOrError(loading: loading, error: error)
                    if searched && !loading && error == nil && results.isEmpty {
                        Text("No results for \"\(query)\"").foregroundColor(.secondary).padding(.top, 40).frame(maxWidth: .infinity)
                    }
                    if !searched && !loading {
                        VStack(spacing: 8) {
                            Image(systemName: "music.note.list").font(.system(size: 44)).foregroundColor(.secondary)
                            Text("Play what you love").font(.title3.bold())
                            Text("Search songs and artists from Audius and Jamendo.")
                                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                        }
                        .padding(.top, 60).frame(maxWidth: .infinity)
                    }
                    ForEach(Array(results.enumerated()), id: \.element.id) { i, t in
                        TrackRow(track: t, list: results, index: i)
                    }
                }
                .padding(.horizontal, 16)
            }
            .navigationTitle("Search")
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Songs, artists")
            .onSubmit(of: .search) { Task { await run() } }
            .miniPlayerSpacer()
        }
    }

    private func run() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        loading = true
        searched = true
        error = nil
        do {
            results = try await Catalog.search(q)
        } catch let e {
            results = []
            error = e.localizedDescription
        }
        loading = false
    }
}
