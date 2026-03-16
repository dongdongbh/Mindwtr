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

    private var zoneCreated = false
    private var subscriptionCreated = false

    private init() {}

    // MARK: - Account Status

    func accountStatus() async throws -> CKAccountStatus {
        return try await container.accountStatus()
    }

    // MARK: - Zone Management

    func ensureZone() async throws {
        if zoneCreated { return }
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
        zoneCreated = true
    }

    // MARK: - Subscription Management

    func ensureSubscription() async throws {
        if subscriptionCreated { return }

        // Check if subscription already exists
        do {
            _ = try await privateDB.subscription(for: subscriptionID)
            subscriptionCreated = true
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
        subscriptionCreated = true
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

            let (batchConflicts, batchErrors) = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<([String], [Error]), Error>) in
                var conflicts: [String] = []
                var perRecordErrors: [Error] = []

                op.perRecordSaveBlock = { recordID, result in
                    if case .failure(let error) = result {
                        if let ckError = error as? CKError,
                           ckError.code == .serverRecordChanged {
                            conflicts.append(recordID.recordName)
                        } else {
                            perRecordErrors.append(error)
                        }
                    }
                }
                op.modifyRecordsResultBlock = { result in
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
                privateDB.add(op)
            }
            conflictIDs.append(contentsOf: batchConflicts)
            nonConflictErrors.append(contentsOf: batchErrors)
        }

        // If there were non-conflict per-record errors, log them and throw
        if !nonConflictErrors.isEmpty {
            let descriptions = nonConflictErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
            NSLog("[CloudKitSyncManager] saveRecords had \(nonConflictErrors.count) non-conflict error(s): \(descriptions)")
            // Still return conflicts so the caller can handle them, but also surface the errors
            if conflictIDs.isEmpty {
                throw nonConflictErrors[0]
            }
            // If we have both conflicts and errors, log the errors but return conflicts
            // so the caller can retry. The errors are logged above.
        }

        return conflictIDs
    }

    /// Fetch records by ID, returning only those that exist on the server.
    private func fetchRecordsByID(_ ids: [CKRecord.ID]) async throws -> [CKRecord.ID: CKRecord] {
        if ids.isEmpty { return [:] }
        let op = CKFetchRecordsOperation(recordIDs: ids)
        op.qualityOfService = .userInitiated

        return try await withCheckedThrowingContinuation { continuation in
            var results: [CKRecord.ID: CKRecord] = [:]
            op.perRecordResultBlock = { recordID, result in
                if case .success(let record) = result {
                    results[recordID] = record
                }
                // .unknownItem means record doesn't exist yet — that's fine, skip it
            }
            op.fetchRecordsResultBlock = { overallResult in
                switch overallResult {
                case .success:
                    continuation.resume(returning: results)
                case .failure(let error):
                    if let ckError = error as? CKError,
                       ckError.code == .partialFailure {
                        // Some records didn't exist — that's expected for new records
                        continuation.resume(returning: results)
                    } else {
                        continuation.resume(throwing: error)
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
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                var realErrors: [Error] = []

                op.perRecordDeleteBlock = { recordID, result in
                    if case .failure(let error) = result {
                        // unknownItem means already deleted — safe to ignore
                        if let ckError = error as? CKError,
                           ckError.code == .unknownItem {
                            return
                        }
                        realErrors.append(error)
                    }
                }

                op.modifyRecordsResultBlock = { result in
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
                privateDB.add(op)
            }
        }
    }

    // MARK: - Full Fetch

    /// Fetches all records of a given type from the custom zone.
    func fetchAllRecords(recordType: String) async throws -> [CKRecord] {
        var allRecords: [CKRecord] = []
        var cursor: CKQueryOperation.Cursor?

        let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
        let initialOp = CKQueryOperation(query: query)
        initialOp.zoneID = zoneID
        initialOp.qualityOfService = .userInitiated

        let firstResult = try await runQueryOperation(initialOp)
        allRecords.append(contentsOf: firstResult.records)
        cursor = firstResult.cursor

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
