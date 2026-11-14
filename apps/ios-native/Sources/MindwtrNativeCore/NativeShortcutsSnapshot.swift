import Foundation

public struct NativeShortcutsSnapshotItem: Equatable, Sendable {
    public let id: String
    public let title: String
    public let list: String
    public let dueDate: String?
    public let startDate: String?
    public let projectId: String?
    public let projectName: String?

    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, !id.isEmpty, let title = value["title"] as? String, !title.isEmpty else { return nil }
        self.id = id
        self.title = title
        list = value["list"] as? String ?? ""
        dueDate = value["dueDate"] as? String
        startDate = value["startDate"] as? String
        projectId = value["projectId"] as? String
        projectName = value["projectName"] as? String
    }
}

public struct NativeShortcutsSnapshot {
    public static let lists = ["inbox", "focus", "next", "waiting", "someday"]
    static let staleAfter: TimeInterval = 24 * 60 * 60

    public enum Freshness: Equatable { case invalidTimestamp, stale, current }
    public enum ProjectResolution {
        case matched([NativeShortcutsSnapshotItem], omittedCount: Int?)
        case missing
        case ambiguous
    }

    private let root: [String: Any]

    public init?(json: String) {
        guard let value = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any],
              value["version"] != nil, value["generatedAt"] is String, value["lists"] is [String: Any] else { return nil }
        root = value
    }

    public func freshness(now: Date = Date()) -> Freshness {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let raw = root["generatedAt"] as? String,
              let generated = fractional.date(from: raw) ?? ISO8601DateFormatter().date(from: raw) else { return .invalidTimestamp }
        let age = now.timeIntervalSince(generated)
        return age >= 0 && age <= Self.staleAfter ? .current : .stale
    }

    public func knownOmittedTaskCount(forList list: String) -> Int? {
        guard let coverage = root["coverage"] as? [String: Any], let lists = coverage["lists"] as? [String: Any],
              let entry = lists[list] as? [String: Any], let omitted = entry["omitted"] as? NSNumber else { return nil }
        return max(0, omitted.intValue)
    }

    public func items(forList list: String) -> [NativeShortcutsSnapshotItem] {
        ((root["lists"] as? [String: Any])?[list] as? [[String: Any]] ?? []).compactMap(NativeShortcutsSnapshotItem.init)
    }

    public func allItems() -> [NativeShortcutsSnapshotItem] {
        let projects = (root["projects"] as? [[String: Any]] ?? []).flatMap { ($0["items"] as? [[String: Any]] ?? []).compactMap(NativeShortcutsSnapshotItem.init) }
        var seen = Set<String>()
        return (Self.lists.flatMap(items(forList:)) + projects).filter { seen.insert($0.id).inserted }
    }

    public func items(forProjectNamed name: String) -> ProjectResolution {
        let needle = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty, let projects = root["projects"] as? [[String: Any]] else { return .missing }
        let matches = projects.filter { ($0["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == needle }
        guard let match = matches.first else { return .missing }
        guard matches.count == 1 else { return .ambiguous }
        let omitted = (match["coverage"] as? [String: Any])?["omitted"] as? NSNumber
        return .matched((match["items"] as? [[String: Any]] ?? []).compactMap(NativeShortcutsSnapshotItem.init),
                        omittedCount: omitted.map { max(0, $0.intValue) })
    }
}

public struct NativeShortcutsSnapshotFile: Sendable {
    public let url: URL
    static let maximumBytes = 4 * 1024 * 1024

    public init(url: URL) { self.url = url }

    public static func live(selection: NativeLaunchSelection) -> NativeShortcutsSnapshotFile? {
        let home: URL
        switch selection {
        case let .production(containerURL): home = containerURL
        case let .standard(_, containerURL, _): home = containerURL
        case .isolated, .rehearsal: return nil
        }
        return NativeShortcutsSnapshotFile(url: home.appendingPathComponent("Library/Application Support/MindwtrShortcuts/snapshot.json"))
    }

    public func publish(_ json: String) throws {
        guard json.utf8.count <= Self.maximumBytes, NativeShortcutsSnapshot(json: json) != nil else {
            throw HostFailure("INVALID_INPUT: Shortcuts snapshot is invalid")
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        #if os(iOS)
        try Data(json.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try Data(json.utf8).write(to: url, options: [.atomic])
        #endif
    }

    public func withdraw() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    public func read() -> NativeShortcutsSnapshot? {
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]), (values.fileSize ?? .max) <= Self.maximumBytes,
              let data = try? Data(contentsOf: url) else { return nil }
        return NativeShortcutsSnapshot(json: String(decoding: data, as: UTF8.self))
    }
}

public enum NativeLegacyShortcutsSnapshot {
    public static let key = "mindwtr-ios-shortcuts-snapshot"

    public static func defaults(selection: NativeLaunchSelection, bundleIdentifier: String?) -> UserDefaults? {
        guard bundleIdentifier == NativeLaunchSelection.productionNamespace, case .production = selection else { return nil }
        return UserDefaults(suiteName: NativeSavedListCatalog.group)
    }

    public static func retire(from defaults: UserDefaults) -> Bool {
        guard defaults.object(forKey: key) != nil else { return false }
        defaults.removeObject(forKey: key)
        return defaults.object(forKey: key) == nil
    }
}

