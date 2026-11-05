import Darwin
import Foundation

struct IntakeDirectoryIdentity: Codable, Equatable, Sendable {
    let device: UInt64
    let inode: UInt64
    init(_ value: stat) { device = UInt64(truncatingIfNeeded: value.st_dev); inode = UInt64(truncatingIfNeeded: value.st_ino) }
}

struct IntakeFileWitness: Codable, Equatable, Sendable {
    let identity: IntakeDirectoryIdentity
    let mode: UInt32
    let size: Int64
    let modifiedSeconds: Int64
    let modifiedNanoseconds: Int64
    let changedSeconds: Int64
    let changedNanoseconds: Int64
    init(_ value: stat) {
        identity = .init(value); mode = UInt32(value.st_mode); size = Int64(value.st_size)
        modifiedSeconds = Int64(value.st_mtimespec.tv_sec); modifiedNanoseconds = Int64(value.st_mtimespec.tv_nsec)
        changedSeconds = Int64(value.st_ctimespec.tv_sec); changedNanoseconds = Int64(value.st_ctimespec.tv_nsec)
    }
}

final class IntakeFileSnapshot {
    let fd: Int32
    let witness: IntakeFileWitness
    let bytes: Data
    init(fd: Int32, witness: IntakeFileWitness, bytes: Data) { self.fd = fd; self.witness = witness; self.bytes = bytes }
    deinit { Darwin.close(fd) }
}

enum IntakeTarget: Hashable, Sendable {
    case header
    case legacyTerminals
    case record(String)
    case order(Int64)
    var name: String {
        switch self {
        case .header: return "state.json"
        case .legacyTerminals: return "legacy-reminder-terminals.json"
        case let .record(id): return id + ".json"
        case let .order(sequence): return String(format: "%016lld.json", sequence)
        }
    }
    var limit: Int {
        switch self {
        case .header: return IntakeWire.headerLimit
        case .legacyTerminals: return 4 * 1024 * 1024
        case .record, .order: return IntakeWire.recordLimit
        }
    }
}

final class IntakePublicationAttempt {
    let target: IntakeTarget
    let before: IntakeFileSnapshot?
    let bytes: Data
    let exclusive: Bool
    var fd: Int32 = -1
    var witness: IntakeFileWitness?
    init(target: IntakeTarget, before: IntakeFileSnapshot?, bytes: Data, exclusive: Bool) {
        self.target = target; self.before = before; self.bytes = bytes; self.exclusive = exclusive
    }
    func release() { if fd >= 0 { Darwin.close(fd); fd = -1 }; witness = nil }
    deinit { release() }
}

final class IntakeImportAcknowledgement: @unchecked Sendable {
    struct Artifact: Sendable {
        let target: IntakeTarget
        let witness: IntakeFileWitness
        let digest: String
    }
    private enum State: Equatable { case pending, confirmed, rejected }
    private let lock = NSLock()
    private var state = State.pending
    private var files: NativePersonalIntakeFiles?
    private let artifacts: [Artifact]
    fileprivate init(files: NativePersonalIntakeFiles, artifacts: [Artifact]) {
        self.files = files; self.artifacts = artifacts
    }
    var isPending: Bool { lock.lock(); defer { lock.unlock() }; return state == .pending }
    var isConfirmed: Bool { lock.lock(); defer { lock.unlock() }; return state == .confirmed }

    func confirm(_ confirmOriginal: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard state == .pending, let files else { throw NativePersonalIntakeError.unavailable }
        do {
            try files.validateImportAcknowledgement(artifacts)
            try confirmOriginal()
            state = .confirmed; self.files = nil
        } catch {
            state = .rejected; self.files = nil
            throw error
        }
    }
    func invalidateBeforeClose(_ closeDestination: () -> Void) {
        lock.lock(); defer { lock.unlock() }
        state = .rejected; files = nil
        closeDestination()
    }
}

final class NativePersonalIntakeFiles {
    private struct Directory { let name: String; let fd: Int32; let identity: IntakeDirectoryIdentity }
    let route: NativePersonalIntakeRoute
    private(set) var created = false
    private var directories: [Directory] = []
    private var recordsFD: Int32 = -1
    private var orderFD: Int32 = -1
    private var recordsIdentity: IntakeDirectoryIdentity?
    private var orderIdentity: IntakeDirectoryIdentity?
    private var lockFD: Int32 = -1
    private var lockWitness: IntakeFileWitness?
    private var leased = false
    private var closed = false
    private var poisoned = false
    private(set) var headerSnapshot: IntakeFileSnapshot?
    private(set) var attempt: IntakePublicationAttempt?
    private var hotArtifacts: [IntakeTarget: IntakeFileWitness] = [:]
    #if DEBUG
    var beforePublication: ((String) throws -> Void)?
    var afterPublication: ((String) throws -> Void)?
    var retainedArtifactCount: Int { hotArtifacts.count }
    #endif

