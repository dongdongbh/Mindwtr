import Foundation

// Read the catalog already published for widget configuration; task contents are
// resolved against live app state when the destination opens.
enum MindwtrSavedListCatalog {
    struct List: Decodable, Equatable {
        let id: String
        let name: String
    }
    private struct Snapshot: Decodable {
        let savedFilters: [List]?
    }

    static func decode(_ json: String?) -> [List] {
        guard let data = json?.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return [] }
        var seen = Set<String>()
        return (snapshot.savedFilters ?? []).filter {
            !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && destination(id: $0.id) != nil && seen.insert($0.id).inserted
        }
    }

    static func load() -> [List] {
        let defaults = UserDefaults(suiteName: "group.tech.dongdongbh.mindwtr")
        return decode(defaults?.string(forKey: "mindwtr-ios-widget-payload"))
    }

    static func destination(id: String) -> URL? {
        let listId = "filter:" + id
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              listId.utf16.count <= 1024,
              listId.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let segment = listId.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "mindwtr:///widget-list/\(segment)?source=shortcut")
    }
}
