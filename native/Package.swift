// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "memvana-shot-native",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "shot-helper",
            path: "Sources/shot-helper"
        ),
    ]
)
