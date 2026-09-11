import AppIntents
import Foundation
import WidgetKit

private let mindwtrDefaultWidgetListId = "focus"
private let mindwtrSavedFilterListPrefix = "filter:"

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrWidgetListEntity: AppEntity {
    let id: String
    let name: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation {
        TypeDisplayRepresentation(name: "List")
    }

    static var defaultQuery = MindwtrWidgetListEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrWidgetListEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [MindwtrWidgetListEntity] {
        let options = Self.options()
        return identifiers.compactMap { id in options.first(where: { $0.id == id }) }
    }

    func suggestedEntities() async throws -> [MindwtrWidgetListEntity] {
        Self.options()
    }

    private static func options() -> [MindwtrWidgetListEntity] {
        let payload = MindwtrTasksWidgetSnapshotStore.configurationPayload
        let fallbackNames = [
            "focus": "Focus",
            "inbox": "Inbox",
            "next": "Next",
            "waiting": "Waiting",
            "someday": "Someday",
        ]
        var seen = Set<String>()
        var options: [MindwtrWidgetListEntity] = []

        for id in ["focus", "inbox", "next", "waiting", "someday"] {
            let name = payload.title(forList: id) ?? fallbackNames[id] ?? id
            if seen.insert(id).inserted {
                options.append(MindwtrWidgetListEntity(id: id, name: name))
            }
        }

        for filter in payload.savedFilters ?? [] {
            let id = mindwtrSavedFilterListPrefix + filter.id
            guard !filter.id.isEmpty, !filter.name.isEmpty, seen.insert(id).inserted else { continue }
            options.append(MindwtrWidgetListEntity(id: id, name: filter.name))
        }

        return options
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrTasksWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Mindwtr List"
    static var description = IntentDescription("Choose the Mindwtr list this widget shows.")

    @Parameter(title: "List")
    var list: MindwtrWidgetListEntity?

    init() {}

    init(list: MindwtrWidgetListEntity?) {
        self.list = list
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrTasksWidgetAppIntentProvider: AppIntentTimelineProvider {
    func placeholder(in _: Context) -> MindwtrTasksWidgetEntry {
        MindwtrTasksWidgetEntry(date: Date(), payload: .fallback, pendingActions: [])
    }

    func snapshot(
        for configuration: MindwtrTasksWidgetConfigurationIntent,
        in context: Context
    ) async -> MindwtrTasksWidgetEntry {
        entry(for: configuration, family: context.family)
    }

    func timeline(
        for configuration: MindwtrTasksWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<MindwtrTasksWidgetEntry> {
        let now = Date()
        let entry = entry(for: configuration, family: context.family, date: now)
        let refresh = Calendar.current.date(byAdding: .minute, value: 30, to: now)
            ?? now.addingTimeInterval(1800)
        return Timeline(entries: [entry], policy: .after(refresh))
    }

    private func entry(
        for configuration: MindwtrTasksWidgetConfigurationIntent,
        family: WidgetFamily,
        date: Date = Date()
    ) -> MindwtrTasksWidgetEntry {
        MindwtrTasksWidgetSnapshotStore.entry(
            for: family,
            listId: configuration.list?.id ?? mindwtrDefaultWidgetListId,
            date: date
        )
    }
}

private enum MindwtrWidgetTaskIntentError: LocalizedError {
    case unavailableTask
    case unavailableAction

    var errorDescription: String? {
        switch self {
        case .unavailableTask:
            return "This task is no longer available in the widget."
        case .unavailableAction:
            return "This widget action is no longer available."
        }
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrCompleteWidgetTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Mindwtr Task"
    static var description = IntentDescription("Queues a Mindwtr task for completion.")
    static var isDiscoverable: Bool { false }

#if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes {
        .background
    }
#endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Task identifier")
    var taskId: String

    @Parameter(title: "Completion token")
    var completionToken: String

    init() {
        taskId = ""
        completionToken = ""
    }

    init(taskId: String, completionToken: String) {
        self.taskId = taskId
        self.completionToken = completionToken
    }

    func perform() async throws -> some IntentResult {
        guard MindwtrTasksWidgetSnapshotStore.contains(
            taskId: taskId,
            completionToken: completionToken
        ) else {
            throw MindwtrWidgetTaskIntentError.unavailableTask
        }

        try MindwtrWidgetActionStore.appGroupStore().enqueue(
            taskId: taskId,
            token: completionToken
        )
        WidgetCenter.shared.reloadTimelines(ofKind: mindwtrWidgetKind)
        return .result()
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrUndoWidgetTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Undo Mindwtr Task Completion"
    static var description = IntentDescription("Cancels a queued Mindwtr task completion.")
    static var isDiscoverable: Bool { false }

#if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes {
        .background
    }
#endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Action identifier")
    var actionId: String

    init() {
        actionId = ""
    }

    init(actionId: String) {
        self.actionId = actionId
    }

    func perform() async throws -> some IntentResult {
        let store = try MindwtrWidgetActionStore.appGroupStore()
        guard try store.cancel(id: actionId) else {
            throw MindwtrWidgetTaskIntentError.unavailableAction
        }

        WidgetCenter.shared.reloadTimelines(ofKind: mindwtrWidgetKind)
        return .result()
    }
}
