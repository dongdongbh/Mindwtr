import CloudKit
import Foundation

/// Manages the CKContainer, custom record zone, and subscriptions.
/// All CloudKit operations go through this class.
final class CloudKitSyncManager {

    static let shared = CloudKitSyncManager()

    let containerID: String
    let zoneName: String
    let subscriptionID: String
    let operations = NativeCloudKitOperationRegistry()
    private let operationScheduler: ((CKDatabaseOperation) -> Void)?

    private(set) lazy var container = CKContainer(identifier: containerID)
    private(set) lazy var privateDB = container.privateCloudDatabase
    private(set) lazy var zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)

    // Guards against concurrent ensureZone/ensureSubscription calls.
    // Tasks awaiting the same operation share the first caller's result.
    private var zoneTask: Task<Void, Error>?
    private var subscriptionTask: Task<Void, Error>?

    init(containerIdentifier: String = "iCloud.tech.dongdongbh.mindwtr", zoneName: String = "MindwtrZone",
         subscriptionID: String = "MindwtrZoneSubscription", operationScheduler: ((CKDatabaseOperation) -> Void)? = nil) {
        containerID = containerIdentifier; self.zoneName = zoneName; self.subscriptionID = subscriptionID
        self.operationScheduler = operationScheduler
    }

    func cancelOperations() { operations.cancelOperations() }
    private func schedule(_ operation: CKDatabaseOperation, onFailure: (Error) -> Void) {
        do {
            try operations.schedule(operation) { operation in
                if let operationScheduler { operationScheduler(operation) }
                else { privateDB.add(operation) }
            }
        } catch { onFailure(error) }
    }

    private static func preservingRecordErrors(_ errors: [Error]) -> Error {
        let primary = errors[0] as NSError
        var details = primary.userInfo
        details[CKPartialErrorsByItemIDKey] = Dictionary(uniqueKeysWithValues:
            errors.enumerated().map { (AnyHashable($0.offset), $0.element) })
        return NSError(domain: primary.domain, code: primary.code, userInfo: details)
    }

    private let attachmentRecordType = "MindwtrAttachment"
    private let attachmentAssetField = "asset"

    private func fileURL(from path: String) throws -> URL {
        if path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw NSError(
                domain: "MindwtrCloudKit",
                code: 1001,
                userInfo: [NSLocalizedDescriptionKey: "Attachment file path is empty"]
            )
        }
        if let url = URL(string: path), url.isFileURL {
            return url
        }
        return URL(fileURLWithPath: path)
    }

    private func applyAttachmentMetadata(_ metadata: [String: Any], to record: CKRecord) {
        let stringFields = [
            "attachmentId",
            "ownerType",
            "ownerId",
            "title",
            "mimeType",
            "fileHash",
            "updatedAt",
            "deletedAt",
        ]
        for field in stringFields {
            if let value = metadata[field] as? String, !value.isEmpty {
                record[field] = value as CKRecordValue
            } else {
                record[field] = nil
            }
        }
        if let size = metadata["size"] as? Int64 {
            record["size"] = size as CKRecordValue
        } else if let size = metadata["size"] as? Int {
            record["size"] = Int64(size) as CKRecordValue
        } else if let size = metadata["size"] as? Double, size.isFinite {
            record["size"] = Int64(size) as CKRecordValue
        } else {
            record["size"] = nil
        }
    }

    private func attachmentMetadata(from record: CKRecord) -> [String: Any] {
        var result: [String: Any] = ["recordName": record.recordID.recordName]
        let stringFields = [
            "attachmentId",
            "ownerType",
            "ownerId",
            "title",
            "mimeType",
            "fileHash",
            "updatedAt",
            "deletedAt",
        ]
        for field in stringFields {
            if let value = record[field] as? String {
                result[field] = value
            }
        }
        if let size = record["size"] as? Int64 {
            result["size"] = size
        } else if let size = record["size"] as? Int {
            result["size"] = size
        }
        return result
    }

    func saveAttachmentAsset(recordName: String, filePath: String, metadata: [String: Any]) async throws -> [String: Any] {
        try operations.checkActive()
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
        let fetched = try await fetchRecordsByID([recordID])
        let record = fetched[recordID] ?? CKRecord(recordType: attachmentRecordType, recordID: recordID)
        applyAttachmentMetadata(metadata, to: record)
        record[attachmentAssetField] = CKAsset(fileURL: try fileURL(from: filePath))

        let op = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
        op.savePolicy = .changedKeys
        op.qualityOfService = .userInitiated
        // Moves the asset bytes up, so it gets the long transfer budget.
        CloudKitOperationTimeouts.apply(to: op, resourceSeconds: CloudKitOperationTimeouts.assetResourceSeconds)

        let savedRecord = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CKRecord, Error>) in
            var perRecordError: Error?
            op.perRecordSaveBlock = { _, result in
                if case .failure(let error) = result {
                    perRecordError = error
                }
            }
            op.modifyRecordsResultBlock = { result in
                defer { self.operations.complete(op) }
                switch result {
                case .success:
                    if let perRecordError {
                        continuation.resume(throwing: perRecordError)
                    } else {
                        continuation.resume(returning: record)
                    }
                case .failure(let error):
                    continuation.resume(throwing: perRecordError ?? error)
                }
            }
            self.schedule(op) { continuation.resume(throwing: $0) }
        }

        try operations.checkActive()
        return attachmentMetadata(from: savedRecord)
    }

    private func attachmentAsset(recordName: String) async throws -> (record: CKRecord, sourceURL: URL) {
        try operations.checkActive()
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
        let fetched = try await fetchRecordsByID([recordID])
        guard let record = fetched[recordID] else {
            throw NSError(
                domain: "MindwtrCloudKit",
                code: 1002,
                userInfo: [NSLocalizedDescriptionKey: "Attachment asset record not found"]
            )
        }
        guard let asset = record[attachmentAssetField] as? CKAsset, let sourceURL = asset.fileURL else {
            throw NSError(
                domain: "MindwtrCloudKit",
                code: 1003,
                userInfo: [NSLocalizedDescriptionKey: "Attachment asset is missing"]
            )
        }

        return (record, sourceURL)
    }

    /// Native caller consumes the SDK-owned asset while its CKRecord is still retained.
    func fetchAttachmentAsset(recordName: String, consume: @Sendable (URL, String) async throws -> Void) async throws -> String {
        let (record, sourceURL) = try await attachmentAsset(recordName: recordName)
        defer { withExtendedLifetime(record) {} }
        try operations.checkActive()
        let metadataJSON = try NativeCloudKitTransport.encode(attachmentMetadata(from: record))
        try await consume(sourceURL, metadataJSON)
        try operations.checkActive()
        return metadataJSON
    }

    func fetchAttachmentAsset(recordName: String, targetPath: String) async throws -> [String: Any] {
        let (record, sourceURL) = try await attachmentAsset(recordName: recordName)
        defer { withExtendedLifetime(record) {} }
        try operations.checkActive()
        let destinationURL = try fileURL(from: targetPath)
        let parentURL = destinationURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parentURL, withIntermediateDirectories: true)

        // Copy to a temp file in the same directory first, then atomically replace
        // the destination (#1057). The previous copy-in-place (remove destination,
        // then copy over it) could leave `destinationURL` missing or truncated if the
        // app was killed or the volume hiccuped mid-copy — a later sync would then
        // treat that truncated file as new content and re-upload it.
        let tempURL = parentURL.appendingPathComponent(".tmp-\(UUID().uuidString)-\(destinationURL.lastPathComponent)")
        if FileManager.default.fileExists(atPath: tempURL.path) {
            try? FileManager.default.removeItem(at: tempURL)
        }
        do {
            try FileManager.default.copyItem(at: sourceURL, to: tempURL)
            try operations.checkActive()
            if FileManager.default.fileExists(atPath: destinationURL.path) {
                _ = try FileManager.default.replaceItemAt(destinationURL, withItemAt: tempURL)
            } else {
                try FileManager.default.moveItem(at: tempURL, to: destinationURL)
            }
        } catch {
            try? FileManager.default.removeItem(at: tempURL)
            throw error
        }

        var metadata = attachmentMetadata(from: record)
        metadata["filePath"] = destinationURL.absoluteString
        return metadata
    }

    // MARK: - Account Status

    func accountStatus() async throws -> CKAccountStatus {
        try operations.checkActive()
        let result = try await container.accountStatus()
        try operations.checkActive()
        return result
    }

    // MARK: - Zone Management

    func ensureZone() async throws {
        try operations.checkActive()
        if let existing = zoneTask {
            try await existing.value
            try operations.checkActive()
            return
        }
        let task = Task<Void, Error> {
            let zone = CKRecordZone(zoneID: zoneID)
            let op = CKModifyRecordZonesOperation(recordZonesToSave: [zone], recordZoneIDsToDelete: nil)
            op.qualityOfService = .userInitiated
            CloudKitOperationTimeouts.apply(to: op)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                op.modifyRecordZonesResultBlock = { result in
                    defer { self.operations.complete(op) }
                    switch result {
                    case .success:
                        continuation.resume()
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }
                self.schedule(op) { continuation.resume(throwing: $0) }
            }
        }
        zoneTask = task
        do {
            try await task.value
            try operations.checkActive()
        } catch {
            zoneTask = nil // Allow retry on failure
            throw error
        }
    }

    /// Forget the cached zone setup so the next ensureZone call recreates the
    /// zone. Called after CloudKit reports the zone deleted or missing.
    func invalidateZone() {
        zoneTask = nil
    }

    // MARK: - Subscription Management

    func ensureSubscription() async throws {
        if let existing = subscriptionTask {
            try await existing.value
            return
        }
        let task = Task<Void, Error> {
            // Check if subscription already exists
            do {
                _ = try await privateDB.subscription(for: subscriptionID)
                return
            } catch let error as CKError where error.code == .unknownItem {
                // Subscription doesn't exist yet — create it
            }

            let subscription = CKRecordZoneSubscription(
                zoneID: zoneID,
                subscriptionID: subscriptionID
            )
            let notificationInfo = CKSubscription.NotificationInfo()
            notificationInfo.shouldSendContentAvailable = true // Silent push
            subscription.notificationInfo = notificationInfo

            let op = CKModifySubscriptionsOperation(
                subscriptionsToSave: [subscription],
                subscriptionIDsToDelete: nil
            )
            op.qualityOfService = .utility
            CloudKitOperationTimeouts.apply(to: op)
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                op.modifySubscriptionsResultBlock = { result in
                    defer { self.operations.complete(op) }
                    switch result {
                    case .success:
                        continuation.resume()
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }
                self.schedule(op) { continuation.resume(throwing: $0) }
            }
        }
        subscriptionTask = task
        do {
            try await task.value
        } catch {
            subscriptionTask = nil // Allow retry on failure
            throw error
        }
    }

    // MARK: - Batch Save

    /// Saves records to CloudKit using fetch-then-update to preserve system fields.
    /// Returns IDs of records that had server conflicts, and throws for non-conflict errors.
    func saveRecords(
        _ jsonRecords: [[String: Any]],
        recordType: String
    ) async throws -> [String] {
        try operations.checkActive()
        if jsonRecords.isEmpty { return [] }

        // Step 1: Fetch existing records so we have their system fields (changeTag etc).
        // Records that don't exist yet will simply not appear in the fetch results.
        let recordIDs = jsonRecords.compactMap { json -> CKRecord.ID? in
            guard let id = json["id"] as? String, !id.isEmpty else { return nil }
            return CKRecord.ID(recordName: id, zoneID: zoneID)
        }

        var existingByID: [CKRecord.ID: CKRecord] = [:]
        let fetchBatchSize = 400
        for batchStart in stride(from: 0, to: recordIDs.count, by: fetchBatchSize) {
            let batchEnd = min(batchStart + fetchBatchSize, recordIDs.count)
            let batch = Array(recordIDs[batchStart..<batchEnd])
            let fetched = try await fetchRecordsByID(batch)
            for (id, record) in fetched {
                existingByID[id] = record
            }
        }

        // Step 2: Build CKRecords — reuse fetched records (with system fields) when they exist,
        // create new CKRecords only for genuinely new records.
        var recordsToSave: [CKRecord] = []
        for json in jsonRecords {
            guard let id = json["id"] as? String, !id.isEmpty else { continue }
            let recordID = CKRecord.ID(recordName: id, zoneID: zoneID)
            if let existing = existingByID[recordID] {
                CloudKitRecordMapper.updateRecord(existing, from: json, recordType: recordType)
                if !existing.changedKeys().isEmpty {
                    recordsToSave.append(existing)
                }
            } else {
                if let newRecord = CloudKitRecordMapper.record(from: json, recordType: recordType, zoneID: zoneID) {
                    recordsToSave.append(newRecord)
                }
            }
        }

        if recordsToSave.isEmpty { return [] }

        // Step 3: Save in batches, collecting conflicts AND non-conflict errors separately.
        // The zone is atomic: one refused request fails every record in it. Smaller
        // saves keep each request light and let a refused upload resume from the
        // records that already landed (#1278). A refused batch is retried once after
        // CloudKit's interval, then halved on each further refusal; waits stay short
        // because iOS may end a background sync early.
        var conflictIDs: [String] = []
        var nonConflictErrors: [Error] = []
        var saveBatchSize = 100
        let minSaveBatchSize = 25
        let maxInlineWaitSeconds = 20.0
        var waitedSeconds = 0.0
        var retriedThisBatch = false
        var batchStart = 0
        func waitForRetry(_ errors: [Error]) async -> Bool {
            let delay = errors.compactMap { ($0 as? CKError)?.retryAfterSeconds }.max() ?? 0
            guard delay > 0, waitedSeconds + delay <= maxInlineWaitSeconds else { return false }
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return false }
            waitedSeconds += delay
            return true
        }
        while batchStart < recordsToSave.count {
            try operations.checkActive()
            let batchEnd = min(batchStart + saveBatchSize, recordsToSave.count)
            let batch = Array(recordsToSave[batchStart..<batchEnd])

            let op = CKModifyRecordsOperation(recordsToSave: batch, recordIDsToDelete: nil)
            op.savePolicy = .changedKeys
            op.qualityOfService = .userInitiated
            CloudKitOperationTimeouts.apply(to: op)

            // Serialize per-record callbacks — CloudKit dispatches on arbitrary queues.
            let cbQueue = DispatchQueue(label: "tech.dongdongbh.mindwtr.savecb")

            var operationError: Error?
            var batchConflicts: [String] = []
            var batchErrors: [Error] = []
            do {
                (batchConflicts, batchErrors) = try await withCheckedThrowingContinuation {
                    (continuation: CheckedContinuation<([String], [Error]), Error>) in
                    var conflicts: [String] = []
                    var perRecordErrors: [Error] = []

                    op.perRecordSaveBlock = { recordID, result in
                        cbQueue.sync {
                            if case .failure(let error) = result {
                                if let ckError = error as? CKError,
                                   ckError.code == .serverRecordChanged {
                                    conflicts.append(recordID.recordName)
                                } else {
                                    perRecordErrors.append(error)
                                }
                            }
                        }
                    }
                    op.modifyRecordsResultBlock = { result in
                        defer { self.operations.complete(op) }
                        cbQueue.sync {
                            switch result {
                            case .success:
                                continuation.resume(returning: (conflicts, perRecordErrors))
                            case .failure(let error):
                                if let ckError = error as? CKError,
                                   ckError.code == .partialFailure {
                                    // Partial failure: per-record callbacks already captured details
                                    continuation.resume(returning: (conflicts, perRecordErrors))
                                } else {
                                    continuation.resume(throwing: error)
                                }
                            }
                        }
                    }
                    self.schedule(op) { continuation.resume(throwing: $0) }
                }
            } catch {
                operationError = error
                batchErrors = [error]
            }

            if batchErrors.isEmpty {
                conflictIDs.append(contentsOf: batchConflicts)
                batchStart = batchEnd
                retriedThisBatch = false
                continue
            }
            if !retriedThisBatch, await waitForRetry(batchErrors) {
                retriedThisBatch = true
                continue
            }
            if retriedThisBatch, saveBatchSize > minSaveBatchSize, await waitForRetry(batchErrors) {
                saveBatchSize = max(minSaveBatchSize, saveBatchSize / 2)
                continue
            }
            // A whole-operation refusal keeps its original error for the sync layer.
            if let operationError { throw operationError }
            conflictIDs.append(contentsOf: batchConflicts)
            nonConflictErrors.append(contentsOf: batchErrors)
            // Stop at the first refused batch; the next sync resumes from here.
            break
        }

        // If there were non-conflict per-record errors, log them and throw
        if !nonConflictErrors.isEmpty {
            let descriptions = nonConflictErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
            NSLog("[CloudKitSyncManager] saveRecords had \(nonConflictErrors.count) non-conflict error(s): \(descriptions)")
            // An atomic zone save reports the one record that failed with its real
            // error and every other record with `batchRequestFailed` ("Atomic
            // failure"). The victims come first in callback order, so showing
            // errors[0] hid the cause from the Sync screen and the shared log
            // (App Store 1.2.7 report). Prefer the culprit.
            let isBatchVictim: (Error) -> Bool = { error in
                (error as? CKError)?.code == .batchRequestFailed
            }
            let primary = nonConflictErrors.first { !isBatchVictim($0) } ?? nonConflictErrors[0]
            var message = primary.localizedDescription
            if isBatchVictim(primary) {
                message = "CloudKit rejected the whole batch because one record in it failed, and reported no record-level cause (\(nonConflictErrors.count) records): \(message)"
            }
            var userInfo: [String: Any] = [
                NSLocalizedDescriptionKey: message,
                NSUnderlyingErrorKey: primary,
                CKPartialErrorsByItemIDKey: Dictionary(uniqueKeysWithValues:
                    nonConflictErrors.enumerated().map { (AnyHashable($0.offset), $0.element) }),
            ]
            if !conflictIDs.isEmpty {
                userInfo["conflictIDs"] = conflictIDs.joined(separator: ",")
                userInfo[NSLocalizedDescriptionKey] = "CloudKit save failed with both conflicts and non-conflict errors: \(message)"
            }
            throw NSError(domain: "CloudKitSync", code: 2, userInfo: userInfo)
        }

        try operations.checkActive()
        return conflictIDs
    }

    /// Fetch records by ID, returning only those that exist on the server.
    private func fetchRecordsByID(_ ids: [CKRecord.ID]) async throws -> [CKRecord.ID: CKRecord] {
        try operations.checkActive()
        if ids.isEmpty { return [:] }
        let op = CKFetchRecordsOperation(recordIDs: ids)
        op.qualityOfService = .userInitiated
        // This is how both saveAttachmentAsset and fetchAttachmentAsset pull an
        // existing attachment record down, asset bytes included, so it gets the
        // long transfer budget too. (saveRecords also calls it, for conflict
        // re-reads of plain records, which finish well inside either budget.)
        CloudKitOperationTimeouts.apply(to: op, resourceSeconds: CloudKitOperationTimeouts.assetResourceSeconds)

        let cbQueue = DispatchQueue(label: "tech.dongdongbh.mindwtr.fetchcb")

        return try await withCheckedThrowingContinuation { continuation in
            var results: [CKRecord.ID: CKRecord] = [:]
            var perRecordErrors: [Error] = []
            op.perRecordResultBlock = { recordID, result in
                cbQueue.sync {
                    switch result {
                    case .success(let record):
                        results[recordID] = record
                    case .failure(let error):
                        // unknownItem means record doesn't exist yet — that's fine, skip it
                        if let ckError = error as? CKError,
                           ckError.code == .unknownItem {
                            return
                        }
                        perRecordErrors.append(error)
                    }
                }
            }
            op.fetchRecordsResultBlock = { overallResult in
                defer { self.operations.complete(op) }
                cbQueue.sync {
                    switch overallResult {
                    case .success:
                        if !perRecordErrors.isEmpty {
                            let descriptions = perRecordErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
                            NSLog("[CloudKitSyncManager] fetchRecordsByID had \(perRecordErrors.count) per-record error(s): \(descriptions)")
                            continuation.resume(throwing: CloudKitSyncManager.preservingRecordErrors(perRecordErrors))
                            return
                        }
                        continuation.resume(returning: results)
                    case .failure(let error):
                        if let ckError = error as? CKError,
                           ckError.code == .partialFailure {
                            // Some records may be unknownItem (new records) — ignore only those.
                            if perRecordErrors.isEmpty {
                                continuation.resume(returning: results)
                            } else {
                                let descriptions = perRecordErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
                                NSLog("[CloudKitSyncManager] fetchRecordsByID had \(perRecordErrors.count) real partial error(s): \(descriptions)")
                                continuation.resume(throwing: CloudKitSyncManager.preservingRecordErrors(perRecordErrors))
                            }
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }
            self.schedule(op) { continuation.resume(throwing: $0) }
        }
    }

    // MARK: - Batch Delete

    func deleteRecords(recordType: String, recordIDs: [String]) async throws {
        try operations.checkActive()
        if recordIDs.isEmpty { return }
        let ckIDs = recordIDs.map { CKRecord.ID(recordName: $0, zoneID: zoneID) }

        let batchSize = 400
        for batchStart in stride(from: 0, to: ckIDs.count, by: batchSize) {
            try operations.checkActive()
            let batchEnd = min(batchStart + batchSize, ckIDs.count)
            let batch = Array(ckIDs[batchStart..<batchEnd])

            let op = CKModifyRecordsOperation(recordsToSave: nil, recordIDsToDelete: batch)
            op.qualityOfService = .utility
            CloudKitOperationTimeouts.apply(to: op)
            let cbQueue = DispatchQueue(label: "tech.dongdongbh.mindwtr.deletecb")

            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                var realErrors: [Error] = []

                op.perRecordDeleteBlock = { recordID, result in
                    cbQueue.sync {
                        if case .failure(let error) = result {
                            // unknownItem means already deleted — safe to ignore
                            if let ckError = error as? CKError,
                               ckError.code == .unknownItem {
                                return
                            }
                            realErrors.append(error)
                        }
                    }
                }

                op.modifyRecordsResultBlock = { result in
                    defer { self.operations.complete(op) }
                    cbQueue.sync {
                        switch result {
                        case .success:
                            continuation.resume()
                        case .failure(let error):
                            if let ckError = error as? CKError,
                               ckError.code == .partialFailure {
                                // Only suppress if every per-record error was unknownItem
                                if realErrors.isEmpty {
                                    continuation.resume()
                                } else {
                                    let descriptions = realErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
                                    NSLog("[CloudKitSyncManager] deleteRecords had \(realErrors.count) real error(s): \(descriptions)")
                                    continuation.resume(throwing: CloudKitSyncManager.preservingRecordErrors(realErrors))
                                }
                            } else {
                                continuation.resume(throwing: error)
                            }
                        }
                    }
                }
                self.schedule(op) { continuation.resume(throwing: $0) }
            }
        }
    }

    // MARK: - Full Fetch

    /// CloudKit server error code for queries against a record type that does
    /// not yet exist in the container schema (Development environment).
    /// Not published by Apple; determined empirically, stable across iOS 16-18.
    private static let ckServerErrorUnknownRecordType = 2003

    /// Fetches all records of a given type from the custom zone.
    /// Returns an empty array when the record type does not exist yet in the
    /// CloudKit schema (first sync). The subsequent write phase auto-creates
    /// the record type in the Development environment.
    func fetchAllRecords(recordType: String, maximumRecords: Int? = nil, maximumEncodedBytes: Int? = nil) async throws -> [CKRecord] {
        try operations.checkActive()
        var allRecords: [CKRecord] = []
        var encodedBytes = 2
        func append(_ records: [CKRecord]) throws {
            if let maximumRecords, allRecords.count + records.count > maximumRecords { throw NativeCloudKitTransportError(.invalidInput) }
            if let maximumEncodedBytes {
                var count = allRecords.count
                for record in records {
                    encodedBytes += try JSONSerialization.data(withJSONObject: CloudKitRecordMapper.json(from: record), options: [.sortedKeys]).count + (count > 0 ? 1 : 0)
                    count += 1
                    if encodedBytes > maximumEncodedBytes { throw NativeCloudKitTransportError(.invalidInput) }
                }
            }
            allRecords.append(contentsOf: records)
        }
        var cursor: CKQueryOperation.Cursor?

        let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
        let initialOp = CKQueryOperation(query: query)
        initialOp.zoneID = zoneID
        initialOp.qualityOfService = .userInitiated
        CloudKitOperationTimeouts.apply(to: initialOp)

        do {
            let firstResult = try await runQueryOperation(initialOp)
            try operations.checkActive()
            try append(firstResult.records)
            cursor = firstResult.cursor
        } catch {
            if Self.isUnknownRecordTypeError(error) { return [] }
            throw error
        }

        while let nextCursor = cursor {
            try operations.checkActive()
            let continueOp = CKQueryOperation(cursor: nextCursor)
            continueOp.zoneID = zoneID
            continueOp.qualityOfService = .userInitiated
            CloudKitOperationTimeouts.apply(to: continueOp)
            let result = try await runQueryOperation(continueOp)
            try operations.checkActive()
            try append(result.records)
            cursor = result.cursor
        }

        try operations.checkActive()
        return allRecords
    }

    /// Locale-independent check for a missing record type.
    /// CKErrorUnknownItem: client framework doesn't recognize the type.
    /// CKErrorServerRejectedRequest with underlying code 2003: server rejects
    /// the query because the type doesn't exist in the schema yet.
    private static func isUnknownRecordTypeError(_ error: Error) -> Bool {
        if let ckError = error as? CKError {
            if ckError.code == .unknownItem { return true }
            if ckError.code == .serverRejectedRequest,
               let underlying = ckError.userInfo[NSUnderlyingErrorKey] as? NSError,
               underlying.code == ckServerErrorUnknownRecordType {
                return true
            }
        }
        return false
    }

    private func runQueryOperation(_ op: CKQueryOperation) async throws -> (records: [CKRecord], cursor: CKQueryOperation.Cursor?) {
        let collector = NativeCloudKitQueryCollector()
        return try await withCheckedThrowingContinuation { continuation in
            op.recordMatchedBlock = { _, result in collector.matched(result) }
            op.queryResultBlock = { result in
                defer { self.operations.complete(op) }
                do { continuation.resume(returning: try collector.finish(result)) }
                catch { continuation.resume(throwing: error) }
            }
            self.schedule(op) { continuation.resume(throwing: $0) }
        }
    }
}
