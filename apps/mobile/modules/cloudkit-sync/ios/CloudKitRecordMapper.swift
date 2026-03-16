import CloudKit
import Foundation

/// Maps between JSON dictionaries (from JS) and CKRecord instances.
/// Complex nested objects (checklist, attachments, recurrence) are stored as
/// JSON-encoded strings. Primitive arrays (tags, contexts, tagIds) use
/// CloudKit's native list type for potential future server-side queries.
enum CloudKitRecordMapper {

    // MARK: - Record type names

    static let taskType = "MindwtrTask"
    static let projectType = "MindwtrProject"
    static let sectionType = "MindwtrSection"
    static let areaType = "MindwtrArea"
    static let settingsType = "MindwtrSettings"

    static let allTypes = [taskType, projectType, sectionType, areaType, settingsType]

    // MARK: - JSON → CKRecord

    static func record(
        from json: [String: Any],
        recordType: String,
        zoneID: CKRecordZone.ID
    ) -> CKRecord? {
        guard let id = json["id"] as? String, !id.isEmpty else { return nil }
        let recordID = CKRecord.ID(recordName: id, zoneID: zoneID)
        let record = CKRecord(recordType: recordType, recordID: recordID)
        applyFields(from: json, to: record, recordType: recordType)
        return record
    }

    /// Update an existing CKRecord's fields from JSON (for conflict resolution).
    static func updateRecord(
        _ record: CKRecord,
        from json: [String: Any],
        recordType: String
    ) {
        applyFields(from: json, to: record, recordType: recordType)
    }

    // MARK: - CKRecord → JSON

    static func json(from record: CKRecord) -> [String: Any] {
        var result: [String: Any] = ["id": record.recordID.recordName]
        let recordType = record.recordType

        let fieldSpecs = fieldSpecsForType(recordType)
        for spec in fieldSpecs {
            guard let value = record[spec.ckKey] else { continue }
            switch spec.kind {
            case .string:
                if let s = value as? String { result[spec.jsKey] = s }
            case .int:
                if let n = value as? Int64 { result[spec.jsKey] = n }
            case .bool:
                if let n = value as? Int64 { result[spec.jsKey] = n == 1 }
            case .stringArray:
                if let arr = value as? [String] { result[spec.jsKey] = arr }
            case .jsonString:
                // Decode JSON string back to object/array for JS
                if let s = value as? String,
                   let data = s.data(using: .utf8),
                   let parsed = try? JSONSerialization.jsonObject(with: data) {
                    result[spec.jsKey] = parsed
                } else if let s = value as? String {
                    result[spec.jsKey] = s
                }
            case .date:
                if let s = value as? String { result[spec.jsKey] = s }
            }
        }

        return result
    }

    // MARK: - Field Specs

    enum FieldKind {
        case string
        case int
        case bool
        case stringArray
        case jsonString  // Complex objects stored as JSON-encoded strings
        case date        // ISO 8601 strings (kept as strings, not CKRecord Date)
    }

    struct FieldSpec {
        let jsKey: String
        let ckKey: String
        let kind: FieldKind
    }

    static func fieldSpecsForType(_ recordType: String) -> [FieldSpec] {
        switch recordType {
        case taskType: return taskFieldSpecs
        case projectType: return projectFieldSpecs
        case sectionType: return sectionFieldSpecs
        case areaType: return areaFieldSpecs
        case settingsType: return settingsFieldSpecs
        default: return []
        }
    }

    // MARK: - Task Fields

