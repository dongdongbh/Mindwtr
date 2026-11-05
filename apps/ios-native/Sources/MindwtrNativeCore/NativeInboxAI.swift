import Foundation
import CoreFoundation

/// Processing-session grammar stays separate from editor TaskDraft/checklist answer shapes.
enum NativeInboxAIJSON {
    static func request(_ raw: String) throws -> [String: Any] {
        let value = try NativeTaskAIJSON.object(raw)
        guard Set(value.keys) == Set(["sessionId", "taskId", "step"]),
              NativeTaskAIJSON.text(value["sessionId"], maximum: 500, nonempty: true),
              NativeTaskAIJSON.text(value["taskId"], maximum: 500, nonempty: true),
              ["actionable", "decisions", "someday", "later", "incubate", "twoMinute", "execution", "oneAction", "waiting", "file"].contains(value["step"] as? String ?? "") else { throw NativeTaskAIJSON.invalid }
        return value
    }
    static func witness(_ raw: String) throws -> [String: Any] {
        let value = try NativeTaskAIJSON.object(raw)
        guard Set(value.keys) == Set(["draft", "mode", "step", "contexts", "language"]), value["draft"] is [String: Any],
              ["guided", "quick"].contains(value["mode"] as? String ?? ""), NativeTaskAIJSON.text(value["step"], maximum: 100, nonempty: true),
              NativeTaskAIJSON.text(value["language"], maximum: 100, nonempty: true),
              let contexts = value["contexts"] as? [String], contexts.count <= 20_000,
              contexts.allSatisfy({ NativeTaskAIJSON.text($0, maximum: 10_000) }) else { throw NativeTaskAIJSON.invalid }
        return value
    }
    static func edits(_ value: Any?) -> Bool {
        guard let edits = value as? [[String: Any]], (1...2).contains(edits.count) else { return false }
        return edits.enumerated().allSatisfy { index, edit in
            if index == 0 {
                return Set(edit.keys) == Set(["type", "field", "value"]) && edit["type"] as? String == "set"
                    && edit["field"] as? String == "title" && NativeTaskAIJSON.text(edit["value"], maximum: 10_000)
            }
            return Set(edit.keys) == Set(["type", "value"]) && edit["type"] as? String == "addContext"
                && NativeTaskAIJSON.text(edit["value"], maximum: 500, nonempty: true)
        }
    }
    static func answer(_ raw: String) throws -> String {
        let value = try NativeTaskAIJSON.object(raw)
        switch value["kind"] as? String {
        case "none": guard Set(value.keys) == Set(["kind"]) else { throw NativeTaskAIJSON.invalid }
        case "alert":
            guard Set(value.keys) == Set(["kind", "title", "message"]), NativeTaskAIJSON.text(value["title"]), NativeTaskAIJSON.text(value["message"]) else { throw NativeTaskAIJSON.invalid }
        case "toast":
            guard Set(value.keys) == Set(["kind", "toast"]), let toast = value["toast"] as? [String: Any],
                  Set(toast.keys) == Set(["title", "message", "tone", "durationMs", "action"]),
                  NativeTaskAIJSON.text(toast["title"]), NativeTaskAIJSON.text(toast["message"]), toast["tone"] as? String == "warning",
                  let duration = toast["durationMs"] as? NSNumber, CFGetTypeID(duration) != CFBooleanGetTypeID(), duration.doubleValue == 5200,
                  let action = toast["action"] as? [String: Any], Set(action.keys) == Set(["label", "screen"]),
                  NativeTaskAIJSON.text(action["label"]), action["screen"] as? String == "ai" else { throw NativeTaskAIJSON.invalid }
        case "dialog":
            guard Set(value.keys) == Set(["kind", "title", "message", "choices"]), NativeTaskAIJSON.text(value["title"]),
                  value["message"] is NSNull || NativeTaskAIJSON.text(value["message"]),
                  let choices = value["choices"] as? [[String: Any]], (1...100).contains(choices.count) else { throw NativeTaskAIJSON.invalid }
            for choice in choices {
                guard Set(choice.keys) == Set(["label", "variant", "apply"]), NativeTaskAIJSON.text(choice["label"]),
                      choice["variant"] is NSNull || ["primary", "secondary"].contains(choice["variant"] as? String ?? ""),
                      choice["apply"] is NSNull || edits(choice["apply"]) else { throw NativeTaskAIJSON.invalid }
            }
        default: throw NativeTaskAIJSON.invalid
        }
        return raw
    }
}
