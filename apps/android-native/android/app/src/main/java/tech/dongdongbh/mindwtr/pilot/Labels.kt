package tech.dongdongbh.mindwtr.pilot

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.Collections


val LABEL_KEYS = listOf(
    "tab.inbox", "tab.next", "nav.projects",
    "savedFilters.saveTitle", "savedFilters.namePlaceholder",
    "nav.addTask", "quickAdd.inputLabel", "quickAdd.bulkImportTextFile", "quickAdd.bulkImportTextFileLabel", "common.more", "common.retry", "common.done", "common.edit", "common.back",
    "agenda.laterToday",

    "settings.lastSyncError",
    "common.cancel", "common.close", "common.save", "common.ok", "common.clear", "common.discard",

    "projects.actionsLabel", "projects.duplicate", "projects.complete", "projects.reactivate", "projects.cancel", "projects.archiveHelp",
    "projects.cancelConfirmTitle", "projects.cancelConfirmBody", "projects.deleteConfirm", "common.notice",
    "projects.cancelFailed", "projects.duplicateFailed", "projects.deleteFailed", "projects.restoreFailed",

    "projects.tagFilter", "projects.allTags", "projects.noTags", "projects.emptyTag", "filters.show", "filters.hide",

    "projects.reorderTasks", "projects.reorderNeedsDefaultSort", "projects.projectOrder", "projects.taskOrder", "board.dragTask", "projects.moveSectionUp", "projects.moveSectionDown",

    "task.addFailed",
    "common.none", "common.notSet", "taskEdit.titleLabel", "taskEdit.descriptionLabel", "taskEdit.statusLabel",
    "taskEdit.priorityLabel", "taskEdit.noProjectOption", "taskEdit.startDateLabel",
    "taskEdit.dueDateLabel", "taskEdit.discardChanges", "taskEdit.discardChangesDesc", "projects.archivedReadOnlyHint",

    "taskEdit.scheduling", "taskEdit.organization", "taskEdit.details", "taskEdit.editorLayoutHelpLabel", "taskEdit.editorLayoutHelpText",
    "task.destination", "taskEdit.areaLabel", "taskEdit.noAreaOption", "taskEdit.sectionLabel", "taskEdit.noSectionOption",
    "taskEdit.contextsLabel", "taskEdit.contextsPlaceholder", "taskEdit.tagsLabel", "taskEdit.tagsPlaceholder",
    "taskEdit.energyLevel", "energyLevel.low", "energyLevel.medium", "energyLevel.high",
    "taskEdit.assignedTo", "taskEdit.assignedToPlaceholder", "taskEdit.timeEstimateLabel", "taskEdit.locationLabel",
    "taskEdit.locationPlaceholder", "taskEdit.descriptionPlaceholder", "taskEdit.reviewDateLabel", "calendar.changeTime",
    "taskEdit.recurrenceLabel", "recurrence.none", "recurrence.daily", "recurrence.weekly", "recurrence.monthly", "recurrence.yearly",
    "recurrence.custom", "recurrence.monthlyOnDay", "recurrence.repeatEvery", "recurrence.dayUnit", "recurrence.afterCompletion",
    "recurrence.showFutureInCalendar", "recurrence.showFutureInCalendarHint",
    "recurrence.customTitle", "recurrence.onLabel", "recurrence.onDayOfMonth", "recurrence.lastDay", "recurrence.lastDayOfMonth",
    "recurrence.onNthWeekday", "recurrence.weekdayMonFri", "recurrence.ordinal.first", "recurrence.ordinal.second",
    "recurrence.ordinal.third", "recurrence.ordinal.fourth", "recurrence.ordinal.last",
    "taskEdit.resetChecklistOnRepeat", "taskEdit.resetChecklistOnRepeatHint",
    "taskEdit.suppressMindwtrReminders", "taskEdit.suppressMindwtrRemindersHint",
    "taskEdit.startModeAbsolute", "taskEdit.startModeRelative", "taskEdit.relativeStartAmount", "taskEdit.relativeStartBeforeDue",
    "taskEdit.dateOnly", "taskEdit.timeSpentLabel", "recurrence.weekUnit", "recurrence.monthUnit", "recurrence.yearUnit",
    "recurrence.endsLabel", "recurrence.endsNever", "recurrence.endsOnDate", "recurrence.endsAfterCount", "recurrence.occurrenceUnit",
    "viewSections.somedaySection", "taskEdit.checklist", "checklist.progress", "task.addToChecklist", "taskEdit.tab.list", "attachments.title",
    "process.waitingFor", "process.waitingForDesc",
    "status.inbox", "status.next", "status.waiting", "status.someday", "status.reference", "status.done",
    "priority.low", "priority.medium", "priority.high", "priority.urgent",
    "projects.activeSection", "projects.deferredSection", "projects.closed", "projects.noArea", "projects.noNextAction",
    "common.tasks", "filters.starred", "projects.availableNextAction", "projects.laterInSequence",
    "markdown.expand", "markdown.collapse",
    "common.error", "markdown.openLinkFailed", "markdown.copyLink", "markdown.copyLinkFailed",
    "inbox.empty", "inbox.emptyAddHint", "agenda.allClear", "agenda.noTasks", "projects.empty",
    "agenda.addToFocus", "agenda.removeFromFocus", "agenda.focusWhenAvailable", "projects.addToFocus", "projects.removeFromFocus",
    "taskStatus.changeStatus", "task.aria.changeStatus", "task.aria.changeStatusHint",
    "projects.addPlaceholder", "projects.add", "projects.areaFilter", "agenda.reviewDueProjects", "common.open",
    "agenda.collapseOtherSections", "agenda.expandOtherSections", "status.active", "status.archived",

    "search.title", "search.placeholder", "filters.label", "search.saveSearch", "search.saveSearchPrompt", "search.helpOperators",
    "search.showingFirst", "search.hiddenCompletedMatches", "search.noResults", "search.resultTask", "search.resultProject",
    "search.inProjectSuffix", "review.markDone",

    "inbox.processButton", "projects.allAreas", "common.loading", "taskEdit.projectLabel", "task.aria.action",

    "tab.menu", "settings.syncBadgeSyncing", "settings.syncBadgeHealthy", "settings.syncBadgeWarning",
    "waiting.title", "someday.title", "nav.reference", "nav.history", "taskEdit.moreOptions", "common.search",
    "filters.excluded", "filters.remove", "filters.clear", "filters.active", "filters.contexts", "filters.projects", "filters.timeEstimate",
    "filters.more", "filters.priority", "bulk.selected", "viewSections.add", "viewSections.nameHint", "viewSections.namePlaceholder", "common.all",

    "contexts.title", "trash.title", "nav.review", "projects.title", "tab.review", "nav.contexts", "nav.done", "common.delete", "task.aria.delete",
    "common.noMatches", "review.markReviewed", "review.markReviewedDone", "review.advanceWeek", "task.select", "task.deselect",

    "nav.calendar", "nav.board", "filters.contextMatchMode", "filters.tagMatchMode", "filters.matchAny", "bulk.moveTo",

    "markdown.edit", "markdown.preview", "settings.title",

    "mindSweep.title",

    "appLock.title", "appLock.description", "appLock.prompt", "appLock.unlock", "appLock.authenticating",
    "appLock.unavailable", "appLock.cancelled", "appLock.failed",

    "attachments.addFile", "attachments.addPhoto", "attachments.addLink", "attachments.download", "attachments.missing", "attachments.remove",
    "attachments.linkPlaceholder", "attachments.linkInputHint", "attachments.linkBatchHint", "common.validationRequired", "common.share",
    "share.unavailable", "common.play", "common.pause", "audio.loading", "quickAdd.audioNoteTitle", "quickAdd.audioErrorBody",

    "projects.statusLabel", "projects.projectTypeLabel", "projects.projectTypeHelpLabel", "projects.projectTypeHelpText", "projects.sequentialScope",
    "projects.sequentialAcrossSections", "projects.sequentialWithinSections", "projects.sequentialScopeHelpLabel", "projects.sequentialScopeHelpText",
    "projects.sectionsLabel", "settings.manage", "projects.addSection", "projects.areaLabel", "project.notes", "projects.notesPlaceholder",
    "projects.reviewAt", "projects.sectionPlaceholder", "projects.moveUp", "projects.moveDown", "projects.deleteSectionConfirm", "common.add",
    "projects.parallel", "projects.sequential", "projects.perSection", "projects.perSectionTooltip", "projects.sequenceMode",

    "projects.moveProjectFailed", "areas.manage", "projects.manageAreas", "projects.renameArea", "areas.new", "areas.nameExists", "projects.changeColor", "common.rename", "projects.sortByName", "projects.sortByColor", "projects.colorNone", "projects.color",

    "settings.gettingStartedContentContinueTitle", "settings.gettingStartedContentContinueDesc", "onboarding.startFreshTitle",

    "task.copyTaskLink", "task.copyTaskId", "task.moveToProjectOrArea", "list.taskCopied", "list.taskCopyFailed", "taskEdit.duplicateTask", "task.duplicateFailed",
    "task.createProjectFromTask", "task.promoteToProjectCreated", "task.promoteToProjectMoved", "task.promoteToProjectFailed",
    "projects.projectName", "task.keepChecklistDescription", "task.expandChecklist", "task.expandChecklistDescription",
    "reference.convertToAction", "task.convertToSection",
    "task.convertToSectionCreated", "task.skipOccurrence", "task.cancelledWithRestore", "list.taskDeleted", "common.undo", "common.success",

    "settings.gmailCapture", "settings.gmailCaptureDesc", "settings.gmailCaptureDisclosure", "settings.gmailCaptureUnavailable",
    "settings.gmailCaptureAccount", "settings.gmailCaptureLabel", "settings.gmailCaptureChooseLabel", "settings.gmailCaptureLabelHint",
    "settings.gmailCaptureActive", "settings.gmailCapturePaused", "settings.gmailCaptureConnect", "settings.gmailCaptureConnecting",
    "settings.gmailCaptureReconnect", "settings.gmailCaptureCancel", "settings.gmailCaptureDisconnect", "settings.gmailCaptureCheckNow",
    "settings.gmailCaptureChecking", "settings.gmailCaptureSave", "settings.gmailCaptureSaving", "settings.gmailCaptureLastChecked",
    "settings.gmailCaptureImportedCount", "settings.gmailCaptureReceiptsReset", "settings.gmailCaptureCancelled",
    "settings.gmailCaptureDisconnected", "settings.gmailCaptureRevokeManually", "settings.gmailCaptureAuthFailed",
    "settings.gmailCaptureNetworkFailed", "settings.gmailCaptureConfigFailed", "settings.gmailCaptureStorageFailed", "settings.gmailCaptureFailed",

    "task.completeBackdateHintMobile", "task.editCompletedAt",

    "quickAdd.audioRecord", "quickAdd.audioStop", "quickAdd.audioRecording", "quickAdd.audioProcessing", "quickAdd.speechNotConfigured",
    "quickAdd.audioPermissionTitle", "quickAdd.audioPermissionBody", "quickAdd.audioErrorTitle", "sandbox.unavailable",
    "sandbox.open", "sandbox.description", "sandbox.notice", "sandbox.title", "sandbox.label", "sandbox.reset", "sandbox.resetShort", "sandbox.exit", "sandbox.exitShort",
    "sandbox.switching", "sandbox.switchFailed", "sandbox.confirmTitle", "sandbox.confirmDescription", "sandbox.enter", "settings.taskEditorLayout", "settings.appearance", "settings.regionalFormats",
    "quickAdd.audioCaptureLabel",
)


