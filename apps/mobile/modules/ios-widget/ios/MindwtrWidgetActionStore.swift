import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

struct MindwtrWidgetPendingAction: Codable, Equatable, Sendable {
    let id: String
    let taskId: String
    let token: String
    let createdAt: Double
    let notBefore: Double
    var claimed: Bool
}

enum MindwtrWidgetActionStoreError: Error, LocalizedError, Equatable {
    case appGroupUnavailable
    case invalidValue(String)
    case capacityFull
    case unclaimedAcknowledgement
    case corruptState(String)
    case fileOperation(String, Int32)

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "The Mindwtr App Group container is unavailable."
        case .invalidValue(let field):
            return "The widget action contains an invalid \(field)."
        case .capacityFull:
            return "The widget action queue is full."
        case .unclaimedAcknowledgement:
            return "A widget action must be claimed before it can be acknowledged."
        case .corruptState(let reason):
            return "The widget action queue is corrupt: \(reason)"
        case .fileOperation(let operation, let code):
            return "The widget action queue could not \(operation) (errno \(code))."
        }
    }
}

private struct MindwtrWidgetConsumedReceipt: Codable, Equatable {
    let taskId: String
    let token: String
    let consumedAt: Double
}

private struct MindwtrWidgetOperationIdentity: Hashable {
    let taskId: String
    let token: String
}

private struct MindwtrWidgetActionState: Codable, Equatable {
    var version: Int
    var pending: [MindwtrWidgetPendingAction]
    var receipts: [MindwtrWidgetConsumedReceipt]

    static let empty = MindwtrWidgetActionState(version: 1, pending: [], receipts: [])
}

final class MindwtrWidgetActionStore: @unchecked Sendable {
    static let appGroupIdentifier = "group.tech.dongdongbh.mindwtr"
    static let minimumUndoDelayMilliseconds = 3_000.0
    static let maximumPendingActions = 256
    static let maximumConsumedReceipts = 512

    private static let processLock = NSLock()
    private static let stateFileName = "mindwtr-widget-actions-v1.json"
    private static let lockFileName = ".mindwtr-widget-actions.lock"
    private static let maximumIdentifierBytes = 1_024

    private let directory: URL

