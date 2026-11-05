import Foundation
import CryptoKit

public enum NativePersonalIntakeError: Error, Sendable, Equatable {
    case unavailable
    case pendingPublication
    case ambiguousPublication
    case legacyHeld
    case ambiguousReminderFloor
    case staleItem
}

public struct NativePersonalIntakeRoute: Sendable {
    public let selection: NativeLaunchSelection
    public let namespace: String
    let home: URL
    let components: [String]
    let descriptor: Data
    let fingerprint: String

    private init(arguments: [String], bundleIdentifier: String?, support: URL, home: URL,
                 mode: NativeLaunchSelection.BuildMode) throws {
        let homePath = try Self.normalizedPath(home)
        let supportPath = try Self.normalizedPath(support)
        guard home.absoluteString.utf8.count <= 16 * 1024, support.absoluteString.utf8.count <= 16 * 1024,
              Self.samePath(supportPath, homePath + "/Library/Application Support") else { throw NativePersonalIntakeError.unavailable }
        let normalizedHome = URL(fileURLWithPath: homePath, isDirectory: true)
        let normalizedSupport = URL(fileURLWithPath: supportPath, isDirectory: true)
        let chosen = try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: bundleIdentifier,
            supportURL: normalizedSupport, homeURL: normalizedHome, mode: mode)
        let database: URL, container: URL, namespace: String, kind: String, leaf: String, identifier: String
        switch chosen {
        case let .production(owner):
            database = owner.appendingPathComponent("Documents/SQLite/mindwtr.db")
            container = owner; namespace = NativeLaunchSelection.productionNamespace
            kind = "standard"; leaf = namespace; identifier = ""
        case let .standard(db, owner, name):
            guard name != ".", name != "..", name != "NativePersonalIntake" else { throw NativePersonalIntakeError.unavailable }
            database = db; container = owner; namespace = name; kind = "standard"; leaf = name; identifier = ""
        case let .isolated(db, owner, name, id):
            database = db; container = owner; namespace = name; kind = "isolated"
            leaf = id.uuidString.lowercased(); identifier = leaf
        case .rehearsal: throw NativePersonalIntakeError.unavailable
        }
        let rootComponents = ["Library", "Application Support", "NativePersonalIntake", "v1", kind, leaf]
        let intakePath = homePath + "/" + rootComponents.joined(separator: "/")
        let databasePath = try Self.normalizedPath(database)
        let containerPath = try Self.normalizedPath(container)
        let libraryPath = (databasePath as NSString).deletingLastPathComponent
        let kvFamily = containerPath + "/Library/Application Support/" + namespace
        guard !Self.overlap(intakePath, libraryPath), !Self.overlap(intakePath, kvFamily),
              !Self.overlap(intakePath, homePath + "/Library/Preferences"),
              kind != "isolated" || !Self.overlap(intakePath, containerPath) else { throw NativePersonalIntakeError.unavailable }
        let bytes = try JSONSerialization.data(withJSONObject: ["version": "1", "kind": kind, "namespace": namespace,
            "identifier": identifier, "home": homePath, "support": supportPath, "database": databasePath, "container": containerPath], options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= 64 * 1024 else { throw NativePersonalIntakeError.unavailable }
        self.selection = chosen; self.namespace = namespace; self.home = normalizedHome
        self.components = rootComponents; self.descriptor = bytes
        self.fingerprint = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    func matchesStoredOrigin(_ saved: Data) -> Bool {
        if saved == descriptor { return true }
        do {
            guard saved.count <= 64 * 1024,
                  let origin = try JSONSerialization.jsonObject(with: saved) as? [String: String],
                  Set(origin.keys) == Set(["version", "kind", "namespace", "identifier", "home", "support", "database", "container"]),
                  try JSONSerialization.data(withJSONObject: origin, options: [.sortedKeys, .withoutEscapingSlashes]) == saved,
                  let previousHome = origin["home"], Self.canonicalStoredHome(previousHome) else { return false }
            let kind: String, identifier: String, database: URL, container: URL
            switch selection {
            case let .production(owner):
                kind = "standard"; identifier = ""
                database = owner.appendingPathComponent("Documents/SQLite/mindwtr.db"); container = owner
            case let .standard(selectedDatabase, selectedContainer, _):
                kind = "standard"; identifier = ""; database = selectedDatabase; container = selectedContainer
            case let .isolated(selectedDatabase, selectedContainer, _, selectedIdentifier):
                kind = "isolated"; identifier = selectedIdentifier.uuidString.lowercased()
                database = selectedDatabase; container = selectedContainer
            case .rehearsal: return false
            }
            guard Self.samePath(origin["version"]!, "1"), Self.samePath(origin["kind"]!, kind),
                  Self.samePath(origin["namespace"]!, namespace), Self.samePath(origin["identifier"]!, identifier) else { return false }
            let currentHome = try Self.normalizedPath(home), prefix = Data(currentHome.utf8)
            let paths = [("support", currentHome + "/Library/Application Support"),
                         ("database", try Self.normalizedPath(database)), ("container", try Self.normalizedPath(container))]
            for (field, currentPath) in paths {
                let bytes = Data(currentPath.utf8)
                guard bytes.starts(with: prefix),
                      bytes.count == prefix.count || bytes[prefix.count] == 47 else { return false }
                var expected = Data(previousHome.utf8)
                expected.append(contentsOf: bytes.dropFirst(prefix.count))
                guard Data(origin[field]!.utf8) == expected else { return false }
            }
            return true
        } catch { return false }
    }
    private static func canonicalStoredHome(_ path: String) -> Bool {
        let parts = path.split(separator: "/")
        return path.utf8.count <= 16 * 1024 && !path.utf8.contains(0) && !parts.isEmpty
            && !parts.contains(".") && !parts.contains("..")
            && samePath(path, "/" + parts.joined(separator: "/"))
    }

    public static func current() throws -> Self {
        #if targetEnvironment(simulator)
        #if DEBUG
        let mode = NativeLaunchSelection.BuildMode.simulatorDebug
        #else
        let mode = NativeLaunchSelection.BuildMode.simulatorRelease
        #endif
        #elseif DEBUG && NATIVE_DEVICE_TEST
        let mode = NativeLaunchSelection.BuildMode.deviceTest
        #else
        let mode = NativeLaunchSelection.BuildMode.production
        #endif
        do {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: false)
            return try Self(arguments: ProcessInfo.processInfo.arguments, bundleIdentifier: Bundle.main.bundleIdentifier,
                support: support, home: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true), mode: mode)
        } catch { throw NativePersonalIntakeError.unavailable }
    }

    #if DEBUG
    static func fixture(home: URL, arguments: [String] = [], bundleIdentifier: String? = "mindwtr.intake.fixture",
                        mode: NativeLaunchSelection.BuildMode = .simulatorDebug) throws -> Self {
        let path = try Self.normalizedPath(home)
        let base = try Self.normalizedPath(URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
        let prefix = base + "/.mindwtr-native-tests/personal-intake/"
        guard path.hasPrefix(prefix) else { throw NativePersonalIntakeError.unavailable }
        let suffix = String(path.dropFirst(prefix.count)).split(separator: "/").map(String.init)
        guard suffix.count == 2, suffix[1] == "home", UUID(uuidString: suffix[0])?.uuidString.lowercased() == suffix[0] else {
            throw NativePersonalIntakeError.unavailable
        }
        return try Self(arguments: arguments, bundleIdentifier: bundleIdentifier,
            support: URL(fileURLWithPath: path + "/Library/Application Support", isDirectory: true), home: home, mode: mode)
    }
    #endif

    private static func normalizedPath(_ url: URL) throws -> String {
        let path = try NativeAttachmentFiles.filePath(url.absoluteString)
        let normalized = "/" + path.split(separator: "/").joined(separator: "/")
        guard samePath(path, normalized) || samePath(path, normalized + "/") else { throw NativePersonalIntakeError.unavailable }
        return normalized
    }

    private static func samePath(_ a: String, _ b: String) -> Bool { Data(a.utf8) == Data(b.utf8) }
    private static func overlap(_ a: String, _ b: String) -> Bool {
        let x = a.split(separator: "/").map { Data($0.utf8) }, y = b.split(separator: "/").map { Data($0.utf8) }
        return Array(x.prefix(min(x.count, y.count))) == Array(y.prefix(min(x.count, y.count)))
    }
}
