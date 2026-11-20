import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

private struct MindwtrAnyCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

private func rejectUnknownFields(
    from decoder: Decoder,
    allowed: Set<String>
) throws {
    let container = try decoder.container(keyedBy: MindwtrAnyCodingKey.self)
    guard container.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else {
        throw DecodingError.dataCorrupted(DecodingError.Context(
            codingPath: decoder.codingPath,
            debugDescription: "The object contains an unsupported field."
        ))
    }
}

public enum MindwtrSiriActionOperation: String, Codable, CaseIterable, Equatable, Sendable {
    case create
    case update
    case delete
}

public enum MindwtrSiriActionClearField: String, Codable, CaseIterable, Hashable, Sendable {
    case description
    case dueDate
    case projectId
}

public struct MindwtrSiriActionFields: Codable, Equatable, Sendable {
    public let title: String?
    public let description: String?
    public let dueDate: String?
    public let tags: [String]?
    public let projectId: String?
    public let isFocusedToday: Bool?
    public let isCompleted: Bool?

    public init(
        title: String? = nil,
        description: String? = nil,
        dueDate: String? = nil,
        tags: [String]? = nil,
        projectId: String? = nil,
        isFocusedToday: Bool? = nil,
        isCompleted: Bool? = nil
    ) {
        self.title = title
        self.description = description
        self.dueDate = dueDate
        self.tags = tags
        self.projectId = projectId
        self.isFocusedToday = isFocusedToday
        self.isCompleted = isCompleted
    }

    private enum CodingKeys: String, CodingKey {
        case title
        case description
        case dueDate
        case tags
        case projectId
        case isFocusedToday
        case isCompleted
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownFields(
            from: decoder,
            allowed: [
                "title", "description", "dueDate", "tags", "projectId",
                "isFocusedToday", "isCompleted",
            ]
        )
        let container = try decoder.container(keyedBy: CodingKeys.self)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        dueDate = try container.decodeIfPresent(String.self, forKey: .dueDate)
        tags = try container.decodeIfPresent([String].self, forKey: .tags)
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        isFocusedToday = try container.decodeIfPresent(Bool.self, forKey: .isFocusedToday)
        isCompleted = try container.decodeIfPresent(Bool.self, forKey: .isCompleted)
    }

    fileprivate var isEmpty: Bool {
        title == nil
            && description == nil
            && dueDate == nil
            && tags == nil
            && projectId == nil
            && isFocusedToday == nil
            && isCompleted == nil
    }
}

public struct MindwtrSiriActionRequest: Codable, Equatable, Sendable {
    public let version: Int
    public let id: String
    public let operation: MindwtrSiriActionOperation
    public let targetId: String?
    public let expectedToken: String?
    public let createdAt: Double
    public let expiresAt: Double
    public let fields: MindwtrSiriActionFields
    public let clearFields: [MindwtrSiriActionClearField]

    public init(
        version: Int = 1,
        id: String,
        operation: MindwtrSiriActionOperation,
        targetId: String? = nil,
        expectedToken: String? = nil,
        createdAt: Double,
        expiresAt: Double,
        fields: MindwtrSiriActionFields = MindwtrSiriActionFields(),
        clearFields: [MindwtrSiriActionClearField] = []
    ) {
        self.version = version
        self.id = id
        self.operation = operation
        self.targetId = targetId
        self.expectedToken = expectedToken
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.fields = fields
        self.clearFields = clearFields
    }

    private enum CodingKeys: String, CodingKey {
        case version
        case id
        case operation
        case targetId
        case expectedToken
        case createdAt
        case expiresAt
        case fields
        case clearFields
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownFields(
            from: decoder,
            allowed: [
                "version", "id", "operation", "targetId", "expectedToken",
                "createdAt", "expiresAt", "fields", "clearFields",
            ]
        )
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        id = try container.decode(String.self, forKey: .id)
        operation = try container.decode(MindwtrSiriActionOperation.self, forKey: .operation)
        targetId = try container.decodeIfPresent(String.self, forKey: .targetId)
        expectedToken = try container.decodeIfPresent(String.self, forKey: .expectedToken)
        createdAt = try container.decode(Double.self, forKey: .createdAt)
        expiresAt = try container.decode(Double.self, forKey: .expiresAt)
        fields = try container.decode(MindwtrSiriActionFields.self, forKey: .fields)
        clearFields = try container.decode(
            [MindwtrSiriActionClearField].self,
            forKey: .clearFields
        )
    }
}

public enum MindwtrSiriActionOutcome: String, Codable, Equatable, Sendable {
    case persisted
    case rejected
}

public enum MindwtrSiriActionRejectionReason: String, Codable, Equatable, Sendable {
    case stale
    case missing
    case unsupported
    case invalid
    case expired
    case cancelled
}

public struct MindwtrSiriActionResult: Codable, Equatable, Sendable {
    public let outcome: MindwtrSiriActionOutcome
    public let reason: MindwtrSiriActionRejectionReason?
    public let task: String?

    public init(
        outcome: MindwtrSiriActionOutcome,
        reason: MindwtrSiriActionRejectionReason? = nil,
        task: String? = nil
    ) {
        self.outcome = outcome
        self.reason = reason
        self.task = task
    }

    private enum CodingKeys: String, CodingKey {
        case outcome
        case reason
        case task
    }

