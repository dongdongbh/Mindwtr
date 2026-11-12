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
