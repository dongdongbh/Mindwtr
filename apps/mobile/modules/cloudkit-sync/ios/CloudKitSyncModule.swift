import Foundation
import ExpoModulesCore
import CloudKit

private final class CloudKitAttachmentNotFoundException: Exception {
    override var reason: String {
        "CloudKit attachment is no longer available"
    }

    override var code: String {
        "ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND"
    }
}


private final class CloudKitZoneGoneException: Exception {
    override var reason: String {
        "CloudKit zone was deleted or cleared and must be recreated"
    }

    override var code: String {
        "ERR_CLOUDKIT_ZONE_GONE"
    }
}

public class CloudKitSyncModule: Module {

    private static let remoteChangeNotification = Notification.Name("tech.dongdongbh.mindwtr.cloudkit.remoteChange")
    private static let pendingRemoteChangeKey = "tech.dongdongbh.mindwtr.cloudkit.pendingRemoteChange"

    private let manager = CloudKitSyncManager.shared
    private var remoteChangeObserver: NSObjectProtocol?

    public func definition() -> ModuleDefinition {
        Name("CloudKitSync")

        Events("onRemoteChange")

        OnCreate {
            self.remoteChangeObserver = NotificationCenter.default.addObserver(
                forName: Self.remoteChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.sendEvent("onRemoteChange", [:])
            }
        }

        OnDestroy {
            if let observer = self.remoteChangeObserver {
                NotificationCenter.default.removeObserver(observer)
                self.remoteChangeObserver = nil
            }
        }


        AsyncFunction("getAccountStatus") { () -> String in
            let status = try await self.manager.accountStatus()
            switch status {
            case .available: return "available"
            case .noAccount: return "noAccount"
            case .restricted: return "restricted"
            case .temporarilyUnavailable: return "temporarilyUnavailable"
            case .couldNotDetermine: return "unknown"
            @unknown default: return "unknown"
            }
        }


        AsyncFunction("ensureZone") { () -> Bool in
            try await self.reportingRetryAfter { try await self.manager.ensureZone() }
            return true
        }

        AsyncFunction("ensureSubscription") { () -> Bool in
            try await self.reportingRetryAfter { try await self.manager.ensureSubscription() }
            return true
        }


        AsyncFunction("fetchChanges") { (changeTokenBase64: String?) -> [String: Any] in
            do {
                let result = try await self.reportingRetryAfter {
                    try await CloudKitChangeTracker.fetchChanges(
                        database: self.manager.privateDB,
                        zoneID: self.manager.zoneID,
                        changeTokenBase64: changeTokenBase64
                    )
                }
                return self.formatChangeResult(result)
            } catch is ChangeTokenExpiredError {

                return ["tokenExpired": true]
            }
        }


        AsyncFunction("fetchAllRecords") { (recordType: String) -> [[String: Any]] in
            let records = try await self.reportingRetryAfter {
                try await self.manager.fetchAllRecords(recordType: recordType)
            }
            return records.map { CloudKitRecordMapper.json(from: $0) }
        }


        AsyncFunction("saveRecords") { (recordType: String, recordsJSON: String) -> [String] in
            guard let data = recordsJSON.data(using: .utf8),
                  let jsonArray = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                throw NSError(domain: "CloudKitSync", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Invalid JSON input for saveRecords"
                ])
            }