    public init(from decoder: Decoder) throws {
        try rejectUnknownFields(
            from: decoder,
            allowed: ["outcome", "reason", "task"]
        )
        let container = try decoder.container(keyedBy: CodingKeys.self)
        outcome = try container.decode(MindwtrSiriActionOutcome.self, forKey: .outcome)
        reason = try container.decodeIfPresent(
            MindwtrSiriActionRejectionReason.self,
            forKey: .reason
        )
        task = try container.decodeIfPresent(String.self, forKey: .task)
    }
}

public enum MindwtrSiriActionStoreError: Error, LocalizedError, Equatable {
    case appGroupUnavailable
    case accessUnavailable
    case invalidRequest(String)
    case expiredRequest
    case futureRequest
    case conflictingRequestIdentifier
    case pendingCapacityFull
    case receiptCapacityFull
    case unclaimedAcknowledgement
    case invalidResult(String)
    case invalidSnapshot
    case snapshotTooLarge
    case corruptState(String)
    case storeTooLarge
    case fileOperation(String, Int32)

    public var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "The Mindwtr App Group container is unavailable."
        case .accessUnavailable:
            return "Siri reminder access is unavailable."
        case .invalidRequest(let reason):
            return "The Siri action request is invalid: \(reason)."
        case .expiredRequest:
            return "The Siri action request has expired."
        case .futureRequest:
            return "The Siri action request was created too far in the future."
        case .conflictingRequestIdentifier:
            return "The Siri action request identifier is already used by a different request."
        case .pendingCapacityFull:
            return "The Siri action request queue is full."
        case .receiptCapacityFull:
            return "The Siri action receipt queue is full."
        case .unclaimedAcknowledgement:
            return "A Siri action must be claimed before it can be acknowledged."
        case .invalidResult(let reason):
            return "The Siri action result is invalid: \(reason)."
        case .invalidSnapshot:
            return "The Siri snapshot is not a valid JSON object."
        case .snapshotTooLarge:
            return "The Siri snapshot exceeds its size limit."
        case .corruptState(let reason):
            return "The Siri action queue is corrupt: \(reason)."
        case .storeTooLarge:
            return "The Siri action queue exceeds its size limit."
        case .fileOperation(let operation, let code):
            return "The Siri action store could not \(operation) (errno \(code))."
        }
    }
}

private struct MindwtrSiriPendingRecord: Codable, Equatable {
    let request: MindwtrSiriActionRequest
    let accessSession: UUID?
    var claimed: Bool
    var claimedAt: Double?
}

private struct MindwtrSiriReceiptRecord: Codable, Equatable {
    let id: String
    let requestPayload: Data
    let outcome: MindwtrSiriActionOutcome
    let reason: MindwtrSiriActionRejectionReason?
    let taskPayload: Data?
    let completedAt: Double
}

private struct MindwtrSiriActionState: Codable, Equatable {
    var version: Int
    var pending: [MindwtrSiriPendingRecord]
    var receipts: [MindwtrSiriReceiptRecord]

    static let empty = MindwtrSiriActionState(version: 1, pending: [], receipts: [])
}

public final class MindwtrSiriActionStore: @unchecked Sendable {
    public static let appGroupIdentifier = "group.tech.dongdongbh.mindwtr"
    public static let maximumPendingActions = 32
    public static let maximumReceipts = 256
    public static let maximumCommandBytes = 64 * 1_024
    public static let maximumResultTaskBytes = 64 * 1_024
    public static let maximumSnapshotBytes = 1_024 * 1_024
    public static let maximumStoreBytes = 50 * 1_024 * 1_024
    public static let maximumLifetimeMilliseconds = 120_000.0
    public static let maximumFutureSkewMilliseconds = 5_000.0
    public static let receiptRetentionMilliseconds = 24.0 * 60.0 * 60.0 * 1_000.0
    public static let pendingActionsChangedNotification = Notification.Name(
        "tech.dongdongbh.mindwtr.siriActions.pending.changed"
    )

    private static let processLock = NSLock()
    private static let accessLock = NSLock()
    private static var accessSessionActive = false
    private static var accessSessionGeneration: UInt64 = 0
    private static var publishedSession: UInt64?
    private static var grantedAccessSession: UUID?
    private static let stateFileName = "mindwtr-siri-actions-v1.json"
    private static let snapshotFileName = "mindwtr-siri-snapshot-v1.json"
    private static let lockFileName = ".mindwtr-siri-actions.lock"
    private static let maximumTitleBytes = 2_000
    private static let maximumDescriptionBytes = 32_000
    private static let maximumTagBytes = 100
    private static let maximumTags = 32
    private static let maximumTokenBytes = 4_096
    private static let maximumDateBytes = 4_096
    private static let maximumResultEnvelopeBytes = 64 * 1_024 * 6 + 1_024

    private let directory: URL
    private let publicationHook: ((String) throws -> Void)?

    public static var isAccessAllowed: Bool {
        allowedAccessSession != nil
    }

    public static var allowedAccessSession: UUID? {
        accessLock.lock()
        defer { accessLock.unlock() }
        return grantedAccessSession
    }

    @discardableResult
    static func beginAccessSession() -> UInt64 {
        accessLock.lock()
        accessSessionGeneration &+= 1
        accessSessionActive = true
        publishedSession = nil
        grantedAccessSession = nil
        let generation = accessSessionGeneration
        accessLock.unlock()
        return generation
    }

