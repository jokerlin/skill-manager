// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Skm",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "Skm",
            path: "Sources/Skm",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        )
    ]
)
