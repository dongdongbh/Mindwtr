import CoreFoundation
import CryptoKit
import Foundation
import Darwin

public struct NativeWidgetPendingAction: Sendable {
    public let id: String
    public let identifier: String
    public let token: String
    public let createdAt: Double
    public let notBefore: Double
    public var claimed: Bool
}

public struct NativeWidgetActionIdentity: Sendable {
    public let identifier: String
    public let token: String?
    public init(identifier: String, token: String?) { self.identifier = identifier; self.token = token }
}

/// RN's read-only grace overlay. Undo cancels queued work; it never reopens a saved Task.
public enum NativeWidgetActionProjection {
    public static func pendingAction(for identity: NativeWidgetActionIdentity,
                                     in actions: [NativeWidgetPendingAction], at date: Date) -> NativeWidgetPendingAction? {
        guard let token = identity.token else { return nil }
        let now = date.timeIntervalSince1970 * 1_000
        return actions.last { Data($0.identifier.utf8) == Data(identity.identifier.utf8)
            && Data($0.token.utf8) == Data(token.utf8) && !$0.claimed && now < $0.notBefore }
    }

    public static func isHidden(_ identity: NativeWidgetActionIdentity,
                                by actions: [NativeWidgetPendingAction], at date: Date) -> Bool {
        guard let token = identity.token else { return false }
        let now = date.timeIntervalSince1970 * 1_000
        return actions.contains { Data($0.identifier.utf8) == Data(identity.identifier.utf8)
            && Data($0.token.utf8) == Data(token.utf8) && ($0.claimed || now >= $0.notBefore) }
    }

    public static func timelineDates(pendingActions: [NativeWidgetPendingAction], now: Date) -> [Date] {
        let clock = now.timeIntervalSince1970 * 1_000
        let future = Set(pendingActions.compactMap { !$0.claimed && $0.notBefore > clock ? $0.notBefore : nil })
        return [now] + future.sorted().map { Date(timeIntervalSince1970: $0 / 1_000) }
    }
}

public enum NativeWidgetActionStoreError: Error, LocalizedError, Equatable {
    case unavailable, invalidValue, capacityFull, unclaimedAcknowledgement, corruptState
    case fileOperation(String, Int32)
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "The native widget action store is unavailable."
        case .invalidValue: return "The native widget action is invalid."
        case .capacityFull: return "The native widget action queue is full."
        case .unclaimedAcknowledgement: return "A widget action must be claimed before acknowledgement."
        case .corruptState: return "The native widget action queue is invalid."
        case let .fileOperation(operation, code): return "The native widget action queue could not \(operation) (errno \(code))."
        }
    }
}

private struct ConsumedWidgetAction {
    let identifier: String, token: String
    let consumedAt: Double
}
private struct WidgetOperationIdentity: Hashable {
    let identifier: Data, token: Data
    init(_ identifier: String, _ token: String) { self.identifier = Data(identifier.utf8); self.token = Data(token.utf8) }
}
private struct WidgetActionState {
    var pending: [NativeWidgetPendingAction] = []
    var receipts: [ConsumedWidgetAction] = []
}

/// Concrete dev-only port of RN's locked, synced widget outbox. The App remains the only Task writer.
public final class NativeWidgetActionStore: @unchecked Sendable {
    public static let namespace = "tech.dongdongbh.mindwtr.native.dev"
    public static let group = "group." + namespace
    public static let minimumUndoDelayMilliseconds = 3_000.0
    public static let maximumPendingActions = 256
    public static let maximumConsumedReceipts = 512
    private static let maximumBytes = 16 * 1_024 * 1_024
    private static let maximumTime = 8_640_000_000_000_000.0
    private static let scope = SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
    private static let processLock = NSLock()
    static let stateFileName = "actions-v1.json"
    static let lockFileName = ".actions.lock"
    private let directory: URL
    #if DEBUG && !MINDWTR_WIDGET_EXTENSION
    var beforePromotion: (() throws -> Void)?
    var afterPromotion: (() throws -> Void)?
    #endif

