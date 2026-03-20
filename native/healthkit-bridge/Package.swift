// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HealthKitBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "HealthKitBridge", targets: ["HealthKitBridge"]),
    ],
    targets: [
        .executableTarget(
            name: "HealthKitBridge",
            path: "Sources/HealthKitBridge",
            swiftSettings: [
                .unsafeFlags(["-parse-as-library"])
            ]
        ),
    ]
)
