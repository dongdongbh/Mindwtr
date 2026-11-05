import Foundation

public struct NativeRNStartupPreferences {
    public static let focusSectionKeys = ["focus", "schedule", "next", "upcoming", "reviewDue", "reviewProjects"]

    public struct Names {
        public let devicePrefix: String
        public let addAnother: String
        public let projectShowCompleted: String
        public let pomodoroCollapsed: String
        public let focusShowDetails: String
        public let focusExpandedSections: String
        public let referenceView: String
        public let historyViews: [String: String]
        public let manageOpenSections: String
        public var language: String { devicePrefix + "mindwtr-language" }
        public var theme: String { devicePrefix + "@mindwtr_theme" }
        public var taskOpenMode: String { devicePrefix + "mindwtr:view:taskOpenMode:v1" }
        public var inboxFolds: String { devicePrefix + "mindwtr:view:group-collapse:inbox:v1" }

        fileprivate init(prefix: String, devicePrefix: String, manage: String) {
            self.devicePrefix = devicePrefix
            addAnother = prefix + ".capture.addAnother"
            projectShowCompleted = prefix + ".project.showCompleted"
            pomodoroCollapsed = prefix + ".pomodoro.collapsed"
            focusShowDetails = prefix + ".focus.showDetails"
            focusExpandedSections = prefix + ".focus.expandedSections"
            referenceView = prefix + ".reference.view"
            historyViews = ["done": prefix + ".history.done.view", "archive": prefix + ".history.archived.view"]
            manageOpenSections = manage
        }
    }

    public let names: Names
    public let language: String
    public let theme: String
    public let taskOpenMode: String?
    public let addAnother: Bool
    public let projectShowCompleted: Bool
    public let pomodoroCollapsed: Bool
    public let focusShowDetails: Bool
    public let focusExpandedSections: [String: Bool]
    public let referenceGroupBy: String?
    public let referenceCollapsedGroups: [String: [String]]
    public let inboxCollapsedGroupsRaw: String?
    public let historyViews: [String: [String: Any]]
    public let manageOpenSectionsFallback: String?

    public init(selection: NativeLaunchSelection, defaults: UserDefaults) throws {
        let container: URL
        let names: Names
        switch selection {
        case let .production(owner):
            container = owner
            names = Names(prefix: "nativeFoundation", devicePrefix: "", manage: "mindwtr:settings:manage:openSections")
        case let .rehearsal(owner, _, identifier):
            guard identifier == NativeLaunchSelection.productionNamespace else { throw CocoaError(.coderInvalidValue) }
            container = owner
            names = Names(prefix: "nativeRNRehearsal", devicePrefix: "nativeRNRehearsal.", manage: "nativeRNRehearsal.manage.openSections")
        case .standard, .isolated:
            throw CocoaError(.coderInvalidValue)
        }
        self.names = names
        let legacy = try LegacyRNStorage(containerURL: container, bundleIdentifier: NativeLaunchSelection.productionNamespace)
        func string(_ rn: String, _ native: String) throws -> String? {
            if let stored = defaults.object(forKey: native) { return stored as? String }
            return try legacy.value(forKey: rn)
        }
        func boolean(_ rn: String, _ native: String) throws -> Bool {
            if let stored = defaults.object(forKey: native) { return stored as? Bool ?? false }
            return try legacy.value(forKey: rn) == "true"
        }
        language = try string("mindwtr-language", names.language) ?? ""
        theme = try string("@mindwtr_theme", names.theme) ?? ""
        taskOpenMode = try string("mindwtr:view:taskOpenMode:v1", names.taskOpenMode)
        addAnother = try boolean("mindwtr:quickCapture:addAnother", names.addAnother)
        projectShowCompleted = try boolean("mindwtr:view:project-detail:show-completed:v1", names.projectShowCompleted)
        pomodoroCollapsed = try boolean("@mindwtr_pomodoro_collapsed", names.pomodoroCollapsed)
        inboxCollapsedGroupsRaw = try string("mindwtr:view:group-collapse:inbox:v1", names.inboxFolds)
        if defaults.object(forKey: names.manageOpenSections) == nil {
            manageOpenSectionsFallback = try legacy.value(forKey: "mindwtr:settings:manage:openSections")
        } else { manageOpenSectionsFallback = nil }
        let focus = Self.object(try legacy.value(forKey: "mindwtr:view:focus:v1"))
        if let stored = defaults.object(forKey: names.focusShowDetails) {
            focusShowDetails = stored as? Bool ?? false
        } else { focusShowDetails = Self.strictBoolean(focus?["showDetails"]) ?? false }
        if let stored = defaults.object(forKey: names.focusExpandedSections) {
            focusExpandedSections = Self.focusMap(stored, legacyAlias: false)
        } else { focusExpandedSections = Self.focusMap(focus?["expandedSections"], legacyAlias: true) }
        if let stored = defaults.object(forKey: names.referenceView) {
            let view = stored as? [String: Any] ?? [:]
            referenceGroupBy = view["groupBy"] as? String
            referenceCollapsedGroups = Self.foldMap(view["collapsedGroups"], preserveEmpty: true)
        } else {
            referenceGroupBy = try legacy.value(forKey: "mindwtr:view:reference:groupBy:v1")
            referenceCollapsedGroups = Self.foldMap(Self.object(try legacy.value(forKey: "mindwtr:view:group-collapse:reference:v1")), preserveEmpty: false)
        }
        var history: [String: [String: Any]] = [:]
        for (name, viewKey, foldKey) in [
            ("done", "mindwtr:view:done:v1", "mindwtr:view:group-collapse:done:v1"),
            ("archive", "mindwtr:view:archived:v1", "mindwtr:view:group-collapse:archived:v1")
        ] {
            if let key = names.historyViews[name], let stored = defaults.object(forKey: key) {
                history[name] = stored as? [String: Any] ?? [:]
            } else {
                var view = Self.object(try legacy.value(forKey: viewKey)) ?? [:]
                if let folds = Self.object(try legacy.value(forKey: foldKey)) {
                    view["collapsedGroups"] = Self.foldMap(folds, preserveEmpty: false)
                }
                history[name] = view
            }
        }
        historyViews = history
    }

    private static func object(_ raw: String?) -> [String: Any]? {
        guard let raw, let data = raw.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
    private static func strictBoolean(_ raw: Any?) -> Bool? {
        guard let value = raw as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }
    private static func focusMap(_ raw: Any?, legacyAlias: Bool) -> [String: Bool] {
        guard let source = raw as? [String: Any] else { return [:] }
        var result: [String: Bool] = [:]
        for key in focusSectionKeys {
            if let value = strictBoolean(source[key]) { result[key] = value }
        }
        if legacyAlias, result["next"] == nil, let value = strictBoolean(source["nextActions"]) { result["next"] = value }
        return result
    }
    private static func foldMap(_ raw: Any?, preserveEmpty: Bool) -> [String: [String]] {
        guard let axes = raw as? [String: Any] else { return [:] }
        var folds: [String: [String]] = [:]
        for (axis, value) in axes {
            guard let values = value as? [Any] else { continue }
            let ids = values.compactMap { $0 as? String }
            if preserveEmpty || !ids.isEmpty { folds[axis] = ids }
        }
        return folds
    }
}
