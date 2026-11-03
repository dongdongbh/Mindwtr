import Foundation
import Darwin
import CryptoKit

enum NativeBackupOperationFilesError: LocalizedError, Equatable {
    case unavailable, planTooLarge, snapshotTooLarge
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Backup recovery files unavailable"
        case .planTooLarge: return "Backup operation exceeds the supported byte limit"
        case .snapshotTooLarge: return "Recovery snapshot exceeds the supported backup byte limit"
        }
    }
}

struct NativeBackupSnapshotReference: Codable, Equatable, Sendable {
    let id: String
    let name: String
    let sha256: String
    let byteCount: Int
}

struct NativeBackupOperationReference: Codable, Equatable, Sendable {
    let id: String
    let sha256: String
    let byteCount: Int
}

struct NativeBackupOperationRead: Sendable {
    let planJSON: String
    let snapshot: NativeBackupSnapshotReference
}


final class NativeBackupOperationFiles {
    static let maximumPlanBytes = 512 * 1024 * 1024
    static let maximumSnapshotBytes = 128 * 1024 * 1024
    static let maximumManifestBytes = 16 * 1024
    private static let maximumMetadataBytes = 8 * 1024
    private let root: URL

    private struct Manifest: Codable {
        let version: Int
        let id: String
        let planSHA256: String
        let planByteCount: Int
        let snapshot: NativeBackupSnapshotReference
        let createdSnapshotBool: Bool
    }

    private struct Metadata: Codable {
        let version: Int
        let snapshot: NativeBackupSnapshotReference
        let completed: Bool
    }

    #if DEBUG
    var beforeSnapshotWrite: (() throws -> Void)?
    var beforePlanWrite: (() throws -> Void)?
    var beforeMetadataPromote: (() throws -> Void)?
    var afterMetadataPromote: (() throws -> Void)?
    #endif

    init(libraryRoot: URL) { root = Self.normalized(libraryRoot) }


    func nextSnapshotName(at date: Date) throws -> String {
        try safe {
            guard date.timeIntervalSince1970.isFinite else { throw failure() }
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "yyyy-MM-dd'T'HH-mm-ss.SSS"
            let base = "data." + formatter.string(from: date)
            guard Self.isSnapshotName(base + ".snapshot.json") else { throw failure() }
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let snapshots = try openFamily(parent, "backup-snapshots", create: false)
            guard let snapshots else { return base + ".snapshot.json" }
            defer { Darwin.close(snapshots) }
            let used = try names(snapshots)
            for collision in 0..<100 {
                let name = base + (collision == 0 ? "" : ".\(collision)") + ".snapshot.json"
                if !used.contains(reservationName(name)) { return name }
            }
            throw failure()
        }
    }

    func prepare(id: String, planJSON: String,
                 newSnapshot: (name: String, content: String)?,
                 existingSnapshot: NativeBackupSnapshotReference?) throws -> NativeBackupOperationReference {
        try safe {
            guard Self.isUUID(id), (newSnapshot == nil) != (existingSnapshot == nil) else { throw failure() }

            guard planJSON.utf8.count <= Self.maximumPlanBytes else { throw NativeBackupOperationFilesError.planTooLarge }
            if let newSnapshot {
                guard Self.isSnapshotName(newSnapshot.name) else { throw failure() }
                guard newSnapshot.content.utf8.count <= Self.maximumSnapshotBytes else {
                    throw NativeBackupOperationFilesError.snapshotTooLarge
                }
            }
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let operations = try requiredFamily(parent, "backup-operations")
            defer { Darwin.close(operations) }
            let snapshots = try requiredFamily(parent, "backup-snapshots")
            defer { Darwin.close(snapshots) }
            guard Darwin.mkdirat(operations, id, mode_t(0o700)) == 0 else { throw failure() }
            let operation = try childDirectory(operations, id)
            defer { Darwin.close(operation) }
            var accepted = false
            var created: NativeBackupSnapshotReference?
            defer {
                if !accepted {
                    try? removeKnownDirectory(operations, id, allowed: ["plan.json", "manifest.json"])
                    if let created { try? removeSnapshot(snapshots, created, allowIncomplete: true) }
                }
            }
            let snapshot: NativeBackupSnapshotReference
            if let newSnapshot {
                snapshot = try createSnapshot(snapshots, name: newSnapshot.name, content: newSnapshot.content)
                created = snapshot
            } else {
                guard let existingSnapshot else { throw failure() }
                let metadata = try snapshotMetadata(snapshots, existingSnapshot)
                guard metadata.completed else { throw failure() }
                _ = try snapshotBytes(snapshots, existingSnapshot)
                snapshot = existingSnapshot
            }
            #if DEBUG
            try beforePlanWrite?()
            #endif
            let bytes = Data(planJSON.utf8)
            try writeExclusive(operation, "plan.json", bytes: bytes)
            let manifest = Manifest(version: 1, id: id, planSHA256: digest(bytes), planByteCount: bytes.count,
                                    snapshot: snapshot, createdSnapshotBool: newSnapshot != nil)
            let encoded = try encode(manifest)
            guard encoded.count <= Self.maximumManifestBytes else { throw failure() }
            try writeExclusive(operation, "manifest.json", bytes: encoded)
            try syncDirectory(operation)
            try syncDirectory(operations)
            accepted = true
            return NativeBackupOperationReference(id: id, sha256: digest(encoded), byteCount: encoded.count)
        }
    }

