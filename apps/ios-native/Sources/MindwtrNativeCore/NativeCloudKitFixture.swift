#if DEBUG && targetEnvironment(simulator)
import Foundation

actor NativeCloudKitFixture {
    private let account: String
    private var records: [String: String] = [:]
    init(account: String) { self.account = account }

    func call(_ json: String) throws -> String {
        switch try NativeCloudKitRequest(json: json) {
        case .accountStatus:
            return "\"" + account + "\""
        case .ensureZone:
            guard account == "available" else { throw HostFailure("Fixture account is unavailable") }
            return "null"
        case .fetchAllRecords(let type):
            return records[type.rawValue] ?? "[]"
        case .saveRecords(let type, let value):
            records[type.rawValue] = value
            return "[]"
        case .deleteRecords(let type, let ids):
            let rows = try NativeJSON.jsonObject(with: Data((records[type.rawValue] ?? "[]").utf8)) as? [[String: Any]] ?? []
            let removed = Set(ids.map { Data($0.utf8) })
            let kept = rows.filter { row in (row["id"] as? String).map { !removed.contains(Data($0.utf8)) } ?? false }
            records[type.rawValue] = String(decoding: try JSONSerialization.data(withJSONObject: kept), as: UTF8.self)
            return "null"
        case .saveAttachmentAsset, .fetchAttachmentAsset:
            throw HostFailure("The UI fixture has no attachment assets")
        }
    }
}
#endif