    static func appGroupStore() throws -> MindwtrWidgetActionStore {
#if os(iOS) || os(macOS)
        guard let directory = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            throw MindwtrWidgetActionStoreError.appGroupUnavailable
        }
        return MindwtrWidgetActionStore(directory: directory)
#else
        throw MindwtrWidgetActionStoreError.appGroupUnavailable
#endif
    }

    init(directory: URL) {
        self.directory = directory.standardizedFileURL
    }

    func pendingActions() throws -> [MindwtrWidgetPendingAction] {
        try withLockedState { state in
            (state.pending, false)
        }
    }

    func enqueue(taskId: String, token: String, now: Date = Date()) throws {
        try validateInput(taskId, field: "task id")
        try validateInput(token, field: "completion token")
        let createdAt = try milliseconds(for: now)

        _ = try withLockedState { state in
            let isReplay = state.pending.contains { action in
                action.taskId == taskId && action.token == token
            } || state.receipts.contains { receipt in
                receipt.taskId == taskId && receipt.token == token
            }
            if isReplay {
                return ((), false)
            }
            guard state.pending.count < Self.maximumPendingActions else {
                throw MindwtrWidgetActionStoreError.capacityFull
            }
            state.pending.append(MindwtrWidgetPendingAction(
                id: UUID().uuidString,
                taskId: taskId,
                token: token,
                createdAt: createdAt,
                notBefore: createdAt + Self.minimumUndoDelayMilliseconds,
                claimed: false
            ))
            return ((), true)
        }
    }

    @discardableResult
    func cancel(id: String) throws -> Bool {
        try validateInput(id, field: "action id")
        return try withLockedState { state in
            guard let index = state.pending.firstIndex(where: { $0.id == id }) else {
                return (false, false)
            }
            guard !state.pending[index].claimed else {
                return (false, false)
            }
            state.pending.remove(at: index)
            return (true, true)
        }
    }

    func claimReady(now: Date = Date()) throws -> [MindwtrWidgetPendingAction] {
        let nowMilliseconds = try milliseconds(for: now)
        return try withLockedState { state in
            var changed = false
            for index in state.pending.indices where
                !state.pending[index].claimed && state.pending[index].notBefore <= nowMilliseconds
            {
                state.pending[index].claimed = true
                changed = true
            }
            return (state.pending.filter(\.claimed), changed)
        }
    }

    func acknowledge(id: String) throws {
        try validateInput(id, field: "action id")
        _ = try withLockedState { state in
            guard let index = state.pending.firstIndex(where: { $0.id == id }) else {
                return ((), false)
            }
            guard state.pending[index].claimed else {
                throw MindwtrWidgetActionStoreError.unclaimedAcknowledgement
            }

            let action = state.pending.remove(at: index)
            state.receipts.removeAll { receipt in
                receipt.taskId == action.taskId && receipt.token == action.token
            }
            state.receipts.append(MindwtrWidgetConsumedReceipt(
                taskId: action.taskId,
                token: action.token,
                consumedAt: Date().timeIntervalSince1970 * 1_000.0
            ))
            if state.receipts.count > Self.maximumConsumedReceipts {
                state.receipts.removeFirst(state.receipts.count - Self.maximumConsumedReceipts)
            }
            return ((), true)
        }
    }

    func nextReadyAt() throws -> Double? {
        try withLockedState { state in
            let next = state.pending.lazy
                .filter { !$0.claimed }
                .map(\.notBefore)
                .min()
            return (next, false)
        }
    }

    private func validateInput(_ value: String, field: String) throws {
        guard !value.isEmpty,
              value.utf8.count <= Self.maximumIdentifierBytes,
              !value.unicodeScalars.contains(where: { $0.value == 0 })
        else {
            throw MindwtrWidgetActionStoreError.invalidValue(field)
        }
    }

    private func milliseconds(for date: Date) throws -> Double {
        let value = date.timeIntervalSince1970 * 1_000.0
        guard value.isFinite, value >= 0 else {
            throw MindwtrWidgetActionStoreError.invalidValue("timestamp")
        }
        return value
    }

    private func withLockedState<Result>(
        _ body: (inout MindwtrWidgetActionState) throws -> (Result, Bool)
    ) throws -> Result {
        Self.processLock.lock()
        defer { Self.processLock.unlock() }

        try ensureDirectoryExists()
        return try withExclusiveFileLock {
            var state = try readState()
            let (result, changed) = try body(&state)
            if changed {
                try validate(state)
                try writeStateAtomically(state)
            }
            return result
        }
    }

    private func ensureDirectoryExists() throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw MindwtrWidgetActionStoreError.fileOperation("open its directory", ENOTDIR)
            }
            return
        }
        do {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            throw MindwtrWidgetActionStoreError.fileOperation("create its directory", currentErrno())
        }
    }

    private func withExclusiveFileLock<Result>(_ body: () throws -> Result) throws -> Result {
        let lockURL = directory.appendingPathComponent(Self.lockFileName, isDirectory: false)
        let descriptor = systemOpen(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("open its lock", currentErrno())
        }
        defer { _ = systemClose(descriptor) }

        while systemFlock(descriptor, LOCK_EX) != 0 {
            let code = currentErrno()
            if code == EINTR { continue }
            throw MindwtrWidgetActionStoreError.fileOperation("acquire its lock", code)
        }
        defer { _ = systemFlock(descriptor, LOCK_UN) }

        return try body()
    }

    private func readState() throws -> MindwtrWidgetActionState {
        let stateURL = directory.appendingPathComponent(Self.stateFileName, isDirectory: false)
        guard FileManager.default.fileExists(atPath: stateURL.path) else {
            return .empty
        }

        let data: Data
        do {
            data = try Data(contentsOf: stateURL)
        } catch {
            throw MindwtrWidgetActionStoreError.fileOperation("read its state", currentErrno())
        }

        let state: MindwtrWidgetActionState
        do {
            state = try JSONDecoder().decode(MindwtrWidgetActionState.self, from: data)
        } catch {
            throw MindwtrWidgetActionStoreError.corruptState("invalid JSON")
        }
        try validate(state)
        return state
    }

    private func validate(_ state: MindwtrWidgetActionState) throws {
        guard state.version == 1 else {
            throw MindwtrWidgetActionStoreError.corruptState("unsupported version")
        }
        guard state.pending.count <= Self.maximumPendingActions else {
            throw MindwtrWidgetActionStoreError.corruptState("pending capacity exceeded")
        }
        guard state.receipts.count <= Self.maximumConsumedReceipts else {
            throw MindwtrWidgetActionStoreError.corruptState("receipt capacity exceeded")
        }

        var ids = Set<String>()
        var operationKeys = Set<MindwtrWidgetOperationIdentity>()
        for action in state.pending {
            let identity = MindwtrWidgetOperationIdentity(taskId: action.taskId, token: action.token)
            guard isValidStoredString(action.id),
                  isValidStoredString(action.taskId),
                  isValidStoredString(action.token),
                  action.createdAt.isFinite,
                  action.createdAt >= 0,
                  action.notBefore.isFinite,
                  action.notBefore >= action.createdAt + Self.minimumUndoDelayMilliseconds,
                  ids.insert(action.id).inserted,
                  operationKeys.insert(identity).inserted
            else {
                throw MindwtrWidgetActionStoreError.corruptState("invalid or duplicate pending action")
            }
        }

        var receiptKeys = Set<MindwtrWidgetOperationIdentity>()
        for receipt in state.receipts {
            let identity = MindwtrWidgetOperationIdentity(taskId: receipt.taskId, token: receipt.token)
            guard isValidStoredString(receipt.taskId),
                  isValidStoredString(receipt.token),
                  receipt.consumedAt.isFinite,
                  receipt.consumedAt >= 0,
                  receiptKeys.insert(identity).inserted,
                  !operationKeys.contains(identity)
            else {
                throw MindwtrWidgetActionStoreError.corruptState("invalid or duplicate receipt")
            }
        }
    }

    private func isValidStoredString(_ value: String) -> Bool {
        !value.isEmpty
            && value.utf8.count <= Self.maximumIdentifierBytes
            && !value.unicodeScalars.contains(where: { $0.value == 0 })
    }

    private func writeStateAtomically(_ state: MindwtrWidgetActionState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var data: Data
        do {
            data = try encoder.encode(state)
            data.append(0x0A)
        } catch {
            throw MindwtrWidgetActionStoreError.corruptState("could not encode valid state")
        }

        let stateURL = directory.appendingPathComponent(Self.stateFileName, isDirectory: false)
        let temporaryURL = directory.appendingPathComponent(
            ".\(Self.stateFileName).\(UUID().uuidString).tmp",
            isDirectory: false
        )
        let descriptor = systemOpen(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
            0o600
        )
        guard descriptor >= 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("create a temporary state", currentErrno())
        }

        var descriptorIsOpen = true
        var shouldRemoveTemporary = true
        defer {
            if descriptorIsOpen {
                _ = systemClose(descriptor)
            }
            if shouldRemoveTemporary {
                _ = systemUnlink(temporaryURL.path)
            }
        }

        try writeAll(data, to: descriptor)
        guard systemFsync(descriptor) == 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("synchronize its temporary state", currentErrno())
        }
        descriptorIsOpen = false
        guard systemClose(descriptor) == 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("close its temporary state", currentErrno())
        }

        guard systemRename(temporaryURL.path, stateURL.path) == 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("replace its state", currentErrno())
        }
        shouldRemoveTemporary = false
        try synchronizeDirectory()
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let written = systemWrite(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    bytes.count - offset
                )
                if written < 0 {
                    let code = currentErrno()
                    if code == EINTR { continue }
                    throw MindwtrWidgetActionStoreError.fileOperation("write its temporary state", code)
                }
                guard written > 0 else {
                    throw MindwtrWidgetActionStoreError.fileOperation("write its temporary state", EIO)
                }
                offset += written
            }
        }
    }

    private func synchronizeDirectory() throws {
        let descriptor = systemOpen(directory.path, O_RDONLY | O_CLOEXEC, 0)
        guard descriptor >= 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("open its directory for synchronization", currentErrno())
        }
        defer { _ = systemClose(descriptor) }
        guard systemFsync(descriptor) == 0 else {
            throw MindwtrWidgetActionStoreError.fileOperation("synchronize its directory", currentErrno())
        }
    }
}

