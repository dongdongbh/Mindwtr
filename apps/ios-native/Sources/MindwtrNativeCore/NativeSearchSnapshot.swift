import CryptoKit
import Foundation

/// A bounded readonly projection; library-scoped publication belongs to its future index owner.
public struct NativeSearchSnapshot: Sendable {
    public enum List: String, Sendable {
        case inbox, focus, next, waiting, someday
    }

    public struct Item: Sendable {
        public let id: String
        public let title: String
        public let list: List
        public let projectName: String?
        public let dueDate: String?
        public let startDate: String?
    }

    public let items: [Item]
    public let fingerprint: String

    public init(json: String) throws {
        let invalid = HostFailure("INVALID_INPUT: Native search snapshot is invalid")
        guard json.utf8.count <= 8 * 1_024 * 1_024,
              let root = try NativeJSON.jsonObject(with: Data(json.utf8)) as? NSDictionary,
              root.count == 1, let values = root["items"] as? [NSDictionary], values.count <= 2_750,
              try NativeJSON.hasUniqueObjectKeys(json) else { throw invalid }
        let fields: Set<String> = ["id", "title", "list", "projectName", "dueDate", "startDate"]
        var identities = Set<Data>(), decoded: [Item] = []
        decoded.reserveCapacity(values.count)
        for value in values {
            guard value.allKeys.allSatisfy({ ($0 as? String).map(fields.contains) == true }),
                  let id = value["id"] as? String, !id.isEmpty, id.utf16.count <= 500,
                  identities.insert(Data(id.utf8)).inserted,
                  let title = value["title"] as? String, title.utf16.count <= 16_384,
                  let name = value["list"] as? String, let list = List(rawValue: name) else { throw invalid }
            var optional: [String: String] = [:]
            for field in ["projectName", "dueDate", "startDate"] where value[field] != nil {
                guard let text = value[field] as? String,
                      text.utf16.count <= (field == "projectName" ? 16_384 : 100),
                      field == "projectName" || !text.isEmpty else { throw invalid }
                optional[field] = text
            }
            decoded.append(Item(id: id, title: title, list: list, projectName: optional["projectName"],
                                dueDate: optional["dueDate"], startDate: optional["startDate"]))
        }
        items = decoded
        fingerprint = SHA256.hash(data: Data(json.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
