import Foundation
import CoreFoundation

/// App invalidates this exact visible editor/input owner synchronously, before any async cleanup.
public final class NativeTaskAIEditorLease: @unchecked Sendable {
    private let lock = NSLock()
    private var live = true
    public init() {}
    public func invalidate() { lock.lock(); live = false; lock.unlock() }
    public var isCurrent: Bool { lock.lock(); defer { lock.unlock() }; return live }
}

/// An ephemeral request, bound to one original Host. Settlement includes owned transport drain.
public final class NativeTaskAIHandle: @unchecked Sendable {
    let host: UUID
    enum Scope { case task, inbox, review }
    let scope: Scope
    var inbox: Bool { scope == .inbox }
    var review: Bool { scope == .review }
    let identity = UUID()
    let cancellation = NativeAttachmentCancellation()
    let lease: NativeTaskAIEditorLease
    private let lock = NSLock()
    private var result: Result<String, Error>?
    private var waiters: [CheckedContinuation<String, Error>] = []
    init(host: UUID, lease: NativeTaskAIEditorLease, scope: Scope = .task) { self.host = host; self.lease = lease; self.scope = scope }
    func cancel() { lease.invalidate(); cancellation.cancel() }
    func settle(_ value: Result<String, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); return }
        result = value; let pending = waiters; waiters.removeAll(); lock.unlock()
        for waiter in pending { waiter.resume(with: value) }
    }
    func value() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if let result { lock.unlock(); continuation.resume(with: result) }
            else { waiters.append(continuation); lock.unlock() }
        }
    }
}

/// One private AI owner. Closing cannot miss a reserved request which has not submitted a JS ticket yet.
final class NativeTaskAIRequests: @unchecked Sendable {
    let identity = UUID()
    private let lock = NSLock()
    private var active: NativeTaskAIHandle?
    private var closed = false
    func reserve(_ lease: NativeTaskAIEditorLease, scope: NativeTaskAIHandle.Scope = .task) throws -> NativeTaskAIHandle {
        lock.lock(); defer { lock.unlock() }
        guard !closed, active == nil, lease.isCurrent else { throw NativeTaskAIJSON.unavailable }
        let handle = NativeTaskAIHandle(host: identity, lease: lease, scope: scope); active = handle; return handle
    }
    func finish(_ handle: NativeTaskAIHandle) {
        lock.lock(); defer { lock.unlock() }
        if active === handle { active = nil }
    }
    func takeForDrain(fence: Bool) -> NativeTaskAIHandle? {
        lock.lock(); defer { lock.unlock() }
        if fence { closed = true }
        active?.cancel(); return active
    }
}

enum NativeTaskAIJSON {
    static let invalid = HostFailure("INVALID_INPUT: Task AI requires a bounded canonical editor request")
    static let unavailable = HostFailure("STALE_REVISION: Task AI editor owner is unavailable")
    static func object(_ raw: String, maximum: Int = 2_000_000) throws -> [String: Any] {
        guard raw.utf8.count <= maximum, try NativeJSON.hasUniqueObjectKeys(raw),
              let value = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw invalid }
        return value
    }
    static func text(_ value: Any?, maximum: Int = 100_000, nonempty: Bool = false) -> Bool {
        guard let value = value as? String else { return false }
        return value.utf16.count <= maximum && (!nonempty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    static func request(_ raw: String, operation: Bool) throws -> [String: Any] {
        let input = try object(raw)
        let fields: Set<String> = !operation ? ["id", "draft"] : input["operation"] as? String == "breakdown"
            ? ["operation", "id", "draft", "checklist"] : ["operation", "id", "draft"]
        guard Set(input.keys) == fields, text(input["id"], maximum: 500, nonempty: true), input["draft"] is [String: Any],
              !operation || ["clarify", "breakdown"].contains(input["operation"] as? String ?? ""),
              input["operation"] as? String != "breakdown" || checklist(input["checklist"]) else { throw invalid }
        return input
    }
    static func checklist(_ value: Any?) -> Bool {
        guard let list = value as? [[String: Any]], list.count <= 1000 else { return false }
        return list.allSatisfy { item in
            Set(item.keys) == Set(["id", "title", "isCompleted"])
                && text(item["id"], maximum: 200) && text(item["title"], maximum: 10_000)
                && (item["isCompleted"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true
        }
    }
    static func options(_ raw: String) throws -> String {
        let value = try object(raw)
        guard Set(value.keys) == Set(["enabled", "clarify", "breakdown", "working"]),
              (value["enabled"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() }) == true,
              ["clarify", "breakdown", "working"].allSatisfy({ text(value[$0], maximum: 10_000) }) else { throw invalid }
        return raw
    }
    // These manual actions emit only field edits. Canonical editTaskDraft validates their values again at Apply.
    private static func fields(_ value: Any?, operation: String) -> Bool {
        guard let edit = value as? [String: Any], Set(edit.keys) == Set(["type", "patch"]), edit["type"] as? String == "fields",
              let patch = edit["patch"] as? [String: Any] else { return false }
        if operation == "breakdown" {
            return Set(patch.keys) == Set(["status"]) && ["inbox", "next", "waiting", "someday", "done", "reference"].contains(patch["status"] as? String ?? "")
        }
        guard Set(patch.keys).isSubset(of: ["title", "contexts", "timeEstimate"]) else { return false }
        return patch.values.allSatisfy { text($0) }
    }
    static func answer(_ raw: String, operation: String) throws -> String {
        let value = try object(raw)
        switch value["kind"] as? String {
        case "none": guard Set(value.keys) == Set(["kind"]) else { throw invalid }
        case "alert":
            guard Set(value.keys) == Set(["kind", "title", "message"]), text(value["title"]), text(value["message"]) else { throw invalid }
        case "dialog":
            guard Set(value.keys) == Set(["kind", "title", "message", "choices"]), text(value["title"]),
                  value["message"] is NSNull || text(value["message"]),
                  let choices = value["choices"] as? [[String: Any]], (1...100).contains(choices.count) else { throw invalid }
            for choice in choices {
                guard Set(choice.keys) == Set(["label", "variant", "apply"]), text(choice["label"]),
                      choice["variant"] is NSNull || ["primary", "secondary"].contains(choice["variant"] as? String ?? "") else { throw invalid }
                if choice["apply"] is NSNull { continue }
                if operation == "clarify" { guard fields(choice["apply"], operation: operation) else { throw invalid } }
                else {
                    guard let apply = choice["apply"] as? [String: Any], Set(apply.keys) == Set(["checklist", "edit"]),
                          checklist(apply["checklist"]), apply["edit"] is NSNull || fields(apply["edit"], operation: operation) else { throw invalid }
                }
            }
        default: throw invalid
        }
        return raw
    }
}

struct TaskAIPreload: Sendable {
    let secrets: NativeSecretJobs
    let provider: NativeAISettingsProjection.Provider
    let legacy: String?
    let http: NativeHTTPJobs
}
