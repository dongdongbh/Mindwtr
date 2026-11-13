import Foundation

struct NativeStartupRecovery: Equatable {
    let method: String
    let resultJSON: String
    var source: String? = nil
    var requestId: String? = nil

    static let methods: Set<String> = [
        "appLockCommit", "archiveTaskCompletedAtCommit", "archivedTaskRestoreCommit", "archivedTasksDeleteCommit",
        "archivedTasksDeleteUndoCommit", "archivedTasksRestoreCommit", "areaColorCommit", "areaCreateCommit", "areaDeleteCommit",
        "areaOrderCommit", "areaRenameCommit", "backupDocumentCommit", "boardCommit", "calendarComposerCommit",
        "calendarComposerCreateCommit", "calendarDeleteCommit", "calendarEventTaskCommit", "calendarSubscriptionAddCommit",
        "calendarSubscriptionSettingCommit", "calendarUnscheduleCommit", "checklistPreparedCommit", "dataSetting",
        "deviceCalendarSettingCommit", "doneTaskCompletedAtCommit", "doneTaskStatusCommit", "focusGroupWrite",
        "focusOrderCommit", "focusSavedFilterCommit", "generalPreferenceCommit", "gettingStarted", "gtdWorkflowCommit",
        "inboxOrganizeDestinationCreateCommit", "inboxPreparedCommit", "inboxTasksAddTagCommit", "inboxTasksMoveCommit",
        "inboxTasksOrganizeCommit", "inboxTasksRemoveTagCommit", "inboxUndoCommit", "inlineChecklistCommit",
        "iosAIGeminiThinkingBudgetCommit", "iosAIReasoningEffortCommit", "iosAIRequestTimeoutCommit",
        "manageAreaCreateCommit", "manageAreaDeleteCommit", "manageAreaEditCommit", "managePersonCreateCommit",
        "managePersonDeleteCommit", "managePersonEditCommit", "manageTaxonomyCommit", "mindSweepCommit",
        "notificationSettingCommit", "projectAreaCommit", "projectAttachmentWriteCommit", "projectCreateCommit",
        "projectDateCommit", "projectCalendarReferenceCommit", "projectDeleteCommit", "projectDeleteUndoCommit", "projectDuplicateCommit",
        "projectFileRemoveWriteCommit", "projectFlowCommit", "projectFocusCommit", "projectLifecycleCommit", "projectMoveCommit",
        "projectNotesWriteCommit", "projectOrganizeDestinationCreateCommit", "projectRenameCommit",
        "projectSectionCreateCommit", "projectSectionDeleteCommit", "projectSectionOrderCommit",
        "projectSectionRenameCommit", "projectStatusCommit", "projectTagsWriteCommit", "projectTaskOrderCommit",
        "projectTaskSortCommit", "projectTasksAddTagCommit", "projectTasksDeleteCommit", "projectTasksDeleteUndoCommit",
        "projectTasksMoveCommit", "projectTasksOrganizeCommit", "projectTasksRemoveTagCommit", "projectToSectionCommit",
        "projectToSectionUndoCommit", "referenceProjectNextActionCommit", "referenceTaskBackdateCommit",
        "referenceTaskDestinationCommit", "referenceTasksAddTagCommit", "referenceTasksMoveCommit",
        "referenceTasksRemoveTagCommit", "reminderCompletionCommit", "reminderSnoozeCommit", "rowQuickStatusCommit",
        "rowTaskBackdateCommit", "rowTaskDatesCommit", "rowTaskDestinationCommit", "rowTaskFocusCommit",
        "savedSearchCommit", "somedaySectionCreateWrite", "somedaySectionDeleteWrite", "somedaySectionOrderWrite",
        "somedaySectionRenameWrite", "somedaySectionTaskCommit", "taskChecklistMoveCommit", "taskChecklistMoveUndoCommit",
        "taskCompletionCommit", "taskCompletionUndoCommit", "taskDeleteCommit", "taskFocusCommit", "taskListSortWrite",
        "taskPromoteCommit", "taskPromoteUndoCommit", "trashItemsPurgeCommit", "trashItemsRestoreCommit",
        "trashProjectRestoreCommit", "trashTaskRestoreCommit", "unassignedAreaColorWrite", "weeklyReviewProjectTaskCommit",
    ]

