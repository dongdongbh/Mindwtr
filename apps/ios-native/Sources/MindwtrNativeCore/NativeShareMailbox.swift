import Foundation
import Darwin
import CryptoKit

public actor NativeShareMailbox {
    public static let appIdentifier = "tech.dongdongbh.mindwtr.native.dev"
    public static let extensionIdentifier = "tech.dongdongbh.mindwtr.native.dev.share"
    public static let groupIdentifier = "group.tech.dongdongbh.mindwtr.native.dev"
    public enum Route: Sendable, Equatable {
        case development
        case production

        public var appIdentifier: String {
            switch self {
            case .development: return NativeShareMailbox.appIdentifier
            case .production: return "tech.dongdongbh.mindwtr"
            }
        }
        public var extensionIdentifier: String {
            switch self {
            case .development: return NativeShareMailbox.extensionIdentifier
            case .production: return "tech.dongdongbh.mindwtr.share-extension"
            }
        }
        public var groupIdentifier: String { "group." + appIdentifier }

        public static func resolve(bundleIdentifier: String?) -> Self? {
            guard let bundleIdentifier else { return nil }
            return [Self.development, .production].first {
                bundleIdentifier == $0.appIdentifier || bundleIdentifier == $0.extensionIdentifier
            }
        }

        #if !MINDWTR_SHARE_EXTENSION
        public static func app(selection: NativeLaunchSelection, bundleIdentifier: String?) -> Self? {
            guard let route = resolve(bundleIdentifier: bundleIdentifier), bundleIdentifier == route.appIdentifier else { return nil }
            switch (route, selection) {
            case (.production, .production): return route
            case let (.development, .standard(_, _, namespace)) where namespace == route.appIdentifier: return route
            default: return nil
            }
        }
        #endif
    }
    public struct Item: Sendable {
        public let envelope: NativeShareEnvelope
        public let namespace: String
        fileprivate let owner: UUID
        fileprivate let bytes: Data
        fileprivate let witness: Witness
    }
    public struct Page: Sendable { public let items: [Item]; public let next: String? }
    fileprivate struct Witness: Equatable, Sendable {
        let device: UInt64, inode: UInt64, size: Int64
        init(_ info: stat) { device = UInt64(info.st_dev); inode = UInt64(info.st_ino); size = info.st_size }
    }
    private let root: URL, namespace: String, owner = UUID()
    private let descriptors: [Int32], witnesses: [Witness]
    private let lockFD: Int32
    private var directory: Int32 { descriptors[2] }
    #if DEBUG && !MINDWTR_SHARE_EXTENSION
    var afterPublication: (@Sendable () throws -> Void)?
    var beforeAcknowledgment: (@Sendable () throws -> Void)?
    #endif

    public static func current() throws -> NativeShareMailbox {
        guard let route = Route.resolve(bundleIdentifier: Bundle.main.bundleIdentifier),
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: route.groupIdentifier) else {
            throw NativeShareError.unavailable
        }
        return try NativeShareMailbox(root: root, namespace: route.appIdentifier)
    }
    static func group(for bundle: String) throws -> String {
        guard let route = Route.resolve(bundleIdentifier: bundle) else { throw NativeShareError.unavailable }
        return route.groupIdentifier
    }
    private init(root: URL, namespace: String) throws {
        guard root.isFileURL else { throw NativeShareError.unavailable }
        var opened: [Int32] = [], facts: [Witness] = [], acquired: Int32 = -1
        do {
            let first = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard first >= 0 else { throw NativeShareError.unavailable }; opened.append(first)
            for name in ["NativeShare", "v1"] {
                let parent = opened.last!
                if mkdirat(parent, name, 0o700) != 0 && errno != EEXIST { throw NativeShareError.unavailable }
                let child = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard child >= 0 else { throw NativeShareError.unavailable }; opened.append(child)
                guard fsync(parent) == 0 else { throw NativeShareError.unavailable }
            }
            for fd in opened {
                var info = stat(); guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else { throw NativeShareError.unavailable }
                facts.append(Witness(info))
            }
            acquired = openat(opened[2], ".lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard acquired >= 0 else { throw NativeShareError.unavailable }
            var info = stat(); guard fstat(acquired, &info) == 0, Self.regular(info) else { throw NativeShareError.unavailable }
            guard fsync(opened[2]) == 0 else { throw NativeShareError.unavailable }
        } catch {
            if acquired >= 0 { Darwin.close(acquired) }; opened.reversed().forEach { Darwin.close($0) }; throw error
        }
        self.root = root; self.namespace = namespace; descriptors = opened; witnesses = facts; lockFD = acquired
    }
    deinit { Darwin.close(lockFD); descriptors.reversed().forEach { Darwin.close($0) } }

    #if DEBUG && !MINDWTR_SHARE_EXTENSION
    static func fixture(root: URL, namespace: String) throws -> NativeShareMailbox {
        let base = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).appendingPathComponent(".mindwtr-native-tests/share/").path + "/"
        guard root.path.hasPrefix(base), !root.path.contains("/../"), namespace.hasPrefix("mindwtr.share.fixture.") else {
            throw NativeShareError.unavailable
        }
        return try NativeShareMailbox(root: root, namespace: namespace)
    }
    static func fixture(root: URL, route: Route) throws -> NativeShareMailbox {
        let base = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).appendingPathComponent(".mindwtr-native-tests/share/").path + "/"
        guard root.path.hasPrefix(base), !root.path.contains("/../") else { throw NativeShareError.unavailable }
        return try NativeShareMailbox(root: root, namespace: route.appIdentifier)
    }
    func setFaults(afterPublication: (@Sendable () throws -> Void)? = nil,
                   beforeAcknowledgment: (@Sendable () throws -> Void)? = nil) {
        self.afterPublication = afterPublication; self.beforeAcknowledgment = beforeAcknowledgment
    }
    #endif

    private static func regular(_ info: stat) -> Bool { info.st_mode & S_IFMT == S_IFREG && info.st_nlink == 1 }
    private func check() throws {
        for (index, fd) in descriptors.enumerated() {
            var held = stat(), named = stat()
            let status = index == 0 ? lstat(root.path, &named)
                : fstatat(descriptors[index - 1], index == 1 ? "NativeShare" : "v1", &named, AT_SYMLINK_NOFOLLOW)
            guard fstat(fd, &held) == 0, status == 0, held.st_mode & S_IFMT == S_IFDIR,
                  named.st_mode & S_IFMT == S_IFDIR, held.st_dev == named.st_dev, held.st_ino == named.st_ino,
                  UInt64(held.st_dev) == witnesses[index].device, UInt64(held.st_ino) == witnesses[index].inode else {
                throw NativeShareError.changedSource
            }
        }
        var held = stat(), named = stat()
        guard fstat(lockFD, &held) == 0, fstatat(directory, ".lock", &named, AT_SYMLINK_NOFOLLOW) == 0,
              Self.regular(held), Self.regular(named), held.st_dev == named.st_dev, held.st_ino == named.st_ino else {
            throw NativeShareError.changedSource
        }
    }
    private func acquire() throws {
        try check()
        guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw NativeShareError.unavailable }
        do { try check() } catch { _ = flock(lockFD, LOCK_UN); throw error }
    }
    private func read(_ name: String) throws -> (Data, Witness)? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw NativeShareError.unavailable }
        defer { Darwin.close(fd) }
        var before = stat(), after = stat(), named = stat()
        guard fstat(fd, &before) == 0, Self.regular(before), before.st_size > 0,
              before.st_size <= NativeShareEnvelope.maximumBytes else { throw NativeShareError.invalidInput }
        var bytes = Data(count: Int(before.st_size))
        try bytes.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw NativeShareError.changedSource }; offset += count
            }
        }
        guard fstat(fd, &after) == 0, fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
              Self.regular(after), Self.regular(named), Witness(before) == Witness(after), Witness(after) == Witness(named) else {
            throw NativeShareError.changedSource
        }
        return (bytes, Witness(after))
    }
    private func names() throws -> [String] {
        let copy = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard copy >= 0, let stream = fdopendir(copy) else { if copy >= 0 { Darwin.close(copy) }; throw NativeShareError.unavailable }
        defer { closedir(stream) }
        var names: [String] = [], scanned = 0
        while true {
            errno = 0
            guard let entry = readdir(stream) else {
                guard errno == 0 else { throw NativeShareError.unavailable }
                break
            }
            scanned += 1; guard scanned <= 4096 else { throw NativeShareError.full }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." || name == ".lock" || name.hasPrefix(".pending-") { continue }
            guard name.hasSuffix(".json"), UUID(uuidString: String(name.dropLast(5)))?.uuidString.lowercased() == String(name.dropLast(5)) else {
                throw NativeShareError.invalidInput
            }
            names.append(name)
        }
        return names.sorted()
    }
    public func publish(_ envelope: NativeShareEnvelope) throws {
        try envelope.validate(); let bytes = try envelope.encoded(), name = envelope.id + ".json"
        try acquire(); defer { _ = flock(lockFD, LOCK_UN) }
        if !envelope.sharedFiles.isEmpty { try promotePayload(envelope) }
        if let (existing, _) = try read(name) {
            guard existing == bytes else { throw NativeShareError.changedSource }
            let published = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
            guard published >= 0 else { throw NativeShareError.unavailable }
            defer { Darwin.close(published) }
            guard fsync(published) == 0, fcntl(published, F_FULLFSYNC) == 0, fsync(directory) == 0,
                  try read(name)?.0 == bytes else { throw NativeShareError.unavailable }; try check(); return
        }
        guard try names().count < 1024 else { throw NativeShareError.full }
        var retained: Int32 = -1; defer { if retained >= 0 { Darwin.close(retained) } }
        try DurableFile.write(bytes, to: name, in: directory, retainingFile: &retained,
            preservingProtectionFrom: directory, exclusive: true)
        #if DEBUG && !MINDWTR_SHARE_EXTENSION
        try afterPublication?()
        #endif
        guard try read(name)?.0 == bytes else { throw NativeShareError.changedSource }; try check()
    }
    public nonisolated func payloadWriter(for envelopeID: UUID) throws -> NativeSharePayloadWriter {
        let files = try NativeSharePayloadDirectory.open(descriptors[1], create: true); defer { Darwin.close(files) }
        return try NativeSharePayloadWriter(files: files, id: envelopeID.uuidString.lowercased())
    }
    public nonisolated func payloadURL(_ envelope: NativeShareEnvelope, file: NativeShareEnvelope.File) -> URL {
        root.appendingPathComponent("NativeShare/files", isDirectory: true)
            .appendingPathComponent(envelope.id, isDirectory: true).appendingPathComponent(file.id, isDirectory: false)
    }
    private func promotePayload(_ envelope: NativeShareEnvelope) throws {
        let files = try NativeSharePayloadDirectory.open(descriptors[1], create: true); defer { Darwin.close(files) }
        let staging = NativeSharePayloadDirectory.stagingName(envelope.id)
        var info = stat()
        if fstatat(files, envelope.id, &info, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT, renameatx_np(files, staging, files, envelope.id, UInt32(RENAME_EXCL)) == 0,
                  fsync(files) == 0 else { throw NativeShareError.unavailable }
        }
        let payload = try NativeSharePayloadDirectory.open(files, name: envelope.id); defer { Darwin.close(payload) }
        let expected = Dictionary(uniqueKeysWithValues: envelope.sharedFiles.map { ($0.id, $0.size) })
        for name in try NativeSharePayloadDirectory.entries(payload) where expected[name] == nil {
            guard fstatat(payload, name, &info, AT_SYMLINK_NOFOLLOW) == 0, info.st_mode & S_IFMT == S_IFREG,
                  unlinkat(payload, name, 0) == 0 else { throw NativeShareError.changedSource }
        }
        guard fsync(payload) == 0, try NativeSharePayloadDirectory.entries(payload).sorted() == expected.keys.sorted() else { throw NativeShareError.changedSource }
        for (name, size) in expected {
            guard fstatat(payload, name, &info, AT_SYMLINK_NOFOLLOW) == 0, Self.regular(info), info.st_size == size else {
                throw NativeShareError.changedSource
            }
        }
    }
    public func removePayload(_ envelopeID: String, unlessPublished: Bool = false) throws {
        guard NativeSharePayloadDirectory.uuid(envelopeID) else { throw NativeShareError.invalidInput }
        try acquire(); defer { _ = flock(lockFD, LOCK_UN) }
        if unlessPublished, try read(envelopeID + ".json") != nil { return }
        guard let files = try NativeSharePayloadDirectory.openIfPresent(descriptors[1]) else { return }
        defer { Darwin.close(files) }
        for name in [envelopeID, NativeSharePayloadDirectory.stagingName(envelopeID)] { try NativeSharePayloadDirectory.remove(name, in: files) }
        guard fsync(files) == 0 else { throw NativeShareError.unavailable }; try check()
    }
    public func sweepPayloads(keeping retained: Set<String>, stagingOlderThan age: TimeInterval = 86_400, now: Date = Date()) throws -> Int {
        try acquire(); defer { _ = flock(lockFD, LOCK_UN) }
        guard let files = try NativeSharePayloadDirectory.openIfPresent(descriptors[1]) else { return 0 }
        defer { Darwin.close(files) }
        let pending = Set(try names().map { String($0.dropLast(5)) })
        var removed = 0
        for name in try NativeSharePayloadDirectory.entries(files) {
            let staged = name.hasPrefix(NativeSharePayloadDirectory.stagingPrefix)
            let id = staged ? String(name.dropFirst(NativeSharePayloadDirectory.stagingPrefix.count)) : name
            guard NativeSharePayloadDirectory.uuid(id), !pending.contains(id), !retained.contains(id) else { continue }
            var info = stat()
            guard fstatat(files, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
            if staged, now.timeIntervalSince1970 - Double(info.st_mtimespec.tv_sec) < age { continue }
            try NativeSharePayloadDirectory.remove(name, in: files); removed += 1
        }
        guard fsync(files) == 0 else { throw NativeShareError.unavailable }; try check()
        return removed
    }
    public func pendingPage(after cursor: String? = nil) throws -> Page {
        if let cursor { guard cursor.hasSuffix(".json"), UUID(uuidString: String(cursor.dropLast(5)))?.uuidString.lowercased() == String(cursor.dropLast(5)) else { throw NativeShareError.invalidInput } }
        try acquire(); defer { _ = flock(lockFD, LOCK_UN) }
        let candidates = try names().filter { cursor == nil || $0 > cursor! }, selected = Array(candidates.prefix(32))
        let items = try selected.map { name -> Item in
            guard let (bytes, witness) = try read(name) else { throw NativeShareError.changedSource }
            let envelope = try NativeShareEnvelope.decode(bytes)
            guard envelope.id + ".json" == name else { throw NativeShareError.invalidInput }
            return Item(envelope: envelope, namespace: namespace, owner: owner, bytes: bytes, witness: witness)
        }
        try check(); return Page(items: items, next: candidates.count > selected.count ? selected.last : nil)
    }
    #if (DEBUG || NATIVE_DEVICE_TEST) && !MINDWTR_SHARE_EXTENSION
    func exportRaw(documents: URL, run: String) throws -> NativeShareMailboxExport.Receipt {
        guard documents.isFileURL, documents.path == documents.standardizedFileURL.path,
              UUID(uuidString: run)?.uuidString.lowercased() == run else { throw NativeShareError.invalidInput }
        try acquire(); defer { _ = flock(lockFD, LOCK_UN) }
        let names = try names()
        guard names.count <= 1024 else { throw NativeShareError.full }
        var sources: [(String, Data, Witness)] = [], total = 0
        for name in names {
            guard let (bytes, witness) = try read(name) else { throw NativeShareError.changedSource }
            let envelope = try NativeShareEnvelope.decode(bytes)
            guard envelope.id + ".json" == name else { throw NativeShareError.invalidInput }
            total += bytes.count
            guard total <= 32 * 1024 * 1024 else { throw NativeShareError.full }
            sources.append((name, bytes, witness))
        }
        let documentFD = open(documents.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard documentFD >= 0 else { throw NativeShareError.unavailable }
        defer { Darwin.close(documentFD) }
        let parentName = "NativeShareMailboxExports"
        guard mkdirat(documentFD, parentName, 0o700) == 0 || errno == EEXIST else { throw NativeShareError.unavailable }
        let parentFD = openat(documentFD, parentName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parentFD >= 0 else { throw NativeShareError.unavailable }
        defer { Darwin.close(parentFD) }
        guard mkdirat(parentFD, run, 0o700) == 0 else { throw NativeShareError.unavailable }
        let outputFD = openat(parentFD, run, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard outputFD >= 0 else { throw NativeShareError.unavailable }
        defer { Darwin.close(outputFD) }
        var records: [[String: Any]] = []
        for (name, bytes, _) in sources {
            var retained: Int32 = -1
            defer { if retained >= 0 { Darwin.close(retained) } }
            try DurableFile.write(bytes, to: name, in: outputFD, retainingFile: &retained, preservingProtectionFrom: directory, exclusive: true)
            records.append(["name": name, "bytes": bytes.count, "sha256": IntakeWire.digest(bytes)])
        }
        guard try self.names() == names else { throw NativeShareError.changedSource }
        for (name, bytes, witness) in sources {
            guard let confirmed = try read(name), confirmed.0 == bytes, confirmed.1 == witness else { throw NativeShareError.changedSource }
        }
        try check()
        let receipt = try JSONSerialization.data(withJSONObject: ["version": 1, "run": run, "namespace": namespace,
            "group": Self.groupIdentifier, "files": records, "count": records.count, "bytes": total,
            "acknowledged": false, "imported": false, "mailboxInitializationMayCreateDirectoriesAndLock": true], options: [.sortedKeys, .withoutEscapingSlashes])
        var retained: Int32 = -1; defer { if retained >= 0 { Darwin.close(retained) } }
        try DurableFile.write(receipt, to: "receipt.json", in: outputFD, retainingFile: &retained, preservingProtectionFrom: directory, exclusive: true)
        for (fd, parent, name) in [(documentFD, Int32(-1), documents.path), (parentFD, documentFD, parentName), (outputFD, parentFD, run)] {
            var held = stat(), named = stat()
            let status = parent < 0 ? lstat(name, &named) : fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW)
            guard fstat(fd, &held) == 0, status == 0, held.st_mode & S_IFMT == S_IFDIR, named.st_mode & S_IFMT == S_IFDIR,
                  Witness(held) == Witness(named) else { throw NativeShareError.changedSource }
        }
        return .init(directory: documents.appendingPathComponent(parentName).appendingPathComponent(run), envelopes: records.count, bytes: total)
    }
    #endif
    public func acknowledge(_ item: Item) throws {
        guard item.owner == owner, item.namespace == namespace else { throw NativeShareError.changedSource }
        try acquire(); defer { _ = flock(lockFD, LOCK_UN) }
        let name = item.envelope.id + ".json"
        if let (bytes, witness) = try read(name) {
            guard bytes == item.bytes, witness == item.witness else { throw NativeShareError.changedSource }
            #if DEBUG && !MINDWTR_SHARE_EXTENSION
            try beforeAcknowledgment?()
            #endif
            guard let confirmed = try read(name), confirmed.0 == item.bytes, confirmed.1 == item.witness else {
                throw NativeShareError.changedSource
            }
            guard unlinkat(directory, name, 0) == 0 else { throw NativeShareError.unavailable }
        }
        guard fsync(directory) == 0 else { throw NativeShareError.unavailable }; try check()
    }
}

enum NativeSharePayloadDirectory {
    static let stagingPrefix = ".staging-"
    static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func stagingName(_ id: String) -> String { stagingPrefix + id }
    static func open(_ parent: Int32, create: Bool) throws -> Int32 {
        if create, mkdirat(parent, "files", 0o700) != 0, errno != EEXIST { throw NativeShareError.unavailable }
        if create { guard fsync(parent) == 0 else { throw NativeShareError.unavailable } }
        return try open(parent, name: "files")
    }
    static func openIfPresent(_ parent: Int32) throws -> Int32? {
        var info = stat()
        if fstatat(parent, "files", &info, AT_SYMLINK_NOFOLLOW) != 0 {
            guard errno == ENOENT else { throw NativeShareError.unavailable }; return nil
        }
        return try open(parent, name: "files")
    }
    static func open(_ parent: Int32, name: String) throws -> Int32 {
        let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeShareError.unavailable }
        return fd
    }
    static func entries(_ directory: Int32) throws -> [String] {
        let copy = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard copy >= 0, let stream = fdopendir(copy) else { if copy >= 0 { Darwin.close(copy) }; throw NativeShareError.unavailable }
        defer { closedir(stream) }
        var names: [String] = []
        while true {
            errno = 0
            guard let entry = readdir(stream) else { guard errno == 0 else { throw NativeShareError.unavailable }; break }
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            names.append(name); guard names.count <= 4096 else { throw NativeShareError.full }
        }
        return names
    }
    static func remove(_ name: String, in parent: Int32) throws {
        var info = stat()
        if fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) != 0 { guard errno == ENOENT else { throw NativeShareError.unavailable }; return }
        guard info.st_mode & S_IFMT == S_IFDIR else { throw NativeShareError.changedSource }
        let directory = try open(parent, name: name); defer { Darwin.close(directory) }
        for child in try entries(directory) {
            var item = stat()
            guard fstatat(directory, child, &item, AT_SYMLINK_NOFOLLOW) == 0, item.st_mode & S_IFMT == S_IFREG,
                  unlinkat(directory, child, 0) == 0 else { throw NativeShareError.unavailable }
        }
        guard unlinkat(parent, name, AT_REMOVEDIR) == 0 else { throw NativeShareError.unavailable }
    }
}

