import XCTest
@testable import MindwtrNativeCore

final class HostAdmissionTests: XCTestCase {
    private enum Entry { case call, pomodoroCall, reminderCompletionCall, invoke, attachmentDraft }
    private typealias Turns = HostAdmission.Turns

    private static let voice = "HostFailure: INVALID_INPUT: Native voice data is malformed"
    private static let aiText = "CoreHostRejection: INVALID_INPUT: AI text configuration requires its private facade"
    private static let aiTimeout = "CoreHostRejection: INVALID_INPUT: AI timeout requires its private facade"
    private static let aiEffort = "CoreHostRejection: INVALID_INPUT: AI reasoning effort requires its private facade"
    private static let aiGemini = "CoreHostRejection: INVALID_INPUT: AI Gemini thinking budget requires its private facade"
    private static let pomodoro = "CoreHostRejection: INVALID_INPUT: Pomodoro requires its explicit facade"
    private static let calendarPush = "CoreHostRejection: NOT_READY: Calendar push requires its current explicit owner"
    private static let calendarAccess = "CoreHostRejection: NOT_READY: Calendar access requires its current explicit owner"
    private static let receipts = "CoreHostRejection: INVALID_INPUT: Receipt retention requires startup ownership"
    private static let snooze = "CoreHostRejection: INVALID_INPUT: Reminder Snooze requires its explicit facade"
    private static let completion = "CoreHostRejection: INVALID_INPUT: Reminder completion requires its explicit facade"
    private static let reminders = "HostFailure: NOT_READY: Reminder reconciliation is unavailable"
    private static let subscription = "CoreHostRejection: NOT_READY: Calendar subscription settings require their current explicit owner"
    private static let deviceCalendar = "CoreHostRejection: NOT_READY: Device Calendar Settings require their current explicit owner"
    private static let notification = "CoreHostRejection: NOT_READY: Notification Settings require their current explicit owner"
    private static let accessAwaiting = "CoreHostRejection: NOT_READY: Calendar access is still awaiting its owner"

    private func refusal(_ admission: HostAdmission, _ entry: Entry, _ method: String) -> String? {
        do {
            switch entry {
            case .call: try admission.admitCall(method, pomodoroOwned: false, reminderCompletionOwned: false)
            case .pomodoroCall: try admission.admitCall(method, pomodoroOwned: true, reminderCompletionOwned: false)
            case .reminderCompletionCall: try admission.admitCall(method, pomodoroOwned: false, reminderCompletionOwned: true)
            case .invoke: try admission.admitInvoke(method)
            case .attachmentDraft: try admission.admitAttachmentDraft()
            }
            return nil
        } catch {
            return "\(type(of: error)): \(error.localizedDescription)"
        }
    }