    func read(_ reference: NativeBackupOperationReference) throws -> NativeBackupOperationRead {
        try safe {
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let operations = try requiredFamily(parent, "backup-operations")
            defer { Darwin.close(operations) }
            let snapshots = try requiredFamily(parent, "backup-snapshots")
            defer { Darwin.close(snapshots) }
            let (manifest, bytes) = try readOperation(operations, reference)
            _ = try snapshotBytes(snapshots, manifest.snapshot)
            guard let plan = String(data: bytes, encoding: .utf8) else { throw failure() }
            return NativeBackupOperationRead(planJSON: plan, snapshot: manifest.snapshot)
        }
    }

    func readSnapshot(_ reference: NativeBackupSnapshotReference) throws -> String {
        try safe {
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let snapshots = try requiredFamily(parent, "backup-snapshots")
            defer { Darwin.close(snapshots) }
            guard let result = String(data: try snapshotBytes(snapshots, reference), encoding: .utf8) else { throw failure() }
            return result
        }
    }

    func listSnapshots() throws -> [NativeBackupSnapshotReference] {
        try safe {
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            guard let snapshots = try openFamily(parent, "backup-snapshots", create: false) else { return [] }
            defer { Darwin.close(snapshots) }
            return try validSnapshots(snapshots).filter { $0.completed }.map { $0.snapshot }.sorted(by: newer)
        }
    }


    func complete(_ reference: NativeBackupOperationReference) throws {
        try safe {
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let operations = try requiredFamily(parent, "backup-operations")
            defer { Darwin.close(operations) }
            let snapshots = try requiredFamily(parent, "backup-snapshots")
            defer { Darwin.close(snapshots) }
            let (manifest, _) = try readOperation(operations, reference)
            _ = try snapshotBytes(snapshots, manifest.snapshot)
            let metadata = try snapshotMetadata(snapshots, manifest.snapshot)
            guard manifest.createdSnapshotBool || metadata.completed else { throw failure() }
            let directory = try childDirectory(snapshots, manifest.snapshot.id)
            defer { Darwin.close(directory) }
            if !metadata.completed {
                try promoteMetadata(directory, Metadata(version: 1, snapshot: manifest.snapshot, completed: true))
            } else {

                try syncFile(directory, "metadata.json")
                try syncDirectory(directory)
            }
            try syncDirectory(snapshots)
            try? pruneSnapshots(operations, snapshots)
        }
    }


    func discard(_ reference: NativeBackupOperationReference, provenRejected: Bool) throws {
        try safe {
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let operations = try requiredFamily(parent, "backup-operations")
            defer { Darwin.close(operations) }
            let snapshots = try requiredFamily(parent, "backup-snapshots")
            defer { Darwin.close(snapshots) }
            let (manifest, _) = try readOperation(operations, reference)
            _ = try snapshotBytes(snapshots, manifest.snapshot)
            let metadata = try snapshotMetadata(snapshots, manifest.snapshot)
            guard metadata.completed || !manifest.createdSnapshotBool || provenRejected else { throw failure() }

            if provenRejected && manifest.createdSnapshotBool && !metadata.completed {
                let protected = try operationSnapshots(operations, excluding: [reference.id])
                guard !protected.contains(manifest.snapshot.id) else { throw failure() }
                try removeSnapshot(snapshots, manifest.snapshot, allowIncomplete: false)
            }
            try removeKnownDirectory(operations, reference.id, allowed: ["plan.json", "manifest.json"])
        }
    }


