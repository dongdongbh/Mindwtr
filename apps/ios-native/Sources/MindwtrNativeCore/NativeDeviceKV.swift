import CryptoKit
import Darwin
import Foundation

/// Internal device settings only. Calls (including close) must be serialized by
/// the owner. RN writers must be stopped; this namespace lease is advisory.
/// No CoreHost/JS binding or Sync capability is granted by constructing a store.
final class NativeDeviceKV {
    private static let manifestLimit = 64 * 1024 * 1024
    private static let snapshotLimit = 256 * 1024 * 1024
    private static let entryLimit = 64
    private static let keyLimit = 4 * 1024
    private static let valueLimit = 1024 * 1024
    private static let mutationLimit = 8 * 1024 * 1024
    private static let lockName = ".mindwtr-device-kv.lock"
    private static let manifestName = "manifest.json"
    private static let writable: Set<Data> = Set([
        "@mindwtr_sync_backend", "@mindwtr_sync_path", "@mindwtr_sync_path_bookmark",
        "@mindwtr_webdav_url", "@mindwtr_webdav_username", "@mindwtr_webdav_allow_insecure_http",
        "@mindwtr_webdav_allow_weak_fingerprint", "@mindwtr_cloud_provider", "@mindwtr_cloud_url",
        "@mindwtr_cloud_allow_insecure_http", "@mindwtr_sync_encryption_state_v1",
        "@mindwtr_fast_sync_state_v1", "@mindwtr_local_sync_status_v1",
        "@mindwtr_webdav_capability_proof_v1", "@mindwtr_webdav_legacy_proof_v1",
        "@mindwtr_attachment_presence_reconcile_v1", "mindwtr-external-calendars", "mindwtr-system-calendar-settings",
        "mindwtr-update-available", "mindwtr-update-last-check", "mindwtr-update-latest",
    ].map { Data($0.utf8) })
    private static let removableSecrets: Set<Data> = Set([
        "@mindwtr_webdav_password", "@mindwtr_cloud_token", "@mindwtr_sync_encryption_key_v1",
    ].map { Data($0.utf8) })
    private static var failure: HostFailure { HostFailure("Device settings storage is unavailable") }
    private static var invalid: HostFailure { HostFailure("Device settings input is invalid") }

