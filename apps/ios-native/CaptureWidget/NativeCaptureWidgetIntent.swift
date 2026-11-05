import AppIntents

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
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
    func perform() async throws -> some IntentResult { .result() }
}