    static func endAccessSession() {
        accessLock.lock()
        accessSessionGeneration &+= 1
        accessSessionActive = false
        publishedSession = nil
        grantedAccessSession = nil
        accessLock.unlock()
    }

    @discardableResult
    static func setAccessAllowed(_ allowed: Bool, forSession generation: UInt64) -> UInt64? {
        accessLock.lock()
        defer { accessLock.unlock() }
        if !allowed {
            accessSessionGeneration &+= 1
            publishedSession = nil
            grantedAccessSession = nil
        } else if accessSessionActive,
                  accessSessionGeneration == generation,
                  publishedSession == generation,
                  grantedAccessSession == nil {
            grantedAccessSession = UUID()
        }
        return accessSessionActive ? accessSessionGeneration : nil
    }

    func publishSnapshotForAccessSession(_ snapshotJSON: String, generation: UInt64) throws {
        guard Self.isActiveSession(generation) else {
            throw MindwtrSiriActionStoreError.accessUnavailable
        }
        try publishSnapshot(snapshotJSON)
        Self.accessLock.lock()
        defer { Self.accessLock.unlock() }
        guard Self.accessSessionActive, Self.accessSessionGeneration == generation else {
            throw MindwtrSiriActionStoreError.accessUnavailable
        }
        Self.publishedSession = generation
    }

    private static func isActiveSession(_ generation: UInt64) -> Bool {
        accessLock.lock()
        defer { accessLock.unlock() }
        return accessSessionActive && accessSessionGeneration == generation
    }

    func clearSnapshot() throws {
        Self.accessLock.lock()
        Self.publishedSession = nil
        Self.grantedAccessSession = nil
        Self.accessLock.unlock()
        try publishSnapshot("{}")
    }