    private struct Identity: Equatable {
        let device: dev_t
        let inode: ino_t
        init(_ value: stat) { device = value.st_dev; inode = value.st_ino }
    }
    private struct Directory {
        let name: String
        let fd: Int32
        let identity: Identity
    }
    private final class FileBinding {
        let fd: Int32
        let generation: stat
        let bytes: Data
        init(fd: Int32, generation: stat, bytes: Data) {
            self.fd = fd; self.generation = generation; self.bytes = bytes
        }
        deinit { Darwin.close(fd) }
    }
    private struct Snapshot {
        let manifest: FileBinding?
        let values: [Data: String]
        let external: [String: FileBinding]
        let consumedBytes: Int
    }
    private struct Change: Equatable {
        let key: String
        let bytes: Data
        let value: String?
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.bytes == rhs.bytes && lhs.value.map { Data($0.utf8) } == rhs.value.map { Data($0.utf8) }
        }
    }
    private final class SecretRetirement {
        let name: String
        let file: FileBinding?
        var removed = false
        init(name: String, file: FileBinding?) { self.name = name; self.file = file }
    }
    private final class Pending {
        let changes: [Change]
        let before: Snapshot
        let after: Data
        let afterValues: [Data: String]
        let retirement: SecretRetirement?
        var fileFD: Int32 = -1
        init(changes: [Change], before: Snapshot, after: Data, afterValues: [Data: String], retirement: SecretRetirement?) {
            self.changes = changes; self.before = before; self.after = after; self.afterValues = afterValues
            self.retirement = retirement
        }
        func releaseFile() { if fileFD >= 0 { Darwin.close(fileFD); fileFD = -1 } }
        deinit { releaseFile() }
    }

    private let containerURL: URL
    private let bundleIdentifier: String
    private var directories: [Directory] = []
    private var leaseFD: Int32 = -1
    private var leaseGeneration: stat?
    private var snapshot: Snapshot?
    private var retainedExternal: [String: FileBinding] = [:]
    private var pending: Pending?
    private var closed = false
    private var poisoned = false
    #if DEBUG
    let faults = NativeDeviceKVFaults()
    #endif

    init(containerURL: URL, bundleIdentifier: String) throws {
        guard containerURL.isFileURL, containerURL.absoluteString.utf8.count <= 16 * 1024,
              !bundleIdentifier.isEmpty, bundleIdentifier.utf8.count <= Self.keyLimit,
              bundleIdentifier != ".", bundleIdentifier != "..", !bundleIdentifier.contains("/"),
              !bundleIdentifier.utf8.contains(0) else { throw Self.invalid }
        // Reuse only the existing fixed Apple system-alias rule, never arbitrary
        // symlink resolution as authority for the caller's supplied container.
        let path: String
        do { path = try NativeAttachmentFiles.filePath(containerURL.absoluteString) }
        catch { throw Self.invalid }
        self.containerURL = URL(fileURLWithPath: path, isDirectory: true)
        self.bundleIdentifier = bundleIdentifier
        do {
            let root = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard root >= 0 else { throw Self.failure }
            do { directories.append(Directory(name: "", fd: root, identity: Identity(try Self.directoryStat(root)))) }
            catch { Darwin.close(root); throw error }
            let initial = try LegacyRNStorage(containerURL: self.containerURL, bundleIdentifier: bundleIdentifier)
                .deviceNamespaceSnapshot()
            guard !initial.hasPopulatedLegacyCopy else { throw Self.failure }
            for component in ["Library", "Application Support", bundleIdentifier] {
                try appendDirectory(component)
            }
            let owner = try ownerFD()
            leaseFD = Darwin.openat(owner, Self.lockName, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            guard leaseFD >= 0 else { throw Self.failure }
            leaseGeneration = try Self.fileStat(leaseFD)
            guard flock(leaseFD, LOCK_EX | LOCK_NB) == 0 else { throw Self.failure }
            try verifyLease()
            guard fsync(owner) == 0 else { throw Self.failure }
            try appendDirectory("RCTAsyncLocalStorage_V1")
            snapshot = try readSnapshot()
            retainedExternal = snapshot?.external ?? [:]
        } catch {
            close()
            throw error
        }
    }

    func close() {
        closed = true
        pending?.releaseFile()
        pending = nil; snapshot = nil; retainedExternal.removeAll()
        if leaseFD >= 0 { _ = flock(leaseFD, LOCK_UN); Darwin.close(leaseFD); leaseFD = -1 }
        for directory in directories.reversed() { Darwin.close(directory.fd) }
        directories.removeAll()
    }
    deinit { close() }

    func get(_ key: String) throws -> String? { try multiGet([key])[0].1 }
    func multiGet(_ keys: [String]) throws -> [(String, String?)] {
        try Self.validateKeys(keys)
        try requireUsable()
        guard pending == nil else { throw Self.failure }
        let current = try checkedRead()
        return keys.map { ($0, current.values[Data($0.utf8)]) }
    }
    func set(_ key: String, _ value: String) throws { try multiSet([(key, value)]) }
    func multiSet(_ entries: [(String, String)]) throws {
        try Self.validateKeys(entries.map { $0.0 })
        let changes = entries.map { Change(key: $0.0, bytes: Data($0.0.utf8), value: $0.1) }
        try Self.validateChanges(changes)
        try mutate(changes)
    }
    func remove(_ key: String) throws { try multiRemove([key]) }
    static func isLegacySecretRemoval(_ keys: [String]) -> Bool {
        keys.count == 1 && removableSecrets.contains(Data(keys[0].utf8))
    }
    func multiRemove(_ keys: [String]) throws {
        try Self.validateKeys(keys)
        let changes = keys.map { Change(key: $0, bytes: Data($0.utf8), value: nil) }
        try Self.validateChanges(changes)
        try mutate(changes)
    }

    func recordAboutUpdateCheck(timestamp: String) throws {
        try Self.validateAboutTimestamp(timestamp)
        let changes = [Change(key: "mindwtr-update-last-check", bytes: Data("mindwtr-update-last-check".utf8), value: timestamp)]
        try Self.validateChanges(changes)
        try mutate(changes, skipUnchanged: true)
    }

    func storeAboutUpdateResult(available: Bool, latestVersion: String, checkedAt: String? = nil) throws {
        guard latestVersion.utf16.count <= 200, !latestVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !latestVersion.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw Self.invalid }
        if let checkedAt { try Self.validateAboutTimestamp(checkedAt) }
        var changes = [
            Change(key: "mindwtr-update-available", bytes: Data("mindwtr-update-available".utf8), value: available ? "true" : "false"),
            Change(key: "mindwtr-update-latest", bytes: Data("mindwtr-update-latest".utf8), value: available ? latestVersion : nil),
        ]
        if let checkedAt {
            changes.append(Change(key: "mindwtr-update-last-check", bytes: Data("mindwtr-update-last-check".utf8), value: checkedAt))
        }
        try Self.validateChanges(changes)
        try mutate(changes, skipUnchanged: true)
    }

    private static let searchConsentName = "mindwtr:iosSearchIndexingEnabled"
    func readSearchConsent() throws -> Bool {
        switch try get(Self.searchConsentName) {
        case nil, "false": return false
        case "true": return true
        default: throw Self.failure
        }
    }
    // Private typed authority; the cell stays outside the generic JS writable allowlist.
    func setSearchConsent(_ enabled: Bool) throws {
        try mutate([Change(key: Self.searchConsentName, bytes: Data(Self.searchConsentName.utf8),
                           value: enabled ? "true" : "false")], skipUnchanged: true)
    }

    private static let reminderNames = ["mindwtr:local:alarms:v1", "mindwtr:native:reminders:v1"]
    var hasPendingReminderMutation: Bool {
        pending.map { $0.changes.map(\.key) == Self.reminderNames } ?? false
    }
    /// Fixed private two-cell CAS; reminder keys remain absent from the generic writable allowlist.
    func compareAndSetReminderMaps(expected: [String?], next: [String?], confirmUnchanged: Bool = false) throws {
        guard expected.count == 2, next.count == 2,
              (expected + next).allSatisfy({ ($0?.utf8.count ?? 0) <= Self.valueLimit }) else { throw Self.invalid }
        try requireUsable()
        let changes = zip(Self.reminderNames, next).map { Change(key: $0.0, bytes: Data($0.0.utf8), value: $0.1) }
        let before: Snapshot
        if let pending {
            guard pending.changes == changes else { throw Self.failure }
            before = pending.before
        } else { before = try checkedRead() }
        guard zip(Self.reminderNames, expected).allSatisfy({ name, value in
            before.values[Data(name.utf8)].map { Data($0.utf8) } == value.map { Data($0.utf8) }
        }) else { throw Self.failure }
        try mutate(changes, skipUnchanged: !confirmUnchanged)
    }

    private static let calendarSettingNames = ["mindwtr-system-calendar-settings", "mindwtr:native:calendar-setting:v1"]
    func readCalendarSettingState() throws -> [String?] {
        try multiGet(Self.calendarSettingNames).map(\.1)
    }
    var hasPendingCalendarSettingMutation: Bool {
        pending.map { $0.changes.map(\.key) == Self.calendarSettingNames } ?? false
    }
    /// Only the prepared calendar owner may atomically publish its private mutation proof.
    func compareAndSetCalendarSetting(expected: [String?], next: [String]) throws {
        guard expected.count == 2, next.count == 2,
              expected.allSatisfy({ ($0?.utf8.count ?? 0) <= Self.valueLimit }),
              next.allSatisfy({ $0.utf8.count <= Self.valueLimit }) else { throw Self.invalid }
        try requireUsable()
        let changes = zip(Self.calendarSettingNames, next).map { Change(key: $0.0, bytes: Data($0.0.utf8), value: $0.1) }
        let before: Snapshot
        if let pending {
            guard pending.changes == changes else { throw Self.failure }
            before = pending.before
        } else { before = try checkedRead() }
        guard zip(Self.calendarSettingNames, expected).allSatisfy({ name, value in
            before.values[Data(name.utf8)].map { Data($0.utf8) } == value.map { Data($0.utf8) }
        }) else { throw Self.failure }
        try mutate(changes, skipUnchanged: true)
    }

    private static let calendarPushNames = [
        "mindwtr:calendar-push-sync:enabled", "mindwtr:calendar-push-sync:calendar-id",
        "mindwtr:calendar-push-sync:target-calendar-id", "mindwtr:calendar-push-sync:color",
        "mindwtr:calendar-push-sync:creation-intent", "mindwtr:native:calendar-push-effect:v1",
    ]
    func readCalendarPushState() throws -> [String?] {
        let values = try multiGet(Self.calendarPushNames).map(\.1)
        guard values.allSatisfy({ ($0?.utf8.count ?? 0) <= Self.valueLimit }) else { throw Self.failure }
        return values
    }
    var hasPendingCalendarPushMutation: Bool {
        pending.map { $0.changes.map(\.key) == Self.calendarPushNames } ?? false
    }
    /// Private raw six-cell authority; the effect owner validates transitions before using it.
    func compareAndSetCalendarPushState(expected: [String?], next: [String?]) throws {
        guard expected.count == 6, next.count == 6,
              (expected + next).allSatisfy({ ($0?.utf8.count ?? 0) <= Self.valueLimit }) else { throw Self.invalid }
        try requireUsable()
        let changes = zip(Self.calendarPushNames, next).map { Change(key: $0.0, bytes: Data($0.0.utf8), value: $0.1) }
        let before: Snapshot
        if let pending {
            guard pending.changes == changes else { throw Self.failure }
            before = pending.before
        } else { before = try checkedRead() }
        guard zip(Self.calendarPushNames, expected).allSatisfy({ name, value in
            before.values[Data(name.utf8)].map { Data($0.utf8) } == value.map { Data($0.utf8) }
        }) else { throw Self.failure }
        try mutate(changes, skipUnchanged: true)
    }

    private static func validateAboutTimestamp(_ timestamp: String) throws {
        guard !timestamp.isEmpty, timestamp.utf8.count <= 16, let value = UInt64(timestamp),
              value <= 9_007_199_254_740_991, String(value) == timestamp else { throw invalid }
    }

    private func mutate(_ changes: [Change], skipUnchanged: Bool = false) throws {
        try requireUsable()
        if let pending {
            guard pending.changes == changes else { throw Self.failure }
        } else {
            var before = try checkedRead()
            if changes.isEmpty { return }
            if skipUnchanged && changes.allSatisfy({ change in
                before.values[change.bytes].map { Data($0.utf8) } == change.value.map { Data($0.utf8) }
            }) { return }
            let object: NSMutableDictionary
            if let bytes = before.manifest?.bytes {
                guard let parsed = try NativeJSON.jsonObject(with: bytes, options: [.mutableContainers]) as? NSMutableDictionary else {
                    throw Self.failure
                }
                object = parsed
            } else { object = NSMutableDictionary() }
            var retirement: SecretRetirement?
            var orphanInputBytes = 0
            if Self.isLegacySecretRemoval(changes.map(\.key)) {
                let selected = changes[0]
                let name = Self.externalName(selected.key)
                // A different live manifest reference never grants permission
                // to retire its backing path, even if its MD5 filename collides.
                for (key, value) in object where value is NSNull {
                    guard let key = key as? String else { throw Self.failure }
                    guard Data(key.utf8) == selected.bytes || Self.externalName(key) != name else { throw Self.failure }
                }
                var remaining = Self.snapshotLimit - (before.manifest?.bytes.count ?? 0)
                for file in before.external.values { remaining -= file.bytes.count }
                guard remaining >= 0 else { throw Self.failure }
                var inputLimit = Self.snapshotLimit
                #if DEBUG
                if let limit = faults.snapshotByteLimit { inputLimit = min(inputLimit, max(0, limit)) }
                #endif
                // An unreferenced file is additional to the legacy reader's
                // full input (including old manifests/repeated references).
                remaining = min(remaining, max(0, inputLimit - before.consumedBytes))
                let file = try before.external[name] ?? Self.readFile(try storeFD(), name: name,
                    limit: Self.snapshotLimit, remaining: &remaining, optional: true)
                if !(object.object(forKey: selected.key) is NSNull) { orphanInputBytes = file?.bytes.count ?? 0 }
                let current = try readSnapshot()
                guard Self.sameSnapshot(current, before) else { throw poison() }
                try verifyFile(file, name: name)
                retirement = SecretRetirement(name: name, file: file)
                if before.values[selected.bytes] == nil, file == nil { return }
                if let file, before.external[name] == nil {
                    var external = before.external; external[name] = file
                    before = Snapshot(manifest: before.manifest, values: before.values,
                                      external: external, consumedBytes: before.consumedBytes)
                    // Bind a captured orphan only after validating the original
                    // namespace and snapshot; constructor/read never retire it.
                    snapshot = before; retainedExternal = external
                }
            }
            var values = before.values
            for change in changes {
                if let value = change.value {
                    object.setObject(value, forKey: change.key as NSString)
                    values[change.bytes] = value
                } else {
                    object.removeObject(forKey: change.key as NSString)
                    values.removeValue(forKey: change.bytes)
                }
            }
            let after = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            guard after.count <= Self.manifestLimit else { throw Self.invalid }
            // Keep the reader's full contribution from old empty manifests and
            // repeated external references. Inline/remove can only reduce that
            // contribution, so retaining it is a conservative future ceiling.
            let otherInput = before.consumedBytes - (before.manifest?.bytes.count ?? 0)
            let withOrphan = otherInput.addingReportingOverflow(orphanInputBytes)
            let futureInput = withOrphan.partialValue.addingReportingOverflow(after.count)
            var inputLimit = Self.snapshotLimit
            #if DEBUG
            if let limit = faults.snapshotByteLimit { inputLimit = min(inputLimit, max(0, limit)) }
            #endif
            guard otherInput >= 0, !withOrphan.overflow, !futureInput.overflow,
                  futureInput.partialValue <= inputLimit else { throw Self.invalid }
            var retainedBytes = after.count
            for file in before.external.values {
                let count = retainedBytes.addingReportingOverflow(file.bytes.count)
                guard !count.overflow, count.partialValue <= Self.snapshotLimit else { throw Self.invalid }
                retainedBytes = count.partialValue
            }
            pending = Pending(changes: changes, before: before, after: after, afterValues: values, retirement: retirement)
        }
        guard let operation = pending else { throw Self.failure }
        do {
            let actual = try readSnapshot()
            if Self.sameSnapshot(actual, operation.before) {
                #if DEBUG
                try faults.beforePromotion?()
                #endif
                let beforeWrite = try readSnapshot()
                guard Self.sameSnapshot(beforeWrite, operation.before) else { throw poison() }
                operation.releaseFile()
                try DurableFile.write(operation.after, to: Self.manifestName, in: try storeFD(), retainingFile: &operation.fileFD,
                                      preservingProtectionFrom: operation.before.manifest?.fd)
                try verifyNamespace()
                #if DEBUG
                try faults.afterPromotion?()
                #endif
            } else if try isOwnedAfter(actual, operation: operation) {
                try synchronize(operation)
            } else {
                throw poison()
            }
            #if DEBUG
            try faults.beforeReadback?()
            #endif
            let written = try readSnapshot()
            guard try isOwnedAfter(written, operation: operation) else { throw poison() }
            try synchronize(operation)
            let acknowledged = try readSnapshot()
            guard try isOwnedAfter(acknowledged, operation: operation) else { throw poison() }
            var final = acknowledged
            if let retirement = operation.retirement {
                try retireSecret(retirement, operation: operation)
                final = try readSnapshot()
                guard try isOwnedAfter(final, operation: operation) else { throw poison() }
            }
            snapshot = final
            retainedExternal = final.external
            pending = nil
        } catch {
            // A fault or write error retains this operation. Namespace/file
            // uncertainty is poisoned by the verification paths, never adopted.
            if !poisoned {
                do { try verifyNamespace() }
                catch { _ = poison() }
            }
            throw error
        }
    }

    private func retireSecret(_ retirement: SecretRetirement, operation: Pending) throws {
        #if DEBUG
        try faults.beforeSecretUnlink?()
        #endif
        let current = try readSnapshot()
        guard try isOwnedAfter(current, operation: operation) else { throw poison() }
        try verifyNamespace()
        if let file = retirement.file, !retirement.removed {
            try verifyFile(file, name: retirement.name)
            guard unlinkat(try storeFD(), retirement.name, 0) == 0 else { throw Self.failure }
            // This state must survive a lost acknowledgment after our unlink.
            // The held FD stays alive, but its unlinked generation is no longer
            // required to equal the previously named single-link file.
            retirement.removed = true
            retainedExternal.removeValue(forKey: retirement.name)
            #if DEBUG
            try faults.afterSecretUnlink?()
            #endif
        }
        try verifyFile(nil, name: retirement.name)
        guard fsync(try storeFD()) == 0 else { throw Self.failure }
        try verifyNamespace()
        try verifyFile(nil, name: retirement.name)
    }

    private func synchronize(_ operation: Pending) throws {
        try verifyNamespace()
        guard operation.fileFD >= 0, fsync(operation.fileFD) == 0,
              fcntl(operation.fileFD, F_FULLFSYNC) == 0, fsync(try storeFD()) == 0 else { throw Self.failure }
        try verifyNamespace()
    }
    private func isOwnedAfter(_ current: Snapshot, operation: Pending) throws -> Bool {
        var external = operation.before.external
        if let retirement = operation.retirement, retirement.removed { external.removeValue(forKey: retirement.name) }
        guard let manifest = current.manifest, manifest.bytes == operation.after,
              Self.sameValues(current.values, operation.afterValues),
              Self.sameExternal(current.external, external) else { return false }
        guard operation.fileFD >= 0 else { return false }
        let owned = try Self.fileStat(operation.fileFD)
        guard Identity(owned) == Identity(manifest.generation) else { throw poison() }
        return true
    }
    private func requireUsable() throws { guard !closed, !poisoned else { throw Self.failure } }
    private func poison() -> HostFailure {
        poisoned = true
        close()
        return Self.failure
    }
    private func checkedRead() throws -> Snapshot {
        do {
            let current = try readSnapshot()
            guard let snapshot, Self.sameSnapshot(current, snapshot) else { throw Self.failure }
            return current
        } catch { throw poison() }
    }

    private func readSnapshot() throws -> Snapshot {
        do {
            try verifyNamespace()
            var remaining = Self.snapshotLimit
            let manifest = try Self.readFile(try storeFD(), name: Self.manifestName,
                                             limit: Self.manifestLimit, remaining: &remaining, optional: true)
            let parsed = try LegacyRNStorage(containerURL: containerURL, bundleIdentifier: bundleIdentifier)
                .deviceNamespaceSnapshot()
            guard !parsed.hasPopulatedLegacyCopy, parsed.manifest == manifest?.bytes else { throw Self.failure }
            var external: [String: FileBinding] = [:]
            if let bytes = manifest?.bytes {
                guard let entries = try NativeJSON.jsonObject(with: bytes) as? NSDictionary else { throw Self.failure }
                for (key, value) in entries where value is NSNull {
                    guard let key = key as? String else { throw Self.failure }
                    let name = Self.externalName(key)
                    if external[name] == nil {
                        guard let file = try Self.readFile(try storeFD(), name: name, limit: Self.snapshotLimit,
                                                          remaining: &remaining, optional: false) else { throw Self.failure }
                        external[name] = file
                    }
                    // RN's UTF-8 file reader consumes one encoding marker.
                    // Bind that decoded value separately
                    // while retaining the original raw bytes and generation.
                    guard let file = external[name], let decoded = LegacyRNStorage.decodeExternalUTF8(file.bytes),
                          let value = parsed.values[Data(key.utf8)], Data(decoded.utf8) == Data(value.utf8) else {
                        throw Self.failure
                    }
                }
            }
            // Inline replacement/removal changes only the manifest reference.
            // Every previously referenced external file remains bound and kept.
            for (name, original) in retainedExternal {
                if external[name] == nil {
                    guard let current = try Self.readFile(try storeFD(), name: name, limit: Self.snapshotLimit,
                                                         remaining: &remaining, optional: false) else { throw Self.failure }
                    external[name] = current
                }
                guard let current = external[name], current.bytes == original.bytes,
                      Self.sameGeneration(current.generation, original.generation) else { throw Self.failure }
            }
            if let retirement = pending?.retirement, retirement.removed || retirement.file == nil {
                try verifyFile(nil, name: retirement.name)
            }
            try verifyNamespace()
            try verifyFile(manifest, name: Self.manifestName)
            for (name, file) in external { try verifyFile(file, name: name) }
            return Snapshot(manifest: manifest, values: parsed.values, external: external, consumedBytes: parsed.consumedBytes)
        } catch { throw poison() }
    }

    private func appendDirectory(_ name: String) throws {
        guard let parent = directories.last else { throw Self.failure }
        if mkdirat(parent.fd, name, 0o700) == 0 {
            guard fsync(parent.fd) == 0 else { throw Self.failure }
        } else if errno != EEXIST { throw Self.failure }
        let fd = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Self.failure }
        do { directories.append(Directory(name: name, fd: fd, identity: Identity(try Self.directoryStat(fd)))) }
        catch { Darwin.close(fd); throw error }
    }
    private func ownerFD() throws -> Int32 {
        guard directories.count >= 4 else { throw Self.failure }
        return directories[3].fd
    }
    private func storeFD() throws -> Int32 {
        guard directories.count == 5 else { throw Self.failure }
        return directories[4].fd
    }
    private func verifyLease() throws {
        guard leaseFD >= 0, let expected = leaseGeneration else { throw Self.failure }
        let descriptor = try Self.fileStat(leaseFD)
        var named = stat()
        guard fstatat(try ownerFD(), Self.lockName, &named, AT_SYMLINK_NOFOLLOW) == 0,
              Self.sameGeneration(descriptor, expected), Self.sameGeneration(named, expected) else { throw Self.failure }
    }
    private func verifyNamespace() throws {
        try requireUsable()
        guard let root = directories.first else { throw Self.failure }
        let fd = Darwin.open(containerURL.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { throw Self.failure }
        defer { Darwin.close(fd) }
        guard Identity(try Self.directoryStat(fd)) == root.identity else { throw Self.failure }
        for index in directories.indices {
            let directory = directories[index]
            guard Identity(try Self.directoryStat(directory.fd)) == directory.identity else { throw Self.failure }
            if index > 0 {
                var named = stat()
                guard fstatat(directories[index - 1].fd, directory.name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                      named.st_mode & S_IFMT == S_IFDIR, Identity(named) == directory.identity else { throw Self.failure }
            }
        }
        try verifyLease()
    }
    private func verifyFile(_ binding: FileBinding?, name: String) throws {
        var named = stat()
        if let binding {
            guard fstatat(try storeFD(), name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  Self.sameGeneration(try Self.fileStat(binding.fd), binding.generation),
                  Self.sameGeneration(named, binding.generation) else { throw Self.failure }
        } else {
            guard fstatat(try storeFD(), name, &named, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw Self.failure }
        }
    }

    private static func readFile(_ directory: Int32, name: String, limit: Int,
                                 remaining: inout Int, optional: Bool) throws -> FileBinding? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { if optional && errno == ENOENT { return nil }; throw failure }
        do {
            let initial = try fileStat(fd)
            guard initial.st_size >= 0, initial.st_size <= Int64(min(limit, remaining)) else { throw failure }
            var bytes = Data()
            var buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
                if count < 0 && errno == EINTR { continue }
                guard count >= 0, count <= remaining - bytes.count else { throw failure }
                if count == 0 { break }
                guard bytes.count <= Int(initial.st_size) - count else { throw failure }
                bytes.append(contentsOf: buffer.prefix(count))
            }
            var named = stat()
            guard bytes.count == Int(initial.st_size), sameGeneration(initial, try fileStat(fd)),
                  fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  sameGeneration(initial, named) else { throw failure }
            remaining -= bytes.count
            return FileBinding(fd: fd, generation: initial, bytes: bytes)
        } catch { Darwin.close(fd); throw error }
    }
    private static func directoryStat(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & S_IFMT == S_IFDIR else { throw failure }
        return value
    }
    private static func fileStat(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1 else { throw failure }
        return value
    }
    private static func sameGeneration(_ lhs: stat, _ rhs: stat) -> Bool {
        Identity(lhs) == Identity(rhs) && lhs.st_mode == rhs.st_mode && lhs.st_nlink == 1 && rhs.st_nlink == 1
            && lhs.st_size == rhs.st_size && lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec
            && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec && lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec
            && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec
    }
    private static func sameValues(_ lhs: [Data: String], _ rhs: [Data: String]) -> Bool {
        lhs.count == rhs.count && lhs.allSatisfy { key, value in rhs[key].map { Data($0.utf8) } == Data(value.utf8) }
    }
    private static func sameExternal(_ lhs: [String: FileBinding], _ rhs: [String: FileBinding]) -> Bool {
        lhs.count == rhs.count && lhs.allSatisfy { name, file in
            guard let other = rhs[name] else { return false }
            return file.bytes == other.bytes && sameGeneration(file.generation, other.generation)
        }
    }
    private static func sameSnapshot(_ lhs: Snapshot, _ rhs: Snapshot) -> Bool {
        let manifest: Bool
        switch (lhs.manifest, rhs.manifest) {
        case (nil, nil): manifest = true
        case let (left?, right?): manifest = left.bytes == right.bytes && sameGeneration(left.generation, right.generation)
        default: manifest = false
        }
        return manifest && lhs.consumedBytes == rhs.consumedBytes
            && sameValues(lhs.values, rhs.values) && sameExternal(lhs.external, rhs.external)
    }
    private static func validateKeys(_ keys: [String]) throws {
        guard keys.count <= entryLimit, keys.allSatisfy({ !$0.isEmpty && $0.utf8.count <= keyLimit }) else {
            throw invalid
        }
    }
    private static func validateChanges(_ changes: [Change]) throws {
        try validateKeys(changes.map(\.key))
        let secretRemoval = changes.count == 1 && changes[0].value == nil && isLegacySecretRemoval(changes.map(\.key))
        var count = 0
        for change in changes {
            guard (writable.contains(change.bytes) || secretRemoval), (change.value?.utf8.count ?? 0) <= valueLimit else { throw invalid }
            for size in [change.bytes.count, change.value?.utf8.count ?? 0] {
                let next = count.addingReportingOverflow(size)
                guard !next.overflow, next.partialValue <= mutationLimit else { throw invalid }
                count = next.partialValue
            }
        }
    }
    private static func externalName(_ key: String) -> String {
        Insecure.MD5.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

#if DEBUG
// IO boundaries only, never release-build knobs or domain fixtures.
final class NativeDeviceKVFaults {
    var beforePromotion: (() throws -> Void)?
    var afterPromotion: (() throws -> Void)?
    var beforeReadback: (() throws -> Void)?
    var beforeSecretUnlink: (() throws -> Void)?
    var afterSecretUnlink: (() throws -> Void)?
    // A smaller IO read ceiling for bounded tests; release limits are unchanged.
    var snapshotByteLimit: Int?
}
#endif
