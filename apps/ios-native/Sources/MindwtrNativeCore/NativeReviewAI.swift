import Foundation
import CoreFoundation

/// Weekly Review analysis is read-only; selected Apply is a separate exact, revision-bound journal command.
enum NativeReviewAIJSON {
    static func request(_ raw: String) throws {
        guard try NativeTaskAIJSON.object(raw, maximum: 1024).isEmpty else { throw NativeTaskAIJSON.invalid }
    }
    static func witness(_ raw: String) throws -> [String: Any] {
        let value = try NativeTaskAIJSON.object(raw)
        guard Set(value.keys) == Set(["items", "taskRevisions", "language", "weekStart"]),
              let items = value["items"] as? [[String: Any]], items.count <= 20_000,
              let revisions = value["taskRevisions"] as? [String: String],
              NativeTaskAIJSON.text(value["language"], maximum: 100, nonempty: true),
              value["weekStart"] is NSNull || ["system", "monday", "sunday", "saturday"].contains(value["weekStart"] as? String ?? ""),
              items.allSatisfy({ NativeTaskAIJSON.text($0["id"], maximum: 500, nonempty: true) }),
              revisions.allSatisfy({ NativeTaskAIJSON.text($0.key, maximum: 500, nonempty: true)
                && NativeTaskAIJSON.text($0.value, maximum: 200, nonempty: true) }) else { throw NativeTaskAIJSON.invalid }
        return value
    }
    static func answer(_ raw: String) throws -> String {
        let value = try NativeTaskAIJSON.object(raw)
        guard Set(value.keys) == Set(["error", "suggestions", "selectedIds"]),
              value["error"] is NSNull || NativeTaskAIJSON.text(value["error"]) else { throw NativeTaskAIJSON.invalid }
        if !(value["suggestions"] is NSNull) {
            guard let rows = value["suggestions"] as? [[String: Any]], rows.count <= 20_000 else { throw NativeTaskAIJSON.invalid }
            var ids = Set<String>()
            for row in rows {
                guard Set(row.keys) == Set(["id", "action", "reason", "title", "meta", "actionable", "taskRevision"]),
                      let id = row["id"] as? String, NativeTaskAIJSON.text(id, maximum: 500, nonempty: true), ids.insert(id).inserted,
                      ["someday", "archive", "keep", "breakdown"].contains(row["action"] as? String ?? ""),
                      NativeTaskAIJSON.text(row["reason"], maximum: 2000), NativeTaskAIJSON.text(row["title"]), NativeTaskAIJSON.text(row["meta"]),
                      (row["actionable"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() }) == true,
                      row["taskRevision"] is NSNull || NativeTaskAIJSON.text(row["taskRevision"], maximum: 200, nonempty: true) else { throw NativeTaskAIJSON.invalid }
            }
        }
        guard value["selectedIds"] is NSNull || (value["selectedIds"] as? [String]).map({ ids in ids.count <= 20_000
            && ids.allSatisfy({ NativeTaskAIJSON.text($0, maximum: 500, nonempty: true) }) }) == true else { throw NativeTaskAIJSON.invalid }
        return raw
    }
    static func apply(_ raw: String) throws -> [String: Any] {
        let value = try NativeTaskAIJSON.object(raw, maximum: 1_000_000)
        guard Set(value.keys) == Set(["requestId", "suggestions", "taskRevisions"]),
              let requestID = value["requestId"] as? String, requestID.utf16.count == 36, UUID(uuidString: requestID) != nil,
              let rows = value["suggestions"] as? [[String: Any]], (1...100).contains(rows.count),
              let revisions = value["taskRevisions"] as? [String: String] else { throw NativeTaskAIJSON.invalid }
        var ids = Set<String>()
        for row in rows {
            guard Set(row.keys) == Set(["id", "action", "reason"]), let id = row["id"] as? String,
                  NativeTaskAIJSON.text(id, maximum: 500, nonempty: true), !id.hasPrefix("project:"), ids.insert(id).inserted,
                  ["someday", "archive"].contains(row["action"] as? String ?? ""), NativeTaskAIJSON.text(row["reason"], maximum: 2000),
                  NativeTaskAIJSON.text(revisions[id], maximum: 200, nonempty: true) else { throw NativeTaskAIJSON.invalid }
        }
        guard Set(revisions.keys) == ids else { throw NativeTaskAIJSON.invalid }
        return value
    }
    static func result(_ raw: String) throws {
        let value = try NativeTaskAIJSON.object(raw, maximum: 4096)
        guard Set(value.keys) == Set(["changed", "toast", "createdId"]),
              (value["changed"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() }) == true,
              value["toast"] is NSNull, value["createdId"] is NSNull else { throw NativeTaskAIJSON.invalid }
    }
}
