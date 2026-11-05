import CloudKit
import CoreFoundation
import Foundation

public struct NativeCloudKitTransportError: Error, LocalizedError, Sendable {
    public enum Code: String, Sendable {
        case invalidInput = "INVALID_INPUT", cancelled = "CANCELLED"
        case zoneGone = "ERR_CLOUDKIT_ZONE_GONE", attachmentNotFound = "ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND"
        case transient = "ERR_CLOUDKIT_TRANSIENT", unavailable = "ERR_CLOUDKIT_UNAVAILABLE"
    }
    public let code: Code
    public let retryAfterSeconds: Double?
    public var errorDescription: String? {
        switch code {
        case .invalidInput: return "The CloudKit request is invalid."
        case .cancelled: return "The CloudKit request was cancelled."
        case .zoneGone: return "The CloudKit zone is unavailable."
        case .attachmentNotFound: return "The CloudKit attachment is no longer available."
        case .transient: return "The CloudKit request could not finish. Try again later."
        case .unavailable: return "CloudKit is unavailable."
        }
    }
    init(_ code: Code, retryAfterSeconds: Double? = nil) { self.code = code; self.retryAfterSeconds = retryAfterSeconds }
}

/// One foreground transport's SDK operations. Retirement is sticky; terminal callbacks release each entry.
final class NativeCloudKitOperationRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var retired = false
    private var operations: [ObjectIdentifier: CKDatabaseOperation] = [:]
    func checkActive() throws {
        lock.lock(); defer { lock.unlock() }
        if retired || Task.isCancelled { throw CancellationError() }
    }
    func schedule(_ operation: CKDatabaseOperation, add: (CKDatabaseOperation) -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard !retired, !Task.isCancelled else { throw CancellationError() }
        operations[ObjectIdentifier(operation)] = operation
        // SDK add only queues the operation; no SDK/network wait occurs under this lock.
        add(operation)
    }
    func complete(_ operation: CKDatabaseOperation) {
        lock.lock(); defer { lock.unlock() }; operations.removeValue(forKey: ObjectIdentifier(operation))
    }
    func cancelOperations() {
        lock.lock(); retired = true; let pending = Array(operations.values); lock.unlock()
        pending.forEach { $0.cancel() }
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return operations.count }
}

/// Serializes arbitrary query callback queues and never turns a matched-record failure into a partial snapshot.
final class NativeCloudKitQueryCollector: @unchecked Sendable {
    private let queue = DispatchQueue(label: "tech.dongdongbh.mindwtr.cloudkit.querycb")
    private var records: [CKRecord] = []
    private var errors: [Error] = []
    func matched(_ result: Result<CKRecord, Error>) {
        queue.sync {
            switch result { case .success(let record): records.append(record); case .failure(let error): errors.append(error) }
        }
    }
    func finish(_ result: Result<CKQueryOperation.Cursor?, Error>) throws -> (records: [CKRecord], cursor: CKQueryOperation.Cursor?) {
        try queue.sync {
            var failures = errors
            if case .failure(let error) = result, !records.isEmpty || !failures.isEmpty { failures.append(error) }
            if !failures.isEmpty {
                // A top-level partial failure cannot be mistaken for an initially absent schema.
                throw NSError(domain: CKErrorDomain, code: CKError.Code.partialFailure.rawValue, userInfo: [
                    CKPartialErrorsByItemIDKey: Dictionary(uniqueKeysWithValues: failures.enumerated().map { (AnyHashable($0.offset), $0.element) })])
            }
            switch result {
            case .success(let cursor): return (records, cursor)
            case .failure(let error): throw error
            }
        }
    }
}

