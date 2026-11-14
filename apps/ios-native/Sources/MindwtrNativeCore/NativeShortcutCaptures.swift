import CoreFoundation
import Foundation

public struct NativeShortcutCaptureQueue: Sendable {
    public let directory: URL
    static let maximumBytes = 32 * 1024

    public init(directory: URL) { self.directory = directory }

    public static func live() -> NativeShortcutCaptureQueue? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            .map { NativeShortcutCaptureQueue(directory: $0.appendingPathComponent("pending-captures", isDirectory: true)) }
    }

    public static let dateOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = .current
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    public func enqueue(task: String, note: String?, tags: String?, project: String?, dueDate: Date?, startDate: Date?,
                        id: String = UUID().uuidString, now: Date = Date()) -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var payload: [String: Any] = ["id": id, "title": task, "createdAt": ISO8601DateFormatter().string(from: now)]
            if let note = NativeShortcutIntentLinks.trimmed(note) { payload["note"] = note }
            if let tags = NativeShortcutIntentLinks.normalizedCommaList(tags) { payload["tags"] = tags }
            if let project = NativeShortcutIntentLinks.trimmed(project) { payload["project"] = project }
            if let dueDate { payload["dueDate"] = Self.dateOnly.string(from: dueDate) }
            if let startDate { payload["startDate"] = Self.dateOnly.string(from: startDate) }
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            try data.write(to: directory.appendingPathComponent(id + ".json"), options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    public func pending(limit: Int = 256) throws -> [(name: String, body: String)] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        var sources: [(name: String, body: String)] = []
        for name in names.sorted() where name.hasSuffix(".json") && sources.count < limit {
            let url = directory.appendingPathComponent(name)
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true, (values?.fileSize ?? .max) <= Self.maximumBytes,
                  let data = try? Data(contentsOf: url), let body = String(data: data, encoding: .utf8) else { continue }
            sources.append((name: name, body: body))
        }
        return sources
    }

    public func retire(name: String, body: String) throws {
        guard !name.contains("/"), name.hasSuffix(".json"), !name.hasPrefix(".") else { throw Self.invalid }
        let url = directory.appendingPathComponent(name)
        guard let current = try? Data(contentsOf: url), current == Data(body.utf8) else { throw Self.invalid }
        try FileManager.default.removeItem(at: url)
    }

    static var invalid: HostFailure { HostFailure("INVALID_INPUT: Shortcuts capture source changed") }
}

public struct NativeShortcutCaptureBatch: Sendable {
    public struct Entry: Sendable {
        public let name: String
        public let body: String
    }
    public let entries: [Entry]
    let json: String

    private static let keys: Set<String> = ["id", "title", "createdAt", "note", "tags", "project", "dueDate", "startDate"]

    public static func isValid(name: String, body: String) -> Bool {
        guard body.utf8.count <= NativeShortcutCaptureQueue.maximumBytes,
              (try? NativeJSON.hasUniqueObjectKeys(body)) == true,
              let value = (try? NativeJSON.jsonObject(with: Data(body.utf8))) as? [String: Any],
              Set(value.keys).isSubset(of: keys), value.values.allSatisfy({ $0 is String }),
              let id = value["id"] as? String, let uuid = UUID(uuidString: id),
              id == uuid.uuidString || id == uuid.uuidString.lowercased(), name == id + ".json",
              let title = value["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let created = value["createdAt"] as? String, createdDate(created) != nil else { return false }
        return ["dueDate", "startDate"].allSatisfy { field in
            guard let text = value[field] as? String else { return true }
            return text.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil
        }
    }

    private static func createdDate(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    public static func next(_ sources: [(name: String, body: String)]) throws -> NativeShortcutCaptureBatch? {
        let ordered = sources.filter { isValid(name: $0.name, body: $0.body) }.compactMap { source -> (name: String, body: String, at: Date)? in
            guard let value = (try? NativeJSON.jsonObject(with: Data(source.body.utf8))) as? [String: Any],
                  let created = value["createdAt"] as? String, let at = createdDate(created) else { return nil }
            return (source.name, source.body, at)
        }.sorted { $0.at == $1.at ? $0.name < $1.name : $0.at < $1.at }
        guard !ordered.isEmpty else { return nil }
        let entries = ordered.prefix(16).map { ["name": $0.name, "body": $0.body] }
        let frame: [String: Any] = ["version": 1, "requestId": UUID().uuidString.lowercased(), "entries": entries]
        return try Self(json: String(decoding: JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]), as: UTF8.self))
    }

    public init(json: String) throws {
        guard json.utf8.count <= 1024 * 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let raw = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(raw.keys) == ["version", "requestId", "entries"], Self.integer(raw["version"], equals: 1),
              let id = raw["requestId"] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let items = raw["entries"] as? [[String: Any]], (1...16).contains(items.count) else { throw Self.invalid }
        var names = Set<String>()
        entries = try items.map { item in
            guard Set(item.keys) == ["name", "body"], let name = item["name"] as? String, let body = item["body"] as? String,
                  Self.isValid(name: name, body: body), names.insert(name).inserted else { throw Self.invalid }
            return Entry(name: name, body: body)
        }
        self.json = json
    }

    public func result(_ json: String) throws -> [String] {
        guard json.utf8.count <= 64 * 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let raw = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(raw.keys) == ["version", "ingested", "completed"], Self.integer(raw["version"], equals: 1),
              Self.integer(raw["ingested"], equals: entries.count),
              let completed = raw["completed"] as? [[String: Any]], completed.count == entries.count,
              zip(entries, completed).allSatisfy({ entry, value in Set(value.keys) == ["name"] && value["name"] as? String == entry.name })
        else { throw Self.invalid }
        return entries.map(\.name)
    }

    private static func integer(_ value: Any?, equals expected: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue == Double(expected)
    }
    static var invalid: HostFailure { HostFailure("INVALID_INPUT: Native Shortcuts capture batch is invalid") }
}