    static let fixedSources: [String: String] = [
        "taskChecklistMoveCommit": "checklistMove", "taskChecklistMoveUndoCommit": "checklistMoveUndo",
        "rowQuickStatusCommit": "rowQuickStatus", "inlineChecklistCommit": "inlineChecklist",
        "referenceTasksMoveCommit": "reference", "referenceTasksAddTagCommit": "reference", "referenceTasksRemoveTagCommit": "reference",
        "projectTasksMoveCommit": "project", "projectTasksAddTagCommit": "project", "projectTasksRemoveTagCommit": "project",
        "projectTasksOrganizeCommit": "project", "projectOrganizeDestinationCreateCommit": "project",
        "inboxTasksMoveCommit": "inbox", "inboxTasksAddTagCommit": "inbox", "inboxTasksRemoveTagCommit": "inbox",
        "inboxTasksOrganizeCommit": "inbox", "inboxOrganizeDestinationCreateCommit": "inbox",
        "rowTaskFocusCommit": "rowFocus", "rowTaskDatesCommit": "rowDates", "rowTaskDestinationCommit": "rowDestination",
        "referenceTaskDestinationCommit": "reference", "rowTaskBackdateCommit": "row", "referenceTaskBackdateCommit": "reference",
    ]

    static let releasedWithRuntime: Set<String> = [
        "boardCommit", "rowQuickStatusCommit", "inlineChecklistCommit", "doneTaskStatusCommit", "referenceTaskBackdateCommit",
        "taskChecklistMoveCommit", "taskChecklistMoveUndoCommit", "projectToSectionCommit", "projectToSectionUndoCommit",
        "taskPromoteUndoCommit", "rowTaskFocusCommit", "rowTaskDatesCommit", "rowTaskDestinationCommit", "rowTaskBackdateCommit",
        "referenceTaskDestinationCommit", "referenceProjectNextActionCommit", "doneTaskCompletedAtCommit",
        "archiveTaskCompletedAtCommit", "trashTaskRestoreCommit", "trashProjectRestoreCommit", "calendarComposerCreateCommit",
        "calendarComposerCommit", "calendarEventTaskCommit", "mindSweepCommit", "weeklyReviewProjectTaskCommit",
        "inboxPreparedCommit", "inboxUndoCommit", "checklistPreparedCommit", "focusGroupWrite", "deviceCalendarSettingCommit",
        "calendarSubscriptionSettingCommit", "calendarSubscriptionAddCommit",
    ]

    static let methodsReportedAfterRelease: [String: String] = [
        "manageAreaCreateCommit": "areaCreateCommit", "manageAreaEditCommit": "areaRenameCommit",
        "manageAreaDeleteCommit": "areaDeleteCommit",
    ]

    static let requestIdsReleasedWithRuntime: Set<String> = ["taskCompletionCommit", "taskCompletionUndoCommit"]

    func payload(result: Any) -> [String: Any] {
        var payload: [String: Any] = ["method": method, "result": result]
        if let source { payload["source"] = source }
        if let requestId { payload["requestId"] = requestId }
        return payload
    }

    func releasingRuntime() -> NativeStartupRecovery? {
        guard !Self.releasedWithRuntime.contains(method) else { return nil }
        return NativeStartupRecovery(method: Self.methodsReportedAfterRelease[method] ?? method, resultJSON: resultJSON,
                                     source: Self.fixedSources[method],
                                     requestId: Self.requestIdsReleasedWithRuntime.contains(method) ? nil : requestId)
    }
}
