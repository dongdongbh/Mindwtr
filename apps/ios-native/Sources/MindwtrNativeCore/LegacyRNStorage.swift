import CryptoKit
import CoreFoundation
import Foundation

/// Constructing this snapshot is read-only. The upgrade coordinator must stop
/// legacy writers and hold exclusive ownership through any authority-marker commit.
public struct LegacyRNStorage {
    // Fail explicitly, never truncate: iOS backups are not limited by Android's
    // CursorWindow. These caps bound manifest parsing and total snapshot input.
    private static let manifestLimit = 64 * 1024 * 1024
    private static let snapshotLimit = 256 * 1024 * 1024
    private static let jsonAhead = "mindwtr-data:json-ahead-of-sqlite"
    private static let reconciled = "mindwtr-data:sqlite-json-reconcile-v1"
    private struct Store {
        let manifestURL: URL
        let manifest: Data
        // NSString keys in RN distinguish different UTF-8 normalizations.
        let values: [Data: String]
    }
    private let containerURL: URL
    private let bundleIdentifier: String
    private let source: Store?
    private let storeCopies: [Store]
    private let nonemptyStoreCount: Int
    private let consumedSnapshotBytes: Int
    private var values: [Data: String] { source?.values ?? [:] }
    var hasStoredValues: Bool { !values.isEmpty }
    #if DEBUG
    let commitFaults = LegacyRNStorageCommitFaults()
    #endif

    public init(containerURL: URL, bundleIdentifier: String) throws {
        guard containerURL.isFileURL, !bundleIdentifier.isEmpty,
              bundleIdentifier != ".", bundleIdentifier != "..",
              !bundleIdentifier.contains("/"), !bundleIdentifier.contains("\0") else {
            throw HostFailure("Invalid legacy storage location")
        }
        let root = containerURL.resolvingSymlinksInPath()
        guard try Self.attributes(root)?[.type] as? FileAttributeType == .typeDirectory else {
            throw HostFailure("Legacy storage container is unavailable")
        }
        let paths = [
            ["Library", "Application Support", bundleIdentifier, "RCTAsyncLocalStorage_V1"],
            ["Documents", "RCTAsyncLocalStorage_V1"],
            ["Documents", "RNCAsyncLocalStorage_V1"],
            ["Documents", "RCTAsyncLocalStorage"],
        ]
        var remaining = Self.snapshotLimit
        var selected: Store?
        var copies: [Store] = []
        var nonemptyCount = 0
        for components in paths {
            guard let directory = try Self.directory(root: root, components: components) else { continue }
            guard let candidate = try Self.readStore(directory, remaining: &remaining) else { continue }
            copies.append(candidate)
            guard !candidate.values.isEmpty else { continue }
            nonemptyCount += 1
            if let selected {
                guard Self.equalValues(candidate.values, selected.values) else {
                    throw HostFailure("Conflicting legacy storage copies require recovery")
                }
            } else {
                selected = candidate
            }
        }
        self.containerURL = root
        self.bundleIdentifier = bundleIdentifier
        source = selected
        storeCopies = copies
        nonemptyStoreCount = nonemptyCount
        consumedSnapshotBytes = Self.snapshotLimit - remaining
    }

    public func value(forKey key: String) throws -> String? { values[Data(key.utf8)] }

    // Read-only reuse for the internal current-namespace settings store. This
    // grants no legacy migration or authority-marker mutation permission.
    struct DeviceNamespaceSnapshot {
        let manifest: Data?
        let values: [Data: String]
        let hasPopulatedLegacyCopy: Bool
        let consumedBytes: Int
    }
    func deviceNamespaceSnapshot() -> DeviceNamespaceSnapshot {
        let canonical = containerURL.appendingPathComponent("Library/Application Support")
            .appendingPathComponent(bundleIdentifier).appendingPathComponent("RCTAsyncLocalStorage_V1/manifest.json")
        let current = storeCopies.first { $0.manifestURL == canonical }
        return DeviceNamespaceSnapshot(manifest: current?.manifest, values: current?.values ?? [:],
            hasPopulatedLegacyCopy: storeCopies.contains { $0.manifestURL != canonical && !$0.values.isEmpty },
            consumedBytes: consumedSnapshotBytes)
    }

