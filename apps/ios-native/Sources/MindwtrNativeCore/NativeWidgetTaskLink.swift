import Foundation

/// Closed foreground URL adapter. The qualified scope token stays in the original intake event.
public enum NativeWidgetTaskLink {
    private static let prefix = "mindwtr-native-dev://widget-task/"

    public static func isCandidate(_ url: URL) -> Bool {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.host?.lowercased() == "widget-task"
    }

    public static func url(identifier: String) -> URL? {
        guard decodedTaskID(identifier) != nil else { return nil }
        return URL(string: prefix + identifier)
    }

    public static func identifier(in url: URL) -> String? {
        guard url.absoluteString.utf8.count <= 4_096,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "mindwtr-native-dev", parts.host == "widget-task", parts.user == nil,
              parts.password == nil, parts.port == nil, parts.query == nil, parts.fragment == nil,
              parts.path.hasPrefix("/") else { return nil }
        let identifier = String(parts.path.dropFirst())
        guard parts.percentEncodedPath == "/" + identifier, decodedTaskID(identifier) != nil,
              url.absoluteString == prefix + identifier else { return nil }
        return identifier
    }

    static func decodedTaskID(_ identifier: String) -> String? {
        let pieces = identifier.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count == 2, pieces[0].utf8.count == 64,
              pieces[0].utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              !pieces[1].isEmpty, pieces[1].utf8.count <= 2_668,
              pieces[1].utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0)
                  || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else { return nil }
        let base64 = pieces[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let bytes = Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)),
              bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") == pieces[1] else { return nil }
        let id = String(decoding: bytes, as: UTF8.self)
        guard Data(id.utf8) == bytes, !id.isEmpty, id.utf16.count <= 500 else { return nil }
        return id
    }

    #if !MINDWTR_WIDGET_EXTENSION
    /// Same resolver for ordinary and reserved replay; no Spotlight consent is acquired.
    @MainActor
    public static func taskID(for url: URL, selection: NativeLaunchSelection) -> String? {
        guard let identifier = identifier(in: url) else { return nil }
        return NativeSearchIndex.taskID(for: identifier, selection: selection)
    }
    #endif
}