    func discardUnreferencedOperations(retaining ids: Set<String>) throws {
        try safe {
            guard ids.allSatisfy(Self.isUUID) else { throw failure() }
            let parent = try openRoot()
            defer { Darwin.close(parent) }
            let operations = try requiredFamily(parent, "backup-operations")
            defer { Darwin.close(operations) }
            let snapshots = try requiredFamily(parent, "backup-snapshots")
            defer { Darwin.close(snapshots) }
            for id in ids {
                let reference = try referenceForOperation(operations, id)
                let (manifest, _) = try readOperation(operations, reference)
                _ = try snapshotBytes(snapshots, manifest.snapshot)
            }
            for id in try names(operations) where Self.isUUID(id) && !ids.contains(id) {


                try? removeKnownDirectory(operations, id, allowed: ["plan.json", "manifest.json"])
            }

            let protected = try operationSnapshots(operations)
            for metadata in try validSnapshots(snapshots) where !metadata.completed && !protected.contains(metadata.snapshot.id) {
                try? removeSnapshot(snapshots, metadata.snapshot, allowIncomplete: false)
            }
            try cleanupAbandonedReservations(snapshots, protected: protected)
            try? pruneSnapshots(operations, snapshots)
        }
    }

    private func createSnapshot(_ snapshots: Int32, name: String, content: String) throws -> NativeBackupSnapshotReference {
        let id = UUID().uuidString.lowercased()
        let bytes = Data(content.utf8)
        let reference = NativeBackupSnapshotReference(id: id, name: name, sha256: digest(bytes), byteCount: bytes.count)

        try writeExclusive(snapshots, reservationName(name), bytes: Data(id.utf8))
        var completed = false
        var createdDirectory = false
        defer {
            if !completed {
                if createdDirectory {
                    try? removeSnapshot(snapshots, reference, allowIncomplete: true)
                } else {

                    if (try? readFile(snapshots, reservationName(name), maximum: 36)) == Data(id.utf8) {
                        _ = Darwin.unlinkat(snapshots, reservationName(name), 0)
                        try? syncDirectory(snapshots)
                    }
                }
            }
        }
        guard Darwin.mkdirat(snapshots, id, mode_t(0o700)) == 0 else { throw failure() }
        createdDirectory = true
        let directory = try childDirectory(snapshots, id)
        defer { Darwin.close(directory) }
        #if DEBUG
        try beforeSnapshotWrite?()
        #endif
        try writeExclusive(directory, name, bytes: bytes)
        try writeExclusive(directory, "metadata.json", bytes: encode(Metadata(version: 1, snapshot: reference, completed: false)))
        try syncDirectory(directory)
        try syncDirectory(snapshots)
        completed = true
        return reference
    }

    private func readOperation(_ operations: Int32, _ reference: NativeBackupOperationReference) throws -> (Manifest, Data) {
        try validate(reference)
        let directory = try childDirectory(operations, reference.id)
        defer { Darwin.close(directory) }
        guard try knownChildren(directory, allowed: ["plan.json", "manifest.json"], allowPending: false) else { throw failure() }
        let encoded = try readFile(directory, "manifest.json", maximum: Self.maximumManifestBytes)
        guard encoded.count == reference.byteCount, digest(encoded) == reference.sha256 else { throw failure() }
        let manifest = try decode(Manifest.self, encoded)
        try validate(manifest.snapshot)
        guard manifest.version == 1, manifest.id == reference.id, Self.isDigest(manifest.planSHA256),
              manifest.planByteCount >= 0, manifest.planByteCount <= Self.maximumPlanBytes else { throw failure() }
        let bytes = try readFile(directory, "plan.json", maximum: Self.maximumPlanBytes)
        guard bytes.count == manifest.planByteCount, digest(bytes) == manifest.planSHA256 else { throw failure() }
        return (manifest, bytes)
    }