/// Foreground-only SDK facade. Every instance requires its explicit container/zone and owns one cancellable job.
public actor NativeCloudKitTransport {
    public static let maximumJSONBytes = 16 * 1_024 * 1_024
    public static let maximumRecords = 100_000
    private let manager: CloudKitSyncManager

    public init(containerIdentifier: String, zoneName: String) throws {
        try Self.validateContainer(containerIdentifier, zoneName: zoneName)
        manager = CloudKitSyncManager(containerIdentifier: containerIdentifier, zoneName: zoneName)
    }
    init(manager: CloudKitSyncManager) { self.manager = manager }

    public func cancelOperations() { manager.cancelOperations() }

    public func accountStatus() async throws -> String {
        try await run {
            switch try await self.manager.accountStatus() {
            case .available: return "available"
            case .noAccount: return "noAccount"
            case .restricted: return "restricted"
            case .temporarilyUnavailable: return "temporarilyUnavailable"
            case .couldNotDetermine: return "unknown"
            @unknown default: return "unknown"
            }
        }
    }
    public func ensureZone() async throws { try await run { try await self.manager.ensureZone() } }

    public func fetchAllRecords(recordType: String) async throws -> String {
        try Self.validateRecordType(recordType)
        return try await run {
            let records = try await self.manager.fetchAllRecords(recordType: recordType,
                maximumRecords: Self.maximumRecords, maximumEncodedBytes: Self.maximumJSONBytes)
            return try Self.encode(records.map { Self.mappedRecord($0) })
        }
    }
    public func saveRecords(recordType: String, recordsJSON: String) async throws -> [String] {
        let records = try Self.records(recordsJSON, recordType: recordType)
        return try await run { try await self.manager.saveRecords(records, recordType: recordType) }
    }
    public func deleteRecords(recordType: String, recordIDs: [String]) async throws {
        try Self.validateRecordType(recordType, allowAttachments: true)
        guard recordIDs.count <= Self.maximumRecords, recordIDs.allSatisfy(Self.identifier),
              Set(recordIDs.map { Data($0.utf8) }).count == recordIDs.count else { throw NativeCloudKitTransportError(.invalidInput) }
        _ = try Self.encode(recordIDs)
        try await run { try await self.manager.deleteRecords(recordType: recordType, recordIDs: recordIDs) }
    }
    public func saveAttachmentAsset(recordName: String, filePath: String, metadataJSON: String) async throws -> String {
        guard Self.identifier(recordName) else { throw NativeCloudKitTransportError(.invalidInput) }
        try Self.validatePath(filePath)
        let metadata = try Self.metadata(metadataJSON, recordName: recordName)
        return try await run { try Self.encode(await self.manager.saveAttachmentAsset(recordName: recordName, filePath: filePath, metadata: metadata)) }
    }
    public func fetchAttachmentAsset(recordName: String, targetPath: String) async throws -> String {
        guard Self.identifier(recordName) else { throw NativeCloudKitTransportError(.invalidInput) }
        try Self.validatePath(targetPath)
        return try await run(attachment: true) { try Self.encode(await self.manager.fetchAttachmentAsset(recordName: recordName, targetPath: targetPath)) }
    }

    /// The URL comes only from the SDK asset; the consumer must adopt/copy it before returning.
    public func fetchAttachmentAsset(recordName: String, consume: @Sendable (URL, String) async throws -> Void) async throws -> String {
        guard Self.identifier(recordName) else { throw NativeCloudKitTransportError(.invalidInput) }
        return try await run(attachment: true) {
            try await self.manager.fetchAttachmentAsset(recordName: recordName, consume: consume)
        }
    }

    private func run<T>(attachment: Bool = false, _ body: () async throws -> T) async throws -> T {
        let original = manager
        do {
            return try await withTaskCancellationHandler {
                try original.operations.checkActive()
                let result = try await body()
                try original.operations.checkActive()
                return result
            } onCancel: { original.cancelOperations() }
        } catch { throw Self.classify(error, attachment: attachment) }
    }

    static func validateContainer(_ container: String, zoneName: String) throws {
        guard container.hasPrefix("iCloud."), container.utf8.count <= 255,
              container.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty }),
              container.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 46 }),
              identifier(zoneName) else { throw NativeCloudKitTransportError(.invalidInput) }
    }
    static func identifier(_ text: String) -> Bool {
        !text.isEmpty && text.utf8.count <= 4_096 && !text.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
    static func validateRecordType(_ name: String, allowAttachments: Bool = false) throws {
        guard CloudKitRecordMapper.allTypes.contains(name) || allowAttachments && name == "MindwtrAttachment" else {
            throw NativeCloudKitTransportError(.invalidInput)
        }
    }
    static func validatePath(_ path: String) throws {
        guard path.hasPrefix("/"), !path.hasSuffix("/"), path.utf8.count <= 16_384,
              !path.contains("://"), !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }) else {
            throw NativeCloudKitTransportError(.invalidInput)
        }
    }
    private static func parse(_ json: String) throws -> Any {
        guard json.utf8.count <= maximumJSONBytes else { throw NativeCloudKitTransportError(.invalidInput) }
        do { return try JSONDecoder().decode(NativeCloudKitJSON.self, from: Data(json.utf8)).foundation }
        catch { throw NativeCloudKitTransportError(.invalidInput) }
    }
    static func encode(_ value: Any) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard bytes.count <= maximumJSONBytes else { throw NativeCloudKitTransportError(.invalidInput) }
        return String(decoding: bytes, as: UTF8.self)
    }
    private static func integer(_ value: Any) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              value as? Int64 != nil else { return false }
        return true
    }
    static func records(_ json: String, recordType: String) throws -> [[String: Any]] {
        try validateRecordType(recordType)
        guard let values = try parse(json) as? [[String: Any]], values.count <= maximumRecords else { throw NativeCloudKitTransportError(.invalidInput) }
        var ids = Set<Data>()
        let specs = CloudKitRecordMapper.fieldSpecsForType(recordType)
        for value in values {
            guard let id = value["id"] as? String, identifier(id), ids.insert(Data(id.utf8)).inserted else { throw NativeCloudKitTransportError(.invalidInput) }
            for spec in specs {
                guard let field = value[spec.jsKey], !(field is NSNull) else { continue }
                let valid: Bool
                switch spec.kind {
                case .string, .date: valid = field is String
                case .int: valid = integer(field)
                case .bool: valid = (field as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true
                case .stringArray: valid = field is [String]
                case .jsonString: valid = field is String || field is [Any] || field is [String: Any]
                }
                guard valid else { throw NativeCloudKitTransportError(.invalidInput) }
            }
        }
        return values
    }
    static func metadata(_ json: String, recordName: String) throws -> [String: Any] {
        guard let value = try parse(json) as? [String: Any],
              Set(value.keys).isSubset(of: ["recordName", "attachmentId", "ownerType", "ownerId", "title", "mimeType", "size", "fileHash", "updatedAt", "deletedAt", "filePath"]),
              let attachment = value["attachmentId"] as? String, identifier(attachment),
              let owner = value["ownerId"] as? String, identifier(owner),
              let type = value["ownerType"] as? String, ["task", "project"].contains(type),
              value["title"] is String, value["updatedAt"] is String else { throw NativeCloudKitTransportError(.invalidInput) }
        for field in ["recordName", "mimeType", "fileHash", "deletedAt", "filePath"] {
            if let item = value[field], !(item is String) { throw NativeCloudKitTransportError(.invalidInput) }
        }
        if let name = value["recordName"] as? String, Data(name.utf8) != Data(recordName.utf8) { throw NativeCloudKitTransportError(.invalidInput) }
        if let size = value["size"], !integer(size) || ((size as? NSNumber)?.doubleValue ?? -1) < 0 { throw NativeCloudKitTransportError(.invalidInput) }
        return value
    }

    static func mappedRecord(_ record: CKRecord) -> [String: Any] {
        var result = CloudKitRecordMapper.json(from: record)
        // Reuse the mapper; decode its nested JSON fields through the same byte-preserving boundary.
        for spec in CloudKitRecordMapper.fieldSpecsForType(record.recordType) {
            if case .jsonString = spec.kind, let json = record[spec.ckKey] as? String,
               let decoded = try? JSONDecoder().decode(NativeCloudKitJSON.self, from: Data(json.utf8)) {
                result[spec.jsKey] = decoded.foundation
            }
        }
        return result
    }

    static func classify(_ error: Error, attachment: Bool = false) -> NativeCloudKitTransportError {
        if let known = error as? NativeCloudKitTransportError { return known }
        let errors = nested(error)
        if error is CancellationError || errors.contains(where: { $0.domain == CKErrorDomain && $0.code == CKError.Code.operationCancelled.rawValue }) {
            return NativeCloudKitTransportError(.cancelled)
        }
        if errors.contains(where: { $0.domain == CKErrorDomain && [CKError.Code.zoneNotFound.rawValue, CKError.Code.userDeletedZone.rawValue].contains($0.code) }) {
            return NativeCloudKitTransportError(.zoneGone)
        }
        if attachment && CloudKitAttachmentErrorClassifier.isTerminalNotFound(error) { return NativeCloudKitTransportError(.attachmentNotFound) }
        let retry = errors.compactMap { ($0.userInfo[CKErrorRetryAfterKey] as? NSNumber)?.doubleValue }.filter { $0.isFinite && $0 > 0 }.max()
        let transient: Set<Int> = [CKError.Code.networkFailure.rawValue, CKError.Code.networkUnavailable.rawValue,
            CKError.Code.requestRateLimited.rawValue, CKError.Code.serviceUnavailable.rawValue, CKError.Code.zoneBusy.rawValue,
            CKError.Code.serverResponseLost.rawValue, CKError.Code.batchRequestFailed.rawValue]
        return NativeCloudKitTransportError(errors.contains { $0.domain == CKErrorDomain && transient.contains($0.code) } ? .transient : .unavailable,
                                           retryAfterSeconds: retry)
    }
    private static func nested(_ error: Error, depth: Int = 0) -> [NSError] {
        guard depth < 8 else { return [] }
        let original = error as NSError
        let partial = original.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: Error] ?? [:]
        let underlying = (original.userInfo[NSUnderlyingErrorKey] as? Error).map { nested($0, depth: depth + 1) } ?? []
        return [original] + partial.values.flatMap { nested($0, depth: depth + 1) } + underlying
    }
}