    public static func appGroupStore() throws -> MindwtrSiriActionStore {
#if os(iOS) || os(macOS)
        guard let bundleIdentifier = Bundle.main.bundleIdentifier,
              !bundleIdentifier.isEmpty,
              let directory = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            throw MindwtrSiriActionStoreError.appGroupUnavailable
        }
        return MindwtrSiriActionStore(directory: directory
            .appendingPathComponent("siri-actions", isDirectory: true)
            .appendingPathComponent(bundleIdentifier, isDirectory: true))
#else
        throw MindwtrSiriActionStoreError.appGroupUnavailable
#endif
    }

    public static func readSnapshot() throws -> String? {
        guard let session = allowedAccessSession else { return nil }
        let snapshot = try appGroupStore().readSnapshotFile()
        guard allowedAccessSession == session else { return nil }
        return snapshot
    }

    init(
        directory: URL,
        publicationHook: ((String) throws -> Void)? = nil
    ) {
        self.directory = directory.standardizedFileURL
        self.publicationHook = publicationHook
    }

    public func enqueue(_ request: MindwtrSiriActionRequest, now: Date, accessSession: UUID? = nil) throws {
        let nowMilliseconds = try milliseconds(for: now)
        try validateRequest(request, enforceCurrentTimeAt: nil)
        let requestPayload = try encodeRequest(request)
        let inserted = try withLockedState { state in
            if let accessSession, Self.allowedAccessSession != accessSession {
                throw MindwtrSiriActionStoreError.accessUnavailable
            }
            let pruned = pruneReceipts(&state, nowMilliseconds: nowMilliseconds)
            if let pending = state.pending.first(where: {
                canonicalIdentifier($0.request.id) == canonicalIdentifier(request.id)
            }) {
                guard pending.request == request else {
                    throw MindwtrSiriActionStoreError.conflictingRequestIdentifier
                }
                return (false, pruned)
            }
            if let receipt = state.receipts.first(where: {
                canonicalIdentifier($0.id) == canonicalIdentifier(request.id)
            }) {
                let original = try decodeReceiptRequest(receipt)
                guard original == request else {
                    throw MindwtrSiriActionStoreError.conflictingRequestIdentifier
                }
                return (false, pruned)
            }

            try validateRequest(request, enforceCurrentTimeAt: nowMilliseconds)
            guard requestPayload.count <= Self.maximumCommandBytes else {
                throw MindwtrSiriActionStoreError.invalidRequest("command size")
            }
            guard state.pending.count < Self.maximumPendingActions else {
                throw MindwtrSiriActionStoreError.pendingCapacityFull
            }
            state.pending.append(MindwtrSiriPendingRecord(
                request: request,
                accessSession: accessSession,
                claimed: false,
                claimedAt: nil
            ))
            return (true, true)
        }

        if inserted {
            NotificationCenter.default.post(
                name: Self.pendingActionsChangedNotification,
                object: nil
            )
        }
    }

    public func claimPending(now: Date) throws -> [MindwtrSiriActionRequest] {
        try claimPendingRecords(now: now).map(\.request)
    }

    func claimPending(now: Date, accessSession: UUID) throws -> [(request: MindwtrSiriActionRequest, replayOnly: Bool)] {
        guard Self.allowedAccessSession == accessSession else { return [] }
        let records = try claimPendingRecords(now: now)
        guard Self.allowedAccessSession == accessSession else { return [] }
        return records.map { ($0.request, $0.accessSession != accessSession) }
    }

    private func claimPendingRecords(now: Date) throws -> [MindwtrSiriPendingRecord] {
        let nowMilliseconds = try milliseconds(for: now)
        return try withLockedState { state in
            var changed = pruneReceipts(&state, nowMilliseconds: nowMilliseconds)
            let expiredIndices = state.pending.indices.filter { index in
                !state.pending[index].claimed
                    && state.pending[index].request.expiresAt <= nowMilliseconds
            }
            guard state.receipts.count + expiredIndices.count <= Self.maximumReceipts else {
                throw MindwtrSiriActionStoreError.receiptCapacityFull
            }

            for index in expiredIndices.reversed() {
                let record = state.pending.remove(at: index)
                state.receipts.append(try makeReceipt(
                    request: record.request,
                    result: MindwtrSiriActionResult(outcome: .rejected, reason: .expired),
                    completedAt: nowMilliseconds
                ))
                changed = true
            }

            for index in state.pending.indices where !state.pending[index].claimed {
                state.pending[index].claimed = true
                state.pending[index].claimedAt = nowMilliseconds
                changed = true
            }

            return (state.pending.filter(\.claimed), changed)
        }
    }

    public func acknowledge(
        id: String,
        result: MindwtrSiriActionResult,
        now: Date
    ) throws {
        guard canonicalIdentifier(id) != nil else {
            throw MindwtrSiriActionStoreError.invalidRequest("identifier")
        }
        let nowMilliseconds = try milliseconds(for: now)
        try Self.validateResult(result)

        _ = try withLockedState { state in
            _ = pruneReceipts(&state, nowMilliseconds: nowMilliseconds)
            guard let index = state.pending.firstIndex(where: {
                canonicalIdentifier($0.request.id) == canonicalIdentifier(id)
            }), state.pending[index].claimed else {
                throw MindwtrSiriActionStoreError.unclaimedAcknowledgement
            }
            guard state.receipts.count < Self.maximumReceipts else {
                throw MindwtrSiriActionStoreError.receiptCapacityFull
            }

            let record = state.pending.remove(at: index)
            state.receipts.append(try makeReceipt(
                request: record.request,
                result: result,
                completedAt: nowMilliseconds
            ))
            return ((), true)
        }
    }

    public func result(id: String, now: Date) throws -> MindwtrSiriActionResult? {
        guard canonicalIdentifier(id) != nil else {
            throw MindwtrSiriActionStoreError.invalidRequest("identifier")
        }
        let nowMilliseconds = try milliseconds(for: now)
        return try withLockedState { state in
            let changed = pruneReceipts(&state, nowMilliseconds: nowMilliseconds)
            let receipt = state.receipts.first(where: {
                canonicalIdentifier($0.id) == canonicalIdentifier(id)
            })
            return (try receipt.map { try result(from: $0) }, changed)
        }
    }

    @discardableResult
    public func cancelUnclaimed(id: String, now: Date) throws -> Bool {
        guard canonicalIdentifier(id) != nil else {
            throw MindwtrSiriActionStoreError.invalidRequest("identifier")
        }
        let nowMilliseconds = try milliseconds(for: now)
        return try withLockedState { state in
            var changed = pruneReceipts(&state, nowMilliseconds: nowMilliseconds)
            guard let index = state.pending.firstIndex(where: {
                canonicalIdentifier($0.request.id) == canonicalIdentifier(id)
            }), !state.pending[index].claimed else {
                return (false, changed)
            }
            guard state.receipts.count < Self.maximumReceipts else {
                throw MindwtrSiriActionStoreError.receiptCapacityFull
            }

            let record = state.pending.remove(at: index)
            let expired = record.request.expiresAt <= nowMilliseconds
            state.receipts.append(try makeReceipt(
                request: record.request,
                result: MindwtrSiriActionResult(
                    outcome: .rejected,
                    reason: expired ? .expired : .cancelled
                ),
                completedAt: nowMilliseconds
            ))
            changed = true
            return (!expired, changed)
        }
    }

    public func publishSnapshot(_ snapshotJSON: String) throws {
        let data = Data(snapshotJSON.utf8)
        guard data.count <= Self.maximumSnapshotBytes else {
            throw MindwtrSiriActionStoreError.snapshotTooLarge
        }
        guard Self.isJSONObject(data) else {
            throw MindwtrSiriActionStoreError.invalidSnapshot
        }

        try withFileLock {
            try writeDataAtomically(
                data,
                fileName: Self.snapshotFileName,
                sizeLimit: Self.maximumSnapshotBytes
            )
        }
    }

    func readSnapshotFile() throws -> String? {
        try withFileLock {
            let snapshotURL = directory.appendingPathComponent(
                Self.snapshotFileName,
                isDirectory: false
            )
            guard FileManager.default.fileExists(atPath: snapshotURL.path) else {
                return nil
            }
            let data = try readBoundedData(
                at: snapshotURL,
                maximumBytes: Self.maximumSnapshotBytes,
                oversizedError: .snapshotTooLarge,
                operation: "read its snapshot"
            )
            guard Self.isJSONObject(data), let snapshot = String(data: data, encoding: .utf8) else {
                throw MindwtrSiriActionStoreError.invalidSnapshot
            }
            return snapshot
        }
    }

    static func decodeResultJSON(_ resultJSON: String) throws -> MindwtrSiriActionResult {
        let data = Data(resultJSON.utf8)
        guard data.count <= Self.maximumResultEnvelopeBytes else {
            throw MindwtrSiriActionStoreError.invalidResult("result size")
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw MindwtrSiriActionStoreError.invalidResult("JSON")
        }
        guard let dictionary = object as? [String: Any],
              hasExpectedKeys(
                dictionary,
                allowed: ["outcome", "reason", "task"],
                required: ["outcome"]
              ) else {
            throw MindwtrSiriActionStoreError.invalidResult("shape")
        }
        let result: MindwtrSiriActionResult
        do {
            result = try JSONDecoder().decode(MindwtrSiriActionResult.self, from: data)
        } catch {
            throw MindwtrSiriActionStoreError.invalidResult("fields")
        }
        try validateResult(result)
        return result
    }

    private func withLockedState<Result>(
        _ body: (inout MindwtrSiriActionState) throws -> (Result, Bool)
    ) throws -> Result {
        try withFileLock {
            var state = try readState()
            let (result, changed) = try body(&state)
            if changed {
                try validate(state)
                try writeStateAtomically(state)
            }
            return result
        }
    }

    private func withFileLock<Result>(_ body: () throws -> Result) throws -> Result {
        Self.processLock.lock()
        defer { Self.processLock.unlock() }

        try ensureDirectoryExists()
        return try withExclusiveFileLock(body)
    }

    private func ensureDirectoryExists() throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw MindwtrSiriActionStoreError.fileOperation("open its directory", ENOTDIR)
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
            throw MindwtrSiriActionStoreError.fileOperation("create its directory", siriCurrentErrno())
        }
    }

    private func withExclusiveFileLock<Result>(_ body: () throws -> Result) throws -> Result {
        let lockURL = directory.appendingPathComponent(Self.lockFileName, isDirectory: false)
        let descriptor = siriSystemOpen(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            throw MindwtrSiriActionStoreError.fileOperation("open its lock", siriCurrentErrno())
        }
        defer { _ = siriSystemClose(descriptor) }

        while siriSystemFlock(descriptor, LOCK_EX) != 0 {
            let code = siriCurrentErrno()
            if code == EINTR { continue }
            throw MindwtrSiriActionStoreError.fileOperation("acquire its lock", code)
        }
        defer { _ = siriSystemFlock(descriptor, LOCK_UN) }

        return try body()
    }

    private func readState() throws -> MindwtrSiriActionState {
        let stateURL = directory.appendingPathComponent(Self.stateFileName, isDirectory: false)
        guard FileManager.default.fileExists(atPath: stateURL.path) else {
            return .empty
        }
        let data = try readBoundedData(
            at: stateURL,
            maximumBytes: Self.maximumStoreBytes,
            oversizedError: .storeTooLarge,
            operation: "read its state"
        )

        try validateStateJSONSchema(data)
        let state: MindwtrSiriActionState
        do {
            state = try JSONDecoder().decode(MindwtrSiriActionState.self, from: data)
        } catch {
            throw MindwtrSiriActionStoreError.corruptState("invalid JSON")
        }
        try validate(state)
        return state
    }

    private func readBoundedData(
        at url: URL,
        maximumBytes: Int,
        oversizedError: MindwtrSiriActionStoreError,
        operation: String
    ) throws -> Data {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            if let size = attributes[.size] as? NSNumber, size.uint64Value > UInt64(maximumBytes) {
                throw oversizedError
            }
            let data = try Data(contentsOf: url, options: [.mappedIfSafe])
            guard data.count <= maximumBytes else { throw oversizedError }
            return data
        } catch let error as MindwtrSiriActionStoreError {
            throw error
        } catch {
            throw MindwtrSiriActionStoreError.fileOperation(operation, siriCurrentErrno())
        }
    }

    private func validateStateJSONSchema(_ data: Data) throws {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw MindwtrSiriActionStoreError.corruptState("invalid JSON")
        }
        guard let root = object as? [String: Any],
              Self.hasExpectedKeys(
                root,
                allowed: ["version", "pending", "receipts"],
                required: ["version", "pending", "receipts"]
              ),
              let pending = root["pending"] as? [Any],
              let receipts = root["receipts"] as? [Any] else {
            throw MindwtrSiriActionStoreError.corruptState("invalid state shape")
        }

        for value in pending {
            guard let record = value as? [String: Any],
                  Self.hasExpectedKeys(
                    record,
                    allowed: ["request", "accessSession", "claimed", "claimedAt"],
                    required: ["request", "claimed"]
                  ),
                  let request = record["request"] as? [String: Any] else {
                throw MindwtrSiriActionStoreError.corruptState("invalid pending shape")
            }
            try validateRequestJSONSchema(request)
        }

        for value in receipts {
            guard let receipt = value as? [String: Any],
                  Self.hasExpectedKeys(
                    receipt,
                    allowed: ["id", "requestPayload", "outcome", "reason", "taskPayload", "completedAt"],
                    required: ["id", "requestPayload", "outcome", "completedAt"]
                  ) else {
                throw MindwtrSiriActionStoreError.corruptState("invalid receipt shape")
            }
        }
    }

    private func validateRequestJSONSchema(_ request: [String: Any]) throws {
        guard Self.hasExpectedKeys(
            request,
            allowed: [
                "version", "id", "operation", "targetId", "expectedToken",
                "createdAt", "expiresAt", "fields", "clearFields",
            ],
            required: [
                "version", "id", "operation", "createdAt", "expiresAt", "fields", "clearFields",
            ]
        ), let fields = request["fields"] as? [String: Any],
           Self.hasExpectedKeys(
            fields,
            allowed: [
                "title", "description", "dueDate", "tags", "projectId",
                "isFocusedToday", "isCompleted",
            ],
            required: []
           ) else {
            throw MindwtrSiriActionStoreError.corruptState("unknown or missing request fields")
        }
    }

    private func validate(_ state: MindwtrSiriActionState) throws {
        guard state.version == 1 else {
            throw MindwtrSiriActionStoreError.corruptState("unsupported version")
        }
        guard state.pending.count <= Self.maximumPendingActions else {
            throw MindwtrSiriActionStoreError.corruptState("pending capacity exceeded")
        }
        guard state.receipts.count <= Self.maximumReceipts else {
            throw MindwtrSiriActionStoreError.corruptState("receipt capacity exceeded")
        }

        var identifiers = Set<String>()
        for record in state.pending {
            do {
                try validateRequest(record.request, enforceCurrentTimeAt: nil)
                guard try encodeRequest(record.request).count <= Self.maximumCommandBytes else {
                    throw MindwtrSiriActionStoreError.invalidRequest("command size")
                }
            } catch {
                throw MindwtrSiriActionStoreError.corruptState("invalid pending request")
            }
            guard let identifier = canonicalIdentifier(record.request.id),
                  identifiers.insert(identifier).inserted,
                  record.claimed == (record.claimedAt != nil),
                  record.claimedAt?.isFinite != false,
                  (record.claimedAt ?? 0) >= 0 else {
                throw MindwtrSiriActionStoreError.corruptState("invalid or duplicate pending request")
            }
        }

        for receipt in state.receipts {
            guard let identifier = canonicalIdentifier(receipt.id),
                  identifiers.insert(identifier).inserted,
                  receipt.completedAt.isFinite,
                  receipt.completedAt >= 0 else {
                throw MindwtrSiriActionStoreError.corruptState("invalid or duplicate receipt")
            }
            let request: MindwtrSiriActionRequest
            do {
                request = try decodeReceiptRequest(receipt)
                guard canonicalIdentifier(request.id) == identifier else {
                    throw MindwtrSiriActionStoreError.corruptState("receipt identity mismatch")
                }
                _ = try result(from: receipt)
            } catch let error as MindwtrSiriActionStoreError {
                switch error {
                case .corruptState:
                    throw error
                default:
                    throw MindwtrSiriActionStoreError.corruptState("invalid receipt content")
                }
            } catch {
                throw MindwtrSiriActionStoreError.corruptState("invalid receipt content")
            }
        }
    }

    private func validateRequest(
        _ request: MindwtrSiriActionRequest,
        enforceCurrentTimeAt nowMilliseconds: Double?
    ) throws {
        guard request.version == 1 else {
            throw MindwtrSiriActionStoreError.invalidRequest("version")
        }
        guard canonicalIdentifier(request.id) != nil else {
            throw MindwtrSiriActionStoreError.invalidRequest("identifier")
        }
        guard request.createdAt.isFinite,
              request.expiresAt.isFinite,
              request.createdAt >= 0,
              request.expiresAt > request.createdAt,
              request.expiresAt - request.createdAt <= Self.maximumLifetimeMilliseconds else {
            throw MindwtrSiriActionStoreError.invalidRequest("lifetime")
        }

        switch request.operation {
        case .create:
            guard request.targetId == nil, request.expectedToken == nil else {
                throw MindwtrSiriActionStoreError.invalidRequest("create identity")
            }
        case .update:
            guard let targetId = request.targetId,
                  canonicalIdentifier(targetId) != nil,
                  let expectedToken = request.expectedToken,
                  isBoundedNonempty(expectedToken, maximumBytes: Self.maximumTokenBytes) else {
                throw MindwtrSiriActionStoreError.invalidRequest("update identity")
            }
        case .delete:
            guard let targetId = request.targetId,
                  canonicalIdentifier(targetId) != nil,
                  let expectedToken = request.expectedToken,
                  isBoundedNonempty(expectedToken, maximumBytes: Self.maximumTokenBytes),
                  request.fields.isEmpty,
                  request.clearFields.isEmpty else {
                throw MindwtrSiriActionStoreError.invalidRequest("delete payload")
            }
        }

        if let title = request.fields.title,
           title.utf8.count > Self.maximumTitleBytes {
            throw MindwtrSiriActionStoreError.invalidRequest("title size")
        }
        if let description = request.fields.description,
           description.utf8.count > Self.maximumDescriptionBytes {
            throw MindwtrSiriActionStoreError.invalidRequest("description size")
        }
        if let dueDate = request.fields.dueDate,
           dueDate.utf8.count > Self.maximumDateBytes {
            throw MindwtrSiriActionStoreError.invalidRequest("date size")
        }
        if let tags = request.fields.tags {
            guard tags.count <= Self.maximumTags,
                  tags.allSatisfy({ $0.utf8.count <= Self.maximumTagBytes }) else {
                throw MindwtrSiriActionStoreError.invalidRequest("tags")
            }
        }
        if let projectId = request.fields.projectId,
           !isBoundedNonempty(projectId, maximumBytes: Self.maximumCommandBytes) {
            throw MindwtrSiriActionStoreError.invalidRequest("project identifier")
        }

        let clearFields = Set(request.clearFields)
        guard clearFields.count == request.clearFields.count else {
            throw MindwtrSiriActionStoreError.invalidRequest("duplicate clear fields")
        }
        if request.fields.description != nil && clearFields.contains(.description)
            || request.fields.dueDate != nil && clearFields.contains(.dueDate)
            || request.fields.projectId != nil && clearFields.contains(.projectId) {
            throw MindwtrSiriActionStoreError.invalidRequest("conflicting clear fields")
        }

        if let nowMilliseconds {
            guard request.createdAt <= nowMilliseconds + Self.maximumFutureSkewMilliseconds else {
                throw MindwtrSiriActionStoreError.futureRequest
            }
            guard request.expiresAt > nowMilliseconds else {
                throw MindwtrSiriActionStoreError.expiredRequest
            }
        }
    }

    private static func validateResult(_ result: MindwtrSiriActionResult) throws {
        switch result.outcome {
        case .persisted:
            guard result.reason == nil else {
                throw MindwtrSiriActionStoreError.invalidResult("persisted reason")
            }
        case .rejected:
            guard result.task == nil else {
                throw MindwtrSiriActionStoreError.invalidResult("rejected task")
            }
        }

        if let task = result.task {
            let data = Data(task.utf8)
            guard data.count <= Self.maximumResultTaskBytes,
                  isJSONObject(data) else {
                throw MindwtrSiriActionStoreError.invalidResult("task")
            }
        }
    }

    private func makeReceipt(
        request: MindwtrSiriActionRequest,
        result: MindwtrSiriActionResult,
        completedAt: Double
    ) throws -> MindwtrSiriReceiptRecord {
        try Self.validateResult(result)
        return MindwtrSiriReceiptRecord(
            id: request.id,
            requestPayload: try encodeRequest(request),
            outcome: result.outcome,
            reason: result.reason,
            taskPayload: result.task.map { Data($0.utf8) },
            completedAt: completedAt
        )
    }

    private func decodeReceiptRequest(
        _ receipt: MindwtrSiriReceiptRecord
    ) throws -> MindwtrSiriActionRequest {
        guard receipt.requestPayload.count <= Self.maximumCommandBytes else {
            throw MindwtrSiriActionStoreError.corruptState("receipt request size")
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: receipt.requestPayload)
        } catch {
            throw MindwtrSiriActionStoreError.corruptState("invalid receipt request JSON")
        }
        guard let dictionary = object as? [String: Any] else {
            throw MindwtrSiriActionStoreError.corruptState("invalid receipt request shape")
        }
        try validateRequestJSONSchema(dictionary)
        let request: MindwtrSiriActionRequest
        do {
            request = try JSONDecoder().decode(
                MindwtrSiriActionRequest.self,
                from: receipt.requestPayload
            )
            try validateRequest(request, enforceCurrentTimeAt: nil)
        } catch let error as MindwtrSiriActionStoreError {
            throw error
        } catch {
            throw MindwtrSiriActionStoreError.corruptState("invalid receipt request")
        }
        return request
    }

    private func result(from receipt: MindwtrSiriReceiptRecord) throws -> MindwtrSiriActionResult {
        let task: String?
        if let taskPayload = receipt.taskPayload {
            guard taskPayload.count <= Self.maximumResultTaskBytes,
                  Self.isJSONObject(taskPayload),
                  let value = String(data: taskPayload, encoding: .utf8) else {
                throw MindwtrSiriActionStoreError.corruptState("invalid receipt task")
            }
            task = value
        } else {
            task = nil
        }
        let result = MindwtrSiriActionResult(
            outcome: receipt.outcome,
            reason: receipt.reason,
            task: task
        )
        do {
            try Self.validateResult(result)
        } catch {
            throw MindwtrSiriActionStoreError.corruptState("invalid receipt result")
        }
        return result
    }

    private func pruneReceipts(
        _ state: inout MindwtrSiriActionState,
        nowMilliseconds: Double
    ) -> Bool {
        let cutoff = nowMilliseconds - Self.receiptRetentionMilliseconds
        let originalCount = state.receipts.count
        state.receipts.removeAll { $0.completedAt < cutoff }
        return state.receipts.count != originalCount
    }

    private func encodeRequest(_ request: MindwtrSiriActionRequest) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do {
            return try encoder.encode(request)
        } catch {
            throw MindwtrSiriActionStoreError.invalidRequest("encoding")
        }
    }

    private func writeStateAtomically(_ state: MindwtrSiriActionState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data: Data
        do {
            data = try encoder.encode(state)
        } catch {
            throw MindwtrSiriActionStoreError.corruptState("could not encode valid state")
        }
        try writeDataAtomically(
            data,
            fileName: Self.stateFileName,
            sizeLimit: Self.maximumStoreBytes
        )
    }

    private func writeDataAtomically(
        _ data: Data,
        fileName: String,
        sizeLimit: Int
    ) throws {
        guard data.count <= sizeLimit else {
            if fileName == Self.snapshotFileName {
                throw MindwtrSiriActionStoreError.snapshotTooLarge
            }
            throw MindwtrSiriActionStoreError.storeTooLarge
        }

        let destinationURL = directory.appendingPathComponent(fileName, isDirectory: false)
        let temporaryURL = directory.appendingPathComponent(
            ".\(fileName).\(UUID().uuidString).tmp",
            isDirectory: false
        )
        let descriptor = siriSystemOpen(
            temporaryURL.path,
            O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
            0o600
        )
        guard descriptor >= 0 else {
            throw MindwtrSiriActionStoreError.fileOperation(
                "create a temporary file",
                siriCurrentErrno()
            )
        }

        var descriptorIsOpen = true
        var shouldRemoveTemporary = true
        defer {
            if descriptorIsOpen { _ = siriSystemClose(descriptor) }
            if shouldRemoveTemporary { _ = siriSystemUnlink(temporaryURL.path) }
        }

        try writeAll(data, to: descriptor)
        guard siriSystemFsync(descriptor) == 0 else {
            throw MindwtrSiriActionStoreError.fileOperation(
                "synchronize its temporary file",
                siriCurrentErrno()
            )
        }
        descriptorIsOpen = false
        guard siriSystemClose(descriptor) == 0 else {
            throw MindwtrSiriActionStoreError.fileOperation(
                "close its temporary file",
                siriCurrentErrno()
            )
        }

        try publicationHook?(fileName)
        guard siriSystemRename(temporaryURL.path, destinationURL.path) == 0 else {
            throw MindwtrSiriActionStoreError.fileOperation(
                "replace its file",
                siriCurrentErrno()
            )
        }
        shouldRemoveTemporary = false
        try synchronizeDirectory()
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let written = siriSystemWrite(
                    descriptor,
                    baseAddress.advanced(by: offset),
                    bytes.count - offset
                )
                if written < 0 {
                    let code = siriCurrentErrno()
                    if code == EINTR { continue }
                    throw MindwtrSiriActionStoreError.fileOperation(
                        "write its temporary file",
                        code
                    )
                }
                guard written > 0 else {
                    throw MindwtrSiriActionStoreError.fileOperation(
                        "write its temporary file",
                        EIO
                    )
                }
                offset += written
            }
        }
    }

    private func synchronizeDirectory() throws {
        let descriptor = siriSystemOpen(directory.path, O_RDONLY | O_CLOEXEC, 0)
        guard descriptor >= 0 else {
            throw MindwtrSiriActionStoreError.fileOperation(
                "open its directory for synchronization",
                siriCurrentErrno()
            )
        }
        defer { _ = siriSystemClose(descriptor) }
        guard siriSystemFsync(descriptor) == 0 else {
            throw MindwtrSiriActionStoreError.fileOperation(
                "synchronize its directory",
                siriCurrentErrno()
            )
        }
    }

    private func milliseconds(for date: Date) throws -> Double {
        let value = date.timeIntervalSince1970 * 1_000.0
        guard value.isFinite, value >= 0 else {
            throw MindwtrSiriActionStoreError.invalidRequest("timestamp")
        }
        return value
    }

    private func canonicalIdentifier(_ value: String) -> String? {
        Self.canonicalIdentifier(value)
    }

    private static func canonicalIdentifier(_ value: String) -> String? {
        guard value.utf8.count == 36,
              let parsed = UUID(uuidString: value),
              parsed.uuidString.lowercased() == value.lowercased() else {
            return nil
        }
        return parsed.uuidString.lowercased()
    }

    private func isBoundedNonempty(_ value: String, maximumBytes: Int) -> Bool {
        Self.isBoundedNonempty(value, maximumBytes: maximumBytes)
    }

    private static func isBoundedNonempty(_ value: String, maximumBytes: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximumBytes
    }

    private static func hasExpectedKeys(
        _ dictionary: [String: Any],
        allowed: Set<String>,
        required: Set<String>
    ) -> Bool {
        let keys = Set(dictionary.keys)
        return required.isSubset(of: keys) && keys.isSubset(of: allowed)
    }

    private static func isJSONObject(_ data: Data) -> Bool {
        guard let object = try? JSONSerialization.jsonObject(with: data) else {
            return false
        }
        return object is [String: Any]
    }
}