            return try await self.reportingRetryAfter {
                try await self.manager.saveRecords(jsonArray, recordType: recordType)
            }
        }


        AsyncFunction("deleteRecords") { (recordType: String, recordIDs: [String]) -> Bool in
            try await self.reportingRetryAfter {
                try await self.manager.deleteRecords(recordType: recordType, recordIDs: recordIDs)
            }
            return true
        }


        AsyncFunction("saveAttachmentAsset") { (recordName: String, filePath: String, metadata: [String: Any]) -> [String: Any] in
            return try await self.reportingRetryAfter {
                try await self.manager.saveAttachmentAsset(
                    recordName: recordName,
                    filePath: filePath,
                    metadata: metadata
                )
            }
        }

        AsyncFunction("fetchAttachmentAsset") { (recordName: String, targetPath: String) -> [String: Any] in
            return try await self.reportingRetryAfter {
                do {
                    return try await self.manager.fetchAttachmentAsset(
                        recordName: recordName,
                        targetPath: targetPath
                    )
                } catch {
                    if CloudKitAttachmentErrorClassifier.isTerminalNotFound(error) {
                        throw CloudKitAttachmentNotFoundException().causedBy(error)
                    }
                    throw error
                }
            }
        }

        AsyncFunction("consumePendingRemoteChange") { () -> Bool in
            let defaults = UserDefaults.standard
            let hadPending = defaults.bool(forKey: Self.pendingRemoteChangeKey)
            if hadPending {
                defaults.removeObject(forKey: Self.pendingRemoteChangeKey)
            }
            return hadPending
        }
    }


    private func reportingRetryAfter<T>(_ operation: () async throws -> T) async throws -> T {
        do {
            return try await operation()
        } catch {
            if Self.isZoneGone(error) {
                manager.invalidateZone()
                throw CloudKitZoneGoneException().causedBy(error)
            }
            throw Self.annotatingRetryAfter(error)
        }
    }


    private static func isZoneGone(_ error: Error, depth: Int = 0) -> Bool {
        if depth >= 8 { return false }
        let nsError = error as NSError
        if nsError.domain == CKError.errorDomain
            && (nsError.code == CKError.Code.userDeletedZone.rawValue
                || nsError.code == CKError.Code.zoneNotFound.rawValue) {
            return true
        }
        if let partial = nsError.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: Error] {
            if partial.values.contains(where: { isZoneGone($0, depth: depth + 1) }) { return true }
        }
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error {
            return isZoneGone(underlying, depth: depth + 1)
        }
        return false
    }

    static func annotatingRetryAfter(_ error: Error) -> Error {
        guard let seconds = retryAfterSeconds(in: error) else { return error }
        return NSError(domain: (error as NSError).domain, code: (error as NSError).code, userInfo: [
            NSLocalizedDescriptionKey: "\(error.localizedDescription) [retryAfter=\(seconds)]"
        ])
    }


    private static func retryAfterSeconds(in error: Error, depth: Int = 0) -> Double? {
        if depth >= 8 { return nil }
        let nsError = error as NSError
        var longest = (nsError.userInfo[CKErrorRetryAfterKey] as? NSNumber)?.doubleValue
        if let partial = nsError.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: Error] {
            for nested in partial.values {
                if let seconds = retryAfterSeconds(in: nested, depth: depth + 1) {
                    longest = max(longest ?? seconds, seconds)
                }
            }
        }
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error,
           let seconds = retryAfterSeconds(in: underlying, depth: depth + 1) {
            longest = max(longest ?? seconds, seconds)
        }
        return longest
    }

    private func formatChangeResult(_ result: CloudKitChangeTracker.ChangeResult) -> [String: Any] {

        var recordsByType: [String: [[String: Any]]] = [:]
        for record in result.changedRecords {
            let type = record.recordType
            let json = CloudKitRecordMapper.json(from: record)
            recordsByType[type, default: []].append(json)
        }


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


    public func handleRemoteNotification(userInfo: [AnyHashable: Any]) {
        Self.handleRemoteNotificationPayload(userInfo)
    }

    @discardableResult
    public static func handleRemoteNotificationPayload(_ userInfo: [AnyHashable: Any]) -> Bool {
        let notification = CKNotification(fromRemoteNotificationDictionary: userInfo)
        guard notification?.subscriptionID == CloudKitSyncManager.shared.subscriptionID else { return false }
        publishRemoteChange()
        return true
    }

    private static func publishRemoteChange() {
        UserDefaults.standard.set(true, forKey: pendingRemoteChangeKey)
        NotificationCenter.default.post(name: remoteChangeNotification, object: nil)
    }
}
