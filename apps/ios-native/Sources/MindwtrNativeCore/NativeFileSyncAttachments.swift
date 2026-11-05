import AttachmentFileInstallerEngine
import Darwin
import Foundation

final class NativeFileSyncAttachments: @unchecked Sendable {
    static let maximumBytes = 8 * 1024 * 1024
    static let maximumEntries = 10_000
    static let maximumDepth = 8
    enum Failure: Error { case unavailable }

    private let root: URL
    private let directoryURI: String
    private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.file-sync-attachments")
    private var closed = false
    private struct Stage {
        let prepared: ImmutableAttachmentPreparedStage
        let target: String
        var written = false
    }
    private var stages: [String: Stage] = [:]

    init(root: URL, rootURI: String) {
        self.root = root
        directoryURI = rootURI + "attachments/"
    }

    private var directory: URL { root.appendingPathComponent("attachments", isDirectory: true) }

    func perform(_ op: String, _ request: [String: Any]) async throws -> (Any, Data?) {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Any, Data?), Error>) in
            queue.async {
                continuation.resume(with: Result {
                    guard !self.closed else { throw Failure.unavailable }
                    return try self.execute(op, request)
                })
            }
        }
    }

    func close() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async {
                self.closed = true
                self.stages.removeAll()
                continuation.resume()
            }
        }
    }

    private func execute(_ op: String, _ request: [String: Any]) throws -> (Any, Data?) {
        switch op {
        case "attachmentInfo":
            let value = try info(components(request["uri"]))
            return (value, nil)
        case "attachmentList":
            let names = try list(components(request["uri"]))
            return (names, nil)
        case "attachmentDirectory":
            guard try components(request["uri"]).isEmpty else { throw Failure.unavailable }
            try ensureDirectory()
            return (NSNull(), nil)
        case "attachmentRead":
            guard let position = Self.integer(request["position"]) else { throw Failure.unavailable }
            let length: Int?
            if request["length"] is NSNull { length = nil }
            else {
                guard let value = Self.integer(request["length"]), value <= Self.maximumBytes else { throw Failure.unavailable }
                length = value
            }
            switch try read(components(request["uri"]), position: position, length: length) {
            case .absent: return ("absent", nil)
            case .tooLarge: return ("tooLarge", nil)
            case .bytes(let data): return ("bytes", data)
            }
        case "attachmentPrepare":
            let target = try targetName(request["uri"])
            guard let operation = request["operationId"] as? String, Self.validOperation(operation),
                  stages[operation] == nil else { throw Failure.unavailable }
            let prepared = try installer().prepareImmutableStage(targetInput: targetURL(target), operationId: operation)
            guard Self.samePath(prepared.stagedUrl, stageURL(operation)) else { throw Failure.unavailable }
            stages[operation] = Stage(prepared: prepared, target: target)
            return (["stagedIdentity": prepared.stagedIdentity, "directoryIdentity": prepared.directoryIdentity,
                     "privateDirectoryIdentity": prepared.privateDirectoryIdentity], nil)
        case "attachmentWrite":
            let operation = try stageOperation(request["uri"])
            guard let stage = stages[operation], !stage.written,
                  let text = request["base64"] as? String, text.utf8.count <= ((Self.maximumBytes + 2) / 3) * 4,
                  let bytes = Data(base64Encoded: text), bytes.count <= Self.maximumBytes,
                  Data(bytes.base64EncodedString().utf8) == Data(text.utf8) else { throw Failure.unavailable }
            stages[operation]?.written = true
            let writer = try installer().openPreparedStageForWriting(stage.prepared, targetInput: targetURL(stage.target))
            defer { writer.close() }
            try writer.append(bytes)
            try writer.synchronize()
            return (NSNull(), nil)
        case "attachmentSnapshot":
            let operation = try stageOperation(request["uri"]), target = try targetName(request["target"])
            let snapshot = try installer().snapshotImmutableStage(stagedInput: stageURL(operation), targetInput: targetURL(target),
                expectedStagedSha256: try Self.digest(request["sha256"]))
            return (["stagedIdentity": snapshot.stagedIdentity, "directoryIdentity": snapshot.directoryIdentity], nil)
        case "attachmentPublish":
            let operation = try stageOperation(request["uri"]), target = try targetName(request["target"])
            let outcome = try installer().publishImmutable(stagedInput: stageURL(operation), targetInput: targetURL(target),
                expectedStagedSha256: try Self.digest(request["sha256"]),
                expectedStagedIdentity: try Self.identity(request["stagedIdentity"]),
                expectedDirectoryIdentity: try Self.identity(request["directoryIdentity"]),
                expectedPrivateDirectoryIdentity: try Self.identity(request["privateDirectoryIdentity"]))
            stages.removeValue(forKey: operation)
            switch outcome {
            case .published: return ("published", nil)
            case .alreadyExists: return ("alreadyExists", nil)
            }
        case "attachmentCleanup":
            let operation = try stageOperation(request["uri"]), target = try targetName(request["target"])
            guard request["operationId"] as? String == operation else { throw Failure.unavailable }
            let digest = try Self.optional(request["sha256"], Self.digest)
            let staged = try Self.optional(request["stagedIdentity"], Self.identity)
            let parentIdentity = try Self.optional(request["directoryIdentity"], Self.identity)
            let privateDirectory = try Self.optional(request["privateDirectoryIdentity"], Self.identity)
            let outcome = try installer().cleanupImmutableStage(stagedInput: stageURL(operation), targetInput: targetURL(target),
                operationId: operation, expectedStagedSha256: digest, expectedStagedIdentity: staged,
                expectedDirectoryIdentity: parentIdentity, expectedPrivateDirectoryIdentity: privateDirectory)
            stages.removeValue(forKey: operation)
            switch outcome {
            case .removed: return ("removed", nil)
            case .missing: return ("missing", nil)
            case .conflict: return ("conflict", nil)
            }
        default: throw Failure.unavailable
        }
    }

    private func installer() throws -> AttachmentFileInstaller {
        do { return try AttachmentFileInstaller(targetRoot: directory, sourceRoots: []) }
        catch { throw Failure.unavailable }
    }

    private func targetURL(_ name: String) -> URL { directory.appendingPathComponent(name, isDirectory: false) }

    private func stageURL(_ operation: String) -> URL {
        directory.appendingPathComponent(".mindwtr-install-" + operation + ".candidate", isDirectory: true)
            .appendingPathComponent("stage", isDirectory: false)
    }

    private func components(_ input: Any?) throws -> [String] {
        guard let uri = input as? String, uri.utf8.count <= 16 * 1024,
              uri.utf8.starts(with: directoryURI.utf8) else { throw Failure.unavailable }
        var rest = String(decoding: Array(uri.utf8.dropFirst(directoryURI.utf8.count)), as: UTF8.self)
        guard Data(rest.utf8) == Data(uri.utf8.dropFirst(directoryURI.utf8.count)) else { throw Failure.unavailable }
        if rest.hasSuffix("/") { rest.removeLast() }
        if rest.isEmpty { return [] }
        let parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count <= Self.maximumDepth, parts.allSatisfy(Self.validName) else { throw Failure.unavailable }
        return parts
    }

    private func targetName(_ input: Any?) throws -> String {
        let parts = try components(input)
        guard parts.count == 1, let name = parts.first, !name.hasPrefix(".mindwtr-install-"),
              !name.hasPrefix(".mindwtr-preserved-"), name != ".mindwtr-attachment-installer.lock" else { throw Failure.unavailable }
        return name
    }

    private func stageOperation(_ input: Any?) throws -> String {
        let parts = try components(input)
        let prefix = ".mindwtr-install-", suffix = ".candidate"
        guard parts.count == 2, parts[1] == "stage", parts[0].hasPrefix(prefix), parts[0].hasSuffix(suffix) else { throw Failure.unavailable }
        let operation = String(parts[0].dropFirst(prefix.count).dropLast(suffix.count))
        guard Self.validOperation(operation) else { throw Failure.unavailable }
        return operation
    }

    private static func validName(_ name: String) -> Bool {
        !name.isEmpty && name != "." && name != ".." && !name.utf8.contains(0) && !name.contains("/")
    }

    private static func validOperation(_ value: String) -> Bool {
        value.utf8.count == 32 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private static func digest(_ input: Any?) throws -> String {
        guard let value = input as? String, value.utf8.count == 64,
              value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw Failure.unavailable }
        return value
    }

    private static func identity(_ input: Any?) throws -> String {
        guard let value = input as? String, value.utf8.count <= 41 else { throw Failure.unavailable }
        let parts = value.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ part in
            !part.isEmpty && part.utf8.count <= 20 && part.utf8.allSatisfy { (48...57).contains($0) }
        }) else { throw Failure.unavailable }
        return value
    }

    private static func optional(_ input: Any?, _ parse: (Any?) throws -> String) throws -> String? {
        if input is NSNull { return nil }
        return try parse(input)
    }

    private static func integer(_ input: Any?) -> Int? {
        guard let number = input as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        guard value.isFinite, value >= 0, value <= Double(Int32.max), value.rounded() == value else { return nil }
        return Int(value)
    }

    private static func samePath(_ lhs: URL, _ rhs: URL) -> Bool {
        lhs.standardizedFileURL.resolvingSymlinksInPath().path == rhs.standardizedFileURL.resolvingSymlinksInPath().path
    }

    private enum Read { case absent, tooLarge, bytes(Data) }

    private func openRoot() throws -> Int32 {
        let fd = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Failure.unavailable }
        return fd
    }

    private func openDirectory(_ parts: [String]) throws -> Int32? {
        var fd = try openRoot()
        for name in ["attachments"] + parts {
            let next = name.withCString { Darwin.openat(fd, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            let failure = errno
            Darwin.close(fd)
            guard next >= 0 else {
                if failure == ENOENT { return nil }
                throw Failure.unavailable
            }
            fd = next
        }
        return fd
    }

    private func named(_ parent: Int32, _ name: String) throws -> stat? {
        var value = stat()
        let rc = name.withCString { Darwin.fstatat(parent, $0, &value, AT_SYMLINK_NOFOLLOW) }
        if rc != 0 {
            guard errno == ENOENT else { throw Failure.unavailable }
            return nil
        }
        let kind = value.st_mode & S_IFMT
        guard kind == S_IFREG || kind == S_IFDIR, value.st_size >= 0 else { throw Failure.unavailable }
        return value
    }

    private func info(_ parts: [String]) throws -> [String: Any] {
        let value: stat?
        if let leaf = parts.last {
            guard let parent = try openDirectory(Array(parts.dropLast())) else { return ["exists": false] }
            defer { Darwin.close(parent) }
            value = try named(parent, leaf)
        } else {
            let fd = try openRoot()
            defer { Darwin.close(fd) }
            value = try named(fd, "attachments")
            guard value.map({ $0.st_mode & S_IFMT == S_IFDIR }) ?? true else { throw Failure.unavailable }
        }
        guard let value else { return ["exists": false] }
        let isDirectory = value.st_mode & S_IFMT == S_IFDIR
        return ["exists": true, "isDirectory": isDirectory, "size": isDirectory ? 0 : Int64(value.st_size),
                "modificationTime": Double(value.st_mtimespec.tv_sec) + Double(value.st_mtimespec.tv_nsec) / 1_000_000_000]
    }

    private func list(_ parts: [String]) throws -> [String] {
        guard let fd = try openDirectory(parts) else { throw Failure.unavailable }
        guard let stream = Darwin.fdopendir(fd) else { Darwin.close(fd); throw Failure.unavailable }
        defer { Darwin.closedir(stream) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = Darwin.readdir(stream) else {
                guard errno == 0 else { throw Failure.unavailable }
                break
            }
            let count = Int(entry.pointee.d_namlen)
            let raw = withUnsafeBytes(of: entry.pointee.d_name) { Data($0.prefix(count)) }
            guard let name = String(data: raw, encoding: .utf8), Data(name.utf8) == raw else { throw Failure.unavailable }
            if name == "." || name == ".." { continue }
            guard Self.validName(name), names.count < Self.maximumEntries else { throw Failure.unavailable }
            names.append(name)
        }
        return names.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
    }

    private func ensureDirectory() throws {
        let fd = try openRoot()
        defer { Darwin.close(fd) }
        if "attachments".withCString({ Darwin.mkdirat(fd, $0, 0o755) }) == 0 {
            guard Darwin.fsync(fd) == 0 else { throw Failure.unavailable }
        } else if errno != EEXIST {
            throw Failure.unavailable
        }
        guard let value = try named(fd, "attachments"), value.st_mode & S_IFMT == S_IFDIR else { throw Failure.unavailable }
    }

    private func read(_ parts: [String], position: Int, length: Int?) throws -> Read {
        guard let leaf = parts.last else { throw Failure.unavailable }
        var url = directory
        for part in parts { url.appendPathComponent(part, isDirectory: false) }
        var result: Result<Read, Error>?
        var coordinationError: NSError?
        NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: url, options: [], error: &coordinationError) { _ in
            result = Result { try self.readNamed(parts: parts, leaf: leaf, position: position, length: length) }
        }
        if coordinationError != nil { throw Failure.unavailable }
        guard let result else { throw Failure.unavailable }
        return try result.get()
    }

    private func readNamed(parts: [String], leaf: String, position: Int, length: Int?) throws -> Read {
        guard let parent = try openDirectory(Array(parts.dropLast())) else { return .absent }
        defer { Darwin.close(parent) }
        let fd = leaf.withCString { Darwin.openat(parent, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) }
        if fd < 0 {
            if errno == ENOENT { return .absent }
            throw Failure.unavailable
        }
        defer { Darwin.close(fd) }
        var before = stat()
        guard Darwin.fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0 else { throw Failure.unavailable }
        let size = Int64(before.st_size)
        let start = min(Int64(position), size)
        let wanted: Int64
        if let length { wanted = min(Int64(length), size - start) }
        else {
            guard size <= Int64(Self.maximumBytes) else { return .tooLarge }
            wanted = size - start
        }
        var data = Data(count: Int(wanted))
        var offset = 0
        try data.withUnsafeMutableBytes { buffer in
            while offset < buffer.count {
                let count = Darwin.pread(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset, off_t(start) + off_t(offset))
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Failure.unavailable }
                offset += count
            }
        }
        var after = stat()
        guard Darwin.fstat(fd, &after) == 0, after.st_dev == before.st_dev, after.st_ino == before.st_ino,
              after.st_size == before.st_size, after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec,
              after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec else { throw Failure.unavailable }
        var named = stat()
        guard leaf.withCString({ Darwin.fstatat(parent, $0, &named, AT_SYMLINK_NOFOLLOW) }) == 0,
              named.st_dev == before.st_dev, named.st_ino == before.st_ino else { throw Failure.unavailable }
        return .bytes(data)
    }
}
