import Foundation
import Darwin

// All callers, including teardown, run on CoreHost's serial queue.
enum DurableFile {
    enum ProtectionStage: String, Sendable { case source, set, readback }
    #if (DEBUG || NATIVE_DEVICE_TEST) && !MINDWTR_SHARE_EXTENSION
    struct ProtectionFailure: Error {
        let stage: ProtectionStage
        let sourceClass: Int32
        let targetClass: Int32
        let errorNumber: Int32
    }
    #endif

    private static func protectionFailure(_ stage: ProtectionStage, source: Int32, target: Int32 = -1, number: Int32) -> Error {
        #if (DEBUG || NATIVE_DEVICE_TEST) && !MINDWTR_SHARE_EXTENSION
        return ProtectionFailure(stage: stage, sourceClass: source, targetClass: target, errorNumber: number)
        #else
        return HostFailure("Cannot preserve recovery data protection")
        #endif
    }

    struct ProtectionSnapshot {
        let source: stat
        let directory: stat
        let sourceClass: Int32
        let destinationClass: Int32?
    }
    struct ProtectedFile {
        let policy: ProtectionSnapshot
        let file: stat
        let fileClass: Int32
    }
    static func protectionSnapshot(source: Int32, directory: Int32, readClass: (Int32) -> Int32) throws -> ProtectionSnapshot {
        var sourceInfo = stat(), directoryInfo = stat()
        guard fstat(source, &sourceInfo) == 0, fstat(directory, &directoryInfo) == 0,
              directoryInfo.st_mode & S_IFMT == S_IFDIR,
              sourceInfo.st_mode & S_IFMT == S_IFDIR || sourceInfo.st_mode & S_IFMT == S_IFREG else {
            throw HostFailure("Cannot preserve recovery data protection")
        }
        let sourceClass = readClass(source)
        guard sourceClass >= 0 else { throw protectionFailure(.source, source: sourceClass, number: errno) }
        if sourceClass == 0 {
            guard sourceInfo.st_mode & S_IFMT == S_IFDIR else { throw protectionFailure(.source, source: 0, number: 0) }
            let destinationClass = readClass(directory)
            guard destinationClass == 0, sourceInfo.st_dev == directoryInfo.st_dev else {
                throw protectionFailure(.source, source: 0, target: destinationClass, number: destinationClass < 0 ? errno : 0)
            }
            return .init(source: sourceInfo, directory: directoryInfo, sourceClass: 0, destinationClass: 0)
        }
        guard (1...7).contains(sourceClass) else { throw protectionFailure(.source, source: sourceClass, number: 0) }
        return .init(source: sourceInfo, directory: directoryInfo, sourceClass: sourceClass, destinationClass: nil)
    }
    static func protectFreshFile(_ policy: ProtectionSnapshot, source: Int32, directory: Int32, file: Int32,
                                readClass: (Int32) -> Int32, setClass: (Int32, Int32) -> Int32) throws -> ProtectedFile {
        var info = stat()
        guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_size == 0 else {
            throw HostFailure("Cannot preserve recovery data protection")
        }
        if policy.sourceClass != 0 {
            let changed = setClass(file, policy.sourceClass)
            guard changed == 0 else { throw protectionFailure(.set, source: policy.sourceClass, number: errno) }
        }
        let fileClass = readClass(file)
        guard (1...7).contains(fileClass), policy.sourceClass == 0 || fileClass == policy.sourceClass else {
            throw protectionFailure(.readback, source: policy.sourceClass, target: fileClass, number: fileClass < 0 ? errno : 0)
        }
        let protected = ProtectedFile(policy: policy, file: info, fileClass: fileClass)
        try verifyProtection(protected, source: source, directory: directory, file: file, readClass: readClass)
        return protected
    }
    static func verifyProtection(_ protected: ProtectedFile, source: Int32, directory: Int32, file: Int32,
                                 readClass: (Int32) -> Int32) throws {
        let current = try protectionSnapshot(source: source, directory: directory, readClass: readClass)
        let policy = protected.policy
        var actual = stat()
        guard current.source.st_dev == policy.source.st_dev, current.source.st_ino == policy.source.st_ino,
              current.source.st_mode & S_IFMT == policy.source.st_mode & S_IFMT,
              current.directory.st_dev == policy.directory.st_dev, current.directory.st_ino == policy.directory.st_ino,
              current.sourceClass == policy.sourceClass, current.destinationClass == policy.destinationClass,
              fstat(file, &actual) == 0, actual.st_mode & S_IFMT == S_IFREG, actual.st_nlink == 1,
              actual.st_dev == protected.file.st_dev, actual.st_ino == protected.file.st_ino,
              readClass(file) == protected.fileClass else { throw HostFailure("Cannot preserve recovery data protection") }
    }

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
        try fillAndSync(data, fd: fd)
        guard rename(temporary.path, url.path) == 0 else { throw HostFailure("Cannot promote pending command journal") }
        try sync(url.deletingLastPathComponent(), directory: true)
    }

    // The caller owns the directory lease and the duplicated creation FD, even
    // if promotion succeeded but directory synchronization failed. No pathname
    // protection/backup mutation is performed through a possibly replaced root.
    static func write(_ data: Data, to name: String, in directoryFD: Int32,
                      retainingFile: inout Int32, preservingProtectionFrom sourceFD: Int32? = nil,
                      exclusive: Bool = false) throws {
        guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.utf8.contains(0),
              retainingFile < 0 else { throw HostFailure("Invalid anchored recovery publication") }
        #if os(iOS)
        let policy = try sourceFD.map { try protectionSnapshot(source: $0, directory: directoryFD, readClass: { fcntl($0, F_GETPROTECTIONCLASS) }) }
        #endif
        let temporary = ".pending-\(UUID().uuidString)"
        let fd = openat(directoryFD, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw HostFailure("Cannot create pending command journal") }
        defer {
            var owned = stat(); var named = stat()
            if fstat(fd, &owned) == 0, fstatat(directoryFD, temporary, &named, AT_SYMLINK_NOFOLLOW) == 0,
               owned.st_dev == named.st_dev, owned.st_ino == named.st_ino {
                _ = unlinkat(directoryFD, temporary, 0)
            }
            Darwin.close(fd)
        }
        retainingFile = dup(fd)
        guard retainingFile >= 0 else { throw HostFailure("Cannot retain recovery publication") }
        #if os(iOS)
        let protected: ProtectedFile?
        if let policy, let sourceFD {
            protected = try protectFreshFile(policy, source: sourceFD, directory: directoryFD, file: fd,
                readClass: { fcntl($0, F_GETPROTECTIONCLASS) }, setClass: { fcntl($0, F_SETPROTECTIONCLASS, $1) })
        } else { protected = nil }
        #endif
        try fillAndSync(data, fd: fd)
        #if os(iOS)
        if let protected, let sourceFD {
            try verifyProtection(protected, source: sourceFD, directory: directoryFD, file: fd, readClass: { fcntl($0, F_GETPROTECTIONCLASS) })
        }
        #endif
        let promoted = exclusive
            ? renameatx_np(directoryFD, temporary, directoryFD, name, UInt32(RENAME_EXCL))
            : renameat(directoryFD, temporary, directoryFD, name)
        guard promoted == 0 else {
            throw HostFailure("Cannot promote pending command journal")
        }
        guard fsync(directoryFD) == 0 else { throw HostFailure("Cannot synchronize recovery data") }
    }

    private static func fillAndSync(_ data: Data, fd: Int32) throws {
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
    }

    static func remove(_ url: URL) throws {
        if unlink(url.path) != 0 && errno != ENOENT { throw HostFailure("Cannot clear pending command journal") }
        try sync(url.deletingLastPathComponent(), directory: true)
    }
}