    /// Exact wire shape consumed by the shared host's LegacyState. Empty strings
    /// still count as present; backup parsing and import decisions belong to core.
    public func bootState() throws -> (stateJSON: String, backupJSON: String) {
        let backup = ["mindwtr-data", "focus-gtd-data", "gtd-todo-data", "gtd-data"]
            .lazy.compactMap { self.values[Data($0.utf8)] }.first
        let state: [String: Any] = [
            "jsonAhead": try value(forKey: Self.jsonAhead) != nil,
            "reconciled": try value(forKey: Self.reconciled) != nil,
            "backupVersion": try value(forKey: "mindwtr-data:startup-backup-version") as Any? ?? NSNull(),
            "backupPresent": backup != nil,
        ]
        let data = try JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
        return (String(decoding: data, as: UTF8.self), backup ?? "")
    }

    /// Called only after core has validated the imported SQLite readback. This
    /// changes authority markers, never backup data or referenced external files.
    func commit(changeJSON: String, checkpointURL: URL) throws {
        guard changeJSON.utf8.count <= 4096,
              let change = try? NativeJSON.jsonObject(with: Data(changeJSON.utf8)) as? NSDictionary,
              change.count == 2,
              let clear = change["clearJsonAhead"] as? NSNumber,
              let reconcile = change["setReconciled"] as? NSNumber,
              CFGetTypeID(clear) == CFBooleanGetTypeID(), CFGetTypeID(reconcile) == CFBooleanGetTypeID() else {
            throw HostFailure("Invalid legacy authority change")
        }
        guard clear.boolValue || reconcile.boolValue else { return }
        guard nonemptyStoreCount == 1, let source else {
            throw HostFailure("Legacy authority commit requires one populated storage copy")
        }
        let object = try NativeJSON.jsonObject(with: source.manifest, options: [.mutableContainers])
        guard let next = object as? NSMutableDictionary else { throw HostFailure("Legacy storage manifest is invalid") }
        var nextValues = values
        if clear.boolValue {
            next.removeObject(forKey: Self.jsonAhead)
            nextValues.removeValue(forKey: Data(Self.jsonAhead.utf8))
        }
        if reconcile.boolValue {
            next[Self.reconciled] = "1" // RN storage-adapter.ts writes this exact string.
            nextValues[Data(Self.reconciled.utf8)] = "1"
        }
        let updated = try JSONSerialization.data(withJSONObject: next, options: [.sortedKeys])
        guard updated.count <= Self.manifestLimit else { throw HostFailure("Legacy storage exceeds the safe read limit; recovery is required") }
        _ = try verifiedCurrent(updated: updated, nextValues: nextValues)
        // Fresh snapshots after success need no second checkpoint or marker write.
        if Self.equalValues(values, nextValues) {
            try DurableFile.sync(source.manifestURL)
            try DurableFile.sync(source.manifestURL.deletingLastPathComponent(), directory: true)
            return
        }
        guard checkpointURL.isFileURL,
              checkpointURL.resolvingSymlinksInPath() != source.manifestURL.resolvingSymlinksInPath(),
              try Self.attributes(checkpointURL.deletingLastPathComponent())?[.type] as? FileAttributeType == .typeDirectory else {
            throw HostFailure("Invalid legacy recovery checkpoint location")
        }
        #if DEBUG
        try commitFaults.beforeCheckpoint?()
        #endif
        if try Self.attributes(checkpointURL) != nil {
            var remaining = Self.manifestLimit
            guard try Self.readFile(checkpointURL, limit: Self.manifestLimit, remaining: &remaining) == source.manifest else {
                throw HostFailure("Legacy recovery checkpoint does not match the original snapshot")
            }
            try DurableFile.sync(checkpointURL)
            try DurableFile.sync(checkpointURL.deletingLastPathComponent(), directory: true)
        } else {
            try DurableFile.write(source.manifest, to: checkpointURL)
        }
        var remaining = Self.manifestLimit
        guard try Self.readFile(checkpointURL, limit: Self.manifestLimit, remaining: &remaining) == source.manifest else {
            throw HostFailure("Legacy recovery checkpoint verification failed")
        }
        #if DEBUG
        try commitFaults.beforePromotion?()
        #endif
        if try verifiedCurrent(updated: updated, nextValues: nextValues) != updated {
            try DurableFile.write(updated, to: source.manifestURL)
        } else {
            // A previous promotion may have succeeded before acknowledgment failed.
            try DurableFile.sync(source.manifestURL)
            try DurableFile.sync(source.manifestURL.deletingLastPathComponent(), directory: true)
        }
        #if DEBUG
        try commitFaults.beforeReadback?()
        #endif
        guard try verifiedCurrent(updated: updated, nextValues: nextValues) == updated else {
            throw HostFailure("Legacy authority readback verification failed")
        }
    }

