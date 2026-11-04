import SwiftUI

// MARK: - Discover

struct DiscoverView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage("discover.type") private var type = "movie"

    private var types: [String] {
        var seen = Set<String>()
        return model.addons
            .flatMap { $0.manifest.catalogs.filter(\.isBrowsable).map(\.type) }
            .filter { seen.insert($0).inserted }
    }

    private var rows: [CatalogRef] {
        model.addons.flatMap { addon in
            addon.manifest.catalogs
                .filter { $0.type == type && $0.isBrowsable }
                .map { CatalogRef(addonURL: addon.transportURL, addonName: addon.manifest.name,
                                  type: $0.type, catalogId: $0.id, title: $0.displayName) }
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 32) {
                ContinueWatchingRow()
                ForEach(rows, id: \.self) { CatalogRow(ref: $0) }
                if rows.isEmpty {
                    ContentUnavailableView("Nothing to browse",
                                           systemImage: "puzzlepiece.extension",
                                           description: Text("Install an add-on with catalogs in Add-ons."))
                        .padding(.top, 80)
                }
            }
            .padding(28)
        }
        .navigationTitle("Discover")
        .toolbar {
            ToolbarItem(placement: .principal) {
                if types.count > 1 {
                    Picker("Type", selection: $type) {
                        ForEach(types, id: \.self) { Text(typeLabel($0)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .fixedSize()
                }
            }
        }
        .onAppear {
            if let first = types.first, !types.contains(type) { type = first }
        }
    }
}

/// One horizontal row of posters from a catalog. Hides itself if the catalog is empty or fails.
struct CatalogRow: View {
    @EnvironmentObject private var model: AppModel
    let ref: CatalogRef
    @State private var items: [MetaPreview] = []
    @State private var state: LoadState = .loading

    var body: some View {
        Group {
            if state == .loaded && items.isEmpty {
                EmptyView()
            } else if case .failed = state {
                EmptyView()
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .firstTextBaseline) {
                        SectionHeader(title: ref.title, subtitle: ref.addonName)
                        Spacer()
                        NavigationLink(value: ref) {
                            Text("See All").font(.callout.weight(.medium))
                        }
                        .buttonStyle(.link)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: 18) {
                            if state == .loading {
                                ForEach(0..<8, id: \.self) { _ in
                                    RoundedRectangle(cornerRadius: 10)
                                        .fill(Color.white.opacity(0.05))
                                        .frame(width: 150, height: 225)
                                }
                            }
                            ForEach(items) { meta in
                                NavigationLink(value: meta) { PosterCard(meta: meta) }
                                    .buttonStyle(.plain)
                            }
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal, 2)
                    }
                }
            }
        }
        .task(id: ref) { await load() }
    }

    private func load() async {
        guard let addon = model.addon(withURL: ref.addonURL) else { state = .failed("Missing add-on"); return }
        do {
            let metas = try await AddonClient.catalog(addon, type: ref.type, id: ref.catalogId)
            var seen = Set<String>()
            items = Array(metas.filter { seen.insert($0.id).inserted }.prefix(30))
            state = .loaded
        } catch {
            if !Task.isCancelled { state = .failed(error.localizedDescription) }
        }
    }
}

// MARK: - Full catalog grid

struct CatalogGridView: View {
    @EnvironmentObject private var model: AppModel
    let ref: CatalogRef

    @State private var genre: String? = nil
    @State private var items: [MetaPreview] = []
    @State private var fetched = 0
    @State private var loading = false
    @State private var reachedEnd = false
    @State private var errorText: String?

    private var addon: InstalledAddon? { model.addon(withURL: ref.addonURL) }
    private var catalog: AddonCatalog? {
        addon?.manifest.catalogs.first { $0.id == ref.catalogId && $0.type == ref.type }
    }

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 170), spacing: 20)],
                      alignment: .leading, spacing: 26) {
                ForEach(items) { meta in
                    NavigationLink(value: meta) { PosterCard(meta: meta) }
                        .buttonStyle(.plain)
                        .onAppear {
                            if meta.id == items.last?.id { Task { await loadMore() } }
                        }
                }
            }
            .padding(28)

            if loading {
                ProgressView().padding(.bottom, 30)
            } else if let errorText, items.isEmpty {
                ContentUnavailableView("Couldn't load this catalog", systemImage: "wifi.exclamationmark",
                                       description: Text(errorText))
            } else if items.isEmpty && reachedEnd {
                ContentUnavailableView("Nothing here", systemImage: "film.stack")
            }
        }
        .navigationTitle("\(ref.title) · \(typeLabel(ref.type))")
        .toolbar {
            ToolbarItem {
                if let genres = catalog?.genreOptions, !genres.isEmpty {
                    Picker("Genre", selection: $genre) {
                        Text("All Genres").tag(String?.none)
                        Divider()
                        ForEach(genres, id: \.self) { Text($0).tag(String?.some($0)) }
                    }
                    .frame(width: 170)
                }
            }
        }
        .task(id: genre) {
            items = []
            fetched = 0
            reachedEnd = false
            errorText = nil
            await loadMore()
        }
    }

    private func loadMore() async {
        guard !loading, !reachedEnd, let addon else { return }
        loading = true
        defer { loading = false }

        var extra: [(String, String)] = []
        if let genre { extra.append(("genre", genre)) }
        if fetched > 0 { extra.append(("skip", String(fetched))) }

        do {
            let page = try await AddonClient.catalog(addon, type: ref.type, id: ref.catalogId, extra: extra)
            fetched += page.count
            let known = Set(items.map(\.id))
            var seen = known
            let fresh = page.filter { seen.insert($0.id).inserted }
            items += fresh
            if page.isEmpty || fresh.isEmpty || !(catalog?.supportsSkip ?? false) { reachedEnd = true }
        } catch {
            if !Task.isCancelled {
                errorText = error.localizedDescription
                reachedEnd = true
            }
        }
    }
}