private func currentErrno() -> Int32 {
    errno
}

private func systemOpen(_ path: String, _ flags: Int32, _ mode: mode_t) -> Int32 {
    path.withCString { pointer in
#if canImport(Darwin)
        Darwin.open(pointer, flags, mode)
#elseif canImport(Glibc)
        Glibc.open(pointer, flags, mode)
#else
        -1
#endif
    }
}

private func systemClose(_ descriptor: Int32) -> Int32 {
#if canImport(Darwin)
    Darwin.close(descriptor)
#elseif canImport(Glibc)
    Glibc.close(descriptor)
#else
    -1
#endif
}

private func systemFlock(_ descriptor: Int32, _ operation: Int32) -> Int32 {
#if canImport(Darwin)
    flock(descriptor, operation)
#elseif canImport(Glibc)
    flock(descriptor, operation)
#else
    -1
#endif
}

private func systemWrite(_ descriptor: Int32, _ buffer: UnsafeRawPointer, _ count: Int) -> Int {
#if canImport(Darwin)
    Darwin.write(descriptor, buffer, count)
#elseif canImport(Glibc)
    Glibc.write(descriptor, buffer, count)
#else
    -1
#endif
}

private func systemFsync(_ descriptor: Int32) -> Int32 {
#if canImport(Darwin)
    Darwin.fsync(descriptor)
#elseif canImport(Glibc)
    Glibc.fsync(descriptor)
#else
    -1
#endif
}

private func systemRename(_ source: String, _ destination: String) -> Int32 {
    source.withCString { sourcePointer in
        destination.withCString { destinationPointer in
#if canImport(Darwin)
            Darwin.rename(sourcePointer, destinationPointer)
#elseif canImport(Glibc)
            Glibc.rename(sourcePointer, destinationPointer)
#else
            -1
#endif
        }
    }
}

private func systemUnlink(_ path: String) -> Int32 {
    path.withCString { pointer in
#if canImport(Darwin)
        Darwin.unlink(pointer)
#elseif canImport(Glibc)
        Glibc.unlink(pointer)
#else
        -1
#endif
    }
}
