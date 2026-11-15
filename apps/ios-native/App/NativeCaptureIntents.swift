import AppIntents
import MindwtrNativeCore
import UIKit

struct MindwtrOpenQuickCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Add Task"
    static var description = IntentDescription("Opens Mindwtr quick capture.")

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { true }

    @MainActor
    func perform() async throws -> some IntentResult {
        NativeQuickCaptureRequests.shared.request()
        return .result()
    }
}

struct MindwtrOpenWidgetTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Task"
    static var description = IntentDescription("Opens a Mindwtr task.")
    static var isDiscoverable: Bool { false }

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { true }

    @Parameter(title: "Task identifier")
    var taskId: String

    init() { taskId = "" }
    init(taskId: String) { self.taskId = taskId }

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let selection = try? NativeAppLaunch.selection.get(),
              let url = NativeProductionWidgetTaskIntent.url(taskId: taskId, selection: selection,
                  bundleIdentifier: Bundle.main.bundleIdentifier) else { return .result() }
        _ = await UIApplication.shared.open(url, options: [:])
        return .result()
    }
}

private enum NativeShortcutIntentLauncher {
    @MainActor
    static func open(_ link: (String) -> URL?) async -> Bool {
        guard let selection = try? NativeAppLaunch.selection.get(),
              let scheme = NativeShortcutIntentLinks.scheme(selection: selection, bundleIdentifier: Bundle.main.bundleIdentifier),
              let url = link(scheme) else { return false }
        return await UIApplication.shared.open(url, options: [:])
    }

    static func savedLists() -> [NativeSavedListCatalog.List] {
        guard let selection = try? NativeAppLaunch.selection.get() else { return [] }
        return NativeSavedListCatalog.load(selection: selection, bundleIdentifier: Bundle.main.bundleIdentifier)
    }
}

enum MindwtrShortcutList: String, AppEnum {
    case inbox
    case focus
    case waiting
    case someday
    case projects
    case review
    case calendar

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Mindwtr List")
    static var caseDisplayRepresentations: [MindwtrShortcutList: DisplayRepresentation] = [
        .inbox: "Inbox",
        .focus: "Focus",
        .waiting: "Waiting",
        .someday: "Someday",
        .projects: "Projects",
        .review: "Review",
        .calendar: "Calendar"
    ]

    var dialogTitle: String {
        switch self {
        case .inbox: return "Inbox"
        case .focus: return "Focus"
        case .waiting: return "Waiting"
        case .someday: return "Someday"
        case .projects: return "Projects"
        case .review: return "Review"
        case .calendar: return "Calendar"
        }
    }
}

struct MindwtrSiriCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Capture to Mindwtr"
    static var description = IntentDescription("Captures a task into the Mindwtr Inbox for later processing.")

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { true }

    @Parameter(title: "Task")
    var task: String

    @Parameter(title: "Note")
    var note: String?

    @Parameter(title: "Tags")
    var tags: String?

    @Parameter(title: "Project")
    var project: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Capture \(\.$task)") {
            \.$note
            \.$tags
            \.$project
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard NativeShortcutIntentLinks.trimmed(task) != nil else {
            return .result(dialog: "Tell Mindwtr what to capture.")
        }
        _ = await NativeShortcutIntentLauncher.open {
            NativeShortcutIntentLinks.capture(scheme: $0, task: task, note: note, tags: tags, project: project)
        }
        return .result(dialog: "Review it in Mindwtr.")
    }
}

struct MindwtrOpenListIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Mindwtr List"
    static var description = IntentDescription("Opens a Mindwtr GTD list or workflow view.")

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { true }

    @Parameter(title: "List", default: MindwtrShortcutList.inbox)
    var list: MindwtrShortcutList

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$list)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        _ = await NativeShortcutIntentLauncher.open { NativeShortcutIntentLinks.feature(scheme: $0, feature: list.rawValue) }
        return .result(dialog: "Opening \(list.dialogTitle) in Mindwtr.")
    }
}

struct MindwtrSavedListEntity: AppEntity {
    let id: String
    let name: String
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Saved List")
    static var defaultQuery = MindwtrSavedListQuery()
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

struct MindwtrSavedListQuery: EntityStringQuery {
    func suggestedEntities() async throws -> [MindwtrSavedListEntity] {
        NativeShortcutIntentLauncher.savedLists().map { MindwtrSavedListEntity(id: $0.id, name: $0.name) }
    }

    func entities(for identifiers: [String]) async throws -> [MindwtrSavedListEntity] {
        let lists = try await suggestedEntities()
        return identifiers.compactMap { id in lists.first { $0.id == id } }
    }