public final class NativeSharePayloadWriter: @unchecked Sendable {
    private let directory: Int32
    private let lock = NSLock()
    fileprivate init(files: Int32, id: String) throws {
        let name = NativeSharePayloadDirectory.stagingName(id)
        guard mkdirat(files, name, 0o700) == 0 || errno == EEXIST else { throw NativeShareError.unavailable }
        directory = try NativeSharePayloadDirectory.open(files, name: name)
        guard fsync(files) == 0 else { Darwin.close(directory); throw NativeShareError.unavailable }
    }
    deinit { Darwin.close(directory) }

    public func copy(from source: URL, id: UUID = UUID(), limit: Int64 = NativeShareEnvelope.File.maximumBytes,
                     checkCancellation: () throws -> Void = {}) throws -> (id: UUID, size: Int64, sha256: String) {
        lock.lock(); defer { lock.unlock() }
        let input = Darwin.open(source.path, O_RDONLY | O_CLOEXEC)
        guard input >= 0 else { throw NativeShareError.invalidInput }
        defer { Darwin.close(input) }
        var info = stat()
        guard fstat(input, &info) == 0, info.st_mode & S_IFMT == S_IFREG else { throw NativeShareError.invalidInput }
        guard info.st_size <= limit else { throw NativeShareError.full }
        let name = id.uuidString.lowercased()
        let output = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard output >= 0 else { throw NativeShareError.unavailable }
        var complete = false
        defer { Darwin.close(output); if !complete { _ = unlinkat(directory, name, 0) } }
        var digest = SHA256(), size: Int64 = 0
        let capacity = 64 * 1024
        let buffer = UnsafeMutableRawPointer.allocate(byteCount: capacity, alignment: 16)
        defer { buffer.deallocate() }
        while true {
            try checkCancellation()
            let count = Darwin.read(input, buffer, capacity)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw NativeShareError.invalidInput }
            if count == 0 { break }
            size += Int64(count); guard size <= limit else { throw NativeShareError.full }
            digest.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: count))
            var offset = 0
            while offset < count {
                let written = Darwin.write(output, buffer.advanced(by: offset), count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw NativeShareError.unavailable }
                offset += written
            }
        }
        guard fsync(output) == 0, fcntl(output, F_FULLFSYNC) == 0, fsync(directory) == 0 else { throw NativeShareError.unavailable }
        complete = true
        return (id, size, digest.finalize().map { String(format: "%02x", $0) }.joined())
    }
}