// MARK: - Search

struct SearchGroup: Identifiable {
    var id: String
    var title: String
    var items: [MetaPreview]
}

struct SearchView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var groups: [SearchGroup] = []
    @State private var searching = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 32) {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ContentUnavailableView("Search movies and shows", systemImage: "magnifyingglass",
                                           description: Text("Results come from every add-on that supports search."))
                        .padding(.top, 80)
                } else if !searching && groups.isEmpty {
                    ContentUnavailableView.search(text: query)
                        .padding(.top, 80)
                }
                ForEach(groups) { group in
                    VStack(alignment: .leading, spacing: 12) {
                        SectionHeader(title: group.title)
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyHStack(alignment: .top, spacing: 18) {
                                ForEach(group.items) { meta in
                                    NavigationLink(value: meta) { PosterCard(meta: meta) }
                                        .buttonStyle(.plain)
                                }
                            }
                            .padding(.vertical, 8)
                            .padding(.horizontal, 2)
                        }
                    }
                }
            }
            .padding(28)
        }
        .overlay(alignment: .top) {
            if searching { ProgressView().controlSize(.small).padding(8) }
        }
        .navigationTitle("Search")
        .searchable(text: $query, placement: .toolbar, prompt: "Movies, shows…")
        .task(id: query) {
            try? await Task.sleep(nanoseconds: 450_000_000)
            guard !Task.isCancelled else { return }
            await runSearch()
        }
    }

    private func runSearch() async {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !term.isEmpty else { groups = []; return }
        searching = true
        defer { searching = false }

        var targets: [(InstalledAddon, AddonCatalog)] = []
        for addon in model.addons {
            for catalog in addon.manifest.catalogs where catalog.supportsSearch {
                targets.append((addon, catalog))
            }
        }

        var results: [(Int, SearchGroup)] = []
        await withTaskGroup(of: (Int, SearchGroup?).self) { taskGroup in
            for (index, target) in targets.enumerated() {
                let (addon, catalog) = target
                taskGroup.addTask {
                    let items = (try? await AddonClient.catalog(addon, type: catalog.type, id: catalog.id,
                                                                extra: [("search", term)])) ?? []
                    guard !items.isEmpty else { return (index, nil) }
                    let title = "\(typeLabel(catalog.type)) · \(addon.manifest.name)"
                    return (index, SearchGroup(id: "\(addon.transportURL)|\(catalog.type)|\(catalog.id)",
                                               title: title, items: items))
                }
            }
            for await (index, group) in taskGroup {
                if let group { results.append((index, group)) }
            }
        }
        guard !Task.isCancelled else { return }
        groups = results.sorted { $0.0 < $1.0 }.map(\.1)
    }
}

// MARK: - Library

struct LibraryView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 32) {
                ContinueWatchingRow()
                VStack(alignment: .leading, spacing: 12) {
                    SectionHeader(title: "Saved", subtitle: model.library.isEmpty ? nil : "\(model.library.count)")
                    if model.library.isEmpty {
                        ContentUnavailableView("Your library is empty", systemImage: "rectangle.stack.badge.plus",
                                               description: Text("Open any title and choose Add to Library."))
                            .padding(.top, 40)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 170), spacing: 20)],
                                  alignment: .leading, spacing: 26) {
                            ForEach(model.library) { meta in
                                NavigationLink(value: meta) { PosterCard(meta: meta) }
                                    .buttonStyle(.plain)
                                    .contextMenu {
                                        Button("Remove from Library", role: .destructive) { model.toggleLibrary(meta) }
                                    }
                            }
                        }
                    }
                }
            }
            .padding(28)
        }
        .navigationTitle("Library")
    }
}