    func testEachTurnKindAdmitsOrRefusesWithTheExactRefusal() {
        let rows: [(Turns, Turns, String?, Entry, String, String?)] = [
            ([], [], nil, .call, "projects", nil),
            ([], [], nil, .call, "iosVoiceCaptureCommit", Self.voice),
            ([], [], nil, .call, "iosAITextConfiguration", Self.aiText),
            ([], .aiTextConfiguration, nil, .call, "iosAITextConfiguration", nil),
            ([], .aiTextConfiguration, nil, .call, "iosAITextConfigurationV2", nil),
            ([], .aiTextConfiguration, nil, .call, "iosAITextConfigurationCommit", Self.aiText),
            ([], [], nil, .call, "iosAIRequestTimeout", Self.aiTimeout),
            ([], .aiRequestTimeout, nil, .call, "iosAIRequestTimeout", nil),
            ([], .aiRequestTimeout, nil, .call, "iosAIRequestTimeoutCommit", Self.aiTimeout),
            ([], [], nil, .call, "iosAIReasoningEffort", Self.aiEffort),
            ([], .aiReasoningEffort, nil, .call, "iosAIReasoningEffort", nil),
            ([], .aiReasoningEffort, nil, .call, "iosAIReasoningEffortCommit", Self.aiEffort),
            ([], [], nil, .call, "iosAIGeminiThinkingBudget", Self.aiGemini),
            ([], .aiGeminiThinkingBudget, nil, .call, "iosAIGeminiThinkingBudget", nil),
            ([], .aiGeminiThinkingBudget, nil, .call, "iosAIGeminiThinkingBudgetCommit", Self.aiGemini),
            ([], [], nil, .call, "pomodoroTransitionWrite", Self.pomodoro),
            ([], [], nil, .pomodoroCall, "pomodoroTransitionWrite", nil),
            ([], [], nil, .call, "iosCalendarPushStart", Self.calendarPush),
            (.calendarPush, [], nil, .call, "projects", Self.calendarPush),
            ([], [], nil, .call, "grantDeviceCalendarAccess", Self.calendarAccess),
            (.calendarAccess, [], nil, .call, "projects", Self.calendarAccess),
            ([], [], nil, .call, "iosPruneReceipts", Self.receipts),
            ([], [], nil, .call, "reminderSnoozeCommit", Self.snooze),
            ([], [], nil, .call, "reminderCompletionCommit", Self.completion),
            ([], [], nil, .reminderCompletionCall, "reminderCompletionCommit", nil),
            ([], [], nil, .reminderCompletionCall, "reminderCompletionProbe", Self.completion),
            ([], [], nil, .call, "iosReminderBegin", Self.reminders),
            (.reminderEffects, .reminderEffects, nil, .call, "projects", Self.reminders),
            (.pomodoroAlarm, [], nil, .call, "projects", Self.reminders),
            ([], [], "calendarSubscriptionAdd", .call, "projects", Self.subscription),
            ([], [], "calendarSubscriptionAdd", .call, "calendarSubscriptionAdd", nil),
            ([], [], "calendarSubscriptionAdd", .call, "calendarSubscriptionAddCommit", Self.subscription),
            ([], [], nil, .call, "calendarSubscriptionSetting", Self.subscription),
            ([], [], nil, .call, "deviceCalendarSetting", Self.deviceCalendar),
            (.deviceCalendarSetting, [], nil, .call, "deviceCalendarSetting", nil),
            (.deviceCalendarSetting, [], nil, .call, "projects", Self.deviceCalendar),
            (.deviceCalendarSetting, [], nil, .call, "deviceCalendarSettingCommit", Self.deviceCalendar),
            ([], [], nil, .call, "notificationSetting", Self.notification),
            ([], .notificationSetting, nil, .call, "notificationSetting", nil),
            (.notificationSetting, [], nil, .call, "projects", Self.notification),
            (.notificationSetting, .notificationSetting, nil, .call, "projects", nil),
            (.notificationSetting, .notificationSetting, nil, .call, "notificationSettingCommit", Self.notification),
            ([.captureAI, .aiConfiguration, .aiTextConfiguration, .aiRequestTimeout], [], nil, .call, "projects", nil),

            (.calendarPush, [], nil, .call, "iosVoiceCaptureCommit", Self.voice),
            (.calendarPush, [], nil, .call, "pomodoroTransitionWrite", Self.pomodoro),
            ([.calendarPush, .calendarAccess], [], nil, .call, "projects", Self.calendarPush),
            (.calendarAccess, [], nil, .call, "iosPruneReceipts", Self.calendarAccess),
            (.reminderEffects, [], nil, .call, "iosPruneReceipts", Self.receipts),
            (.reminderEffects, [], nil, .call, "reminderSnoozeCommit", Self.snooze),
            (.reminderEffects, [], nil, .reminderCompletionCall, "reminderCompletionProbe", Self.completion),
            ([.reminderEffects, .deviceCalendarSetting, .notificationSetting], [], "calendarSubscriptionAdd", .call, "projects", Self.reminders),
            ([.deviceCalendarSetting, .notificationSetting], [], "calendarSubscriptionAdd", .call, "projects", Self.subscription),
            ([.deviceCalendarSetting, .notificationSetting], [], nil, .call, "projects", Self.deviceCalendar),

            ([], [], nil, .invoke, "projects", nil),
            (.calendarAccess, [], nil, .invoke, "projects", Self.accessAwaiting),
            (.calendarAccess, [], nil, .invoke, "deviceCalendarAccessAcknowledged", nil),
            (.reminderEffects, [], nil, .invoke, "iosReminderBegin", Self.reminders),
            (.reminderEffects, .reminderEffects, nil, .invoke, "iosReminderBegin", nil),
            (.pomodoroAlarm, .reminderEffects, nil, .invoke, "iosPomodoroAlarmBegin", nil),
            (.pomodoroAlarm, .reminderEffects, nil, .invoke, "projects", Self.reminders),
            ([], .reminderEffects, nil, .invoke, "projects", nil),
            ([.calendarAccess, .reminderEffects], [], nil, .invoke, "projects", Self.accessAwaiting),
            ([.notificationSetting, .aiTextConfiguration, .calendarPush, .deviceCalendarSetting], [], "calendarSubscriptionAdd", .invoke, "projects", nil),

            ([], [], nil, .attachmentDraft, "", nil),
            ([.calendarPush, .deviceCalendarSetting], [], "calendarSubscriptionAdd", .attachmentDraft, "", nil),
            ([.aiTextConfiguration, .aiRequestTimeout, .aiReasoningEffort, .aiGeminiThinkingBudget, .notificationSetting, .reminderEffects, .pomodoroAlarm],
             [.aiTextConfiguration, .aiRequestTimeout, .aiReasoningEffort, .aiGeminiThinkingBudget, .notificationSetting, .reminderEffects], nil, .attachmentDraft, "", nil),
        ]
        for (active, ownerAccess, operation, entry, method, expected) in rows {
            let admission = HostAdmission(active: active, ownerAccess: ownerAccess, calendarSubscriptionOperation: operation)
            XCTAssertEqual(refusal(admission, entry, method), expected, "\(entry) \(method) active \(active.rawValue) owner \(ownerAccess.rawValue) \(operation ?? "-")")
        }
    }

