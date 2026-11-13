import CloudKit
import Foundation


enum CloudKitRecordMapper {


    static let taskType = "MindwtrTask"
    static let projectType = "MindwtrProject"
    static let sectionType = "MindwtrSection"
    static let areaType = "MindwtrArea"
    static let personType = "MindwtrPerson"
    static let settingsType = "MindwtrSettings"

    static let allTypes = [taskType, projectType, sectionType, areaType, personType, settingsType]


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


    static func updateRecord(
        _ record: CKRecord,
        from json: [String: Any],
        recordType: String
    ) {
        applyFields(from: json, to: record, recordType: recordType)
    }


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
                if spec.jsKey == "calendarReference", value as? String == "null" {
                    result[spec.jsKey] = NSNull()
                    continue
                }

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


    enum FieldKind {
        case string
        case int
        case bool
        case stringArray
        case jsonString
        case date
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
        case personType: return personFieldSpecs
        case settingsType: return settingsFieldSpecs
        default: return []
        }
    }


    private static let taskFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "title", ckKey: "title", kind: .string),
        FieldSpec(jsKey: "status", ckKey: "status", kind: .string),
        FieldSpec(jsKey: "priority", ckKey: "priority", kind: .string),
        FieldSpec(jsKey: "energyLevel", ckKey: "energyLevel", kind: .string),
        FieldSpec(jsKey: "assignedTo", ckKey: "assignedTo", kind: .string),
        FieldSpec(jsKey: "taskMode", ckKey: "taskMode", kind: .string),
        FieldSpec(jsKey: "startTime", ckKey: "startTime", kind: .date),
        FieldSpec(jsKey: "relativeStartOffset", ckKey: "relativeStartOffset", kind: .jsonString),
        FieldSpec(jsKey: "dueDate", ckKey: "dueDate", kind: .date),
        FieldSpec(jsKey: "recurrence", ckKey: "recurrence", kind: .jsonString),
        FieldSpec(jsKey: "showFutureRecurrence", ckKey: "showFutureRecurrence", kind: .bool),
        FieldSpec(jsKey: "pushCount", ckKey: "pushCount", kind: .int),
        FieldSpec(jsKey: "tags", ckKey: "tags", kind: .stringArray),
        FieldSpec(jsKey: "contexts", ckKey: "contexts", kind: .stringArray),
        FieldSpec(jsKey: "checklist", ckKey: "checklist", kind: .jsonString),
        FieldSpec(jsKey: "description", ckKey: "taskDescription", kind: .string),
        FieldSpec(jsKey: "textDirection", ckKey: "textDirection", kind: .string),
        FieldSpec(jsKey: "attachments", ckKey: "attachments", kind: .jsonString),
        FieldSpec(jsKey: "location", ckKey: "location", kind: .string),
        FieldSpec(jsKey: "projectId", ckKey: "projectId", kind: .string),
        FieldSpec(jsKey: "sectionId", ckKey: "sectionId", kind: .string),
        FieldSpec(jsKey: "viewSectionIds", ckKey: "viewSectionIds", kind: .jsonString),
        FieldSpec(jsKey: "areaId", ckKey: "areaId", kind: .string),
        FieldSpec(jsKey: "isFocusedToday", ckKey: "isFocusedToday", kind: .bool),
        FieldSpec(jsKey: "timeEstimate", ckKey: "timeEstimate", kind: .string),
        FieldSpec(jsKey: "timeSpentMinutes", ckKey: "timeSpentMinutes", kind: .int),
        FieldSpec(jsKey: "focusOrder", ckKey: "focusOrder", kind: .int),
        FieldSpec(jsKey: "suppressMindwtrReminders", ckKey: "suppressMindwtrReminders", kind: .bool),
        FieldSpec(jsKey: "reminderPolicy", ckKey: "reminderPolicy", kind: .string),
        FieldSpec(jsKey: "repeatReminderMinutes", ckKey: "repeatReminderMinutes", kind: .int),
        FieldSpec(jsKey: "dueReminderLeadMinutes", ckKey: "dueReminderLeadMinutes", kind: .int),
        FieldSpec(jsKey: "startReminderLeadMinutes", ckKey: "startReminderLeadMinutes", kind: .int),
        FieldSpec(jsKey: "reviewAt", ckKey: "reviewAt", kind: .date),
        FieldSpec(jsKey: "completedAt", ckKey: "completedAt", kind: .date),
        FieldSpec(jsKey: "cancelledAt", ckKey: "cancelledAt", kind: .date),
        FieldSpec(jsKey: "archivedAt", ckKey: "archivedAt", kind: .date),
        FieldSpec(jsKey: "statusBeforeProjectArchive", ckKey: "statusBeforeProjectArchive", kind: .string),
        FieldSpec(jsKey: "completedAtBeforeProjectArchive", ckKey: "completedAtBeforeProjectArchive", kind: .date),
        FieldSpec(jsKey: "isFocusedTodayBeforeProjectArchive", ckKey: "isFocusedTodayBeforeProjectArchive", kind: .bool),
        FieldSpec(jsKey: "projectArchivedAt", ckKey: "projectArchivedAt", kind: .date),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
        FieldSpec(jsKey: "purgedAt", ckKey: "purgedAt", kind: .date),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int),
        FieldSpec(jsKey: "orderNum", ckKey: "orderNum", kind: .int),
    ]


    private static let projectFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "title", ckKey: "title", kind: .string),
        FieldSpec(jsKey: "status", ckKey: "status", kind: .string),
        FieldSpec(jsKey: "color", ckKey: "color", kind: .string),
        FieldSpec(jsKey: "colorOverride", ckKey: "colorOverride", kind: .string),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int),
        FieldSpec(jsKey: "tagIds", ckKey: "tagIds", kind: .stringArray),
        FieldSpec(jsKey: "isSequential", ckKey: "isSequential", kind: .bool),
        FieldSpec(jsKey: "sequentialScope", ckKey: "sequentialScope", kind: .string),
        FieldSpec(jsKey: "perSectionFlow", ckKey: "perSectionFlow", kind: .bool),
        FieldSpec(jsKey: "calendarReference", ckKey: "calendarReference", kind: .jsonString),
        FieldSpec(jsKey: "taskSortBy", ckKey: "taskSortBy", kind: .string),
        FieldSpec(jsKey: "isFocused", ckKey: "isFocused", kind: .bool),
        FieldSpec(jsKey: "supportNotes", ckKey: "supportNotes", kind: .string),
        FieldSpec(jsKey: "attachments", ckKey: "attachments", kind: .jsonString),
        FieldSpec(jsKey: "dueDate", ckKey: "dueDate", kind: .date),
        FieldSpec(jsKey: "reviewAt", ckKey: "reviewAt", kind: .date),
        FieldSpec(jsKey: "cancelledAt", ckKey: "cancelledAt", kind: .date),
        FieldSpec(jsKey: "archivedAt", ckKey: "archivedAt", kind: .date),
        FieldSpec(jsKey: "areaId", ckKey: "areaId", kind: .string),
        FieldSpec(jsKey: "areaTitle", ckKey: "areaTitle", kind: .string),
        FieldSpec(jsKey: "viewSectionIds", ckKey: "viewSectionIds", kind: .jsonString),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
        FieldSpec(jsKey: "purgedAt", ckKey: "purgedAt", kind: .date),
        FieldSpec(jsKey: "startDate", ckKey: "startDateText", kind: .date),
    ]


    private static let sectionFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "projectId", ckKey: "projectId", kind: .string),
        FieldSpec(jsKey: "title", ckKey: "title", kind: .string),
        FieldSpec(jsKey: "description", ckKey: "sectionDescription", kind: .string),
        FieldSpec(jsKey: "order", ckKey: "sortOrder", kind: .int),
        FieldSpec(jsKey: "isCollapsed", ckKey: "isCollapsed", kind: .bool),
        FieldSpec(jsKey: "isSequential", ckKey: "isSequential", kind: .bool),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
        FieldSpec(jsKey: "deletedAtBeforeProjectArchive", ckKey: "deletedAtBeforeProjectArchive", kind: .date),
        FieldSpec(jsKey: "projectArchivedAt", ckKey: "projectArchivedAt", kind: .date),
    ]


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


    private static let personFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "name", ckKey: "name", kind: .string),
        FieldSpec(jsKey: "note", ckKey: "note", kind: .string),
        FieldSpec(jsKey: "referenceLink", ckKey: "referenceLink", kind: .string),
        FieldSpec(jsKey: "rev", ckKey: "rev", kind: .int),
        FieldSpec(jsKey: "revBy", ckKey: "revBy", kind: .string),
        FieldSpec(jsKey: "createdAt", ckKey: "createdAt", kind: .date),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
        FieldSpec(jsKey: "deletedAt", ckKey: "deletedAt", kind: .date),
    ]


    private static let settingsFieldSpecs: [FieldSpec] = [
        FieldSpec(jsKey: "payload", ckKey: "payload", kind: .jsonString),
        FieldSpec(jsKey: "updatedAt", ckKey: "updatedAt", kind: .date),
    ]


    private static func setField(_ value: CKRecordValue?, on record: CKRecord, key: String) {
        let current = record[key]
        if current == nil && value == nil { return }
        if let current = current as? NSObject,
           let value = value as? NSObject,
           current.isEqual(value) { return }
        record[key] = value
    }

    private static func setJSONField(_ value: String, on record: CKRecord, key: String) {
        if record[key] as? String == value { return }
        if let old = record[key] as? String,
           let oldData = old.data(using: .utf8),
           let newData = value.data(using: .utf8),
           let oldJSON = try? JSONSerialization.jsonObject(with: oldData),
           let newJSON = try? JSONSerialization.jsonObject(with: newData),
           let oldCanonical = try? JSONSerialization.data(withJSONObject: oldJSON, options: .sortedKeys),
           let newCanonical = try? JSONSerialization.data(withJSONObject: newJSON, options: .sortedKeys),
           oldCanonical == newCanonical { return }
        setField(value as CKRecordValue, on: record, key: key)
    }

    private static func applyFields(
        from json: [String: Any],
        to record: CKRecord,
        recordType: String
    ) {
        let specs = fieldSpecsForType(recordType)
        for spec in specs {
            guard let value = json[spec.jsKey] else {

                if spec.jsKey != "calendarReference" {
                    setField(nil, on: record, key: spec.ckKey)
                }
                continue
            }

            if value is NSNull {
                if spec.jsKey == "calendarReference" {
                    setJSONField("null", on: record, key: spec.ckKey)
                    continue
                }
                setField(nil, on: record, key: spec.ckKey)
                continue
            }
            switch spec.kind {
            case .string, .date:
                if let str = value as? String {
                    setField(str as CKRecordValue, on: record, key: spec.ckKey)
                } else {
                    setField(nil, on: record, key: spec.ckKey)
                }
            case .int:
                if let n = value as? Int64 {
                    setField(n as CKRecordValue, on: record, key: spec.ckKey)
                } else if let n = value as? Int {
                    setField(Int64(n) as CKRecordValue, on: record, key: spec.ckKey)
                } else if let n = value as? Double {
                    setField(Int64(n) as CKRecordValue, on: record, key: spec.ckKey)
                }
            case .bool:
                if let b = value as? Bool {
                    setField((b ? 1 : 0) as CKRecordValue, on: record, key: spec.ckKey)
                } else if let n = value as? Int {
                    setField(Int64(n) as CKRecordValue, on: record, key: spec.ckKey)
                }
            case .stringArray:
                if let arr = value as? [String] {
                    setField(arr as CKRecordValue, on: record, key: spec.ckKey)
                }
            case .jsonString:

                if let data = try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys),
                   let str = String(data: data, encoding: .utf8) {
                    setJSONField(str, on: record, key: spec.ckKey)
                } else if let str = value as? String {

                    setJSONField(str, on: record, key: spec.ckKey)
                }
            }
        }
    }
}
