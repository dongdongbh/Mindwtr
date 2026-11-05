import AttachmentFileInstallerEngine
import CoreFoundation
import CryptoKit
import Darwin
import Foundation

enum NativeWhisperModelError: Error, Sendable { case invalidSpecification, unavailable, busy, invalidModel, downloadFailed, cleanupPending }
enum NativeWhisperModelState: String, Sendable { case missing, installed, invalid }

struct NativeWhisperModelDiagnostic: Sendable {
    enum Stage: String, Sendable { case initialization, parent, parentAlias, directory, lock, installer, admission, recovery, reserve, record, writer, transfer, publish, cleanup }
    enum Reason: String, Sendable {
        case specification, unavailable, busy, model, download, cleanup, cancelled, other
        case writerRoute, writerRoot, writerNamespace, writerFile, writerIdentity, writerNonempty
    }
    let stage: Stage
    let reason: Reason
    let errorNumber: Int?
    init(stage: Stage, error: Error) {
        self.stage = stage
        if let value = error as? NativeWhisperModelError {
            switch value {
            case .invalidSpecification: reason = .specification
            case .unavailable: reason = .unavailable
            case .busy: reason = .busy
            case .invalidModel: reason = .model
            case .downloadFailed: reason = .download
            case .cleanupPending: reason = .cleanup
            }
        } else if error is CancellationError { reason = .cancelled }
        else {
            let messages: [String: Reason] = [
                "ATTACHMENT_FILE_INSTALLER_FAILED: Reserved writer requires its private attachment stage": .writerRoute,
                "ATTACHMENT_FILE_INSTALLER_FAILED: Could not retain reserved writer root": .writerRoot,
                "ATTACHMENT_FILE_INSTALLER_FAILED: Could not retain reserved writer namespace": .writerNamespace,
                "ATTACHMENT_FILE_INSTALLER_FAILED: Could not retain reserved writer file": .writerFile,
                "ATTACHMENT_FILE_INSTALLER_FAILED: Reserved attachment writer identity changed": .writerIdentity,
                "ATTACHMENT_FILE_INSTALLER_FAILED: Reserved attachment writer requires an empty stage": .writerNonempty,
            ]
            reason = messages[(error as NSError).userInfo[NSLocalizedDescriptionKey] as? String ?? ""] ?? .other
        }
        let value = error as NSError
        let underlying = value.userInfo[NSUnderlyingErrorKey] as? NSError
        let posix = value.domain == NSPOSIXErrorDomain ? value : underlying?.domain == NSPOSIXErrorDomain ? underlying : nil
        errorNumber = posix.flatMap { (1...4095).contains($0.code) ? $0.code : nil }
    }
}

struct NativeWhisperModelSpec: Sendable {
    let id: String
    let fileName: String
    let sizeBytes: Int64
    let sha256: String
    let urls: [URL]

    static func validated(_ json: String) throws -> Self {
        let value = try NativeVoiceJSON.object(json, maximum: 16384)
        guard Set(value.keys) == ["version", "id", "fileName", "sizeBytes", "sha256", "urls"],
              let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let id = value["id"] as? String, let name = value["fileName"] as? String,
              let size = value["sizeBytes"] as? NSNumber, CFGetTypeID(size) != CFBooleanGetTypeID(), size.doubleValue == Double(size.int64Value),
              let digest = value["sha256"] as? String, let sources = value["urls"] as? [String],
              sources.allSatisfy({ $0.utf8.count <= 4096 && !$0.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }) }),
              sources.compactMap(URL.init(string:)).count == sources.count else {
            throw NativeWhisperModelError.invalidSpecification
        }
        let result = Self(id: id, fileName: name, sizeBytes: size.int64Value, sha256: digest, urls: sources.compactMap(URL.init(string:)))
        try result.validate(); return result
    }
    func validate() throws {
        guard Self.validIdentity(id, fileName: fileName), sizeBytes > 0, sizeBytes <= 150_000_000,
              Self.validDigest(sha256), (1...2).contains(urls.count), urls.allSatisfy({
                  Self.allowedURL($0) && $0.absoluteString.utf8.count <= 4096 && $0.path.hasSuffix("/" + fileName)
              }) else { throw NativeWhisperModelError.invalidSpecification }
    }
    static func validIdentity(_ id: String, fileName: String) -> Bool {
        ["whisper-tiny", "whisper-tiny.en", "whisper-base", "whisper-base.en"].contains(id)
            && fileName == "ggml-" + String(id.dropFirst("whisper-".count)) + ".bin"
    }
    static func validDigest(_ value: String) -> Bool { value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    static func allowedURL(_ url: URL) -> Bool {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, parts.fragment == nil,
              !url.absoluteString.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 }) else { return false }
        return true
    }
}

