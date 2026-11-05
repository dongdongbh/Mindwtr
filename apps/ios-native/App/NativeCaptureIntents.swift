import AppIntents
import MindwtrNativeCore
import UIKit

@available(iOS 16.0, *)
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

@available(iOS 17.0, *)
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

@available(iOS 16.0, *)
struct MindwtrNativeCaptureShortcuts: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor { .blue }

    @AppShortcutsBuilder
    static var appShortcuts: [AppShortcut] {
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
    @ObservedObject var model: CoreModel
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