private func siriCurrentErrno() -> Int32 {
    errno
}

private func siriSystemOpen(_ path: String, _ flags: Int32, _ mode: mode_t) -> Int32 {
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

private func siriSystemClose(_ descriptor: Int32) -> Int32 {
#if canImport(Darwin)
    Darwin.close(descriptor)
#elseif canImport(Glibc)
    Glibc.close(descriptor)
#else
    -1
#endif
}

private func siriSystemFlock(_ descriptor: Int32, _ operation: Int32) -> Int32 {
#if canImport(Darwin)
    flock(descriptor, operation)
#elseif canImport(Glibc)
    flock(descriptor, operation)
#else
    -1
#endif
}

private func siriSystemWrite(
    _ descriptor: Int32,
    _ buffer: UnsafeRawPointer,
    _ count: Int
) -> Int {
#if canImport(Darwin)
    Darwin.write(descriptor, buffer, count)
#elseif canImport(Glibc)
    Glibc.write(descriptor, buffer, count)
#else
    -1
#endif
}

private func siriSystemFsync(_ descriptor: Int32) -> Int32 {
#if canImport(Darwin)
    Darwin.fsync(descriptor)
#elseif canImport(Glibc)
    Glibc.fsync(descriptor)
#else
    -1
#endif
}

private func siriSystemRename(_ source: String, _ destination: String) -> Int32 {
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

private func siriSystemUnlink(_ path: String) -> Int32 {
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