    func testAttachmentDraftRefusalsWinInTheirFixedOrder() {
        let chain: [(Turns, String)] = [
            (.captureAI, "HostFailure: Capture copilot request is still active"),
            (.calendarAccess, Self.accessAwaiting),
            (.aiTextConfiguration, "HostFailure: AI text configuration edit is still awaiting its owner"),
            (.aiConfiguration, "HostFailure: AI text configuration operation is active"),
            (.aiRequestTimeout, "HostFailure: AI timeout edit is still awaiting its owner"),
            (.aiReasoningEffort, "HostFailure: AI reasoning effort edit is still awaiting its owner"),
            (.aiGeminiThinkingBudget, "HostFailure: AI Gemini thinking budget edit is still awaiting its owner"),
            (.notificationSetting, "HostFailure: Notification edit is still awaiting its owner"),
            (.pomodoroAlarm, Self.reminders),
        ]
        var active = chain.reduce(into: Turns()) { $0.formUnion($1.0) }
        for (turn, expected) in chain {
            XCTAssertEqual(refusal(HostAdmission(active: active, ownerAccess: [], calendarSubscriptionOperation: nil), .attachmentDraft, ""), expected)
            active.remove(turn)
        }
        XCTAssertNil(refusal(HostAdmission(active: active, ownerAccess: [], calendarSubscriptionOperation: nil), .attachmentDraft, ""))
    }

    func testDeviceStorageIsExclusiveWithSettingEditsOnly() {
        XCTAssertEqual(Turns.deviceStorageExclusive, [.aiTextConfiguration, .aiConfiguration, .aiRequestTimeout, .aiReasoningEffort,
                                                      .aiGeminiThinkingBudget, .deviceCalendarSetting, .calendarSubscriptionSetting])
        XCTAssertTrue(HostAdmission(active: [], ownerAccess: [], calendarSubscriptionOperation: "calendarSubscriptionSetting")
            .active.contains(.calendarSubscriptionSetting))
        XCTAssertTrue(HostAdmission(active: [.captureAI, .notificationSetting, .calendarAccess, .calendarPush, .reminderEffects, .pomodoroAlarm],
                                    ownerAccess: [], calendarSubscriptionOperation: nil).active.isDisjoint(with: .deviceStorageExclusive))
    }

    func testHostRefusesCalendarPushWithoutItsOwnerAndAdmitsAnOrdinaryRead() async throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else {
            throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE to its absolute path")
        }
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".mindwtr-native-tests/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let core = CoreHost(databaseURL: directory.appendingPathComponent("core.sqlite"), bundleURL: URL(fileURLWithPath: path))
        addTeardownBlock { await core.close() }
        _ = try await core.start()
        do {
            _ = try await core.call("iosCalendarPushStart")
            XCTFail("Calendar push must require its explicit owner")
        } catch {
            XCTAssertEqual("\(type(of: error)): \(error.localizedDescription)", Self.calendarPush)
        }
        _ = try await core.call("projects")
    }
}
