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

        return try await withCheckedThrowingContinuation { continuation in
            var result = ChangeResult()

            op.recordWasChangedBlock = { _, recordResult in
                if case .success(let record) = recordResult {
                    result.changedRecords.append(record)
                }
            }

            op.recordWithIDWasDeletedBlock = { recordID, recordType in
                result.deletedRecordIDs.append((
                    recordName: recordID.recordName,
                    recordType: recordType
                ))
            }

            op.recordZoneFetchResultBlock = { _, zoneResult in
                switch zoneResult {
                case .success(let (serverChangeToken, _, moreComing)):
                    result.newChangeToken = serializeToken(serverChangeToken)
                    result.moreComing = moreComing
                case .failure(let error):
                    // If the token expired, we'll catch this in the completion
                    NSLog("[CloudKitChangeTracker] Zone fetch error: \(error.localizedDescription)")
                }
            }

            op.fetchRecordZoneChangesResultBlock = { overallResult in
                switch overallResult {
                case .success:
                    continuation.resume(returning: result)
                case .failure(let error):
                    if let ckError = error as? CKError, ckError.code == .changeTokenExpired {
                        // Signal to caller that a full fetch is needed
                        continuation.resume(throwing: ChangeTokenExpiredError())
                    } else {
                        continuation.resume(throwing: error)
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
