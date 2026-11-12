import Foundation

public enum NativeShortcutIntentLinks {
    public static let features = ["inbox", "focus", "waiting", "someday", "projects", "review", "calendar"]

    public static func scheme(selection: NativeLaunchSelection, bundleIdentifier: String?) -> String? {
        switch selection {
        case .production: return bundleIdentifier == NativeLaunchSelection.productionNamespace ? "mindwtr" : nil
        case .standard, .isolated: return "mindwtr-native-dev"
        case .rehearsal: return nil
        }
    }

    public static func trimmed(_ value: String?) -> String? {
        let text = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    public static func normalizedCommaList(_ value: String?) -> String? {
        guard let value else { return nil }
        let items = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        return items.isEmpty ? nil : items.joined(separator: ",")
    }

    public static func capture(scheme: String, task: String, note: String?, tags: String?, project: String?,
                               requestId: String = UUID().uuidString) -> URL? {
        guard let title = trimmed(task) else { return nil }
        var items = [URLQueryItem(name: "title", value: title), URLQueryItem(name: "requestId", value: requestId)]
        if let note = trimmed(note) { items.append(URLQueryItem(name: "note", value: note)) }
        if let tags = normalizedCommaList(tags) { items.append(URLQueryItem(name: "tags", value: tags)) }
        if let project = trimmed(project) { items.append(URLQueryItem(name: "project", value: project)) }
        return link(scheme: scheme, path: "/capture", items: items)
    }

    public static func feature(scheme: String, feature: String) -> URL? {
        guard features.contains(feature) else { return nil }
        return link(scheme: scheme, path: "/open-feature", items: [URLQueryItem(name: "feature", value: feature)])
    }

    public static func savedList(scheme: String, id: String) -> URL? {
        let listId = "filter:" + id
        guard trimmed(id) != nil, listId.utf16.count <= 1024, listId.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        guard let segment = listId.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "\(scheme):///widget-list/\(segment)?source=shortcut")
    }

    private static func link(scheme: String, path: String, items: [URLQueryItem]) -> URL? {
        var components = URLComponents()
        components.scheme = scheme
        components.host = ""
        components.path = path
        components.queryItems = items
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }
}

public enum NativeSavedListCatalog {
    public static let payloadKey = "mindwtr-ios-widget-payload"

    public struct List: Decodable, Equatable, Sendable {
        public let id: String
        public let name: String
    }

    private struct Snapshot: Decodable {
        let savedFilters: [List]?
    }

    public static func decode(_ json: String?) -> [List] {
        guard let data = json?.data(using: .utf8),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) else { return [] }
        var seen = Set<String>()
        return (snapshot.savedFilters ?? []).filter {
            NativeShortcutIntentLinks.trimmed($0.name) != nil
                && NativeShortcutIntentLinks.savedList(scheme: "mindwtr", id: $0.id) != nil && seen.insert($0.id).inserted
        }
    }

    public static let group = "group.tech.dongdongbh.mindwtr"

    public static func load(selection: NativeLaunchSelection, bundleIdentifier: String?) -> [List] {
        guard bundleIdentifier == NativeLaunchSelection.productionNamespace, case .production = selection else { return [] }
        return decode(UserDefaults(suiteName: group)?.string(forKey: payloadKey))
    }
}
