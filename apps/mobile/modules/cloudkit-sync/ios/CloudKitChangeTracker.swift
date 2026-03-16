import CloudKit
import Foundation

/// Wraps CKFetchRecordZoneChangesOperation for incremental sync.
/// The change token is serialized to/from a base64 string for JS storage.
enum CloudKitChangeTracker {

    struct ChangeResult {
        var changedRecords: [CKRecord] = []
        var deletedRecordIDs: [(recordName: String, recordType: String)] = []
        var newChangeToken: String?
        var moreComing: Bool = false
    }

    /// Fetch changes since the given change token (base64 string, or nil for full fetch).
    static func fetchChanges(
        database: CKDatabase,
        zoneID: CKRecordZone.ID,
        changeTokenBase64: String?
    ) async throws -> ChangeResult {
        let previousToken = deserializeToken(changeTokenBase64)

        var config = CKFetchRecordZoneChangesOperation.ZoneConfiguration()
        config.previousServerChangeToken = previousToken

        let op = CKFetchRecordZoneChangesOperation(recordZoneIDs: [zoneID], configurationsByRecordZoneID: [zoneID: config])
        op.fetchAllChanges = true
        op.qualityOfService = .userInitiated

        // CloudKit dispatches callbacks on arbitrary queues. Serialize all
        // mutations to shared state through a serial queue to prevent races.
        let callbackQueue = DispatchQueue(label: "tech.dongdongbh.mindwtr.changetracker")

        return try await withCheckedThrowingContinuation { continuation in
            var result = ChangeResult()
            var tokenExpired = false
            var zoneError: Error?

            op.recordWasChangedBlock = { _, recordResult in
                if case .success(let record) = recordResult {
                    callbackQueue.sync { result.changedRecords.append(record) }
                }
            }

            op.recordWithIDWasDeletedBlock = { recordID, recordType in
                callbackQueue.sync {
                    result.deletedRecordIDs.append((
                        recordName: recordID.recordName,
                        recordType: recordType
                    ))
                }
            }

            op.recordZoneFetchResultBlock = { _, zoneResult in
                callbackQueue.sync {
                    switch zoneResult {
                    case .success(let (serverChangeToken, _, moreComing)):
                        result.newChangeToken = serializeToken(serverChangeToken)
                        result.moreComing = moreComing
                    case .failure(let error):
                        // Token expiry is reported per-zone, not in the overall completion.
                        if let ckError = error as? CKError, ckError.code == .changeTokenExpired {
                            tokenExpired = true
                        } else {
                            zoneError = error
                        }
                        NSLog("[CloudKitChangeTracker] Zone fetch error: \(error.localizedDescription)")
                    }
                }
            }

            op.fetchRecordZoneChangesResultBlock = { overallResult in
                callbackQueue.sync {
                    // Check zone-level token expiry first — it's the authoritative signal.
                    if tokenExpired {
                        continuation.resume(throwing: ChangeTokenExpiredError())
                        return
                    }
                    if let zoneErr = zoneError {
                        continuation.resume(throwing: zoneErr)
                        return
                    }
                    switch overallResult {
                    case .success:
                        continuation.resume(returning: result)
                    case .failure(let error):
                        // Fallback: overall completion may also report token expiry
                        if let ckError = error as? CKError, ckError.code == .changeTokenExpired {
                            continuation.resume(throwing: ChangeTokenExpiredError())
                        } else {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }

            database.add(op)
        }
    }

    // MARK: - Token Serialization

    static func serializeToken(_ token: CKServerChangeToken?) -> String? {
        guard let token = token else { return nil }
        do {
            let data = try NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
            return data.base64EncodedString()
        } catch {
            NSLog("[CloudKitChangeTracker] Failed to serialize change token: \(error)")
            return nil
        }
    }

    static func deserializeToken(_ base64: String?) -> CKServerChangeToken? {
        guard let base64 = base64, !base64.isEmpty,
              let data = Data(base64Encoded: base64) else { return nil }
        do {
            return try NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
        } catch {
            NSLog("[CloudKitChangeTracker] Failed to deserialize change token: \(error)")
            return nil
        }
    }
}

/// Thrown when the server change token has expired and a full re-fetch is needed.
struct ChangeTokenExpiredError: Error {
    var localizedDescription: String { "CloudKit change token expired; full fetch required" }
}
