import CoreFoundation
import Foundation

public struct NativeProductionWidgetCompletionSource: Sendable {
    public let queueID: String
    public let receiptID: String
    let json: String

    public init(queueID: String, taskID: String, token: String, createdAt: Double) throws {
        guard let id = UUID(uuidString: queueID),
              Data(id.uuidString.lowercased().utf8) == Data(queueID.lowercased().utf8),
              createdAt.isFinite, createdAt >= 0, createdAt <= 8_640_000_000_000_000 else {
            throw NativeWidgetCompletionJSON.invalid
        }
        let receiptID = id.uuidString.lowercased()
        let raw = try NativeWidgetCompletionJSON.encoded(["namespace": NativeLaunchSelection.productionNamespace,
            "actionId": receiptID, "identifier": taskID, "token": token, "createdAt": createdAt])
        _ = try NativeWidgetCompletionJSON.source(raw)
        self.queueID = queueID; self.receiptID = receiptID; json = raw
    }
}

enum NativeWidgetCompletionJSON {
    static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native widget completion is invalid") }
    static func encoded(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    static func object(_ raw: String, limit: Int) throws -> [String: Any] {
        guard raw.utf8.count <= limit, try NativeJSON.hasUniqueObjectKeys(raw),
              let value = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw invalid }
        return value
    }
    static func source(_ action: NativeWidgetPendingAction) throws -> String {
        let raw = try encoded(["namespace": NativeWidgetActionStore.namespace, "actionId": action.id,
            "identifier": action.identifier, "token": action.token, "createdAt": action.createdAt])
        _ = try source(raw); return raw
    }
    static func source(_ raw: String) throws -> [String: Any] {
        let value = try object(raw, limit: 65_536)
        guard Set(value.keys) == ["namespace", "actionId", "identifier", "token", "createdAt"],
              let namespace = value["namespace"] as? String,
              let id = value["actionId"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let identifier = value["identifier"] as? String, let token = value["token"] as? String,
              validOperation(namespace: namespace, identifier: identifier, token: token),
              let at = value["createdAt"] as? NSNumber, CFGetTypeID(at) != CFBooleanGetTypeID(),
              at.doubleValue.isFinite, at.doubleValue >= 0, at.doubleValue <= 8_640_000_000_000_000 else { throw invalid }
        return value
    }
    private static func validOperation(namespace: String, identifier: String, token: String) -> Bool {
        if namespace == NativeWidgetActionStore.namespace {
            return NativeWidgetActionStore.validOperation(identifier, token)
        }
        guard namespace == NativeLaunchSelection.productionNamespace,
              identifier.utf8.count <= 4_096, token.utf8.count <= 8_192,
              let values = try? NativeJSON.jsonObject(with: Data(token.utf8)) as? [Any], values.count == 4,
              let taskID = values[0] as? String, !taskID.isEmpty, taskID.utf16.count <= 500,
              Data(identifier.utf8) == Data(taskID.utf8),
              let revision = values[1] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID(),
              revision.doubleValue.isFinite, revision.doubleValue >= 0, revision.doubleValue <= 9_007_199_254_740_991,
              revision.doubleValue.rounded() == revision.doubleValue,
              let updated = values[2] as? String, !updated.isEmpty,
              let status = values[3] as? String,
              ["inbox", "next", "waiting", "someday", "reference", "done", "archived"].contains(status) else { return false }
        return true
    }
    static func plan(_ raw: String) throws -> [String: Any] {
        let value = try object(raw, limit: 2_100_000)
        guard Set(value.keys) == ["source", "checklist"], let source = value["source"] as? [String: Any],
              value["checklist"] is NSNull || value["checklist"] is [String: Any] else { throw invalid }
        _ = try self.source(encoded(source)); return value
    }
    static func sameSource(_ lhs: Any?, _ rhs: Any?) throws -> Bool {
        guard let lhs = lhs as? [String: Any], let rhs = rhs as? [String: Any] else { return false }
        return try Data(encoded(lhs).utf8) == Data(encoded(rhs).utf8)
    }
    static func result(_ raw: String, source: [String: Any]) throws {
        let value = try object(raw, limit: 512)
        guard Set(value.keys) == ["actionId", "outcome"],
              value["actionId"] as? String == source["actionId"] as? String,
              let outcome = value["outcome"] as? String, ["completed", "discarded"].contains(outcome) else { throw invalid }
    }
}
