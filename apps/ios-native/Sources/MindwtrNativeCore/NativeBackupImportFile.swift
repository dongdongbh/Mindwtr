import Foundation
import Darwin
import CryptoKit

enum NativeBackupImportFileError: LocalizedError, Equatable {
    case unavailable, tooLarge, unknownSize
    var errorDescription: String? {
        switch self {
        case .unavailable: return "Backup import file unavailable"
        case .tooLarge: return "Backup exceeds the supported byte limit"
        case .unknownSize: return "Backup file size is unavailable"
        }
    }
}

/// A reference to native-owned bytes, never a provider URL. The library's exclusive
/// CoreHost lock owns all calls. Accepted references must outlive pending journals.
struct NativeBackupImportReference: Codable, Equatable, Sendable {
    let id: String
    let sha256: String
    let byteCount: Int
}

struct NativeBackupImportSelection: Sendable {
    let reference: NativeBackupImportReference
    let fileName: String
    let modifiedAtMilliseconds: Double
}

/// Copies the selected provider file once, before shared-core inspection. It never
/// parses JSON or writes domain data. Cancellation may discard an unaccepted copy;
/// startup must not sweep files that an unresolved command can still reference.
final class NativeBackupImportFile {
    static let maximumBytes = 128 * 1024 * 1024 // RN backup-transfer.ts byte limit
    private let root: URL
    #if DEBUG
    var afterSourceOpened: (() throws -> Void)?
    var beforePromote: (() throws -> Void)?
    #endif

    init(libraryRoot: URL) { root = Self.normalized(libraryRoot) }

    func stage(_ source: URL) throws -> NativeBackupImportSelection {
        guard source.isFileURL else { throw failure() }
        let accessed = source.startAccessingSecurityScopedResource()
        defer { if accessed { source.stopAccessingSecurityScopedResource() } }
        var coordinationError: NSError?
        var result: Result<NativeBackupImportSelection, Error>?
        NSFileCoordinator().coordinate(readingItemAt: source, options: .withoutChanges, error: &coordinationError) { url in
            result = Result { try copyCoordinatedFile(url) }
        }
        guard coordinationError == nil, let result else { throw failure() }
        return try result.get()
    }

    func read(_ reference: NativeBackupImportReference) throws -> Data {
        try validate(reference)
        let directory = try openDirectory()
        defer { Darwin.close(directory) }
        let fd = Darwin.openat(directory, reference.id + ".json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard fd >= 0 else { throw failure() }
        defer { Darwin.close(fd) }
        let initial = try regularFile(fd)
        guard initial.st_size == reference.byteCount else { throw failure() }
        var bytes = Data()
        bytes.reserveCapacity(reference.byteCount)
        try consume(fd) { bytes.append($0) }
        let final = try regularFile(fd)
        guard unchanged(initial, final), bytes.count == reference.byteCount,
              digest(bytes) == reference.sha256 else { throw failure() }
        return bytes
    }

    /// Only the native owner may call this once cancellation or a terminal journal
    /// result proves the copy is no longer needed. No recursive cleanup is used.
    func discard(_ reference: NativeBackupImportReference) throws {
        _ = try read(reference)
        let directory = try openDirectory()
        defer { Darwin.close(directory) }
        guard Darwin.unlinkat(directory, reference.id + ".json", 0) == 0,
              Darwin.fsync(directory) == 0 else { throw failure() }
    }

    /// Startup only, after the exclusive library lock and successful journal
    /// validation. The caller supplies every still-needed accepted source UUID.
    /// If journal ownership is uncertain, it must not call cleanup at all.
    func discardUnreferencedCopies(retaining ids: Set<String>) throws {
        guard ids.allSatisfy({ UUID(uuidString: $0)?.uuidString.lowercased() == $0 }) else { throw failure() }
        let directory = try openDirectory()
        defer { Darwin.close(directory) }
        let copied = Darwin.dup(directory)
        guard copied >= 0 else { throw failure() }
        guard let stream = Darwin.fdopendir(copied) else { Darwin.close(copied); throw failure() }
        defer { Darwin.closedir(stream) }
        while true {
            errno = 0
            guard let entry = Darwin.readdir(stream) else {
                guard errno == 0 else { throw failure() }
                break
            }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            let candidate: String
            if name.hasPrefix(".pending-") { candidate = String(name.dropFirst(".pending-".count)) }
            else if name.hasSuffix(".json") { candidate = String(name.dropLast(".json".count)) }
            else { continue }
            guard UUID(uuidString: candidate)?.uuidString.lowercased() == candidate, !ids.contains(candidate) else { continue }
            var info = stat()
            guard Darwin.fstatat(directory, name, &info, AT_SYMLINK_NOFOLLOW) == 0,
                  info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { continue }
            guard Darwin.unlinkat(directory, name, 0) == 0 else { throw failure() }
        }
        guard Darwin.fsync(directory) == 0 else { throw failure() }
    }

    private func copyCoordinatedFile(_ source: URL) throws -> NativeBackupImportSelection {
        let input = Darwin.open(source.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard input >= 0 else { throw failure() }
        defer { Darwin.close(input) }
        let initial = try regularFile(input)
        #if DEBUG
        try afterSourceOpened?()
        #endif
        let directory = try openDirectory()
        defer { Darwin.close(directory) }
        let id = UUID().uuidString.lowercased()
        let pending = ".pending-" + id
        let finalName = id + ".json"
        let output = Darwin.openat(directory, pending, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard output >= 0 else { throw failure() }
        var promoted = false
        var completed = false
        defer {
            Darwin.close(output)
            if !completed {
                Darwin.unlinkat(directory, promoted ? finalName : pending, 0)
                _ = Darwin.fsync(directory)
            }
        }
        let temporaryURL = root.appendingPathComponent("backup-imports", isDirectory: true).appendingPathComponent(pending)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                              ofItemAtPath: temporaryURL.path)
        #endif
        var hash = SHA256()
        var total = 0
        try consume(input) { chunk in
            total += chunk.count
            hash.update(data: chunk)
            try chunk.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(output, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw failure() }
                    offset += count
                }
            }
        }
        let final = try regularFile(input)
        guard unchanged(initial, final), total == initial.st_size,
              Darwin.fsync(output) == 0, Darwin.fcntl(output, F_FULLFSYNC) == 0 else { throw failure() }
        #if DEBUG
        try beforePromote?()
        #endif
        // UUID destination is native-owned; exclusive rename also refuses an
        // unexpected existing destination rather than replacing it.
        guard Darwin.renameatx_np(directory, pending, directory, finalName, UInt32(RENAME_EXCL)) == 0 else { throw failure() }
        promoted = true
        guard Darwin.fsync(directory) == 0 else { throw failure() }
        completed = true
        return NativeBackupImportSelection(
            reference: NativeBackupImportReference(id: id, sha256: hash.finalize().map { String(format: "%02x", $0) }.joined(), byteCount: total),
            fileName: source.lastPathComponent,
            modifiedAtMilliseconds: Double(initial.st_mtimespec.tv_sec) * 1000 + Double(initial.st_mtimespec.tv_nsec) / 1_000_000)
    }

