import AppKit
import CoreLocation
import Foundation

private struct LocationPayload: Codable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double
    let timestamp: Double
    let source: String
}

private struct SuccessEnvelope: Codable {
    let ok: Bool
    let location: LocationPayload
}

private struct ErrorPayload: Codable {
    let code: String
    let message: String
}

private struct ErrorEnvelope: Codable {
    let ok: Bool
    let error: ErrorPayload
}

private final class OneShotLocationDelegate: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private let timeoutMs: Int
    private var finished = false
    private var timeoutWorkItem: DispatchWorkItem?

    init(accuracy: String, timeoutMs: Int) {
        self.timeoutMs = max(1000, min(timeoutMs, 60000))
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = accuracy == "coarse"
            ? kCLLocationAccuracyKilometer
            : kCLLocationAccuracyBest
    }

    func start() {
        guard CLLocationManager.locationServicesEnabled() else {
            emitError("LOCATION_UNAVAILABLE", "macOS Location Services are disabled.")
        }

        let timeout = DispatchWorkItem { [weak self] in
            self?.finishError(
                code: "LOCATION_TIMEOUT",
                message: "Timed out while getting current location from macOS Core Location."
            )
        }
        timeoutWorkItem = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(timeoutMs),
            execute: timeout
        )

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finishError(
                code: "LOCATION_DENIED",
                message: "Location access was denied by macOS."
            )
        @unknown default:
            finishError(
                code: "LOCATION_UNAVAILABLE",
                message: "macOS Core Location authorization is unavailable."
            )
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.requestLocation()
        case .denied, .restricted:
            finishError(
                code: "LOCATION_DENIED",
                message: "Location access was denied by macOS."
            )
        case .notDetermined:
            break
        @unknown default:
            finishError(
                code: "LOCATION_UNAVAILABLE",
                message: "macOS Core Location authorization is unavailable."
            )
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            finishError(
                code: "LOCATION_UNAVAILABLE",
                message: "macOS Core Location returned no location."
            )
            return
        }

        let payload = LocationPayload(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracyMeters: max(0, location.horizontalAccuracy),
            timestamp: location.timestamp.timeIntervalSince1970 * 1000,
            source: "macos_core_location"
        )
        finishSuccess(payload)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let nsError = error as NSError
        if nsError.domain == kCLErrorDomain && nsError.code == CLError.denied.rawValue {
            finishError(
                code: "LOCATION_DENIED",
                message: "Location access was denied by macOS."
            )
            return
        }

        finishError(
            code: "LOCATION_UNAVAILABLE",
            message: error.localizedDescription
        )
    }

    private func finishSuccess(_ location: LocationPayload) {
        guard !finished else { return }
        finished = true
        timeoutWorkItem?.cancel()
        emit(SuccessEnvelope(ok: true, location: location), exitCode: 0)
    }

    private func finishError(code: String, message: String) {
        guard !finished else { return }
        finished = true
        timeoutWorkItem?.cancel()
        emitError(code, message)
    }
}

private final class LocationAppDelegate: NSObject, NSApplicationDelegate {
    private let accuracy: String
    private let timeoutMs: Int
    private var locationDelegate: OneShotLocationDelegate?

    init(accuracy: String, timeoutMs: Int) {
        self.accuracy = accuracy
        self.timeoutMs = timeoutMs
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        let delegate = OneShotLocationDelegate(accuracy: accuracy, timeoutMs: timeoutMs)
        locationDelegate = delegate
        delegate.start()
    }
}

private func argumentValue(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let index = args.firstIndex(of: name), index + 1 < args.count else {
        return nil
    }
    return args[index + 1]
}

private func responseOutputPath() -> String? {
    argumentValue("--response-file")
}

private func emit<T: Codable>(_ value: T, exitCode: Int32) -> Never {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = (try? encoder.encode(value)) ?? Data(#"{"ok":false,"error":{"code":"LOCATION_UNAVAILABLE","message":"Failed to encode location response."}}"#.utf8)
    if let outputPath = responseOutputPath() {
        try? data.write(to: URL(fileURLWithPath: outputPath))
    } else {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
    exit(exitCode)
}

private func emitError(_ code: String, _ message: String) -> Never {
    emit(
        ErrorEnvelope(
            ok: false,
            error: ErrorPayload(code: code, message: message)
        ),
        exitCode: 1
    )
}

@main
struct CoWorkLocationHelperMain {
    static func main() {
        let accuracy = argumentValue("--accuracy") == "coarse" ? "coarse" : "precise"
        let timeoutMs = Int(argumentValue("--timeout-ms") ?? "") ?? 15000

        let app = NSApplication.shared
        let appDelegate = LocationAppDelegate(accuracy: accuracy, timeoutMs: timeoutMs)
        app.setActivationPolicy(.regular)
        app.delegate = appDelegate
        app.run()
    }
}