object Labels {

    private var strings by mutableStateOf<Map<String, String>>(emptyMap())
    private val logged: MutableSet<String> = Collections.synchronizedSet(HashSet())

    @Volatile var language: String? = null
        private set


    fun load(reply: JSONObject, reportLoaded: (String) -> Unit = { Log.i(CoreHost.TAG, it) }) {
        val values = reply.getJSONObject("strings")
        strings = LABEL_KEYS.filter(values::has).associateWith(values::getString)
        language = reply.getString("language")
        val missing = reply.getJSONArray("missing")
        for (index in 0 until missing.length()) missing(missing.getString(index))
        reportLoaded("Native Android labels language=${reply.getString("language")} missing=${missing.length()}")
    }

    operator fun get(name: String): String = strings[name] ?: name.also(::missing)

    private fun missing(name: String) {
        if (logged.add(name)) Log.w(CoreHost.TAG, "Native Android label missing label=$name")
    }
}


fun t(name: String): String = Labels[name]

data class TrayAction(val id: String, val label: String, val status: String?, val focused: Boolean)

data class Tray(val swipeRight: List<TrayAction>, val swipeLeft: List<TrayAction>)

object SwipeTrays {
    private var trays by mutableStateOf<Map<String, Tray>>(emptyMap())

    fun load(reply: JSONObject) { trays = parse(reply) }

    internal fun parse(reply: JSONObject): Map<String, Tray> {
        val all = reply.getJSONObject("trays")
        fun side(tray: JSONObject, name: String) = tray.getJSONArray(name).let { list ->
            List(list.length()) { list.getJSONObject(it) }.map { action ->
                TrayAction(action.getString("id"), action.getString("label"), action.optString("status").ifEmpty { null }, action.optBoolean("focused"))
            }
        }
        return all.keys().asSequence().associateWith { key -> all.getJSONObject(key).let { Tray(side(it, "swipeRight"), side(it, "swipeLeft")) } }
    }

    fun of(status: String, focused: Boolean): Tray? = trays[if (focused) "$status:focused" else status]
}

fun loadLabels(runtime: CoreHost) {
    Labels.load(runtime.strings(LABEL_KEYS))
    runCatching { SwipeTrays.load(runtime.swipeTrays()) }.onFailure { Log.w(CoreHost.TAG, "Native Android swipe trays not read ${failureForLog(it)}") }
}
