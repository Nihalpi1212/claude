import SwiftUI

enum SidebarItem: String, Hashable, Identifiable {
    case discover, search, library, files, addons

    var id: String { rawValue }

    var title: String {
        switch self {
        case .discover: return "Discover"
        case .search: return "Search"
        case .library: return "Library"
        case .files: return "My Files"
        case .addons: return "Add-ons"
        }
    }

    var icon: String {
        switch self {
        case .discover: return "sparkles.tv"
        case .search: return "magnifyingglass"
        case .library: return "rectangle.stack"
        case .files: return "externaldrive"
        case .addons: return "puzzlepiece.extension"
        }
    }

    static let browse: [SidebarItem] = [.discover, .search, .library]
    static let sources: [SidebarItem] = [.files, .addons]
}

/// Identifies one catalog of one add-on, e.g. Cinemeta's "Popular" movies.
struct CatalogRef: Hashable {
    var addonURL: String
    var addonName: String
    var type: String
    var catalogId: String
    var title: String
}

struct RootView: View {
    @State private var selection: SidebarItem? = .discover

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("Browse") {
                    ForEach(SidebarItem.browse) { item in
                        Label(item.title, systemImage: item.icon).tag(item)
                    }
                }
                Section("Sources") {
                    ForEach(SidebarItem.sources) { item in
                        Label(item.title, systemImage: item.icon).tag(item)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
        } detail: {
            NavigationStack {
                page(selection ?? .discover)
                    .navigationDestination(for: MetaPreview.self) { DetailView(preview: $0) }
                    .navigationDestination(for: CatalogRef.self) { CatalogGridView(ref: $0) }
            }
            .id(selection)
        }
    }

    @ViewBuilder
    private func page(_ item: SidebarItem) -> some View {
        switch item {
        case .discover: DiscoverView()
        case .search: SearchView()
        case .library: LibraryView()
        case .files: LocalFilesView()
        case .addons: AddonsView()
        }
    }
}