    static func hasExistingRoot(route: NativePersonalIntakeRoute) throws -> Bool {
        var chain: [Directory] = []
        defer { for directory in chain.reversed() { Darwin.close(directory.fd) } }
        let home = Darwin.open(route.home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard home >= 0 else { throw NativePersonalIntakeError.unavailable }
        do { chain.append(.init(name: "", fd: home, identity: .init(try directoryStat(home)))) }
        catch { Darwin.close(home); throw error }
        func verify() throws {
            let current = Darwin.open(route.home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard current >= 0 else { throw NativePersonalIntakeError.unavailable }
            defer { Darwin.close(current) }
            guard IntakeDirectoryIdentity(try directoryStat(current)) == chain[0].identity else { throw NativePersonalIntakeError.unavailable }
            for index in chain.indices {
                guard IntakeDirectoryIdentity(try directoryStat(chain[index].fd)) == chain[index].identity else { throw NativePersonalIntakeError.unavailable }
                if index > 0 {
                    var named = stat()
                    guard fstatat(chain[index - 1].fd, chain[index].name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                          named.st_mode & S_IFMT == S_IFDIR, IntakeDirectoryIdentity(named) == chain[index].identity else { throw NativePersonalIntakeError.unavailable }
                }
            }
        }
        for name in route.components {
            let parent = chain.last!.fd
            let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if fd < 0 {
                var named = stat()
                guard errno == ENOENT, fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0,
                      errno == ENOENT else { throw NativePersonalIntakeError.unavailable }
                try verify(); return false
            }
            do { chain.append(.init(name: name, fd: fd, identity: .init(try directoryStat(fd)))) }
            catch { Darwin.close(fd); throw error }
        }
        try verify(); return true
    }

    init(route: NativePersonalIntakeRoute, requireExisting: Bool = false) throws {
        self.route = route
        var madeRoot = false
        do {
            let fd = Darwin.open(route.home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard fd >= 0 else { throw NativePersonalIntakeError.unavailable }
            do { directories.append(.init(name: "", fd: fd, identity: .init(try Self.directoryStat(fd)))) }
            catch { Darwin.close(fd); throw error }
            for (index, name) in route.components.enumerated() {
                let made = try appendDirectory(name, creating: !requireExisting)
                if index == route.components.count - 1 { madeRoot = made }
            }
            created = madeRoot
            let root = try rootFD()
            if madeRoot {
                guard mkdirat(root, "records", 0o700) == 0, mkdirat(root, "order", 0o700) == 0,
                      fsync(root) == 0 else { throw NativePersonalIntakeError.unavailable }
            }
            recordsFD = openat(root, "records", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            orderFD = openat(root, "order", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            guard recordsFD >= 0, orderFD >= 0 else { throw NativePersonalIntakeError.unavailable }
            recordsIdentity = .init(try Self.directoryStat(recordsFD)); orderIdentity = .init(try Self.directoryStat(orderFD))
            let flags = O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (madeRoot ? O_CREAT | O_EXCL : 0)
            lockFD = openat(root, ".lock", flags, 0o600)
            guard lockFD >= 0 else { throw NativePersonalIntakeError.unavailable }
            lockWitness = try Self.fileWitness(lockFD)
            guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw NativePersonalIntakeError.unavailable }
            leased = true
            try verifyNamespace()
            guard fsync(root) == 0 else { throw NativePersonalIntakeError.unavailable }
            headerSnapshot = try read(.header)
            guard madeRoot ? headerSnapshot == nil : headerSnapshot != nil else { throw NativePersonalIntakeError.unavailable }
            if let snapshot = headerSnapshot { try synchronize(snapshot, target: .header) }
        } catch {
            close(); throw NativePersonalIntakeError.unavailable
        }
    }
    deinit { close() }
    var rootIdentity: IntakeDirectoryIdentity { get throws { .init(try Self.directoryStat(rootFD())) } }
    var recordDirectoryIdentity: IntakeDirectoryIdentity { get throws { .init(try Self.directoryStat(recordsFD)) } }
    var orderDirectoryIdentity: IntakeDirectoryIdentity { get throws { .init(try Self.directoryStat(orderFD)) } }
    var leaseWitness: IntakeFileWitness {
        get throws { guard let lockWitness else { throw NativePersonalIntakeError.unavailable }; return lockWitness }
    }
    func refuse() { poisoned = true }
    func close() {
        guard !closed else { return }; closed = true
        attempt = nil; headerSnapshot = nil; hotArtifacts.removeAll()
        if lockFD >= 0 { if leased { _ = flock(lockFD, LOCK_UN) }; Darwin.close(lockFD); lockFD = -1 }
        if recordsFD >= 0 { Darwin.close(recordsFD); recordsFD = -1 }
        if orderFD >= 0 { Darwin.close(orderFD); orderFD = -1 }
        for directory in directories.reversed() { Darwin.close(directory.fd) }; directories.removeAll()
    }
    func check() throws {
        guard !closed, !poisoned else { throw NativePersonalIntakeError.unavailable }
        guard attempt == nil else { throw NativePersonalIntakeError.pendingPublication }
        do {
            try verifyNamespace()
            guard Self.matches(try read(.header), headerSnapshot) else { throw NativePersonalIntakeError.unavailable }
        } catch { poisoned = true; throw NativePersonalIntakeError.unavailable }
    }
    func read(_ target: IntakeTarget) throws -> IntakeFileSnapshot? {
        try verifyNamespace()
        let directory = try directoryFD(target)
        let fd = openat(directory, target.name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            guard errno == ENOENT else { throw NativePersonalIntakeError.unavailable }
            var named = stat()
            guard fstatat(directory, target.name, &named, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
                throw NativePersonalIntakeError.unavailable
            }
            try verifyNamespace(); return nil
        }
        do {
            let initial = try Self.fileWitness(fd)
            guard initial.size >= 0, initial.size <= Int64(target.limit) else { throw NativePersonalIntakeError.unavailable }
            var bytes = Data(), buffer = [UInt8](repeating: 0, count: 16 * 1024)
            while true {
                let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
                if count < 0 && errno == EINTR { continue }
                guard count >= 0, count <= Int(initial.size) - bytes.count else { throw NativePersonalIntakeError.unavailable }
                if count == 0 { break }; bytes.append(contentsOf: buffer.prefix(count))
            }
            var named = stat()
            guard bytes.count == Int(initial.size), try Self.fileWitness(fd) == initial,
                  fstatat(directory, target.name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                  try Self.validFile(named), IntakeFileWitness(named) == initial else { throw NativePersonalIntakeError.unavailable }
            try verifyNamespace(); return .init(fd: fd, witness: initial, bytes: bytes)
        } catch { Darwin.close(fd); throw NativePersonalIntakeError.unavailable }
    }
    func publish(_ bytes: Data, to target: IntakeTarget, before: IntakeFileSnapshot?, exclusive: Bool) throws -> IntakeFileSnapshot {
        try check()
        guard bytes.count <= target.limit else { throw NativePersonalIntakeError.unavailable }
        let pending = IntakePublicationAttempt(target: target, before: before, bytes: bytes, exclusive: exclusive)
        attempt = pending
        return try perform(pending)
    }
    @discardableResult
    func retryPublication() throws -> IntakeFileSnapshot? {
        guard !closed, !poisoned else { throw NativePersonalIntakeError.unavailable }
        guard let pending = attempt else { try check(); return nil }
        let current: IntakeFileSnapshot?
        do { try verifyNamespace(); current = try read(pending.target) }
        catch { poisoned = true; throw NativePersonalIntakeError.unavailable }
        if Self.matches(current, pending.before) { return try perform(pending) }
        guard let current, let witness = pending.witness, pending.fd >= 0,
              current.bytes == pending.bytes, current.witness == witness,
              try Self.fileWitness(pending.fd) == witness else {
            poisoned = true; throw NativePersonalIntakeError.unavailable
        }
        #if DEBUG
        try afterPublication?(pending.target.name)
        #endif
        try synchronize(current, target: pending.target); try accept(current, target: pending.target); attempt = nil
        return current
    }
    func checkPendingPublication(_ pending: IntakePublicationAttempt, header: IntakeFileSnapshot) throws {
        guard !closed, !poisoned, attempt === pending, pending.target != .header,
              headerSnapshot === header else { throw NativePersonalIntakeError.unavailable }
        try validateSnapshot(header, target: .header)
    }
    func validateSnapshot(_ snapshot: IntakeFileSnapshot, target: IntakeTarget) throws {
        do {
            try verifyNamespace()
            guard try Self.fileWitness(snapshot.fd) == snapshot.witness,
                  Self.matches(try read(target), snapshot) else { throw NativePersonalIntakeError.unavailable }
        } catch { poisoned = true; throw NativePersonalIntakeError.unavailable }
    }
    func ensureArtifact(_ bytes: Data, target: IntakeTarget, witness: IntakeFileWitness?) throws -> IntakeFileWitness {
        try check()
        if let current = try read(target) {
            guard let expected = witness ?? hotArtifacts[target] else { throw NativePersonalIntakeError.ambiguousPublication }
            guard current.witness == expected, current.bytes == bytes else { throw NativePersonalIntakeError.unavailable }
            try synchronize(current, target: target); return current.witness
        }
        guard witness == nil, hotArtifacts[target] == nil else { throw NativePersonalIntakeError.unavailable }
        return try publish(bytes, to: target, before: nil, exclusive: true).witness
    }
    func settleImportedHotArtifacts(_ artifacts: [IntakeImportAcknowledgement.Artifact]) throws {
        guard !hotArtifacts.isEmpty else { return }
        do {
            try check()
            for (target, witness) in hotArtifacts {
                guard let artifact = artifacts.first(where: { $0.target == target }), artifact.witness == witness,
                      let current = try read(target), current.witness == witness,
                      IntakeWire.digest(current.bytes) == artifact.digest else { throw NativePersonalIntakeError.unavailable }
            }
            try check()
            clearHotArtifacts()
        } catch { refuse(); throw NativePersonalIntakeError.unavailable }
    }
    func retainImportAcknowledgement(_ artifacts: [IntakeImportAcknowledgement.Artifact]) throws -> IntakeImportAcknowledgement {
        guard hotArtifacts.isEmpty, (1...257).contains(artifacts.count), Set(artifacts.map(\.target)).count == artifacts.count,
              artifacts.contains(where: { $0.target == .legacyTerminals }),
              artifacts.allSatisfy({ $0.target != .header }) else { throw NativePersonalIntakeError.unavailable }
        try validateImportAcknowledgement(artifacts)
        return .init(files: self, artifacts: artifacts)
    }
    fileprivate func validateImportAcknowledgement(_ artifacts: [IntakeImportAcknowledgement.Artifact]) throws {
        do {
            try check()
            for artifact in artifacts {
                guard let current = try read(artifact.target), current.witness == artifact.witness,
                      IntakeWire.digest(current.bytes) == artifact.digest else { throw NativePersonalIntakeError.unavailable }
            }
            try check()
        } catch { refuse(); throw NativePersonalIntakeError.unavailable }
    }
    func clearHotArtifacts() { hotArtifacts.removeAll() }
    func clearHotArtifact(_ target: IntakeTarget) { hotArtifacts.removeValue(forKey: target) }
    private func accept(_ file: IntakeFileSnapshot, target: IntakeTarget) throws {
        if target == .header { headerSnapshot = file }
        else {
            guard hotArtifacts[target] != nil || hotArtifacts.count < 2 else {
                poisoned = true; throw NativePersonalIntakeError.unavailable
            }
            hotArtifacts[target] = file.witness
        }
    }
    private func perform(_ pending: IntakePublicationAttempt) throws -> IntakeFileSnapshot {
        try verifyNamespace()
        guard Self.matches(try read(pending.target), pending.before) else { poisoned = true; throw NativePersonalIntakeError.unavailable }
        #if DEBUG
        try beforePublication?(pending.target.name)
        #endif
        try verifyNamespace()
        guard Self.matches(try read(pending.target), pending.before) else { poisoned = true; throw NativePersonalIntakeError.unavailable }
        pending.release()
        do {
            try DurableFile.write(pending.bytes, to: pending.target.name, in: directoryFD(pending.target), retainingFile: &pending.fd,
                                  preservingProtectionFrom: pending.before?.fd ?? lockFD, exclusive: pending.exclusive)
        } catch {
            if pending.fd >= 0 { pending.witness = try? Self.fileWitness(pending.fd) }
            throw NativePersonalIntakeError.pendingPublication
        }
        pending.witness = try Self.fileWitness(pending.fd)
        #if DEBUG
        try afterPublication?(pending.target.name)
        #endif
        guard let current = try read(pending.target), current.bytes == pending.bytes, current.witness == pending.witness else {
            poisoned = true; throw NativePersonalIntakeError.unavailable
        }
        try synchronize(current, target: pending.target); try accept(current, target: pending.target); attempt = nil
        return current
    }
    private func synchronize(_ file: IntakeFileSnapshot, target: IntakeTarget) throws {
        try verifyNamespace()
        guard Self.matches(try read(target), file), fsync(file.fd) == 0, fcntl(file.fd, F_FULLFSYNC) == 0,
              fsync(try directoryFD(target)) == 0, Self.matches(try read(target), file) else {
            throw NativePersonalIntakeError.unavailable
        }
        try verifyNamespace()
    }
    private func appendDirectory(_ name: String, creating: Bool = true) throws -> Bool {
        guard let parent = directories.last else { throw NativePersonalIntakeError.unavailable }
        let made: Bool
        if creating {
            made = mkdirat(parent.fd, name, 0o700) == 0
            guard made || errno == EEXIST else { throw NativePersonalIntakeError.unavailable }
            if made { guard fsync(parent.fd) == 0 else { throw NativePersonalIntakeError.unavailable } }
        } else { made = false }
        let fd = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativePersonalIntakeError.unavailable }
        do { directories.append(.init(name: name, fd: fd, identity: .init(try Self.directoryStat(fd)))) }
        catch { Darwin.close(fd); throw error }; return made
    }
    private func rootFD() throws -> Int32 {
        guard let root = directories.last else { throw NativePersonalIntakeError.unavailable }; return root.fd
    }
    private func directoryFD(_ target: IntakeTarget) throws -> Int32 {
        switch target { case .header, .legacyTerminals: return try rootFD(); case .record: return recordsFD; case .order: return orderFD }
    }
    private func verifyNamespace() throws {
        guard !closed, !poisoned, let home = directories.first, let lockWitness,
              let recordsIdentity, let orderIdentity else { throw NativePersonalIntakeError.unavailable }
        let fd = Darwin.open(route.home.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { poisoned = true; throw NativePersonalIntakeError.unavailable }; defer { Darwin.close(fd) }
        do {
            guard IntakeDirectoryIdentity(try Self.directoryStat(fd)) == home.identity else { throw NativePersonalIntakeError.unavailable }
            for index in directories.indices {
                let directory = directories[index]
                guard IntakeDirectoryIdentity(try Self.directoryStat(directory.fd)) == directory.identity else {
                    throw NativePersonalIntakeError.unavailable
                }
                if index > 0 { try verifyDirectory(directory.name, parent: directories[index - 1].fd, fd: directory.fd, expected: directory.identity) }
            }
            let root = try rootFD()
            try verifyDirectory("records", parent: root, fd: recordsFD, expected: recordsIdentity)
            try verifyDirectory("order", parent: root, fd: orderFD, expected: orderIdentity)
            var named = stat()
            guard fstatat(root, ".lock", &named, AT_SYMLINK_NOFOLLOW) == 0, try Self.validFile(named),
                  IntakeFileWitness(named) == lockWitness, try Self.fileWitness(lockFD) == lockWitness else {
                throw NativePersonalIntakeError.unavailable
            }
        } catch { poisoned = true; throw NativePersonalIntakeError.unavailable }
    }
    private func verifyDirectory(_ name: String, parent: Int32, fd: Int32, expected: IntakeDirectoryIdentity) throws {
        var named = stat()
        guard fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0, named.st_mode & S_IFMT == S_IFDIR,
              IntakeDirectoryIdentity(named) == expected, IntakeDirectoryIdentity(try Self.directoryStat(fd)) == expected else {
            throw NativePersonalIntakeError.unavailable
        }
    }
    private static func directoryStat(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & S_IFMT == S_IFDIR, value.st_uid == getuid() else {
            throw NativePersonalIntakeError.unavailable
        }; return value
    }
    private static func validFile(_ value: stat) throws -> Bool {
        guard value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1, value.st_uid == getuid(),
              value.st_mode & 0o777 == 0o600 else { throw NativePersonalIntakeError.unavailable }; return true
    }
    private static func fileWitness(_ fd: Int32) throws -> IntakeFileWitness {
        var value = stat(); guard fstat(fd, &value) == 0, try validFile(value) else { throw NativePersonalIntakeError.unavailable }
        return .init(value)
    }
    private static func matches(_ a: IntakeFileSnapshot?, _ b: IntakeFileSnapshot?) -> Bool {
        switch (a, b) { case (nil, nil): return true; case let (a?, b?): return a.witness == b.witness && a.bytes == b.bytes; default: return false }
    }
}