    func entities(matching string: String) async throws -> [MindwtrSavedListEntity] {
        try await suggestedEntities().filter { $0.name.localizedCaseInsensitiveContains(string) }
    }
}

struct MindwtrOpenSavedListIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Mindwtr Saved List"
    static var description = IntentDescription("Opens a saved Focus filter, including context filters. Save the filter and open Mindwtr once to refresh the available lists.")

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .foreground(.immediate) }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { true }

    @Parameter(title: "Saved List")
    var list: MindwtrSavedListEntity

    static var parameterSummary: some ParameterSummary { Summary("Open \(\.$list)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard NativeShortcutIntentLauncher.savedLists().contains(where: { $0.id == list.id }),
              await NativeShortcutIntentLauncher.open({ NativeShortcutIntentLinks.savedList(scheme: $0, id: list.id) }) else {
            return .result(dialog: "That saved list is unavailable. Open Mindwtr to refresh it, then choose a saved list again.")
        }
        return .result(dialog: "Opening your saved list in Mindwtr.")
    }
}

enum MindwtrBackgroundCaptureError: Error, CustomLocalizedStringResourceConvertible {
    case emptyTask
    case writeFailed

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .emptyTask: return "Tell Mindwtr what to add."
        case .writeFailed: return "Mindwtr could not save the task. Open the app and try again."
        }
    }
}

struct MindwtrBackgroundCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "Add to Mindwtr"
    static var description = IntentDescription("Silently adds a task to Mindwtr without opening the app. It can file into a project. The item appears the next time Mindwtr opens.")

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Task")
    var task: String

    @Parameter(title: "Note")
    var note: String?

    @Parameter(title: "Tags")
    var tags: String?

    @Parameter(title: "Project")
    var project: String?

    @Parameter(title: "Due date")
    var dueDate: Date?

    @Parameter(title: "Start date")
    var startDate: Date?

    static var parameterSummary: some ParameterSummary {
        Summary("Add \(\.$task) to Mindwtr") {
            \.$note
            \.$tags
            \.$project
            \.$dueDate
            \.$startDate
        }
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmedTask = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTask.isEmpty else { throw MindwtrBackgroundCaptureError.emptyTask }
        guard let queue = NativeShortcutCaptureQueue.live(),
              queue.enqueue(task: trimmedTask, note: note, tags: tags, project: project, dueDate: dueDate, startDate: startDate) else {
            throw MindwtrBackgroundCaptureError.writeFailed
        }
        return .result(dialog: "Added to Mindwtr.")
    }
}

enum MindwtrGetTasksList: String, AppEnum {
    case inbox
    case focus
    case next
    case waiting
    case someday

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Mindwtr Task List")
    static var caseDisplayRepresentations: [MindwtrGetTasksList: DisplayRepresentation] = [
        .inbox: "Inbox",
        .focus: "Focus",
        .next: "Next",
        .waiting: "Waiting",
        .someday: "Someday"
    ]

    var dialogTitle: String {
        switch self {
        case .inbox: return "Inbox"
        case .focus: return "Focus"
        case .next: return "Next"
        case .waiting: return "Waiting"
        case .someday: return "Someday"
        }
    }
}

private enum MindwtrTaskDueDateDisplay {
    private static let mediumDateOnly: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static let shortDateTime: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter
    }()

    static func format(_ raw: String) -> String {
        if let dateOnly = NativeShortcutCaptureQueue.dateOnly.date(from: raw) { return mediumDateOnly.string(from: dateOnly) }
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let dateTime = ISO8601DateFormatter().date(from: raw) ?? fractional.date(from: raw) { return shortDateTime.string(from: dateTime) }
        return raw
    }
}

private enum NativeShortcutsSnapshotLoader {
    static var file: NativeShortcutsSnapshotFile? {
        guard let selection = try? NativeAppLaunch.selection.get() else { return nil }
        return NativeShortcutsSnapshotFile.live(selection: selection)
    }

    static func load() -> NativeShortcutsSnapshot? { file?.read() }
}

enum MindwtrGetTasksError: Error, CustomLocalizedStringResourceConvertible {
    case appLocked

    var localizedStringResource: LocalizedStringResource {
        "Get Mindwtr Tasks is off while App Lock is on. Turn off App Lock in Mindwtr Settings to use it."
    }
}

struct MindwtrTaskEntity: AppEntity {
    let id: String
    let title: String
    let listLabel: String
    let dueDate: String?

    static var typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "Mindwtr Task",
        numericFormat: "\(placeholder: .int) tasks"
    )

    var displayRepresentation: DisplayRepresentation {
        if let dueDate, !dueDate.isEmpty {
            return DisplayRepresentation(title: "\(title)", subtitle: "\(listLabel) · Due \(MindwtrTaskDueDateDisplay.format(dueDate))")
        }
        return DisplayRepresentation(title: "\(title)", subtitle: "\(listLabel)")
    }

    static var defaultQuery = MindwtrTaskEntityQuery()

    init(item: NativeShortcutsSnapshotItem) {
        id = item.id
        title = item.title
        dueDate = item.dueDate
        if let projectName = item.projectName, !projectName.isEmpty {
            listLabel = projectName
        } else {
            listLabel = MindwtrGetTasksList(rawValue: item.list)?.dialogTitle ?? item.list.capitalized
        }
    }
}

struct MindwtrTaskEntityQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [MindwtrTaskEntity] {
        let items = NativeShortcutsSnapshotLoader.load()?.allItems() ?? []
        let byId = Dictionary(items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return identifiers.compactMap { byId[$0] }.map(MindwtrTaskEntity.init(item:))
    }

