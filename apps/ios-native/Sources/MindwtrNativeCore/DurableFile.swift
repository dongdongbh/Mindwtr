import Foundation
import Darwin

struct HostFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

// All callers, including teardown, run on CoreHost's serial queue.
enum DurableFile {
    static func sync(_ url: URL, directory: Bool = false) throws {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw HostFailure("Cannot open recovery data for synchronization") }
        defer { Darwin.close(fd) }
        guard fsync(fd) == 0 else { throw HostFailure("Cannot synchronize recovery data") }
        if !directory {
            guard fcntl(fd, F_FULLFSYNC) == 0 else { throw HostFailure("Cannot durably synchronize recovery data") }
        }
    }

    static func write(_ data: Data, to url: URL, privateDraft: Bool = false) throws {
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".pending-\(UUID().uuidString)")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw HostFailure("Cannot create pending command journal") }
        defer { Darwin.close(fd); try? FileManager.default.removeItem(at: temporary) }
        if privateDraft {
            // Protect the empty inode before the first byte of task text is written.
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                  ofItemAtPath: temporary.path)
            #endif
            var protectedURL = temporary
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try protectedURL.setResourceValues(values)
        }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw HostFailure("Cannot write pending command journal") }
                offset += count
            }
        }
        guard fsync(fd) == 0, fcntl(fd, F_FULLFSYNC) == 0 else {
            throw HostFailure("Cannot durably save pending command journal")
        }
        guard rename(temporary.path, url.path) == 0 else { throw HostFailure("Cannot promote pending command journal") }
        try sync(url.deletingLastPathComponent(), directory: true)
    }

    static func remove(_ url: URL) throws {
        if unlink(url.path) != 0 && errno != ENOENT { throw HostFailure("Cannot clear pending command journal") }
        try sync(url.deletingLastPathComponent(), directory: true)
    }
}

#if DEBUG
// IO boundary only; no fixtures, domain mutation hooks, or release-build knobs.
final class HostIOFaults {
    var beforeSQL: ((String) throws -> Void)?
    var afterSQL: ((String) throws -> Void)?
    var checkpoint: (() throws -> Void)?
    var afterIntegrity: (() throws -> Void)?
    var journalWrite: (() throws -> Void)?
    var journalRemove: (() throws -> Void)?
    var editorDraftRemove: (() throws -> Void)?
    var commandDiagnostic: ((String) -> Void)?
    var httpConfiguration: URLSessionConfiguration?
    var httpLoopbackOrigin: URL?
    var httpTimeout: TimeInterval?
    var httpByteLimit: Int?
    var configureHTTPJobs: ((NativeHTTPJobs) -> Void)?
    var secretService: String?
    var secretStatus: ((String, String) -> Int32?)?
    var secretBeforeOperation: ((String, String) -> Void)?
    var secretAfterOperation: ((String, String) -> Void)?
    var configureSecretJobs: ((NativeSecretJobs) -> Void)?
    var cryptoBeforeOperation: ((String) -> Void)?
    var cryptoAfterOperation: ((String) -> Void)?
    var cryptoArgon2Unavailable: (() -> Bool)?
    var configureCryptoJobs: ((NativeCryptoJobs) -> Void)?
}
#endif