final class NativeWhisperModelLease: @unchecked Sendable {
    let url: URL
    private let lock = NSLock()
    private var releaseBody: (@Sendable () async -> Void)?
    private var validateBody: (@Sendable () async throws -> Void)?
    private var duplicateBody: (@Sendable () async throws -> Int32)?
    fileprivate init(url: URL, validate: @escaping @Sendable () async throws -> Void,
                     duplicate: @escaping @Sendable () async throws -> Int32, release: @escaping @Sendable () async -> Void) {
        self.url = url; validateBody = validate; duplicateBody = duplicate; releaseBody = release
    }
    private func takeRelease() -> (@Sendable () async -> Void)? {
        lock.lock(); defer { lock.unlock() }; let body = releaseBody
        releaseBody = nil; validateBody = nil; duplicateBody = nil; return body
    }
    private func validation() -> (@Sendable () async throws -> Void)? { lock.lock(); defer { lock.unlock() }; return validateBody }
    private func duplication() -> (@Sendable () async throws -> Int32)? { lock.lock(); defer { lock.unlock() }; return duplicateBody }
    func validate() async throws {
        guard let body = validation() else { throw NativeWhisperModelError.unavailable }; try await body()
    }
    func duplicateDescriptor() async throws -> Int32 {
        guard let body = duplication() else { throw NativeWhisperModelError.unavailable }; return try await body()
    }
    func release() async { if let body = takeRelease() { await body() } }
    deinit { if let body = takeRelease() { Task { await body() } } }
}

final class NativeWhisperModelStore: @unchecked Sendable {
    private struct Generation: Equatable {
        let device: UInt64, inode: UInt64, size: Int64, mode: mode_t
        let modified: Int64, modifiedNanos: Int64, changed: Int64, changedNanos: Int64
        init(_ value: stat) {
            device = UInt64(value.st_dev); inode = UInt64(value.st_ino); size = Int64(value.st_size); mode = value.st_mode
            modified = Int64(value.st_mtimespec.tv_sec); modifiedNanos = Int64(value.st_mtimespec.tv_nsec)
            changed = Int64(value.st_ctimespec.tv_sec); changedNanos = Int64(value.st_ctimespec.tv_nsec)
        }
        var token: String { "\(device):\(inode)" }
    }
    private struct OpenFile {
        let fd: Int32, root: Int32, generation: Generation
        let fileName: String
        func close() { Darwin.close(fd); Darwin.close(root) }
    }
    private struct Record: Codable {
        let version: Int, id: String, fileName: String, sizeBytes: Int64, sha256: String, operation: String
        let stagedIdentity: String, directoryIdentity: String, privateDirectoryIdentity: String
        var name: String { ".whisper-model-install-" + operation + ".json" }
        func validate() throws {
            func token(_ value: String) -> Bool {
                let parts = value.split(separator: ":", omittingEmptySubsequences: false)
                return value.utf8.count <= 41 && parts.count == 2 && parts.allSatisfy { part in
                    guard let number = UInt64(part) else { return false }; return String(number) == String(part)
                }
            }
            guard version == 1, NativeWhisperModelSpec.validIdentity(id, fileName: fileName), sizeBytes > 0, sizeBytes <= 150_000_000,
                  NativeWhisperModelSpec.validDigest(sha256), operation.utf8.count == 32,
                  operation.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  [stagedIdentity, directoryIdentity, privateDirectoryIdentity].allSatisfy(token) else { throw NativeWhisperModelError.cleanupPending }
        }
    }
    private struct Reservation {
        let record: Record
        let marker: Generation
        let prepared: ImmutableAttachmentPreparedStage
        let writer: ImmutableAttachmentStageWriter
    }