    private static let taskFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "title", ckKey: "title", kind: .string),
        FieldSpec(jsKey: "status", ckKey: "status", kind: .string),
        FieldSpec(jsKey: "priority", ckKey: "priority", kind: .string),
        FieldSpec(jsKey: "taskMode", ckKey: "taskMode", kind: .string),
        FieldSpec(jsKey: "startTime", ckKey: "startTime", kind: .date),
        FieldSpec(jsKey: "dueDate", ckKey: "dueDate", kind: .date),
        FieldSpec(jsKey: "recurrence", ckKey: "recurrence", kind: .jsonString),
        FieldSpec(jsKey: "pushCount", ckKey: "pushCount", kind: .int),
        FieldSpec(jsKey: "tags", ckKey: "tags", kind: .stringArray),
        FieldSpec(jsKey: "contexts", ckKey: "contexts", kind: .stringArray),
        FieldSpec(jsKey: "checklist", ckKey: "checklist", kind: .jsonString),
        FieldSpec(jsKey: "description", ckKey: "taskDescription", kind: .string), // "description" is reserved
        FieldSpec(jsKey: "textDirection", ckKey: "textDirection", kind: .string),
        FieldSpec(jsKey: "attachments", ckKey: "attachments", kind: .jsonString),
        FieldSpec(jsKey: "location", ckKey: "location", kind: .string),
        FieldSpec(jsKey: "projectId", ckKey: "projectId", kind: .string),
        FieldSpec(jsKey: "sectionId", ckKey: "sectionId", kind: .string),
        FieldSpec(jsKey: "areaId", ckKey: "areaId", kind: .string),
        FieldSpec(jsKey: "isFocusedToday", ckKey: "isFocusedToday", kind: .bool),
        FieldSpec(jsKey: "timeEstimate", ckKey: "timeEstimate", kind: .string),
        FieldSpec(jsKey: "reviewAt", ckKey: "reviewAt", kind: .date),
        FieldSpec(jsKey: "completedAt", ckKey: "completedAt", kind: .date),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
        FieldSpec(jsKey: "purgedAt", ckKey: "purgedAt", kind: .date),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int), // "order" may be reserved
        FieldSpec(jsKey: "orderNum", ckKey: "orderNum", kind: .int),
    ]

    // MARK: - Project Fields

    private static let projectFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "title", ckKey: "title", kind: .string),
        FieldSpec(jsKey: "status", ckKey: "status", kind: .string),
        FieldSpec(jsKey: "color", ckKey: "color", kind: .string),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int),
        FieldSpec(jsKey: "tagIds", ckKey: "tagIds", kind: .stringArray),
        FieldSpec(jsKey: "isSequential", ckKey: "isSequential", kind: .bool),
        FieldSpec(jsKey: "isFocused", ckKey: "isFocused", kind: .bool),
        FieldSpec(jsKey: "supportNotes", ckKey: "supportNotes", kind: .string),
        FieldSpec(jsKey: "attachments", ckKey: "attachments", kind: .jsonString),
        FieldSpec(jsKey: "reviewAt", ckKey: "reviewAt", kind: .date),
        FieldSpec(jsKey: "areaId", ckKey: "areaId", kind: .string),
        FieldSpec(jsKey: "areaTitle", ckKey: "areaTitle", kind: .string),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
    ]

    // MARK: - Section Fields

    private static let sectionFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "projectId", ckKey: "projectId", kind: .string),
        FieldSpec(jsKey: "title", ckKey: "title", kind: .string),
        FieldSpec(jsKey: "description", ckKey: "sectionDescription", kind: .string),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int),
        FieldSpec(jsKey: "isCollapsed", ckKey: "isCollapsed", kind: .bool),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
    ]

    // MARK: - Area Fields

    private static let areaFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "name", ckKey: "name", kind: .string),
        FieldSpec(jsKey: "color", ckKey: "color", kind: .string),
        FieldSpec(jsKey: "icon", ckKey: "icon", kind: .string),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
    ]

    // MARK: - Settings Fields
    // Settings is stored as a single record with the full JSON as a payload field.

    private static let settingsFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "payload", ckKey: "payload", kind: .jsonString),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
    ]

    // MARK: - Internal

    private static func applyFields(
        from json: [String: Any],
        to record: CKRecord,
        recordType: String
    ) {
        let specs = fieldSpecsForType(recordType)
        for spec in specs {
            guard let value = json[spec.jsKey] else {
                // Explicitly set nil for missing optional fields so CloudKit clears them.
                record[spec.ckKey] = nil
                continue
            }
            // Handle explicit null from JSON
            if value is NSNull {
                record[spec.ckKey] = nil
                continue
            }
            switch spec.kind {
            case .string, .date:
                record[spec.ckKey] = value as? String
            case .int:
                if let n = value as? Int64 {
                    record[spec.ckKey] = n as CKRecordValue
                } else if let n = value as? Int {
                    record[spec.ckKey] = Int64(n) as CKRecordValue
                } else if let n = value as? Double {
                    record[spec.ckKey] = Int64(n) as CKRecordValue
                }
            case .bool:
                if let b = value as? Bool {
                    record[spec.ckKey] = (b ? 1 : 0) as CKRecordValue
                } else if let n = value as? Int {
                    record[spec.ckKey] = Int64(n) as CKRecordValue
                }
            case .stringArray:
                if let arr = value as? [String] {
                    record[spec.ckKey] = arr as CKRecordValue
                }
            case .jsonString:
                // Encode object/array to JSON string for storage
                if let data = try? JSONSerialization.data(withJSONObject: value),
                   let str = String(data: data, encoding: .utf8) {
                    record[spec.ckKey] = str as CKRecordValue
                } else if let str = value as? String {
                    // Already a string (e.g., from a previous round-trip)
                    record[spec.ckKey] = str as CKRecordValue
                }
            }
        }
    }
}
