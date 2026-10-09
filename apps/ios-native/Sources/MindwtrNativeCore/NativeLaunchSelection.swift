import Foundation

/// A trusted launch choice only. Preparing or admitting the selected filesystem remains the caller's work.
public enum NativeLaunchSelection: Sendable {
    case standard(databaseURL: URL, containerURL: URL, namespace: String)
    case isolated(databaseURL: URL, containerURL: URL, namespace: String, identifier: UUID)
    case rehearsal(containerURL: URL, databaseURL: URL, bundleIdentifier: String)

    public enum BuildMode: Sendable {
        case simulatorDebug
        case simulatorRelease
        case deviceTest
        case unavailable
    }

    private struct SelectionFailure: LocalizedError {
        var errorDescription: String? { "Native iOS launch selection is unavailable." }
    }

    /// Inputs come from the process and system container, never a notification payload or stored preference.
    public static func resolve(arguments: [String], bundleIdentifier: String?, supportURL: URL, homeURL: URL,
                               mode: BuildMode) throws -> NativeLaunchSelection {
        switch mode {
        case .unavailable:
            throw SelectionFailure()
        case .deviceTest:
            guard bundleIdentifier == "tech.dongdongbh.mindwtr.native.dev",
                  !arguments.contains("--native-app-lock-auth"), !arguments.contains("--native-rn-rehearsal") else {
                throw SelectionFailure()
            }
        case .simulatorDebug, .simulatorRelease:
            break
        }
        guard supportURL.isFileURL else { throw SelectionFailure() }
        if mode != .simulatorRelease {
            let positions = arguments.indices.filter { arguments[$0] == "--native-ui-test-library" }
            if let position = positions.first {
                guard positions.count == 1, !arguments.contains("--native-rn-rehearsal"), position + 1 < arguments.count,
                      let identifier = UUID(uuidString: arguments[position + 1]),
                      identifier.uuidString.lowercased() == arguments[position + 1] else { throw SelectionFailure() }
                let name = identifier.uuidString.lowercased()
                let directory = supportURL.appendingPathComponent("NativeUITests", isDirectory: true)
                    .appendingPathComponent(name, isDirectory: true)
                let namespace = "tech.dongdongbh.mindwtr.native-ui." + name
                guard NativeReminderRequest.validNamespace(namespace) else { throw SelectionFailure() }
                return .isolated(databaseURL: directory.appendingPathComponent("mindwtr.sqlite"),
                    containerURL: directory, namespace: namespace, identifier: identifier)
            }
            if arguments.contains("--native-rn-rehearsal") {
                guard let bundleIdentifier, !bundleIdentifier.isEmpty else { throw SelectionFailure() }
                let container = supportURL.appendingPathComponent("NativeRNRehearsal", isDirectory: true)
                return .rehearsal(containerURL: container,
                    databaseURL: container.appendingPathComponent("Documents/SQLite/mindwtr.db"), bundleIdentifier: bundleIdentifier)
            }
        }
        guard homeURL.isFileURL, let bundleIdentifier, NativeReminderRequest.validNamespace(bundleIdentifier) else {
            throw SelectionFailure()
        }
        return .standard(databaseURL: supportURL.appendingPathComponent("NativeFoundation", isDirectory: true)
            .appendingPathComponent("mindwtr.sqlite"), containerURL: homeURL, namespace: bundleIdentifier)
    }
}