    private let root: URL
    private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.whisper-model-files", qos: .userInitiated)
    private let configuration: URLSessionConfiguration
    private let onFailure: (@Sendable (NativeWhisperModelDiagnostic) -> Void)?
    private let installer: AttachmentFileInstaller
    private let rootIdentity: String
    private var rootFD: Int32
    private var lockFD: Int32
    private var closed = false
    private var leases: [UUID: OpenFile] = [:]
    private var operation: UUID?
    private var cancellation: NativeAttachmentCancellation?
    private var transfer: NativeWhisperModelTransfer?
    private var drainWaiters: [CheckedContinuation<Void, Never>] = []
    #if DEBUG
    var beforeRemovalClaim: ((String) throws -> Void)?
    var beforeModelHash: (() throws -> Void)?
    var beforeReservedWriterOpen: (() throws -> Void)?
    var afterModelHash: (() throws -> Void)?
    #endif

    init(root: URL, sessionConfiguration: URLSessionConfiguration = .ephemeral,
         onFailure: (@Sendable (NativeWhisperModelDiagnostic) -> Void)? = nil) throws {
        var phase = NativeWhisperModelDiagnostic.Stage.initialization
        do {
            guard root.isFileURL, let parts = URLComponents(url: root, resolvingAgainstBaseURL: false),
                  parts.host == nil || parts.host == "", parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
                  root.path.hasPrefix("/"), !root.path.utf8.contains(0), root.lastPathComponent != ".", root.lastPathComponent != "..", !root.lastPathComponent.isEmpty else { throw NativeWhisperModelError.unavailable }
            var selectedNode = stat()
            if Darwin.lstat(root.standardizedFileURL.path, &selectedNode) == 0, selectedNode.st_mode & S_IFMT != S_IFDIR { throw NativeWhisperModelError.unavailable }
            let normalized = NativeDiagnosticsLogFile.normalizingSystemVarAlias(root.standardizedFileURL)
            let selected = NativeDiagnosticsLogFile.normalizingSystemVarAlias(normalized.resolvingSymlinksInPath())
            phase = selected.pathComponents.dropFirst().first == "var" ? .parentAlias : .parent
            let parent = Darwin.open(selected.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard parent >= 0 else { throw NativeWhisperModelError.unavailable }; defer { Darwin.close(parent) }
            phase = .directory
            if Darwin.mkdirat(parent, selected.lastPathComponent, 0o700) == 0 {
                guard Darwin.fsync(parent) == 0 else { throw NativeWhisperModelError.unavailable }
            } else if errno != EEXIST { throw NativeWhisperModelError.unavailable }
            let directory = Darwin.openat(parent, selected.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard directory >= 0 else { throw NativeWhisperModelError.unavailable }
            var owned = false
            defer { if !owned { Darwin.close(directory) } }
            var info = stat(); guard Darwin.fstat(directory, &info) == 0 else { throw NativeWhisperModelError.unavailable }
            phase = .lock
            let lock = Darwin.openat(directory, ".whisper-model-store.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            guard lock >= 0 else { throw NativeWhisperModelError.unavailable }
            var locked = false; defer { if !locked { Darwin.close(lock) } }
            var lockInfo = stat()
            guard Darwin.fstat(lock, &lockInfo) == 0, lockInfo.st_mode & S_IFMT == S_IFREG, lockInfo.st_nlink == 1,
                  flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw NativeWhisperModelError.busy }
            self.root = selected; rootFD = directory; lockFD = lock; rootIdentity = Generation(info).token
            configuration = sessionConfiguration
            self.onFailure = onFailure
            phase = .installer
            installer = try AttachmentFileInstaller(targetRoot: selected, sourceRoots: [selected])
            owned = true; locked = true
            do { try queue.sync { try self.requireRoot(); self.recoverRecords() } }
            catch { flock(lockFD, LOCK_UN); Darwin.close(lockFD); Darwin.close(rootFD); lockFD = -1; rootFD = -1; throw error }
        } catch {
            onFailure?(NativeWhisperModelDiagnostic(stage: phase, error: error))
            throw error
        }
    }
    deinit {
        leases.values.forEach { $0.close() }
        if lockFD >= 0 { flock(lockFD, LOCK_UN); Darwin.close(lockFD) }
        if rootFD >= 0 { Darwin.close(rootFD) }
    }

    func inspect(_ model: NativeWhisperModelSpec) async throws -> NativeWhisperModelState {
        try model.validate()
        return try await files { try self.requireAvailable(); return try self.inspectOnLane(model) }
    }
    func acquire(_ model: NativeWhisperModelSpec) async throws -> NativeWhisperModelLease {
        try model.validate()
        return try await files {
            try self.requireAvailable()
            guard let file = try self.verified(model) else { throw NativeWhisperModelError.invalidModel }
            let id = UUID(); self.leases[id] = file
            return NativeWhisperModelLease(url: self.root.appendingPathComponent(model.fileName), validate: { [self] in
                try await self.files { _ = try self.requireLease(id) }
            }, duplicate: { [self] in
                try await self.files {
                    let file = try self.requireLease(id), duplicate = Darwin.dup(file.fd)
                    guard duplicate >= 0 else { throw NativeWhisperModelError.unavailable }
                    guard Darwin.fcntl(duplicate, F_SETFD, FD_CLOEXEC) == 0, Darwin.lseek(duplicate, 0, SEEK_SET) == 0 else {
                        Darwin.close(duplicate); throw NativeWhisperModelError.unavailable
                    }
                    return duplicate
                }
            }, release: { [self] in
                _ = try? await self.files { self.leases.removeValue(forKey: id)?.close() }
            })
        }
    }
    func remove(_ model: NativeWhisperModelSpec) async throws {
        try model.validate()
        try await files {
            try self.requireAvailable()
            guard self.operation == nil, !self.leases.values.contains(where: { $0.fileName == model.fileName }) else { throw NativeWhisperModelError.busy }
            let fd = Darwin.openat(self.rootFD, model.fileName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            if fd < 0 { if errno == ENOENT { guard Darwin.fsync(self.rootFD) == 0 else { throw NativeWhisperModelError.unavailable }; return }; throw NativeWhisperModelError.invalidModel }
            defer { Darwin.close(fd) }
            let before = try self.regular(fd)
            try self.requireRoot(); try self.requireNamed(model.fileName, matches: before)
            try self.claimAndRemove(model.fileName, descriptor: fd, generation: before)
        }
    }

    func install(_ model: NativeWhisperModelSpec, cancellation token: NativeAttachmentCancellation = NativeAttachmentCancellation(),
                 progress: @escaping @Sendable (Int64, Int64) -> Void = { _, _ in }) async throws {
        try model.validate()
        let id: UUID? = try await files {
            return try self.diagnosed(.admission) {
                try self.requireAvailable(); try token.check()
                guard self.operation == nil else { throw NativeWhisperModelError.busy }
                switch try self.inspectOnLane(model, synchronize: true) {
                case .installed: return nil
                case .invalid: throw NativeWhisperModelError.invalidModel
                case .missing: break
                }
                self.recoverRecords()
                let id = UUID(); self.operation = id; self.cancellation = token; return id
            }
        }
        guard let id else { return }
        do {
            try await withTaskCancellationHandler {
                var last: Error = NativeWhisperModelError.downloadFailed
                for url in model.urls {
                    try token.check()
                    let reserved = try await files { try self.requireOperation(id); return try self.reserve(model) }
                    do {
                        let download = NativeWhisperModelTransfer(url: url, model: model, writer: reserved.writer, queue: queue,
                            configuration: configuration, cancellation: token, progress: progress)
                        try await files { try self.requireOperation(id); self.transfer = download }
                        do { try await download.run() }
                        catch { onFailure?(NativeWhisperModelDiagnostic(stage: .transfer, error: error)); throw error }
                        try await files {
                            try self.requireOperation(id); try token.check(); try self.requireRoot()
                            try self.diagnosed(.publish) {
                                reserved.writer.close()
                                _ = try self.installer.publishImmutable(stagedInput: reserved.prepared.stagedUrl,
                                    targetInput: self.root.appendingPathComponent(model.fileName), expectedStagedSha256: model.sha256,
                                    expectedStagedIdentity: reserved.record.stagedIdentity, expectedDirectoryIdentity: reserved.record.directoryIdentity,
                                    expectedPrivateDirectoryIdentity: reserved.record.privateDirectoryIdentity)
                                guard try self.inspectOnLane(model, synchronize: true) == .installed else { throw NativeWhisperModelError.invalidModel }
                            }
                            try self.cleanup(reserved)
                        }
                        try await finish(id); return
                    } catch {
                        try await files { try self.cleanup(reserved) }
                        if token.isCancelled || Task.isCancelled { throw CancellationError() }
                        if case NativeWhisperModelError.invalidModel = error { throw error }
                        last = NativeWhisperModelError.downloadFailed
                    }
                }
                throw last
            } onCancel: { token.cancel() }
        } catch {
            try? await finish(id)
            throw error
        }
    }

    func cancelAndDrain() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.cancellation?.cancel(); self.transfer?.cancel()
                if self.operation == nil { continuation.resume() } else { self.drainWaiters.append(continuation) }
            }
        }
    }
    func close() async throws {
        try await files { self.closed = true }
        await cancelAndDrain()
        try await files {
            guard self.leases.isEmpty else { throw NativeWhisperModelError.busy }
            if self.lockFD >= 0 { flock(self.lockFD, LOCK_UN); Darwin.close(self.lockFD); self.lockFD = -1 }
            if self.rootFD >= 0 { Darwin.close(self.rootFD); self.rootFD = -1 }
        }
    }

