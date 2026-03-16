import ExpoModulesCore
import CloudKit

public class CloudKitSyncModule: Module {

    private let manager = CloudKitSyncManager.shared

    public func definition() -> ModuleDefinition {
        Name("CloudKitSync")

        Events("onRemoteChange")

        // MARK: - Account Status

        AsyncFunction("getAccountStatus") { () -> String in
            let status = try await self.manager.accountStatus()
            switch status {
            case .available: return "available"
            case .noAccount: return "noAccount"
            case .restricted: return "restricted"
            case .temporarilyUnavailable: return "temporarilyUnavailable"
            @unknown default: return "unknown"
            }
        }

        // MARK: - Zone & Subscription Setup

        AsyncFunction("ensureZone") { () -> Bool in
            try await self.manager.ensureZone()
            return true
        }

        AsyncFunction("ensureSubscription") { () -> Bool in
            try await self.manager.ensureSubscription()
            return true
        }

        // MARK: - Incremental Fetch

        /// Fetch changes since a given change token (base64 string).
        /// Returns { records: { [recordType]: [...json] }, deletedIDs: { [recordType]: [...ids] }, changeToken: string? }
        AsyncFunction("fetchChanges") { (changeTokenBase64: String?) -> [String: Any] in
            do {
                let result = try await CloudKitChangeTracker.fetchChanges(
                    database: self.manager.privateDB,
                    zoneID: self.manager.zoneID,
                    changeTokenBase64: changeTokenBase64
                )
                return self.formatChangeResult(result)
            } catch is ChangeTokenExpiredError {
                // Return a sentinel so JS knows to do a full fetch
                return ["tokenExpired": true]
            }
        }

        // MARK: - Full Fetch

        /// Fetch all records of a given type. Returns JSON array.
        AsyncFunction("fetchAllRecords") { (recordType: String) -> [[String: Any]] in
            let records = try await self.manager.fetchAllRecords(recordType: recordType)
            return records.map { CloudKitRecordMapper.json(from: $0) }
        }

        // MARK: - Save Records

        /// Save records from JSON. Returns array of conflicted record IDs.
        AsyncFunction("saveRecords") { (recordType: String, recordsJSON: String) -> [String] in
            guard let data = recordsJSON.data(using: .utf8),
                  let jsonArray = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                throw NSError(domain: "CloudKitSync", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Invalid JSON input for saveRecords"
                ])
            }

            let records = jsonArray.compactMap { json in
                CloudKitRecordMapper.record(
                    from: json,
                    recordType: recordType,
                    zoneID: self.manager.zoneID
                )
            }

            return try await self.manager.saveRecords(records)
        }

        // MARK: - Delete Records

        AsyncFunction("deleteRecords") { (recordType: String, recordIDs: [String]) -> Bool in
            try await self.manager.deleteRecords(recordType: recordType, recordIDs: recordIDs)
            return true
        }
    }

    // MARK: - Helpers

    private func formatChangeResult(_ result: CloudKitChangeTracker.ChangeResult) -> [String: Any] {
        // Group changed records by type
        var recordsByType: [String: [[String: Any]]] = [:]
        for record in result.changedRecords {
            let type = record.recordType
            let json = CloudKitRecordMapper.json(from: record)
            recordsByType[type, default: []].append(json)
        }

        // Group deleted IDs by type
        var deletedByType: [String: [String]] = [:]
        for deleted in result.deletedRecordIDs {
            deletedByType[deleted.recordType, default: []].append(deleted.recordName)
        }

        var response: [String: Any] = [
            "records": recordsByType,
            "deletedIDs": deletedByType,
        ]
        if let token = result.newChangeToken {
            response["changeToken"] = token
        }
        return response
    }

    // MARK: - Push Notification Support

    /// Call this from AppDelegate when a silent push arrives for CloudKit.
    public func handleRemoteNotification(userInfo: [AnyHashable: Any]) {
        let notification = CKNotification(fromRemoteNotificationDictionary: userInfo)
        guard notification?.subscriptionID == manager.subscriptionID else { return }
        sendEvent("onRemoteChange", [:])
    }
}
