import Foundation

public enum NativeProductionWidgetTaskIntent {
    public static func url(taskId: String, selection: NativeLaunchSelection, bundleIdentifier: String?) -> URL? {
        guard bundleIdentifier == NativeLaunchSelection.productionNamespace, case .production = selection,
              !taskId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              taskId.utf16.count <= 500,
              !taskId.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        var components = URLComponents()
        components.scheme = "mindwtr"
        components.host = "open"
        components.queryItems = [URLQueryItem(name: "task", value: taskId)]
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.url
    }
}
