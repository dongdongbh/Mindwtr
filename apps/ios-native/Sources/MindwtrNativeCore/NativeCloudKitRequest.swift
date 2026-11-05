import Foundation

/// Wire grammar only. Asset paths stay opaque until the native asset owner authorizes them.
enum NativeCloudKitRequest: Sendable {
    enum RecordType: String, Sendable {
        case task = "MindwtrTask", project = "MindwtrProject", section = "MindwtrSection"
        case area = "MindwtrArea", person = "MindwtrPerson", settings = "MindwtrSettings"
        case attachment = "MindwtrAttachment"
    }
    case accountStatus
    case ensureZone
    case fetchAllRecords(recordType: RecordType)
    case saveRecords(recordType: RecordType, recordsJSON: String)
    case deleteRecords(recordType: RecordType, recordIDs: [String])
    case saveAttachmentAsset(recordName: String, filePath: String, metadataJSON: String)
    case fetchAttachmentAsset(recordName: String, targetPath: String)

    static let maximumBytes = 16 * 1_024 * 1_024
    private static let maximumRecords = 100_000
    private static var invalid: HostFailure { HostFailure("CloudKit request is invalid") }

    init(json: String) throws {
        guard let input = try Self.object(json), let op = input["op"] as? String else { throw Self.invalid }
        let fields = Set(input.keys)
        switch op {
        case "accountStatus":
            guard fields == ["op"] else { throw Self.invalid }
            self = .accountStatus
        case "ensureZone":
            guard fields == ["op"] else { throw Self.invalid }
            self = .ensureZone
        case "fetchAllRecords":
            guard fields == ["op", "recordType"], let type = Self.recordType(input["recordType"]), type != .attachment else { throw Self.invalid }
            self = .fetchAllRecords(recordType: type)
        case "saveRecords":
            guard fields == ["op", "recordType", "recordsJSON"],
                  let type = Self.recordType(input["recordType"]), type != .attachment,
                  let raw = input["recordsJSON"] as? String,
                  let values = try Self.parse(raw) as? [[String: Any]], values.count <= Self.maximumRecords else { throw Self.invalid }
            var ids = Set<Data>()
            for value in values {
                guard let id = Self.identifier(value["id"]), ids.insert(Data(id.utf8)).inserted else { throw Self.invalid }
            }
            self = .saveRecords(recordType: type, recordsJSON: raw)
        case "deleteRecords":
            guard fields == ["op", "recordType", "recordIDs"], let type = Self.recordType(input["recordType"]),
                  let ids = input["recordIDs"] as? [String], ids.count <= Self.maximumRecords,
                  ids.allSatisfy({ Self.identifier($0) != nil }),
                  Set(ids.map { Data($0.utf8) }).count == ids.count else { throw Self.invalid }
            self = .deleteRecords(recordType: type, recordIDs: ids)
        case "saveAttachmentAsset":
            guard fields == ["op", "recordName", "filePath", "metadataJSON"],
                  let name = Self.identifier(input["recordName"]), let path = Self.path(input["filePath"]),
                  let raw = input["metadataJSON"] as? String, try Self.object(raw) != nil else { throw Self.invalid }
            self = .saveAttachmentAsset(recordName: name, filePath: path, metadataJSON: raw)
        case "fetchAttachmentAsset":
            guard fields == ["op", "recordName", "targetPath"],
                  let name = Self.identifier(input["recordName"]), let path = Self.path(input["targetPath"]) else { throw Self.invalid }
            self = .fetchAttachmentAsset(recordName: name, targetPath: path)
        default: throw Self.invalid
        }
    }

    private static func parse(_ raw: String) throws -> Any {
        guard raw.utf8.count <= maximumBytes, (try? NativeJSON.hasUniqueObjectKeys(raw)) == true,
              let value = try? NativeJSON.jsonObject(with: Data(raw.utf8)) else { throw invalid }
        return value
    }
    private static func object(_ raw: String) throws -> [String: Any]? { try parse(raw) as? [String: Any] }
    private static func recordType(_ value: Any?) -> RecordType? { (value as? String).flatMap(RecordType.init(rawValue:)) }
    private static func identifier(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= 4_096,
              !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
        return text
    }
    private static func path(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= 16_384, !text.utf8.contains(0) else { return nil }
        return text
    }
}