#if DEBUG && !MINDWTR_SHARE_EXTENSION
// IO boundary only; no fixtures, domain mutation hooks, or release-build knobs.
final class HostIOFaults {
    // Weak lifetime observation only; the selected test must not retain these runtime owners.
    var configureRuntimeLifetime: ((AnyObject, AnyObject, AnyObject?) -> Void)?
    // Selected ownership regression holds boxed callbacks, with a queue-only fence outside the Engine queue.
    var configureAIProviderDeviceStateCallbacks: ((AnyObject, AnyObject, @escaping () -> Void) -> Void)?
    var notificationPermissionRead: NativeNotificationPermission.Reader?
    var notificationAuthorizationRequest: NativeNotificationAuthorization.Requester?
    var calendarAuthorizationRequest: NativeCalendarAuthorization.Requester?
    var reminderPort: (any NativeReminderPort)?
    var pomodoroAlarmPort: (any NativePomodoroAlarmPort)?
    var beforeSQL: ((String) throws -> Void)?
    var afterSQL: ((String) throws -> Void)?
    var checkpoint: (() throws -> Void)?
    var afterIntegrity: (() throws -> Void)?
    var journalWrite: (() throws -> Void)?
    var journalRemove: (() throws -> Void)?
    var cleanupBoundary: ((String) throws -> Void)?
    var editorDraftRemove: (() throws -> Void)?
    var commandDiagnostic: ((String) -> Void)?
    var configureDeviceStorage: ((NativeDeviceKV) -> Void)?
    var httpConfiguration: URLSessionConfiguration?
    var httpTimeout: TimeInterval?
    var httpByteLimit: Int?
    var configureHTTPJobs: ((NativeHTTPJobs) -> Void)?
    var configureFileSyncJobs: ((NativeFileSyncJobs) -> Void)?
    var secretService: String?
    var secretStatus: ((String, String) -> Int32?)?
    var secretBeforeOperation: ((String, String) -> Void)?
    var secretAfterOperation: ((String, String) -> Void)?
    var configureSecretJobs: ((NativeSecretJobs) -> Void)?
    var appleRemindersProviderFactory: (() -> NativeAppleRemindersProvider)?
    var calendarReaderFactory: (() -> any NativeCalendarReading)?
    var configureCalendarJobs: ((NativeCalendarJobs) -> Void)?
    var cloudKitRequest: (@Sendable (String) async throws -> String)?
    var cloudKitCancel: (@Sendable () async -> Void)?
    var selectedCloudKitBridge: (@Sendable (NativeAttachmentFileJobs, String) throws -> NativeCloudKitBridge)?
    var cryptoBeforeOperation: ((String) -> Void)?
    var cryptoAfterOperation: ((String) -> Void)?
    var cryptoArgon2Unavailable: (() -> Bool)?
    var configureCryptoJobs: ((NativeCryptoJobs) -> Void)?
}
#endif
