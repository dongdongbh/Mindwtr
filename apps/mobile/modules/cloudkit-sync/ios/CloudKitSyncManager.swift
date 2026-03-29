import CloudKit
import Foundation

/// Manages the CKContainer, custom record zone, and subscriptions.
/// All CloudKit operations go through this class.
final class CloudKitSyncManager {

    static let shared = CloudKitSyncManager()

    let containerID = "iCloud.tech.dongdongbh.mindwtr"
    let zoneName = "MindwtrZone"
    let subscriptionID = "MindwtrZoneSubscription"

    private(set) lazy var container = CKContainer(identifier: containerID)
    private(set) lazy var privateDB = container.privateCloudDatabase
    private(set) lazy var zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)

    // Guards against concurrent ensureZone/ensureSubscription calls.
    // Tasks awaiting the same operation share the first caller's result.
    private var zoneTask: Task<Void, Error>?
    private var subscriptionTask: Task<Void, Error>?

    private init() {}

    // MARK: - Account Status

    func accountStatus() async throws -> CKAccountStatus {
        return try await container.accountStatus()
    }

    // MARK: - Zone Management

    func ensureZone() async throws {
        if let existing = zoneTask {
            try await existing.value
            return
        }
        let task = Task<Void, Error> {
            let zone = CKRecordZone(zoneID: zoneID)
            let op = CKModifyRecordZonesOperation(recordZonesToSave: [zone], recordZoneIDsToDelete: nil)
            op.qualityOfService = .userInitiated
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                op.modifyRecordZonesResultBlock = { result in
                    switch result {
                    case .success:
                        continuation.resume()
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }
                privateDB.add(op)
            }
        }
        zoneTask = task
        do {
            try await task.value
        } catch {
            zoneTask = nil // Allow retry on failure
            throw error
        }
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
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                op.modifySubscriptionsResultBlock = { result in
                    switch result {
                    case .success:
                        continuation.resume()
                    case .failure(let error):
                        continuation.resume(throwing: error)
                    }
                }
                privateDB.add(op)
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
                recordsToSave.append(existing)
            } else {
                if let newRecord = CloudKitRecordMapper.record(from: json, recordType: recordType, zoneID: zoneID) {
                    recordsToSave.append(newRecord)
                }
            }
        }

        if recordsToSave.isEmpty { return [] }

        // Step 3: Save in batches, collecting conflicts AND non-conflict errors separately.
        var conflictIDs: [String] = []
        var nonConflictErrors: [Error] = []
        let saveBatchSize = 400
        for batchStart in stride(from: 0, to: recordsToSave.count, by: saveBatchSize) {
            let batchEnd = min(batchStart + saveBatchSize, recordsToSave.count)
            let batch = Array(recordsToSave[batchStart..<batchEnd])

            let op = CKModifyRecordsOperation(recordsToSave: batch, recordIDsToDelete: nil)
            op.savePolicy = .changedKeys
            op.qualityOfService = .userInitiated

            // Serialize per-record callbacks — CloudKit dispatches on arbitrary queues.
            let cbQueue = DispatchQueue(label: "tech.dongdongbh.mindwtr.savecb")

            let (batchConflicts, batchErrors) = try await withCheckedThrowingContinuation {
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
                privateDB.add(op)
            }
            conflictIDs.append(contentsOf: batchConflicts)
            nonConflictErrors.append(contentsOf: batchErrors)
        }

        // If there were non-conflict per-record errors, log them and throw
        if !nonConflictErrors.isEmpty {
            let descriptions = nonConflictErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
            NSLog("[CloudKitSyncManager] saveRecords had \(nonConflictErrors.count) non-conflict error(s): \(descriptions)")
            var userInfo: [String: Any] = [
                NSLocalizedDescriptionKey: nonConflictErrors[0].localizedDescription,
                NSUnderlyingErrorKey: nonConflictErrors[0],
            ]
            if !conflictIDs.isEmpty {
                userInfo["conflictIDs"] = conflictIDs.joined(separator: ",")
                userInfo[NSLocalizedDescriptionKey] = "CloudKit save failed with both conflicts and non-conflict errors: \(nonConflictErrors[0].localizedDescription)"
            }
            throw NSError(domain: "CloudKitSync", code: 2, userInfo: userInfo)
        }

        return conflictIDs
    }

    /// Fetch records by ID, returning only those that exist on the server.
    private func fetchRecordsByID(_ ids: [CKRecord.ID]) async throws -> [CKRecord.ID: CKRecord] {
        if ids.isEmpty { return [:] }
        let op = CKFetchRecordsOperation(recordIDs: ids)
        op.qualityOfService = .userInitiated

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
                cbQueue.sync {
                    switch overallResult {
                    case .success:
                        if !perRecordErrors.isEmpty {
                            let descriptions = perRecordErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
                            NSLog("[CloudKitSyncManager] fetchRecordsByID had \(perRecordErrors.count) per-record error(s): \(descriptions)")
                            continuation.resume(throwing: perRecordErrors[0])
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
                                continuation.resume(throwing: perRecordErrors[0])
                            }
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }
            privateDB.add(op)
        }
    }

    // MARK: - Batch Delete

    func deleteRecords(recordType: String, recordIDs: [String]) async throws {
        if recordIDs.isEmpty { return }
        let ckIDs = recordIDs.map { CKRecord.ID(recordName: $0, zoneID: zoneID) }

        let batchSize = 400
        for batchStart in stride(from: 0, to: ckIDs.count, by: batchSize) {
            let batchEnd = min(batchStart + batchSize, ckIDs.count)
            let batch = Array(ckIDs[batchStart..<batchEnd])

            let op = CKModifyRecordsOperation(recordsToSave: nil, recordIDsToDelete: batch)
            op.qualityOfService = .utility
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
                                    continuation.resume(throwing: realErrors[0])
                                }
                            } else {
                                continuation.resume(throwing: error)
                            }
                        }
                    }
                }
                privateDB.add(op)
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
    func fetchAllRecords(recordType: String) async throws -> [CKRecord] {
        var allRecords: [CKRecord] = []
        var cursor: CKQueryOperation.Cursor?

        let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
        let initialOp = CKQueryOperation(query: query)
        initialOp.zoneID = zoneID
        initialOp.qualityOfService = .userInitiated

        do {
            let firstResult = try await runQueryOperation(initialOp)
            allRecords.append(contentsOf: firstResult.records)
            cursor = firstResult.cursor
        } catch {
            if Self.isUnknownRecordTypeError(error) { return [] }
            throw error
        }

        while let nextCursor = cursor {
            let continueOp = CKQueryOperation(cursor: nextCursor)
            continueOp.zoneID = zoneID
            continueOp.qualityOfService = .userInitiated
            let result = try await runQueryOperation(continueOp)
            allRecords.append(contentsOf: result.records)
            cursor = result.cursor
        }

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
        return try await withCheckedThrowingContinuation { continuation in
            var records: [CKRecord] = []
            op.recordMatchedBlock = { _, result in
                if case .success(let record) = result {
                    records.append(record)
                }
            }
            op.queryResultBlock = { result in
                switch result {
                case .success(let cursor):
                    continuation.resume(returning: (records, cursor))
                case .failure(let error):
                    continuation.resume(throwing: error)
                }
            }
            privateDB.add(op)
        }
    }
}
