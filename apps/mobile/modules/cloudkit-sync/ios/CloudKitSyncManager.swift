import CloudKit
import Foundation


final class CloudKitSyncManager {

    static let shared = CloudKitSyncManager()

    let containerID = "iCloud.tech.dongdongbh.mindwtr"
    let zoneName = "MindwtrZone"
    let subscriptionID = "MindwtrZoneSubscription"

    private(set) lazy var container = CKContainer(identifier: containerID)
    private(set) lazy var privateDB = container.privateCloudDatabase
    private(set) lazy var zoneID = CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName)


    private var zoneTask: Task<Void, Error>?
    private var subscriptionTask: Task<Void, Error>?

    private init() {}

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
        let recordID = CKRecord.ID(recordName: recordName, zoneID: zoneID)
        let fetched = try await fetchRecordsByID([recordID])
        let record = fetched[recordID] ?? CKRecord(recordType: attachmentRecordType, recordID: recordID)
        applyAttachmentMetadata(metadata, to: record)
        record[attachmentAssetField] = CKAsset(fileURL: try fileURL(from: filePath))

        let op = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
        op.savePolicy = .changedKeys
        op.qualityOfService = .userInitiated

        CloudKitOperationTimeouts.apply(to: op, resourceSeconds: CloudKitOperationTimeouts.assetResourceSeconds)

        let savedRecord = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CKRecord, Error>) in
            var perRecordError: Error?
            op.perRecordSaveBlock = { _, result in
                if case .failure(let error) = result {
                    perRecordError = error
                }
            }
            op.modifyRecordsResultBlock = { result in
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
            self.privateDB.add(op)
        }

        return attachmentMetadata(from: savedRecord)
    }

    func fetchAttachmentAsset(recordName: String, targetPath: String) async throws -> [String: Any] {
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

        let destinationURL = try fileURL(from: targetPath)
        let parentURL = destinationURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: parentURL, withIntermediateDirectories: true)


        let tempURL = parentURL.appendingPathComponent(".tmp-\(UUID().uuidString)-\(destinationURL.lastPathComponent)")
        if FileManager.default.fileExists(atPath: tempURL.path) {
            try? FileManager.default.removeItem(at: tempURL)
        }
        do {
            try FileManager.default.copyItem(at: sourceURL, to: tempURL)
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


    func accountStatus() async throws -> CKAccountStatus {
        return try await container.accountStatus()
    }


    func ensureZone() async throws {
        if let existing = zoneTask {
            try await existing.value
            return
        }
        let task = Task<Void, Error> {
            let zone = CKRecordZone(zoneID: zoneID)
            let op = CKModifyRecordZonesOperation(recordZonesToSave: [zone], recordZoneIDsToDelete: nil)
            op.qualityOfService = .userInitiated
            CloudKitOperationTimeouts.apply(to: op)
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
            zoneTask = nil
            throw error
        }
    }


    func invalidateZone() {
        zoneTask = nil
    }


    func ensureSubscription() async throws {
        if let existing = subscriptionTask {
            try await existing.value
            return
        }
        let task = Task<Void, Error> {

            do {
                _ = try await privateDB.subscription(for: subscriptionID)
                return
            } catch let error as CKError where error.code == .unknownItem {

            }

            let subscription = CKRecordZoneSubscription(
                zoneID: zoneID,
                subscriptionID: subscriptionID
            )
            let notificationInfo = CKSubscription.NotificationInfo()
            notificationInfo.shouldSendContentAvailable = true
            subscription.notificationInfo = notificationInfo

            let op = CKModifySubscriptionsOperation(
                subscriptionsToSave: [subscription],
                subscriptionIDsToDelete: nil
            )
            op.qualityOfService = .utility
            CloudKitOperationTimeouts.apply(to: op)
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
            subscriptionTask = nil
            throw error
        }
    }


    func saveRecords(
        _ jsonRecords: [[String: Any]],
        recordType: String
    ) async throws -> [String] {
        if jsonRecords.isEmpty { return [] }


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
            let batchEnd = min(batchStart + saveBatchSize, recordsToSave.count)
            let batch = Array(recordsToSave[batchStart..<batchEnd])

            let op = CKModifyRecordsOperation(recordsToSave: batch, recordIDsToDelete: nil)
            op.savePolicy = .changedKeys
            op.qualityOfService = .userInitiated
            CloudKitOperationTimeouts.apply(to: op)


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
                        cbQueue.sync {
                            switch result {
                            case .success:
                                continuation.resume(returning: (conflicts, perRecordErrors))
                            case .failure(let error):
                                if let ckError = error as? CKError,
                                   ckError.code == .partialFailure {

                                    continuation.resume(returning: (conflicts, perRecordErrors))
                                } else {
                                    continuation.resume(throwing: error)
                                }
                            }
                        }
                    }
                    privateDB.add(op)
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

            if let operationError { throw operationError }
            conflictIDs.append(contentsOf: batchConflicts)
            nonConflictErrors.append(contentsOf: batchErrors)

            break
        }


        if !nonConflictErrors.isEmpty {
            let descriptions = nonConflictErrors.prefix(5).map { $0.localizedDescription }.joined(separator: "; ")
            NSLog("[CloudKitSyncManager] saveRecords had \(nonConflictErrors.count) non-conflict error(s): \(descriptions)")


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

        return conflictIDs
    }


    private func fetchRecordsByID(_ ids: [CKRecord.ID]) async throws -> [CKRecord.ID: CKRecord] {
        if ids.isEmpty { return [:] }
        let op = CKFetchRecordsOperation(recordIDs: ids)
        op.qualityOfService = .userInitiated


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
                            continuation.resume(throwing: CloudKitSyncManager.preservingRecordErrors(perRecordErrors))
                            return
                        }
                        continuation.resume(returning: results)
                    case .failure(let error):
                        if let ckError = error as? CKError,
                           ckError.code == .partialFailure {

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
            privateDB.add(op)
        }
    }


    func deleteRecords(recordType: String, recordIDs: [String]) async throws {
        if recordIDs.isEmpty { return }
        let ckIDs = recordIDs.map { CKRecord.ID(recordName: $0, zoneID: zoneID) }

        let batchSize = 400
        for batchStart in stride(from: 0, to: ckIDs.count, by: batchSize) {
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
                privateDB.add(op)
            }
        }
    }


    private static let ckServerErrorUnknownRecordType = 2003


    func fetchAllRecords(recordType: String) async throws -> [CKRecord] {
        var allRecords: [CKRecord] = []
        var cursor: CKQueryOperation.Cursor?

        let query = CKQuery(recordType: recordType, predicate: NSPredicate(value: true))
        let initialOp = CKQueryOperation(query: query)
        initialOp.zoneID = zoneID
        initialOp.qualityOfService = .userInitiated
        CloudKitOperationTimeouts.apply(to: initialOp)

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
            CloudKitOperationTimeouts.apply(to: continueOp)
            let result = try await runQueryOperation(continueOp)
            allRecords.append(contentsOf: result.records)
            cursor = result.cursor
        }

        return allRecords
    }


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