    public static func live() throws -> NativeWidgetActionStore {
        #if os(iOS)
        guard [namespace, namespace + ".capture-widget"].contains(Bundle.main.bundleIdentifier ?? ""),
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw NativeWidgetActionStoreError.unavailable
        }
        return NativeWidgetActionStore(directory: root.appendingPathComponent("NativeWidgets/Actions", isDirectory: true))
        #else
        throw NativeWidgetActionStoreError.unavailable
        #endif
    }

    /// Explicit private directory only; production resolves the fixed dev group above.
    init(directory: URL) { self.directory = directory }

    public func pendingActions() throws -> [NativeWidgetPendingAction] {
        try withLockedState { ($0.pending, false) }
    }

    public func enqueue(identifier: String, token: String, now: Date = Date()) throws {
        guard Self.validOperation(identifier, token) else { throw NativeWidgetActionStoreError.invalidValue }
        let createdAt = try Self.milliseconds(now)
        guard createdAt + Self.minimumUndoDelayMilliseconds <= Self.maximumTime else { throw NativeWidgetActionStoreError.invalidValue }
        let identity = WidgetOperationIdentity(identifier, token)
        try withLockedState { state in
            if state.pending.contains(where: { WidgetOperationIdentity($0.identifier, $0.token) == identity })
                || state.receipts.contains(where: { WidgetOperationIdentity($0.identifier, $0.token) == identity }) { return ((), false) }
            guard state.pending.count < Self.maximumPendingActions else { throw NativeWidgetActionStoreError.capacityFull }
            state.pending.append(NativeWidgetPendingAction(id: UUID().uuidString.lowercased(), identifier: identifier, token: token,
                createdAt: createdAt, notBefore: createdAt + Self.minimumUndoDelayMilliseconds, claimed: false))
            return ((), true)
        }
    }

    public func cancel(id: String) throws -> Bool { try cancelLocked(id: id, now: nil) }
    func cancel(id: String, now: Date) throws -> Bool { try cancelLocked(id: id, now: now) }
    private func cancelLocked(id: String, now: Date?) throws -> Bool {
        guard Self.validUUID(id) else { throw NativeWidgetActionStoreError.invalidValue }
        return try withLockedState { state in
            // Resolve the production clock after the cross-process lock: waiting cannot extend Undo.
            let clock = try Self.milliseconds(now ?? Date())
            guard let index = state.pending.firstIndex(where: { $0.id == id }), !state.pending[index].claimed,
                  clock < state.pending[index].notBefore else { return (false, false) }
            state.pending.remove(at: index); return (true, true)
        }
    }

    public func claimReady(now: Date = Date()) throws -> [NativeWidgetPendingAction] {
        let clock = try Self.milliseconds(now)
        return try withLockedState { state in
            var changed = false
            for index in state.pending.indices where !state.pending[index].claimed && state.pending[index].notBefore <= clock {
                state.pending[index].claimed = true; changed = true
            }
            return (state.pending.filter(\.claimed), changed)
        }
    }

    public func acknowledge(id: String) throws {
        guard Self.validUUID(id) else { throw NativeWidgetActionStoreError.invalidValue }
        try withLockedState { state in
            guard let index = state.pending.firstIndex(where: { $0.id == id }) else { return ((), false) }
            guard state.pending[index].claimed else { throw NativeWidgetActionStoreError.unclaimedAcknowledgement }
            let action = state.pending.remove(at: index)
            state.receipts.append(ConsumedWidgetAction(identifier: action.identifier, token: action.token,
                                                       consumedAt: try Self.milliseconds(Date())))
            if state.receipts.count > Self.maximumConsumedReceipts { state.receipts.removeFirst(state.receipts.count - Self.maximumConsumedReceipts) }
            return ((), true)
        }
    }

    public func nextReadyAt() throws -> Double? {
        try withLockedState { ($0.pending.lazy.filter { !$0.claimed }.map(\.notBefore).min(), false) }
    }

    private static func validUUID(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    private static func number(_ value: Any?, integer: Bool = false) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= maximumTime,
              !integer || n.doubleValue.rounded() == n.doubleValue else { return nil }
        return n.doubleValue
    }
    private static func milliseconds(_ date: Date) throws -> Double {
        let value = date.timeIntervalSince1970 * 1_000
        guard value.isFinite, value >= 0, value <= maximumTime else { throw NativeWidgetActionStoreError.invalidValue }
        return value
    }
    static func validOperation(_ identifier: String, _ token: String) -> Bool {
        guard identifier.utf8.count <= 4_096, identifier.hasPrefix(scope + "."),
              let id = NativeWidgetTaskLink.decodedTaskID(identifier), token.utf8.count <= 8_192,
              let values = try? NativeJSON.jsonObject(with: Data(token.utf8)) as? [Any], values.count == 4,
              let rawID = values[0] as? String, Data(rawID.utf8) == Data(id.utf8),
              let revision = values[1] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID(),
              revision.doubleValue.isFinite, revision.doubleValue >= 0, revision.doubleValue <= 9_007_199_254_740_991,
              revision.doubleValue.rounded() == revision.doubleValue,
              let updated = values[2] as? String, !updated.isEmpty,
              let status = values[3] as? String,
              ["inbox", "next", "waiting", "someday", "reference", "done", "archived"].contains(status) else { return false }
        return true
    }

    private func decode(_ data: Data) throws -> WidgetActionState {
        guard data.count <= Self.maximumBytes, let json = String(data: data, encoding: .utf8),
              (try? NativeJSON.hasUniqueObjectKeys(json)) == true,
              let root = try NativeJSON.jsonObject(with: data) as? [String: Any],
              Set(root.keys) == ["version", "namespace", "pending", "receipts"], Self.number(root["version"], integer: true) == 1,
              root["namespace"] as? String == Self.namespace,
              let pending = root["pending"] as? [[String: Any]], pending.count <= Self.maximumPendingActions,
              let receipts = root["receipts"] as? [[String: Any]], receipts.count <= Self.maximumConsumedReceipts else {
            throw NativeWidgetActionStoreError.corruptState
        }
        var state = WidgetActionState(), ids = Set<Data>(), operations = Set<WidgetOperationIdentity>()
        for value in pending {
            guard Set(value.keys) == ["id", "identifier", "token", "createdAt", "notBefore", "claimed"],
                  let id = value["id"] as? String, Self.validUUID(id), ids.insert(Data(id.utf8)).inserted,
                  let identifier = value["identifier"] as? String, let token = value["token"] as? String,
                  Self.validOperation(identifier, token), operations.insert(WidgetOperationIdentity(identifier, token)).inserted,
                  let createdAt = Self.number(value["createdAt"]), let notBefore = Self.number(value["notBefore"]),
                  notBefore == createdAt + Self.minimumUndoDelayMilliseconds,
                  let claimed = value["claimed"] as? NSNumber, CFGetTypeID(claimed) == CFBooleanGetTypeID() else {
                throw NativeWidgetActionStoreError.corruptState
            }
            state.pending.append(NativeWidgetPendingAction(id: id, identifier: identifier, token: token,
                createdAt: createdAt, notBefore: notBefore, claimed: claimed.boolValue))
        }
        var consumed = Set<WidgetOperationIdentity>()
        for value in receipts {
            guard Set(value.keys) == ["identifier", "token", "consumedAt"],
                  let identifier = value["identifier"] as? String, let token = value["token"] as? String,
                  Self.validOperation(identifier, token), let at = Self.number(value["consumedAt"]),
                  consumed.insert(WidgetOperationIdentity(identifier, token)).inserted,
                  !operations.contains(WidgetOperationIdentity(identifier, token)) else { throw NativeWidgetActionStoreError.corruptState }
            state.receipts.append(ConsumedWidgetAction(identifier: identifier, token: token, consumedAt: at))
        }
        return state
    }

    private func withLockedState<T>(_ body: (inout WidgetActionState) throws -> (T, Bool)) throws -> T {
        Self.processLock.lock(); defer { Self.processLock.unlock() }
        let directoryFD = try openDirectory(); defer { Darwin.close(directoryFD) }
        let lock = openat(directoryFD, Self.lockFileName, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw failure("open its lock") }; defer { Darwin.close(lock) }
        var lockInfo = stat()
        guard fstat(lock, &lockInfo) == 0, Self.regular(lockInfo) else { throw NativeWidgetActionStoreError.unavailable }
        guard fchmod(lock, 0o600) == 0 else { throw failure("protect its lock") }
        while flock(lock, LOCK_EX) != 0 { if errno != EINTR { throw failure("acquire its lock") } }
        defer { _ = flock(lock, LOCK_UN) }
        try check(directoryFD, lock: lock)
        var state = try readState(directoryFD)
        let (result, changed) = try body(&state)
        if changed { try writeState(state, directoryFD: directoryFD, lock: lock) }
        // Also settles a prior uncertain promotion when an exact retry is a deduplicated no-op.
        guard fsync(directoryFD) == 0 else { throw failure("synchronize its directory") }
        try check(directoryFD, lock: lock)
        return result
    }

    private func openDirectory() throws -> Int32 {
        guard directory.isFileURL, directory.path.hasPrefix("/"), !directory.pathComponents.contains("..") else {
            throw NativeWidgetActionStoreError.unavailable
        }
        var descriptor = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw failure("open its directory") }
        do {
            for component in directory.pathComponents.dropFirst() {
                var next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                if next < 0, errno == ENOENT {
                    if mkdirat(descriptor, component, 0o700) != 0 && errno != EEXIST { throw failure("create its directory") }
                    next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                    guard next >= 0 else { throw failure("open its directory") }
                    guard fsync(descriptor) == 0 else { Darwin.close(next); throw failure("synchronize its parent") }
                }
                guard next >= 0 else { throw failure("open its directory") }
                Darwin.close(descriptor); descriptor = next
            }
            guard fchmod(descriptor, 0o700) == 0 else { throw failure("protect its directory") }
            var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
            var url = directory; try url.setResourceValues(excluded)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
            #if !targetEnvironment(simulator)
            guard fcntl(descriptor, F_SETPROTECTIONCLASS, 3) == 0, fcntl(descriptor, F_GETPROTECTIONCLASS) == 3 else {
                throw failure("protect its directory")
            }
            #endif
            #endif
            return descriptor
        } catch { Darwin.close(descriptor); throw error }
    }

    private func check(_ directoryFD: Int32, lock: Int32) throws {
        var held = stat(), named = stat(), lockHeld = stat(), lockNamed = stat()
        guard fstat(directoryFD, &held) == 0, lstat(directory.path, &named) == 0,
              held.st_mode & S_IFMT == S_IFDIR, named.st_mode & S_IFMT == S_IFDIR,
              held.st_dev == named.st_dev, held.st_ino == named.st_ino,
              fstat(lock, &lockHeld) == 0, fstatat(directoryFD, Self.lockFileName, &lockNamed, AT_SYMLINK_NOFOLLOW) == 0,
              Self.regular(lockHeld), Self.regular(lockNamed), lockHeld.st_dev == lockNamed.st_dev,
              lockHeld.st_ino == lockNamed.st_ino else { throw NativeWidgetActionStoreError.unavailable }
    }
    private static func regular(_ value: stat) -> Bool { value.st_mode & S_IFMT == S_IFREG && value.st_nlink == 1 }
    private func failure(_ operation: String) -> NativeWidgetActionStoreError { .fileOperation(operation, errno) }

    private func readState(_ directoryFD: Int32) throws -> WidgetActionState {
        let descriptor = openat(directoryFD, Self.stateFileName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 {
            if errno == ENOENT { return WidgetActionState() }
            throw failure("read its state")
        }
        defer { Darwin.close(descriptor) }
        var before = stat(), after = stat(), named = stat()
        guard fstat(descriptor, &before) == 0, Self.regular(before), before.st_size > 0,
              before.st_size <= Self.maximumBytes else { throw NativeWidgetActionStoreError.corruptState }
        guard fchmod(descriptor, 0o600) == 0 else { throw failure("protect its state") }
        var data = Data(count: Int(before.st_size))
        try data.withUnsafeMutableBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let read = Darwin.read(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if read < 0 && errno == EINTR { continue }
                guard read > 0 else { throw NativeWidgetActionStoreError.corruptState }; offset += read
            }
        }
        guard fstat(descriptor, &after) == 0, fstatat(directoryFD, Self.stateFileName, &named, AT_SYMLINK_NOFOLLOW) == 0,
              Self.regular(after), Self.regular(named), before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size, after.st_dev == named.st_dev, after.st_ino == named.st_ino,
              after.st_size == named.st_size else { throw NativeWidgetActionStoreError.corruptState }
        return try decode(data)
    }

    private func writeState(_ state: WidgetActionState, directoryFD: Int32, lock: Int32) throws {
        let pending: [[String: Any]] = state.pending.map { ["id": $0.id, "identifier": $0.identifier, "token": $0.token,
            "createdAt": $0.createdAt, "notBefore": $0.notBefore, "claimed": $0.claimed] }
        let receipts: [[String: Any]] = state.receipts.map { ["identifier": $0.identifier, "token": $0.token, "consumedAt": $0.consumedAt] }
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "namespace": Self.namespace,
            "pending": pending, "receipts": receipts], options: [.sortedKeys])
        _ = try decode(bytes)
        let temporary = ".actions-" + UUID().uuidString.lowercased() + ".tmp"
        let descriptor = openat(directoryFD, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw failure("create its temporary state") }
        defer { Darwin.close(descriptor); _ = unlinkat(directoryFD, temporary, 0) }
        guard fchmod(descriptor, 0o600) == 0 else { throw failure("protect its temporary state") }
        // Simulator protection-class fcntls fail with EINVAL; physical iOS must verify them.
        #if os(iOS) && !targetEnvironment(simulator)
        let protection = fcntl(directoryFD, F_GETPROTECTIONCLASS)
        guard protection == 3, fcntl(descriptor, F_SETPROTECTIONCLASS, protection) == 0,
              fcntl(descriptor, F_GETPROTECTIONCLASS) == protection else { throw failure("protect its temporary state") }
        guard fcntl(directoryFD, F_GETPROTECTIONCLASS) == 3 else { throw failure("protect its temporary state") }
        #endif
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let written = Darwin.write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw failure("write its temporary state") }; offset += written
            }
        }
        guard fsync(descriptor) == 0, fcntl(descriptor, F_FULLFSYNC) == 0 else { throw failure("synchronize its temporary state") }
        try check(directoryFD, lock: lock)
        #if DEBUG && !MINDWTR_WIDGET_EXTENSION
        try beforePromotion?()
        #endif
        #if os(iOS) && !targetEnvironment(simulator)
        guard fcntl(directoryFD, F_GETPROTECTIONCLASS) == 3, fcntl(descriptor, F_GETPROTECTIONCLASS) == 3 else {
            throw failure("protect its temporary state")
        }
        #endif
        guard renameat(directoryFD, temporary, directoryFD, Self.stateFileName) == 0 else { throw failure("promote its state") }
        #if DEBUG && !MINDWTR_WIDGET_EXTENSION
        try afterPromotion?()
        #endif
        guard fsync(directoryFD) == 0 else { throw failure("synchronize its directory") }
    }
}
