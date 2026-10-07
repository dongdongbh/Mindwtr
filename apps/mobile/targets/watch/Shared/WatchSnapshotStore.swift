import Foundation

enum MindwtrWatchSnapshotStore {
    private static let snapshotKey = "mindwtr.watch.snapshot.v1"
    private static let openCaptureKey = "mindwtr.watch.open-capture"

    static var appGroup: String? {
        Bundle.main.object(forInfoDictionaryKey: "MindwtrWatchAppGroup") as? String
    }

    private static var defaults: UserDefaults? {
        guard let appGroup, !appGroup.isEmpty else { return nil }
        return UserDefaults(suiteName: appGroup)
    }

    private static var snapshotURL: URL {
        let directory = appGroup.flatMap { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) }
            ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return directory.appendingPathComponent("watch-snapshot-v1.json")
    }

    static func load() -> MindwtrWatchSnapshot {
        guard let data = (try? Data(contentsOf: snapshotURL)) ?? defaults?.data(forKey: snapshotKey),
              let snapshot = try? JSONDecoder().decode(MindwtrWatchSnapshot.self, from: data)
        else { return .empty }
        return snapshot
    }

    @discardableResult
    static func save(_ snapshot: MindwtrWatchSnapshot) -> Bool {
        do {
            let data = try JSONEncoder().encode(snapshot)
            // A settled command may be removed only after its replacement snapshot is on disk.
            try data.write(to: snapshotURL, options: .atomic)
            defaults?.set(data, forKey: snapshotKey)
            return true
        } catch { return false }
    }

    static func requestCaptureOnNextOpen() {
        defaults?.set(true, forKey: openCaptureKey)
    }

    static func consumeCaptureRequest() -> Bool {
        guard defaults?.bool(forKey: openCaptureKey) == true else { return false }
        defaults?.removeObject(forKey: openCaptureKey)
        return true
    }
}