    private func diagnosed<T>(_ stage: NativeWhisperModelDiagnostic.Stage, _ body: () throws -> T) throws -> T {
        do { return try body() }
        catch { onFailure?(NativeWhisperModelDiagnostic(stage: stage, error: error)); throw error }
    }

    private func files<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in queue.async { continuation.resume(with: Result { try body() }) } }
    }
    private func finish(_ id: UUID) async throws {
        try await files {
            guard self.operation == id else { return }
            self.transfer = nil; self.cancellation = nil; self.operation = nil
            let waiters = self.drainWaiters; self.drainWaiters.removeAll(); waiters.forEach { $0.resume() }
        }
    }
    private func requireAvailable() throws { guard !closed else { throw NativeWhisperModelError.unavailable }; try requireRoot() }
    private func requireOperation(_ id: UUID) throws { guard operation == id else { throw NativeWhisperModelError.unavailable }; try requireRoot() }
    private func requireRoot() throws {
        guard rootFD >= 0 else { throw NativeWhisperModelError.unavailable }
        let current = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard current >= 0 else { throw NativeWhisperModelError.unavailable }; defer { Darwin.close(current) }
        var held = stat(), named = stat()
        guard Darwin.fstat(rootFD, &held) == 0, Darwin.fstat(current, &named) == 0,
              Generation(held).token == rootIdentity, Generation(named).token == rootIdentity else { throw NativeWhisperModelError.unavailable }
    }
    private func regular(_ fd: Int32) throws -> Generation {
        var info = stat()
        guard Darwin.fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1, info.st_size >= 0 else { throw NativeWhisperModelError.invalidModel }
        return Generation(info)
    }
    private func requireNamed(_ name: String, matches generation: Generation) throws {
        var named = stat()
        guard Darwin.fstatat(rootFD, name, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_mode & S_IFMT == S_IFREG, named.st_nlink == 1,
              Generation(named) == generation else { throw NativeWhisperModelError.invalidModel }
    }
    private func requireLease(_ id: UUID) throws -> OpenFile {
        try requireAvailable()
        guard let file = leases[id], try regular(file.fd) == file.generation else { throw NativeWhisperModelError.unavailable }
        try requireNamed(file.fileName, matches: file.generation)
        return file
    }
    private func claimAndRemove(_ name: String, descriptor: Int32, generation: Generation) throws {
        try requireRoot(); try requireNamed(name, matches: generation)
        let claim = ".whisper-model-retire-" + UUID().uuidString.lowercased()
        guard Darwin.mkdirat(rootFD, claim, 0o700) == 0 else { throw NativeWhisperModelError.unavailable }
        let directory = Darwin.openat(rootFD, claim, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw NativeWhisperModelError.unavailable }
        var directoryInfo = stat()
        guard Darwin.fstat(directory, &directoryInfo) == 0 else { Darwin.close(directory); throw NativeWhisperModelError.unavailable }
        let identity = Generation(directoryInfo).token
        defer {
            var named = stat()
            if Darwin.fstatat(rootFD, claim, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_mode & S_IFMT == S_IFDIR,
               Generation(named).token == identity {
                _ = Darwin.unlinkat(rootFD, claim, AT_REMOVEDIR); _ = Darwin.fsync(rootFD)
            }
            Darwin.close(directory)
        }
        #if DEBUG
        try beforeRemovalClaim?(name)
        #endif
        try requireRoot()
        guard Darwin.renameatx_np(rootFD, name, directory, "file", UInt32(RENAME_EXCL)) == 0 else { throw NativeWhisperModelError.invalidModel }
        var claimed = stat()
        guard let retained = try? regular(descriptor), Darwin.fstatat(directory, "file", &claimed, AT_SYMLINK_NOFOLLOW) == 0,
              claimed.st_mode & S_IFMT == S_IFREG, claimed.st_nlink == 1, Generation(claimed) == retained,
              retained.device == generation.device, retained.inode == generation.inode, retained.size == generation.size,
              retained.mode == generation.mode, retained.modified == generation.modified, retained.modifiedNanos == generation.modifiedNanos else {
            _ = Darwin.renameatx_np(directory, "file", rootFD, name, UInt32(RENAME_EXCL))
            _ = Darwin.fsync(directory); _ = Darwin.fsync(rootFD)
            throw NativeWhisperModelError.invalidModel
        }
        try requireRoot()
        guard Darwin.unlinkat(directory, "file", 0) == 0, Darwin.fsync(directory) == 0, Darwin.fsync(rootFD) == 0 else { throw NativeWhisperModelError.unavailable }
    }
    private func verified(_ model: NativeWhisperModelSpec, synchronize: Bool = false) throws -> OpenFile? {
        try requireRoot()
        let fd = Darwin.openat(rootFD, model.fileName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw NativeWhisperModelError.invalidModel }
        var owned = false; defer { if !owned { Darwin.close(fd) } }
        let before = try regular(fd)
        guard before.size == model.sizeBytes else { throw NativeWhisperModelError.invalidModel }
        let hash: String
        #if DEBUG
        try beforeModelHash?()
        let hashed = Result { try self.hashPinned(fd, maximumBytes: model.sizeBytes) }
        try afterModelHash?()
        hash = try hashed.get()
        #else
        hash = try hashPinned(fd, maximumBytes: model.sizeBytes)
        #endif
        try requireRoot(); try requireNamed(model.fileName, matches: before)
        guard try regular(fd) == before, hash == model.sha256 else { throw NativeWhisperModelError.invalidModel }
        if synchronize {
            guard Darwin.fsync(fd) == 0, Darwin.fcntl(fd, F_FULLFSYNC) == 0, Darwin.fsync(rootFD) == 0 else { throw NativeWhisperModelError.unavailable }
        }
        let parent = Darwin.dup(rootFD); guard parent >= 0 else { throw NativeWhisperModelError.unavailable }
        owned = true; return OpenFile(fd: fd, root: parent, generation: before, fileName: model.fileName)
    }
    private func hashPinned(_ fd: Int32, maximumBytes: Int64) throws -> String {
        guard Darwin.lseek(fd, 0, SEEK_SET) == 0 else { throw NativeWhisperModelError.invalidModel }
        var digest = SHA256(), received: Int64 = 0, buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(fd, &buffer, min(64 * 1024, Int(maximumBytes - received) + 1))
            if count < 0 && errno == EINTR { continue }
            guard count >= 0, Int64(count) <= maximumBytes - received else { throw NativeWhisperModelError.invalidModel }
            if count == 0 { break }
            received += Int64(count); digest.update(data: Data(buffer.prefix(count)))
        }
        guard received == maximumBytes else { throw NativeWhisperModelError.invalidModel }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func inspectOnLane(_ model: NativeWhisperModelSpec, synchronize: Bool = false) throws -> NativeWhisperModelState {
        do {
            guard let file = try verified(model, synchronize: synchronize) else { return .missing }
            file.close(); return .installed
        } catch NativeWhisperModelError.invalidModel { return .invalid }
    }

    private func reserve(_ model: NativeWhisperModelSpec) throws -> Reservation {
        try requireRoot()
        let operation = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        let prepared = try diagnosed(.reserve) {
            try installer.prepareImmutableStage(targetInput: root.appendingPathComponent(model.fileName), operationId: operation)
        }
        let record = Record(version: 1, id: model.id, fileName: model.fileName, sizeBytes: model.sizeBytes, sha256: model.sha256, operation: operation,
            stagedIdentity: prepared.stagedIdentity, directoryIdentity: prepared.directoryIdentity, privateDirectoryIdentity: prepared.privateDirectoryIdentity)
        var markerFD: Int32 = -1; defer { if markerFD >= 0 { Darwin.close(markerFD) } }
        let marker = try diagnosed(.record) {
            try DurableFile.write(JSONEncoder().encode(record), to: record.name, in: rootFD, retainingFile: &markerFD, exclusive: true)
            let marker = try regular(markerFD); try requireNamed(record.name, matches: marker); return marker
        }
        let writer = try diagnosed(.writer) {
            #if DEBUG
            try beforeReservedWriterOpen?()
            #endif
            return try installer.openPreparedStageForWriting(prepared, targetInput: root.appendingPathComponent(model.fileName))
        }
        return Reservation(record: record, marker: marker, prepared: prepared, writer: writer)
    }
    private func cleanup(_ reservation: Reservation) throws {
        try diagnosed(.cleanup) {
            reservation.writer.close()
            try retire(reservation.record)
            try removeRecord(reservation.record.name, generation: reservation.marker)
        }
    }
    private func retire(_ record: Record) throws {
        try requireRoot(); try record.validate()
        guard record.directoryIdentity == rootIdentity else { throw NativeWhisperModelError.cleanupPending }
        let stage = root.appendingPathComponent(".mindwtr-install-" + record.operation + ".candidate/stage")
        switch try installer.retireOwnedPrivateStage(stagedInput: stage, targetInput: root.appendingPathComponent(record.fileName), operationId: record.operation,
            expectedStagedIdentity: record.stagedIdentity, expectedDirectoryIdentity: record.directoryIdentity, expectedPrivateDirectoryIdentity: record.privateDirectoryIdentity) {
        case .removed, .missing: return
        case .conflict: throw NativeWhisperModelError.cleanupPending
        }
    }
    private func removeRecord(_ name: String, generation: Generation) throws {
        try requireRoot(); try requireNamed(name, matches: generation)
        let fd = Darwin.openat(rootFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw NativeWhisperModelError.cleanupPending }; defer { Darwin.close(fd) }
        guard try regular(fd) == generation else { throw NativeWhisperModelError.cleanupPending }
        try claimAndRemove(name, descriptor: fd, generation: generation)
    }
    private func recoverRecords() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return }
        for name in names where name.range(of: "^\\.whisper-model-install-[a-f0-9]{32}\\.json$", options: .regularExpression) != nil {
            do {
                try requireRoot()
                let fd = Darwin.openat(rootFD, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
                guard fd >= 0 else { continue }; defer { Darwin.close(fd) }
                let before = try regular(fd); guard before.size <= 16384 else { continue }
                var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
                while true {
                    let count = Darwin.read(fd, &buffer, 4096)
                    if count < 0 && errno == EINTR { continue }
                    guard count >= 0, data.count + max(0, count) <= 16384 else { throw NativeWhisperModelError.cleanupPending }
                    if count == 0 { break }; data.append(contentsOf: buffer.prefix(count))
                }
                let object = try NativeVoiceJSON.object(String(decoding: data, as: UTF8.self), maximum: 16384)
                guard Set(object.keys) == ["version", "id", "fileName", "sizeBytes", "sha256", "operation", "stagedIdentity", "directoryIdentity", "privateDirectoryIdentity"] else { continue }
                let record = try JSONDecoder().decode(Record.self, from: data); try record.validate()
                guard record.name == name, try regular(fd) == before else { continue }
                try requireNamed(name, matches: before); try retire(record); try removeRecord(name, generation: before)
            } catch { onFailure?(NativeWhisperModelDiagnostic(stage: .recovery, error: error)); continue }
        }
    }
}

