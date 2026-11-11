import XCTest
import JavaScriptCore
@testable import MindwtrNativeCore

final class HostMethodRegistryTests: XCTestCase {
    func testEveryDurableWriteStaysJournaled() {
        let durableWrites: Set<String> = [
            "appLock", "archiveTaskCompletedAtWrite", "archivedTaskRestoreWrite", "archivedTasksDeleteUndoWrite", "archivedTasksDeleteWrite",
            "archivedTasksRestoreWrite", "areaColor", "areaCreate", "areaDelete", "areaOrder", "areaRename", "boardAction", "calendarComposerSave",
            "calendarDelete", "calendarEventTaskCreate", "calendarPreference", "calendarSubscriptionAdd", "calendarSubscriptionSetting",
            "calendarUnschedule", "captureCopilotSubmit", "captureLinesSubmit", "captureSubmit", "checklistReset", "checklistSave", "complete",
            "dataSetting", "deviceCalendarSetting", "doneTaskCompletedAtWrite", "doneTaskStatusWrite", "focusGroupWrite", "focusOrderWrite",
            "focusSavedFilterWrite", "generalPreference", "gettingStarted", "gtdWorkflow", "inboxCommit", "inboxOrganizeDestinationCreateWrite",
            "inboxSkip", "inboxTasksAddTagWrite", "inboxTasksMoveWrite", "inboxTasksOrganizeWrite", "inboxTasksRemoveTagWrite", "inboxUndo",
            "inlineChecklistWrite", "iosAIGeminiThinkingBudget", "iosAIReasoningEffort", "iosAIRequestTimeout", "iosAITextConfiguration",
            "iosAITextConfigurationV2", "iosWatchAudioIngest", "iosWatchIngest", "manageAreaCreate", "manageAreaDelete", "manageAreaEdit",
            "managePersonCreate", "managePersonDelete", "managePersonEdit", "manageTaxonomy", "mindSweepAdd", "notificationSetting",
            "pomodoroTransitionWrite", "projectAreaWrite", "projectAttachmentWrite", "projectCreate", "projectDateWrite", "projectDeleteUndo",
            "projectDeleteWrite", "projectDuplicateWrite", "projectFileRemoveWrite", "projectFlowWrite", "projectFocusWrite", "projectLifecycleWrite",
            "projectMoveWrite", "projectNotesWrite", "projectOrganizeDestinationCreateWrite", "projectRenameWrite", "projectSectionCreate", "projectSectionDelete",
            "projectSectionOrder", "projectSectionRename", "projectStatusWrite", "projectTagsWrite", "projectTaskOrderWrite", "projectTaskSortWrite",
            "projectTasksAddTagWrite", "projectTasksDeleteUndoWrite", "projectTasksDeleteWrite", "projectTasksMoveWrite", "projectTasksOrganizeWrite",
            "projectTasksRemoveTagWrite", "projectToSectionUndoWrite", "projectToSectionWrite", "referenceProjectNextAction", "referenceTaskBackdate",
            "referenceTaskDestination", "referenceTasksAddTagWrite", "referenceTasksMoveWrite", "referenceTasksRemoveTagWrite",
            "reminderCompletionCommit", "reminderSnoozeCommit", "reviewAISuggestionsWrite", "reviewTaskWrite", "rowQuickStatusWrite", "rowTaskBackdate",
            "rowTaskDates", "rowTaskDestination", "rowTaskFocus", "saveDraft", "savedSearchWrite", "setAreaFilter", "shareCaptureSubmit",
            "somedaySectionBulkMoveUndo", "somedaySectionBulkMoveWrite", "somedaySectionCreateWrite", "somedaySectionDeleteWrite",
            "somedaySectionMoveUndo", "somedaySectionMoveWrite", "somedaySectionOrderWrite", "somedaySectionRenameWrite", "somedaySectionTaskCommit", "supportPromptShown",
            "taskCancellationUndo", "taskChecklistMove", "taskChecklistMoveUndo", "taskCompletion", "taskCompletionUndo", "taskDelete",
            "taskDeleteUndo", "taskFocusWrite", "taskListSortWrite", "taskPromote", "taskPromoteUndoWrite", "trashItemsPurgeWrite",
            "trashItemsRestoreWrite", "trashProjectRestoreWrite", "trashTaskRestoreWrite", "unassignedAreaColorWrite", "watchPomodoroSubmit",
            "weeklyReviewProjectTaskWrite", "widgetCompletionSubmit"
        ]
        let journaled = Set(HostMethod.registry.filter { $0.value.journaled }.keys)
        XCTAssertEqual(durableWrites.subtracting(journaled), [])
        XCTAssertTrue(HostMethod.registry.values.filter(\.journaled).allSatisfy { $0.arguments != nil })
    }

    func testRegisteredReadsAreBundleFunctionsWithTheRegisteredArity() throws {
        guard let path = ProcessInfo.processInfo.environment["MINDWTR_CORE_BUNDLE"] else {
            throw XCTSkip("Build core-host.js and set MINDWTR_CORE_BUNDLE")
        }
        let context = try XCTUnwrap(JSContext())
        context.evaluateScript("globalThis.__mindwtrNative = {nowMs: () => Date.now(), randomBytes: n => JSON.stringify(Array(n).fill(0)), log: () => {}}")
        context.evaluateScript(try String(contentsOfFile: path, encoding: .utf8))
        XCTAssertNil(context.exception)
        let raw = try XCTUnwrap(context.evaluateScript(
            "JSON.stringify(Object.fromEntries(Object.keys(MindwtrHost).filter(k => typeof MindwtrHost[k] === 'function').map(k => [k, MindwtrHost[k].length])))")?.toString())
        let functions = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Int])
        let answeredByNativeHost: Set<String> = ["pomodoroPanelReadHost", "pomodoroAlarmReadHost", "pomodoroSessionReadHost", "grantDeviceCalendarAccess"]
        let reads = HostMethod.registry.filter { name, method in
            !method.journaled && !answeredByNativeHost.contains(name) && !name.hasSuffix("RetryOutcome") && !name.hasSuffix("ReceiptOutcome")
        }
        XCTAssertGreaterThan(reads.count, 200)
        for (name, method) in reads {
            XCTAssertNotNil(functions[name], name)
            if let arity = method.arguments?.count, let length = functions[name] { XCTAssertEqual(arity, length, name) }
        }
    }
}
