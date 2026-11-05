import AppIntents
import Foundation
import WidgetKit

private enum NativeWidgetTaskIntentError: LocalizedError {
    case unavailableTask, unavailableAction
    var errorDescription: String? {
        switch self {
        case .unavailableTask: return String(localized: "This task is no longer available in the widget.")
        case .unavailableAction: return String(localized: "This widget action is no longer available.")
        }
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct NativeCompleteWidgetTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Mindwtr Task"
    static var description = IntentDescription("Queues a Mindwtr task for completion.")
    static var isDiscoverable: Bool { false }

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Task identifier") var identifier: String
    @Parameter(title: "Completion token") var completionToken: String

    init() { identifier = ""; completionToken = "" }
    init(identifier: String, completionToken: String) {
        self.identifier = identifier; self.completionToken = completionToken
    }

    func perform() async throws -> some IntentResult {
        guard let cache = NativeWidgetNextCache.live(), let record = try cache.read(),
              record.contains(identifier: identifier, token: completionToken) else {
            throw NativeWidgetTaskIntentError.unavailableTask
        }
        try NativeWidgetActionStore.live().enqueue(identifier: identifier, token: completionToken)
        WidgetCenter.shared.reloadTimelines(ofKind: NativeWidgetNextCache.kind)
        return .result()
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct NativeUndoWidgetTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Undo Mindwtr Task Completion"
    static var description = IntentDescription("Cancels a queued Mindwtr task completion.")
    static var isDiscoverable: Bool { false }

    #if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { .background }
    #endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Action identifier") var actionID: String

    init() { actionID = "" }
    init(actionID: String) { self.actionID = actionID }

    func perform() async throws -> some IntentResult {
        guard try NativeWidgetActionStore.live().cancel(id: actionID) else {
            throw NativeWidgetTaskIntentError.unavailableAction
        }
        WidgetCenter.shared.reloadTimelines(ofKind: NativeWidgetNextCache.kind)
        return .result()
    }
}