    private func verifiedCurrent(updated: Data, nextValues: [Data: String]) throws -> Data {
        let current = try LegacyRNStorage(containerURL: containerURL, bundleIdentifier: bundleIdentifier)
        guard let original = source,
              let live = current.storeCopies.first(where: { $0.manifestURL == original.manifestURL }),
              current.nonemptyStoreCount == (live.values.isEmpty ? 0 : 1),
              (live.manifest == original.manifest && Self.equalValues(live.values, values)) ||
                (live.manifest == updated && Self.equalValues(live.values, nextValues)) else {
            throw HostFailure("Legacy storage changed since the upgrade snapshot")
        }
        return live.manifest
    }

    private static func equalValues(_ left: [Data: String], _ right: [Data: String]) -> Bool {
        left.count == right.count && left.allSatisfy { key, value in right[key]?.utf8.elementsEqual(value.utf8) == true }
    }

    // RN's NSString file reader consumes one UTF-8 encoding marker. Foundation's
    // String(data:) differs by OS; use it only to reject malformed input here.
    static func decodeExternalUTF8(_ data: Data) -> String? {
        guard String(data: data, encoding: .utf8) != nil else { return nil }
        if data.starts(with: [0xEF, 0xBB, 0xBF]) {
            return String(decoding: data.dropFirst(3), as: UTF8.self)
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func directory(root: URL, components: [String]) throws -> URL? {
        var current = root
        for component in components {
            current.appendPathComponent(component, isDirectory: true)
            guard let attributes = try attributes(current) else { return nil }
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw HostFailure("Legacy storage directory is invalid")
            }
        }
        return current
    }

    private static func readStore(_ directory: URL, remaining: inout Int) throws -> Store? {
        let manifest = directory.appendingPathComponent("manifest.json")
        guard try attributes(manifest) != nil else {
            let contents: [String]
            do { contents = try FileManager.default.contentsOfDirectory(atPath: directory.path) }
            catch { throw HostFailure("Cannot read legacy storage directory") }
            guard contents.isEmpty else { throw HostFailure("Legacy storage manifest is missing") }
            return nil
        }
        let data = try readFile(manifest, limit: manifestLimit, remaining: &remaining)
        guard String(data: data, encoding: .utf8) != nil else {
            throw HostFailure("Legacy storage manifest is not UTF-8")
        }
        let object: Any
        do { object = try NativeJSON.jsonObject(with: data) }
        catch { throw HostFailure("Legacy storage manifest is invalid") }
        guard let entries = object as? NSDictionary else {
            throw HostFailure("Legacy storage manifest is invalid")
        }
        var result: [Data: String] = [:]
        for (rawKey, value) in entries {
            guard let key = rawKey as? String, !key.isEmpty else { throw HostFailure("Legacy storage manifest is invalid") }
            if let inline = value as? String {
                result[Data(key.utf8)] = inline
            } else if value is NSNull {
                // Format compatibility with RNCAsyncStorage, not a security hash.
                let name = Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
                let data = try readFile(directory.appendingPathComponent(name), limit: snapshotLimit, remaining: &remaining)
                guard let text = decodeExternalUTF8(data) else {
                    throw HostFailure("Legacy storage value is not UTF-8")
                }
                result[Data(key.utf8)] = text
            } else {
                throw HostFailure("Legacy storage manifest is invalid")
            }
        }
        return Store(manifestURL: manifest, manifest: data, values: result)
    }

    private static func readFile(_ url: URL, limit: Int, remaining: inout Int) throws -> Data {
        guard let attributes = try attributes(url),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber else {
            throw HostFailure("Legacy storage file is missing or invalid")
        }
        guard size.int64Value >= 0, size.int64Value <= Int64(min(limit, remaining)) else {
            throw HostFailure("Legacy storage exceeds the safe read limit; recovery is required")
        }
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch { throw HostFailure("Cannot read legacy storage file") }
        guard data.count == size.intValue, data.count <= remaining else {
            throw HostFailure("Legacy storage changed while being read")
        }
        remaining -= data.count
        return data
    }

    private static func attributes(_ url: URL) throws -> [FileAttributeKey: Any]? {
        do { return try FileManager.default.attributesOfItem(atPath: url.path) }
        catch let error as NSError {
            if error.domain == NSCocoaErrorDomain,
               [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) { return nil }
            throw HostFailure("Cannot inspect legacy storage")
        }
    }
}

#if DEBUG
// IO boundaries only; absent from release builds.
final class LegacyRNStorageCommitFaults {
    var beforeCheckpoint: (() throws -> Void)?
    var beforePromotion: (() throws -> Void)?
    var beforeReadback: (() throws -> Void)?
}
#endif