    private func referenceForOperation(_ operations: Int32, _ id: String) throws -> NativeBackupOperationReference {
        guard Self.isUUID(id) else { throw failure() }
        let directory = try childDirectory(operations, id)
        defer { Darwin.close(directory) }
        let bytes = try readFile(directory, "manifest.json", maximum: Self.maximumManifestBytes)
        return NativeBackupOperationReference(id: id, sha256: digest(bytes), byteCount: bytes.count)
    }

    private func snapshotMetadata(_ snapshots: Int32, _ reference: NativeBackupSnapshotReference) throws -> Metadata {
        try validate(reference)
        guard try readFile(snapshots, reservationName(reference.name), maximum: 36) == Data(reference.id.utf8) else { throw failure() }
        let directory = try childDirectory(snapshots, reference.id)
        defer { Darwin.close(directory) }
        guard try knownChildren(directory, allowed: [reference.name, "metadata.json"], allowPending: true) else { throw failure() }
        let metadata = try decode(Metadata.self, readFile(directory, "metadata.json", maximum: Self.maximumMetadataBytes))
        guard metadata.version == 1, metadata.snapshot == reference else { throw failure() }
        return metadata
    }

    private func snapshotBytes(_ snapshots: Int32, _ reference: NativeBackupSnapshotReference) throws -> Data {
        _ = try snapshotMetadata(snapshots, reference)
        let directory = try childDirectory(snapshots, reference.id)
        defer { Darwin.close(directory) }
        let bytes = try readFile(directory, reference.name, maximum: Self.maximumSnapshotBytes)
        guard bytes.count == reference.byteCount, digest(bytes) == reference.sha256 else { throw failure() }
        return bytes
    }

    private func validSnapshots(_ snapshots: Int32) throws -> [Metadata] {
        var result: [Metadata] = []
        for id in try names(snapshots) where Self.isUUID(id) {
            do {
                let directory = try childDirectory(snapshots, id)
                defer { Darwin.close(directory) }
                let metadata = try decode(Metadata.self, readFile(directory, "metadata.json", maximum: Self.maximumMetadataBytes))
                guard metadata.snapshot.id == id else { continue }
                _ = try snapshotBytes(snapshots, metadata.snapshot)
                result.append(metadata)
            } catch { continue }
        }
        return result
    }

    private func operationSnapshots(_ operations: Int32, excluding ids: Set<String> = []) throws -> Set<String> {
        var result = Set<String>()
        for id in try names(operations) where !ids.contains(id) {

            guard Self.isUUID(id) else { throw failure() }
            let reference = try referenceForOperation(operations, id)
            let (manifest, _) = try readOperation(operations, reference)
            result.insert(manifest.snapshot.id)
        }
        return result
    }

    private func pruneSnapshots(_ operations: Int32, _ snapshots: Int32) throws {
        let protected = try operationSnapshots(operations)
        let completed = try validSnapshots(snapshots).filter { $0.completed }.map { $0.snapshot }.sorted(by: newer)
        for reference in completed.dropFirst(5) where !protected.contains(reference.id) {
            try? removeSnapshot(snapshots, reference, allowIncomplete: false)
        }
    }

    private func removeSnapshot(_ snapshots: Int32, _ reference: NativeBackupSnapshotReference, allowIncomplete: Bool) throws {
        try validate(reference)

        guard try readFile(snapshots, reservationName(reference.name), maximum: 36) == Data(reference.id.utf8) else { throw failure() }
        if let directory = try optionalChildDirectory(snapshots, reference.id) {
            defer { Darwin.close(directory) }
            guard try knownChildren(directory, allowed: [reference.name, "metadata.json"], allowPending: true) else { throw failure() }
            if !allowIncomplete { _ = try snapshotBytes(snapshots, reference) }
            if allowIncomplete, isRegular(directory, "metadata.json") {

                let metadata = try decode(Metadata.self, readFile(directory, "metadata.json", maximum: Self.maximumMetadataBytes))
                guard metadata.version == 1, metadata.snapshot == reference, !metadata.completed else { throw failure() }
            }
            try removeKnownDirectory(snapshots, reference.id, allowed: [reference.name, "metadata.json"])
        } else if !allowIncomplete { throw failure() }
        guard Darwin.unlinkat(snapshots, reservationName(reference.name), 0) == 0 else { throw failure() }
        try syncDirectory(snapshots)
    }

