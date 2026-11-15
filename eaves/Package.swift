// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Eaves",
    platforms: [.macOS(.v13)],
    targets: [
        // Simulation, weather mapping and geometry: Foundation only, covered by unit tests.
        .target(name: "EavesCore"),
        // The menu bar app: overlay windows, SpriteKit rendering, settings.
        .executableTarget(name: "Eaves", dependencies: ["EavesCore"]),
        .testTarget(name: "EavesCoreTests", dependencies: ["EavesCore"]),
    ]
)
