import Foundation

@MainActor
public final class NativeWidgetFamilyPublisher {
    public static let namespace = NativeLaunchSelection.productionNamespace
    public static let group = "group.tech.dongdongbh.mindwtr"
    public static let kinds = ["MindwtrTasksWidget", "MindwtrCompactWidget", "MindwtrFocusLockWidget", "MindwtrCaptureLockWidget"]
    private let defaults: UserDefaults
    private var published: [(String, String)]?

    public static func live(selection: NativeLaunchSelection) -> NativeWidgetFamilyPublisher? {
        #if os(iOS)
        guard let group = group(selection: selection, bundleIdentifier: Bundle.main.bundleIdentifier),
              FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil else { return nil }
        return NativeWidgetFamilyPublisher(defaults: UserDefaults(suiteName: group))
        #else
        return nil
        #endif
    }

    static func group(selection: NativeLaunchSelection, bundleIdentifier: String?) -> String? {
        guard bundleIdentifier == namespace, case .production = selection else { return nil }
        return group
    }

    init?(defaults: UserDefaults?) {
        guard let defaults else { return nil }
        self.defaults = defaults
    }

    public func publish(_ snapshot: NativeWidgetFamilySnapshot, reload: (String) -> Void) throws {
        let entries = Self.entries(snapshot)
        for (name, value) in entries { defaults.set(value, forKey: name) }
        guard matches(entries) else { throw Self.unavailable }
        published = entries
        for kind in Self.kinds { reload(kind) }
    }

    public func invalidate(reload: (String) -> Void) throws {
        guard let published, matches(published) else { throw Self.unavailable }
        for (name, _) in published { defaults.removeObject(forKey: name) }
        guard published.allSatisfy({ defaults.object(forKey: $0.0) == nil }) else { throw Self.unavailable }
        self.published = nil
        for kind in Self.kinds { reload(kind) }
    }

    private func matches(_ entries: [(String, String)]) -> Bool {
        entries.allSatisfy { name, expected in
            guard let actual = defaults.object(forKey: name) as? String else { return false }
            return Data(actual.utf8) == Data(expected.utf8)
        }
    }

    private static func entries(_ snapshot: NativeWidgetFamilySnapshot) -> [(String, String)] {
        [("mindwtr-ios-widget-payload", snapshot.payloads.defaultPayload),
         ("mindwtr-ios-widget-payload-small", snapshot.payloads.small),
         ("mindwtr-ios-widget-payload-medium", snapshot.payloads.medium),
         ("mindwtr-ios-widget-payload-large", snapshot.payloads.large),
         ("mindwtr-ios-widget-payload-extra-large", snapshot.payloads.extraLarge)]
    }

    private static var unavailable: HostFailure { HostFailure("Native widget family publication is unavailable") }
}