    private func cleanupAbandonedReservations(_ snapshots: Int32, protected: Set<String>) throws {
        for reservation in try names(snapshots) where reservation.hasPrefix(".name-") {
            let name = String(reservation.dropFirst(6))
            guard Self.isSnapshotName(name),
                  let bytes = try? readFile(snapshots, reservation, maximum: 36),
                  let id = String(data: bytes, encoding: .utf8), Self.isUUID(id), !protected.contains(id) else { continue }
            do {


                guard let directory = try optionalChildDirectory(snapshots, id) else { continue }
                defer { Darwin.close(directory) }


                guard try knownChildren(directory, allowed: [name, "metadata.json"], allowPending: true) else { continue }
                var info = stat()
                let found = Darwin.fstatat(directory, "metadata.json", &info, AT_SYMLINK_NOFOLLOW)
                guard found != 0 && errno == ENOENT else { continue }
                try removeKnownDirectory(snapshots, id, allowed: [name, "metadata.json"])

                guard try readFile(snapshots, reservation, maximum: 36) == bytes else { continue }
                guard Darwin.unlinkat(snapshots, reservation, 0) == 0 else { throw failure() }
                try syncDirectory(snapshots)
            } catch { continue }
        }
    }

    private func promoteMetadata(_ directory: Int32, _ metadata: Metadata) throws {
        let pending = ".pending-" + UUID().uuidString.lowercased()
        try writeExclusive(directory, pending, bytes: encode(metadata))
        defer { _ = Darwin.unlinkat(directory, pending, 0) }
        #if DEBUG
        try beforeMetadataPromote?()
        #endif

        guard isRegular(directory, "metadata.json"),
              Darwin.renameat(directory, pending, directory, "metadata.json") == 0 else { throw failure() }
        #if DEBUG
        try afterMetadataPromote?()
        #endif
        try syncDirectory(directory)
    }

    private func removeKnownDirectory(_ parent: Int32, _ name: String, allowed: Set<String>) throws {
        let directory = try childDirectory(parent, name)
        defer { Darwin.close(directory) }
        guard try knownChildren(directory, allowed: allowed, allowPending: true) else { throw failure() }
        for child in try names(directory) {
            guard Darwin.unlinkat(directory, child, 0) == 0 else { throw failure() }
        }
        try syncDirectory(directory)
        guard Darwin.unlinkat(parent, name, AT_REMOVEDIR) == 0 else { throw failure() }
        try syncDirectory(parent)
    }

    private func knownChildren(_ directory: Int32, allowed: Set<String>, allowPending: Bool) throws -> Bool {
        try names(directory).allSatisfy { name in
            let pending = allowPending && name.hasPrefix(".pending-") && Self.isUUID(String(name.dropFirst(9)))
            return (allowed.contains(name) || pending) && isRegular(directory, name)
        }
    }

