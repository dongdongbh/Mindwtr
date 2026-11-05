import CoreFoundation
import Foundation

/// A bounded read-only canonical Next Actions list. Publication belongs to its caller.
public struct NativeWidgetNextSnapshot: Sendable {
    public enum DueTone: String, Sendable { case overdue, today, normal }

    public struct Item: Sendable {
        public let id: String
        public let title: String
        public let contextLabel: String?
        public let dueLabel: String?
        public let dueTone: DueTone
    }

    public let json: String
    public let version: Int
    public let title: String
    public let emptyMessage: String
    public let totalCount: Int
    public let items: [Item]

    public init(json: String) throws {
        let invalid = HostFailure("INVALID_INPUT: Native widget Next snapshot is invalid")
        guard json.utf8.count <= 1_024 * 1_024,
              try NativeJSON.hasUniqueObjectKeys(json),
              let root = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(root.keys) == ["version", "title", "emptyMessage", "totalCount", "items"],
              Self.integer(root["version"]) == 1,
              let title = root["title"] as? String, title.utf16.count <= 16_384,
              let emptyMessage = root["emptyMessage"] as? String, emptyMessage.utf16.count <= 16_384,
              let totalCount = Self.integer(root["totalCount"]),
              let values = root["items"] as? [[String: Any]], values.count <= 13, totalCount >= values.count else { throw invalid }
        var identities = Set<Data>(), decoded: [Item] = []
        for value in values {
            guard Set(value.keys) == ["id", "title", "contextLabel", "dueLabel", "dueTone"],
                  let id = value["id"] as? String, !id.isEmpty, id.utf16.count <= 500,
                  identities.insert(Data(id.utf8)).inserted,
                  let rowTitle = value["title"] as? String, rowTitle.utf16.count <= 16_384,
                  value["contextLabel"] is NSNull || (value["contextLabel"] as? String).map({ $0.utf16.count <= 16_384 }) == true,
                  value["dueLabel"] is NSNull || (value["dueLabel"] as? String).map({ $0.utf16.count <= 100 }) == true,
                  let name = value["dueTone"] as? String, let tone = DueTone(rawValue: name) else { throw invalid }
            decoded.append(Item(id: id, title: rowTitle, contextLabel: value["contextLabel"] as? String,
                                dueLabel: value["dueLabel"] as? String, dueTone: tone))
        }
        self.json = json
        version = 1
        self.title = title
        self.emptyMessage = emptyMessage
        self.totalCount = totalCount
        items = decoded
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991,
              number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.intValue
    }
}