    func entities(matching string: String) async throws -> [MindwtrTaskEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        return (NativeShortcutsSnapshotLoader.load()?.allItems() ?? [])
            .filter { $0.title.lowercased().contains(needle) }
            .prefix(25)
            .map(MindwtrTaskEntity.init(item:))
    }
}

struct MindwtrGetTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Get Mindwtr Tasks"
    static var description = IntentDescription("Reads up to 50 tasks from a Mindwtr list, as of the last time Mindwtr was open. When Project is set, it is read instead of the list. Never opens the app.")

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "List", default: MindwtrGetTasksList.next)
    var list: MindwtrGetTasksList

    @Parameter(title: "Project")
    var project: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Get tasks from \(\.$list), overridden by \(\.$project) if set")
    }

    func perform() async throws -> some IntentResult & ReturnsValue<[MindwtrTaskEntity]> & ProvidesDialog {
        if NativeShortcutsSnapshotLoader.file?.withdrawnForAppLock == true { throw MindwtrGetTasksError.appLocked }
        let snapshot = NativeShortcutsSnapshotLoader.load()
        let items: [NativeShortcutsSnapshotItem]
        let omittedCount: Int?
        let sourceLabel: String
        if let trimmedProject = NativeShortcutIntentLinks.trimmed(project) {
            switch snapshot?.items(forProjectNamed: trimmedProject) ?? .missing {
            case .matched(let matchedItems, let matchedOmittedCount):
                items = matchedItems
                omittedCount = matchedOmittedCount
                sourceLabel = "project"
            case .missing:
                return .result(value: [], dialog: "That project is not in the current Mindwtr snapshot. Open Mindwtr to refresh it.")
            case .ambiguous:
                return .result(value: [], dialog: "More than one project has that name. Open Mindwtr and choose the project there.")
            }
        } else {
            items = snapshot?.items(forList: list.rawValue) ?? []
            omittedCount = snapshot?.knownOmittedTaskCount(forList: list.rawValue)
            sourceLabel = "list"
        }

        let entities = items.map(MindwtrTaskEntity.init(item:))
        guard !entities.isEmpty, let snapshot else {
            return .result(value: [], dialog: "No tasks found. Open Mindwtr to refresh this list.")
        }
        let current = snapshot.freshness() == .current
        if let omittedCount, omittedCount > 0 {
            if current {
                return .result(value: entities, dialog: "Found \(entities.count) task(s); \(omittedCount) eligible task(s) from this \(sourceLabel) were omitted by the snapshot limit.")
            }
            return .result(value: entities, dialog: "Found \(entities.count) task(s) in a stale snapshot; \(omittedCount) eligible task(s) from this \(sourceLabel) were omitted. Open Mindwtr to refresh it.")
        }
        if omittedCount == nil && entities.count >= 50 {
            if current {
                return .result(value: entities, dialog: "Found \(entities.count) task(s) at the snapshot limit. This \(sourceLabel) may contain more tasks.")
            }
            return .result(value: entities, dialog: "Found \(entities.count) task(s) at the limit in a stale snapshot. This \(sourceLabel) may contain more tasks. Open Mindwtr to refresh it.")
        }
        if current {
            return .result(value: entities, dialog: "Found \(entities.count) task(s).")
        }
        return .result(value: entities, dialog: "Found \(entities.count) task(s) in a stale snapshot. Open Mindwtr to refresh it.")
    }
}

struct MindwtrNativeCaptureShortcuts: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor { .blue }

    @AppShortcutsBuilder
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: MindwtrSiriCaptureIntent(),
            phrases: [
                "Capture in \(.applicationName)",
                "Add to \(.applicationName)",
                "Create a task in \(.applicationName)"
            ],
            shortTitle: "Capture Task",
            systemImageName: "tray.and.arrow.down"
        )
        AppShortcut(
            intent: MindwtrOpenListIntent(),
            phrases: [
                "Open \(.applicationName)",
                "Open a list in \(.applicationName)",
                "Show \(.applicationName)"
            ],
            shortTitle: "Open List",
            systemImageName: "list.bullet"
        )
        AppShortcut(
            intent: MindwtrOpenQuickCaptureIntent(),
            phrases: ["Add a task in \(.applicationName)", "Open quick capture in \(.applicationName)"],
            shortTitle: "Add Task",
            systemImageName: "tray.and.arrow.down"
        )
    }
}

#if DEBUG && targetEnvironment(simulator)
import SwiftUI

struct NativeQuickCaptureIntentFixtureView: View {
    let model: CoreModel
    var body: some View {
        VStack(spacing: 2) {
            Text(model.quickCaptureIntentFixtureState)
                .accessibilityIdentifier("quick-capture-intent-state")
            HStack(spacing: 4) {
                ForEach(["perform", "busy", "release-busy", "conceal", "reveal"], id: \.self) { command in
                    Button(command) { Task { await model.quickCaptureIntentFixtureCommand(command) } }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("quick-capture-intent-" + command)
                }
            }
        }.font(.caption2).padding(4).background(.regularMaterial)
    }
}
#endif