    private func writeExclusive(_ directory: Int32, _ name: String, bytes: Data) throws {


        try protectDirectory(directory)
        let fd = Darwin.openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard fd >= 0 else { throw failure() }
        var finished = false
        defer { Darwin.close(fd); if !finished { _ = Darwin.unlinkat(directory, name, 0) } }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure() }
                offset += count
            }
        }
        guard Darwin.fsync(fd) == 0, Darwin.fcntl(fd, F_FULLFSYNC) == 0 else { throw failure() }
        finished = true
    }

    private func protectDirectory(_ directory: Int32) throws {
        #if os(iOS)
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard buffer.withUnsafeMutableBufferPointer({
            Darwin.fcntl(directory, F_GETPATH, $0.baseAddress!)
        }) == 0 else { throw failure() }
        let path = String(cString: buffer)
        try verifyProtectionDirectory(directory, path: path)
        let protection = FileProtectionType.completeUntilFirstUserAuthentication


        try FileManager.default.setAttributes([.protectionKey: protection], ofItemAtPath: path)
        try verifyProtectionDirectory(directory, path: path)
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        let actual = (attributes[.protectionKey] as? FileProtectionType)?.rawValue
            ?? (attributes[.protectionKey] as? String)
        #if targetEnvironment(simulator)


        guard actual == nil || actual == protection.rawValue else { throw failure() }
        #else
        guard actual == protection.rawValue else { throw failure() }
        #endif
        try verifyProtectionDirectory(directory, path: path)
        try syncDirectory(directory)
        #endif
    }

    #if os(iOS)
    private func verifyProtectionDirectory(_ directory: Int32, path: String) throws {
        let parts = URL(fileURLWithPath: path, isDirectory: true).pathComponents
        let rootParts = root.pathComponents
        guard parts.count == rootParts.count + 1 || parts.count == rootParts.count + 2 else { throw failure() }
        guard zip(parts, rootParts).allSatisfy({ Array($0.utf8) == Array($1.utf8) }) else { throw failure() }
        let suffix = Array(parts.dropFirst(rootParts.count))
        guard ["backup-operations", "backup-snapshots"].contains(suffix[0]),
              suffix.count == 1 || Self.isUUID(suffix[1]) else { throw failure() }
        var verified = try openRoot()
        for part in suffix {
            do {
                let next = try childDirectory(verified, part)
                Darwin.close(verified)
                verified = next
            } catch { Darwin.close(verified); throw error }
        }
        defer { Darwin.close(verified) }
        var original = stat(), current = stat()
        guard Darwin.fstat(directory, &original) == 0, Darwin.fstat(verified, &current) == 0,
              original.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              current.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              original.st_dev == current.st_dev, original.st_ino == current.st_ino else { throw failure() }
    }
    #endif

    private func readFile(_ directory: Int32, _ name: String, maximum: Int) throws -> Data {
        let fd = Darwin.openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw failure() }
        defer { Darwin.close(fd) }
        let initial = try regularFile(fd, maximum: maximum)
        var bytes = Data()
        bytes.reserveCapacity(Int(initial.st_size))
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw failure() }
            if count == 0 { break }
            guard bytes.count <= maximum - count else { throw failure() }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        let final = try regularFile(fd, maximum: maximum)
        guard unchanged(initial, final), bytes.count == initial.st_size else { throw failure() }
        return bytes
    }

    private func regularFile(_ fd: Int32, maximum: Int) throws -> stat {
        var info = stat()
        guard Darwin.fstat(fd, &info) == 0, info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              info.st_nlink == 1, info.st_size >= 0, info.st_size <= maximum else { throw failure() }
        return info
    }

    private func unchanged(_ first: stat, _ second: stat) -> Bool {
        first.st_dev == second.st_dev && first.st_ino == second.st_ino && first.st_size == second.st_size
            && first.st_mtimespec.tv_sec == second.st_mtimespec.tv_sec && first.st_mtimespec.tv_nsec == second.st_mtimespec.tv_nsec
            && first.st_ctimespec.tv_sec == second.st_ctimespec.tv_sec && first.st_ctimespec.tv_nsec == second.st_ctimespec.tv_nsec
    }

    private func isRegular(_ directory: Int32, _ name: String) -> Bool {
        var info = stat()
        return Darwin.fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0
            && info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) && info.st_nlink == 1
    }

    private func syncFile(_ directory: Int32, _ name: String) throws {
        let fd = Darwin.openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw failure() }
        defer { Darwin.close(fd) }
        _ = try regularFile(fd, maximum: Self.maximumMetadataBytes)
        guard Darwin.fsync(fd) == 0, Darwin.fcntl(fd, F_FULLFSYNC) == 0 else { throw failure() }
    }

    private func syncDirectory(_ directory: Int32) throws {
        guard Darwin.fsync(directory) == 0 else { throw failure() }
    }

    private func requiredFamily(_ parent: Int32, _ name: String) throws -> Int32 {
        guard let directory = try openFamily(parent, name, create: true) else { throw failure() }
        return directory
    }

    private func openFamily(_ parent: Int32, _ name: String, create: Bool) throws -> Int32? {
        if create {
            if Darwin.mkdirat(parent, name, mode_t(0o700)) != 0 && errno != EEXIST { throw failure() }
        }
        guard let directory = try optionalChildDirectory(parent, name) else { return nil }
        do {
            if create {
                var url = root.appendingPathComponent(name, isDirectory: true)
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try url.setResourceValues(values)
                try syncDirectory(parent)
            }
            return directory
        } catch { Darwin.close(directory); throw error }
    }

    private func optionalChildDirectory(_ parent: Int32, _ name: String) throws -> Int32? {
        let directory = Darwin.openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if directory < 0 {
            if errno == ENOENT { return nil }
            throw failure()
        }
        return directory
    }

    private func childDirectory(_ parent: Int32, _ name: String) throws -> Int32 {
        guard let directory = try optionalChildDirectory(parent, name) else { throw failure() }
        return directory
    }

    private func openRoot() throws -> Int32 {
        guard root.isFileURL else { throw failure() }
        let home = Self.normalized(URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
        let parts = root.pathComponents
        let homeParts = home.pathComponents
        guard !parts.contains("."), !parts.contains("..") else { throw failure() }
        let inside = parts.count >= homeParts.count && zip(parts, homeParts).allSatisfy { Array($0.utf8) == Array($1.utf8) }
        var fd = Darwin.open(inside ? home.path : "/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw failure() }
        for part in parts.dropFirst(inside ? homeParts.count : 1) {
            let next = Darwin.openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            Darwin.close(fd)
            guard next >= 0 else { throw failure() }
            fd = next
        }
        return fd
    }

    private func names(_ fd: Int32) throws -> [String] {

        let copied = Darwin.openat(fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard copied >= 0 else { throw failure() }
        guard let stream = Darwin.fdopendir(copied) else { Darwin.close(copied); throw failure() }
        defer { Darwin.closedir(stream) }
        var result: [String] = []
        while true {
            errno = 0
            guard let entry = Darwin.readdir(stream) else {
                guard errno == 0 else { throw failure() }
                break
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name != "." && name != ".." { result.append(name) }
        }
        return result
    }

    private func validate(_ reference: NativeBackupSnapshotReference) throws {
        guard Self.isUUID(reference.id), Self.isSnapshotName(reference.name), Self.isDigest(reference.sha256),
              reference.byteCount >= 0, reference.byteCount <= Self.maximumSnapshotBytes else { throw failure() }
    }

    private func validate(_ reference: NativeBackupOperationReference) throws {
        guard Self.isUUID(reference.id), Self.isDigest(reference.sha256), reference.byteCount > 0,
              reference.byteCount <= Self.maximumManifestBytes else { throw failure() }
    }

    private static func isUUID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private static func isDigest(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func isSnapshotName(_ name: String) -> Bool {
        name.range(of: #"\Adata\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}\.[0-9]{3}(?:\.[1-9][0-9]?)?\.snapshot\.json\z"#,
                   options: .regularExpression) != nil
    }

    private func newer(_ left: NativeBackupSnapshotReference, _ right: NativeBackupSnapshotReference) -> Bool {
        let lhs = String(left.name.prefix(28)), rhs = String(right.name.prefix(28))
        if lhs != rhs { return lhs > rhs }
        let lc = left.name.split(separator: "."), rc = right.name.split(separator: ".")
        let ln = lc.count == 6 ? Int(lc[3]) ?? 0 : 0, rn = rc.count == 6 ? Int(rc[3]) ?? 0 : 0
        if ln != rn { return ln > rn }
        return left.id > right.id
    }

    private func reservationName(_ name: String) -> String { ".name-" + name }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
    private func decode<T: Codable>(_ type: T.Type, _ bytes: Data) throws -> T {
        let value = try JSONDecoder().decode(type, from: bytes)


        guard try encode(value) == bytes else { throw failure() }
        return value
    }
    private func safe<T>(_ body: () throws -> T) throws -> T {
        do { return try body() }
        catch let error as NativeBackupOperationFilesError { throw error }
        catch { throw failure() }
    }
    private func failure() -> NativeBackupOperationFilesError { .unavailable }
    private static func normalized(_ url: URL) -> URL {
        if url.pathComponents.dropFirst().first == "var",
           let target = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
           ["private/var", "/private/var"].contains(target) {
            return URL(fileURLWithPath: "/private" + url.path, isDirectory: true)
        }
        return url
    }
}