/// Scoped JSON boundary: Swift strings are decoded directly and boxed from bytes, retaining leading BOMs.
private indirect enum NativeCloudKitJSON: Decodable {
    case null, bool(Bool), string(String), signed(Int64), unsigned(UInt64), number(Double)
    case array([NativeCloudKitJSON]), object([(String, NativeCloudKitJSON)])
    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { return nil }
    }
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .bool(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode(Int64.self) { self = .signed(item) }
        else if let item = try? value.decode(UInt64.self) { self = .unsigned(item) }
        else if let item = try? value.decode(Double.self), item.isFinite { self = .number(item) }
        else if let item = try? value.decode([NativeCloudKitJSON].self) { self = .array(item) }
        else {
            let object = try decoder.container(keyedBy: Key.self)
            self = .object(try object.allKeys.map { ($0.stringValue, try object.decode(NativeCloudKitJSON.self, forKey: $0)) })
        }
    }
    var foundation: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let value): return NSNumber(value: value)
        case .signed(let value): return NSNumber(value: value)
        case .unsigned(let value): return NSNumber(value: value)
        case .number(let value): return NSNumber(value: value)
        case .string(let value): return String(decoding: value.utf8, as: UTF8.self) as NSString
        case .array(let values): return values.map { $0.foundation } as NSArray
        case .object(let values):
            let object = NSMutableDictionary(capacity: values.count)
            for (name, value) in values { object.setObject(value.foundation, forKey: String(decoding: name.utf8, as: UTF8.self) as NSString) }
            return object
        }
    }
}
