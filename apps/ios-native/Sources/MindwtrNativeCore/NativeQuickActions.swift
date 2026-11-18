import Foundation

public enum NativeQuickActions {
    private static let paths = [
        "tech.dongdongbh.mindwtr.add_task": "/capture-quick?mode=text",
        "tech.dongdongbh.mindwtr.open_focus": "/focus",
        "tech.dongdongbh.mindwtr.open_calendar": "/calendar",
    ]

    public static func url(type: String, selection: NativeLaunchSelection, bundleIdentifier: String?) -> URL? {
        url(type: type, scheme: NativeShortcutIntentLinks.scheme(selection: selection, bundleIdentifier: bundleIdentifier))
    }

    public static func url(type: String, scheme: String?) -> URL? {
        guard let scheme, let path = paths[type] else { return nil }
        return URL(string: scheme + "://" + path)
    }
}
