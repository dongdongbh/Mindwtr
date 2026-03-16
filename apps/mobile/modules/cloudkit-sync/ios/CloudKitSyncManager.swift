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

    /// Saves records to CloudKit. Returns IDs of records that had server conflicts.
    func saveRecords(_ records: [CKRecord]) async throws -> [String] {
        if records.isEmpty { return [] }

        var conflictIDs: [String] = []
        // Process in batches of 400 (CloudKit limit is 400 per operation)
        let batchSize = 400
        for batchStart in stride(from: 0, to: records.count, by: batchSize) {
            let batchEnd = min(batchStart + batchSize, records.count)
            let batch = Array(records[batchStart..<batchEnd])

            let op = CKModifyRecordsOperation(recordsToSave: batch, recordIDsToDelete: nil)
            op.savePolicy = .changedKeys
            op.qualityOfService = .userInitiated

            let batchConflicts = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String], Error>) in
                var conflicts: [String] = []
                op.perRecordSaveBlock = { recordID, result in
                    if case .failure(let error) = result,
                       let ckError = error as? CKError,
                       ckError.code == .serverRecordChanged {
                        conflicts.append(recordID.recordName)
                    }
                }
                op.modifyRecordsResultBlock = { result in
                    switch result {
                    case .success:
                        continuation.resume(returning: conflicts)
                    case .failure(let error):
                        // If the overall operation failed but we have per-record conflicts,
                        // that's the expected CK behavior — return them.
                        if let ckError = error as? CKError,
                           ckError.code == .partialFailure,
                           !conflicts.isEmpty {
                            continuation.resume(returning: conflicts)
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                }
                privateDB.add(op)
            }
            conflictIDs.append(contentsOf: batchConflicts)
        }

        return conflictIDs
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
                op.modifyRecordsResultBlock = { result in
                    switch result {
                    case .success:
                        continuation.resume()
                    case .failure(let error):
                        // Ignore "not found" errors on delete
                        if let ckError = error as? CKError,
                           ckError.code == .partialFailure {
                            continuation.resume()
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