private final class NativeWhisperModelTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let source: URL
    private let model: NativeWhisperModelSpec
    private let writer: ImmutableAttachmentStageWriter
    private let queue: DispatchQueue
    private let configuration: URLSessionConfiguration
    private let cancellation: NativeAttachmentCancellation
    private let progress: @Sendable (Int64, Int64) -> Void
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var cancelled = false
    private var session: URLSession?
    private var delegateQueue: OperationQueue?
    private var continuation: CheckedContinuation<Void, Error>?
    private var terminal: Result<Void, Error>?
    private var invalidated = false
    private var failure: Error?
    private var received: Int64 = 0
    private var digest = SHA256()
    private var hops = 0
    private var acceptedResponse = false

    init(url: URL, model: NativeWhisperModelSpec, writer: ImmutableAttachmentStageWriter, queue: DispatchQueue,
         configuration: URLSessionConfiguration, cancellation: NativeAttachmentCancellation,
         progress: @escaping @Sendable (Int64, Int64) -> Void) {
        source = url; self.model = model; self.writer = writer; self.queue = queue
        self.configuration = configuration; self.cancellation = cancellation; self.progress = progress
    }
    func cancel() {
        lock.lock(); cancelled = true; let selected = task; lock.unlock(); selected?.cancel()
    }
    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled || cancellation.isCancelled }
    func run() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                guard !self.isCancelled else { continuation.resume(throwing: CancellationError()); return }
                guard let configuration = self.configuration.copy() as? URLSessionConfiguration else {
                    continuation.resume(throwing: NativeWhisperModelError.unavailable); return
                }
                configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
                configuration.httpShouldSetCookies = false; configuration.httpAdditionalHeaders = nil
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.timeoutIntervalForRequest = 60; configuration.timeoutIntervalForResource = 1800
                configuration.waitsForConnectivity = false
                let delegate = OperationQueue(); delegate.maxConcurrentOperationCount = 1; delegate.underlyingQueue = self.queue
                self.delegateQueue = delegate; self.continuation = continuation
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegate)
                self.session = session
                var request = URLRequest(url: self.source); request.httpMethod = "GET"
                request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                let task = session.dataTask(with: request)
                self.lock.lock(); self.task = task; let cancelled = self.cancelled || self.cancellation.isCancelled; self.lock.unlock()
                self.cancellation.setCancellationHandler { [weak self] in self?.cancel() }
                if cancelled { task.cancel() }
                task.resume()
            }
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard !isCancelled, hops < 5, let url = request.url, NativeWhisperModelSpec.allowedURL(url) else {
            failure = isCancelled ? CancellationError() : NativeWhisperModelError.downloadFailed
            completionHandler(nil); task.cancel(); return
        }
        hops += 1
        var next = URLRequest(url: url); next.httpMethod = "GET"
        next.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        completionHandler(next)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard !isCancelled, let response = response as? HTTPURLResponse, response.statusCode == 200,
              let url = response.url, NativeWhisperModelSpec.allowedURL(url) else {
            failure = isCancelled ? CancellationError() : NativeWhisperModelError.downloadFailed
            completionHandler(.cancel); return
        }
        if let encoding = response.value(forHTTPHeaderField: "Content-Encoding"), encoding.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "identity" {
            failure = NativeWhisperModelError.downloadFailed; completionHandler(.cancel); return
        }
        if let raw = response.value(forHTTPHeaderField: "Content-Length") {
            let text = raw.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty, text.utf8.allSatisfy({ (48...57).contains($0) }), Int64(text) == model.sizeBytes else {
                failure = NativeWhisperModelError.downloadFailed; completionHandler(.cancel); return
            }
        }
        acceptedResponse = true; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        do {
            guard !isCancelled, acceptedResponse else { throw CancellationError() }
            let next = received.addingReportingOverflow(Int64(data.count))
            guard !next.overflow, next.partialValue <= model.sizeBytes else { throw NativeWhisperModelError.downloadFailed }
            try writer.append(data); digest.update(data: data); received = next.partialValue
            progress(received, model.sizeBytes)
        } catch { failure = error; dataTask.cancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        do {
            if isCancelled { throw CancellationError() }
            if let failure { throw failure }
            guard error == nil, acceptedResponse, received == model.sizeBytes,
                  digest.finalize().map({ String(format: "%02x", $0) }).joined() == model.sha256 else { throw NativeWhisperModelError.downloadFailed }
            try writer.synchronize(); terminal = .success(())
        } catch { terminal = .failure(error) }
        session.finishTasksAndInvalidate(); completeIfDrained()
    }
    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        invalidated = true
        if let error, terminal == nil { terminal = .failure(error) }
        completeIfDrained()
    }
    private func completeIfDrained() {
        guard invalidated, let terminal, let continuation else { return }
        self.continuation = nil; cancellation.setCancellationHandler(nil)
        lock.lock(); task = nil; lock.unlock()
        session = nil; delegateQueue = nil
        continuation.resume(with: terminal)
    }
}