    private func consume(_ fd: Int32, chunk: (Data) throws -> Void) throws {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        var total = 0
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw failure() }
            if count == 0 { return }
            total += count
            guard total <= Self.maximumBytes else { throw NativeBackupImportFileError.tooLarge }
            try chunk(Data(buffer.prefix(count)))
        }
    }

    private func regularFile(_ fd: Int32) throws -> stat {
        var info = stat()
        guard Darwin.fstat(fd, &info) == 0, info.st_size >= 0 else { throw NativeBackupImportFileError.unknownSize }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG) else { throw failure() }
        guard info.st_size <= Self.maximumBytes else { throw NativeBackupImportFileError.tooLarge }
        return info
    }

    private func unchanged(_ first: stat, _ second: stat) -> Bool {
        first.st_dev == second.st_dev && first.st_ino == second.st_ino && first.st_size == second.st_size
            && first.st_mtimespec.tv_sec == second.st_mtimespec.tv_sec && first.st_mtimespec.tv_nsec == second.st_mtimespec.tv_nsec
            && first.st_ctimespec.tv_sec == second.st_ctimespec.tv_sec && first.st_ctimespec.tv_nsec == second.st_ctimespec.tv_nsec
    }

    private func validate(_ reference: NativeBackupImportReference) throws {
        guard let uuid = UUID(uuidString: reference.id), uuid.uuidString.lowercased() == reference.id,
              reference.sha256.count == 64, reference.sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              reference.byteCount >= 0, reference.byteCount <= Self.maximumBytes else { throw failure() }
    }

    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

    private func openDirectory() throws -> Int32 {
        let home = Self.normalized(URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true))
        let parts = root.pathComponents
        let homeParts = home.pathComponents
        guard !parts.contains("."), !parts.contains("..") else { throw failure() }
        let inside = parts.count >= homeParts.count && zip(parts, homeParts).allSatisfy { Array($0.utf8) == Array($1.utf8) }
        var parent = Darwin.open(inside ? home.path : "/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw failure() }
        for part in parts.dropFirst(inside ? homeParts.count : 1) {
            let next = Darwin.openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            Darwin.close(parent)
            guard next >= 0 else { throw failure() }
            parent = next
        }
        defer { Darwin.close(parent) }
        if Darwin.mkdirat(parent, "backup-imports", mode_t(0o700)) != 0 && errno != EEXIST { throw failure() }
        let directory = Darwin.openat(parent, "backup-imports", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw failure() }
        do {
            var url = root.appendingPathComponent("backup-imports", isDirectory: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
            guard Darwin.fsync(parent) == 0 else { throw failure() }
            return directory
        } catch { Darwin.close(directory); throw error }
    }

    private static func normalized(_ url: URL) -> URL {
        if url.pathComponents.dropFirst().first == "var",
           let target = try? FileManager.default.destinationOfSymbolicLink(atPath: "/var"),
           ["private/var", "/private/var"].contains(target) {
            return URL(fileURLWithPath: "/private" + url.path, isDirectory: true)
        }
        return url
    }

    private func failure() -> NativeBackupImportFileError { .unavailable }
}
