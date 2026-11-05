import CoreFoundation
import Foundation
import MindwtrWatchPayloadValidation

public struct NativeWatchBatch: Sendable {
    public struct Entry: Sendable {
        public let name: String
        public let body: String
        let checklist: Bool
    }
    public let entries: [Entry]
    let json: String

    /// Select the oldest commands before bounding the frame, so later taps cannot overtake queued ones.
    public static func orderedSources(_ sources: [(name: String, body: String)]) throws -> [(name: String, body: String)] {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ordinary = ISO8601DateFormatter()
        var ordered: [(name: String, body: String, at: Date)] = []
        for source in sources {
            guard source.body.utf8.count <= 32 * 1024,
                  let value = try NativeJSON.jsonObject(with: Data(source.body.utf8)) as? [String: Any],
                  let at = value["createdAt"] as? String,
                  let date = fractional.date(from: at) ?? ordinary.date(from: at) else { throw invalid }
            ordered.append((name: source.name, body: source.body, at: date))
        }
        ordered.sort { left, right in
            if left.at == right.at { return left.name < right.name }
            return left.at < right.at
        }
        return ordered.map { (name: $0.name, body: $0.body) }
    }

    public static func next(_ sources: [(name: String, body: String)]) throws -> NativeWatchBatch? {
        guard !sources.isEmpty else { return nil }
        let ordered = try orderedSources(sources)
        // Sixfold JSON escaping of sixteen maximum-size bodies still fits the 4 MiB frame.
        let entries = ordered.prefix(16).map { ["name": $0.name, "body": $0.body] }
        let frame: [String: Any] = ["version": 1, "requestId": UUID().uuidString.lowercased(), "entries": entries]
        return try Self(json: String(decoding: JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]), as: UTF8.self))
    }

    public init(json: String) throws {
        guard json.utf8.count <= 4 * 1024 * 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let raw = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(raw.keys) == ["version", "requestId", "entries"], Self.integer(raw["version"], equals: 1),
              let id = raw["requestId"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let items = raw["entries"] as? [[String: Any]], (1...256).contains(items.count) else { throw Self.invalid }
        var names = Set<String>()
        entries = try items.map { item in
            guard Set(item.keys) == ["name", "body"], let name = item["name"] as? String,
                  let body = item["body"] as? String, body.utf8.count <= 32 * 1024,
                  try NativeJSON.hasUniqueObjectKeys(body),
                  let payload = try NativeJSON.jsonObject(with: Data(body.utf8)) as? [String: Any] else { throw Self.invalid }
            let validated = try MindwtrWatchPayloadValidator.normalizePendingCommand(payload)
            guard let source = validated["id"] as? String, payload["id"] as? String == source,
                  name == source + ".json", names.insert(name).inserted else { throw Self.invalid }
            return Entry(name: name, body: body, checklist: validated["kind"] as? String == "checklist")
        }
        self.json = json
    }

    func result(_ json: String) throws -> NativeWatchBatchResult {
        guard json.utf8.count <= 64 * 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let raw = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(raw.keys) == ["version", "ingested", "completed"], Self.integer(raw["version"], equals: 1),
              Self.integer(raw["ingested"], equals: entries.count),
              let completed = raw["completed"] as? [[String: Any]], completed.count == entries.count else { throw Self.invalid }
        var outcomes: [String: String] = [:]
        for (entry, value) in zip(entries, completed) {
            guard Set(value.keys) == (entry.checklist ? ["name", "checklistOutcome"] : ["name"]),
                  value["name"] as? String == entry.name else { throw Self.invalid }
            if entry.checklist {
                guard let outcome = value["checklistOutcome"] as? String,
                      ["applied", "stale", "missing", "terminal", "changed"].contains(outcome) else { throw Self.invalid }
                outcomes[entry.name] = outcome
            }
        }
        return NativeWatchBatchResult(completed: entries.map(\.name), checklistOutcomes: outcomes)
    }

    private static func integer(_ value: Any?, equals expected: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == Double(expected)
    }
    static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native Watch batch is invalid") }
}

public struct NativeWatchBatchResult: Sendable {
    public let completed: [String]
    public let checklistOutcomes: [String: String]
}
