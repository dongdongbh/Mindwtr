package tech.dongdongbh.mindwtr.pilot

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.Collections

/**
 * Every core i18n key this app shows (packages/core/src/i18n/locales/en.ts), the
 * one mobile uses for the same control where mobile has one. Kotlin holds no text
 * of its own: core's getStrings fills these at boot, in the language core chose.
 */
val LABEL_KEYS = listOf(
    "tab.inbox", "tab.next", "nav.projects",
    "nav.addTask", "quickAdd.inputLabel", "quickAdd.bulkImportTextFile", "quickAdd.bulkImportTextFileLabel", "common.more", "common.retry", "common.done", "common.edit", "common.back",
    "agenda.laterToday",
    "common.cancel", "common.close", "common.save", "common.ok", "common.clear", "common.discard",
    // The project header's actions sheet (RN ProjectDetailModal's "...") and its confirms; Delete's toast words are core's reply.
    "projects.actionsLabel", "projects.duplicate", "projects.complete", "projects.reactivate", "projects.cancel", "projects.archiveHelp",
    "projects.cancelConfirmTitle", "projects.cancelConfirmBody", "projects.deleteConfirm", "common.notice",
    "projects.cancelFailed", "projects.duplicateFailed", "projects.deleteFailed", "projects.restoreFailed",
    // The project view options' Reorder (RN's reorder mode): its bar, the handle, the section arrows and TalkBack's moves.
    "projects.reorderTasks", "projects.reorderNeedsDefaultSort", "projects.projectOrder", "projects.taskOrder", "board.dragTask", "projects.moveSectionUp", "projects.moveSectionDown",
    // RN's capture screen's failure line (its other words are core's view).
    "task.addFailed",
    "common.none", "common.notSet", "taskEdit.titleLabel", "taskEdit.descriptionLabel", "taskEdit.statusLabel",
    "taskEdit.priorityLabel", "taskEdit.noProjectOption", "taskEdit.startDateLabel",
    "taskEdit.dueDateLabel", "taskEdit.discardChanges", "taskEdit.discardChangesDesc", "projects.archivedReadOnlyHint",
    // The task editor (RN's Form tab); recurrence.* are the label keys core's editor model sends.
    "taskEdit.scheduling", "taskEdit.organization", "taskEdit.details", "taskEdit.editorLayoutHelpLabel", "taskEdit.editorLayoutHelpText",
    "task.destination", "taskEdit.areaLabel", "taskEdit.noAreaOption", "taskEdit.sectionLabel", "taskEdit.noSectionOption",
    "taskEdit.contextsLabel", "taskEdit.contextsPlaceholder", "taskEdit.tagsLabel", "taskEdit.tagsPlaceholder",
    "taskEdit.energyLevel", "energyLevel.low", "energyLevel.medium", "energyLevel.high",
    "taskEdit.assignedTo", "taskEdit.assignedToPlaceholder", "taskEdit.timeEstimateLabel", "taskEdit.locationLabel",
    "taskEdit.locationPlaceholder", "taskEdit.descriptionPlaceholder", "taskEdit.reviewDateLabel", "calendar.changeTime",
    "taskEdit.recurrenceLabel", "recurrence.none", "recurrence.daily", "recurrence.weekly", "recurrence.monthly", "recurrence.yearly",
    "recurrence.custom", "recurrence.monthlyOnDay", "recurrence.repeatEvery", "recurrence.dayUnit", "recurrence.afterCompletion",
    "recurrence.showFutureInCalendar", "recurrence.showFutureInCalendarHint",
    "taskEdit.resetChecklistOnRepeat", "taskEdit.resetChecklistOnRepeatHint",
    "taskEdit.suppressMindwtrReminders", "taskEdit.suppressMindwtrRemindersHint",
    "taskEdit.startModeAbsolute", "taskEdit.startModeRelative", "taskEdit.relativeStartAmount", "taskEdit.relativeStartBeforeDue",
    "taskEdit.dateOnly", "taskEdit.timeSpentLabel", "recurrence.weekUnit", "recurrence.monthUnit", "recurrence.yearUnit",
    "recurrence.endsLabel", "recurrence.endsNever", "recurrence.endsOnDate", "recurrence.endsAfterCount", "recurrence.occurrenceUnit",
    "viewSections.somedaySection", "taskEdit.checklist", "taskEdit.tab.list", "attachments.title",
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
    // Global search (RN's global-search.tsx); the filter sheet's words are core's filterOptions.
    "search.title", "search.placeholder", "filters.label", "search.saveSearch", "search.saveSearchPrompt", "search.helpOperators",
    "search.showingFirst", "search.hiddenCompletedMatches", "search.noResults", "search.resultTask", "search.resultProject",
    "search.inProjectSuffix", "review.markDone",
    // Process Inbox: the Inbox button and scope line; the steps' words are core's view.
    "inbox.processButton", "projects.allAreas", "common.loading", "taskEdit.projectLabel", "task.aria.action",
    // The Menu tab: the tab, RN's stack titles, the list menu and filter sheet, and the Someday name prompt; the lists' words are core's views.
    "tab.menu", "waiting.title", "someday.title", "nav.reference", "nav.history", "taskEdit.moreOptions", "common.search",
    "filters.excluded", "filters.remove", "filters.clear", "filters.active", "filters.contexts", "filters.projects", "filters.timeEstimate",
    "filters.more", "filters.priority", "bulk.selected", "viewSections.add", "viewSections.nameHint", "viewSections.namePlaceholder", "common.all",
    // Contexts, Trash, Review and the reviews, and RN's quick-access tab; the screens' words are core's views.
    "contexts.title", "trash.title", "nav.review", "projects.title", "tab.review", "nav.contexts", "nav.done", "common.delete", "task.aria.delete",
    "common.noMatches", "review.markReviewed", "review.markReviewedDone", "review.advanceWeek", "task.select", "task.deselect",
    // The Calendar and the Board: their stack titles and the Board filter sheet's match control; the screens' words are core's views.
    "nav.calendar", "nav.board", "filters.contextMatchMode", "filters.tagMatchMode", "filters.matchAny", "bulk.moveTo",
    // Settings and the editor's View tab: RN's editor tabs and Settings' header; the screens' words are core's views.
    "markdown.edit", "markdown.preview", "settings.title",
    // Mind Sweep's screen name (its words are core's view).
    "mindSweep.title",
    // RN's app lock screen (AppLock.kt); General's switch and its failure lines are core's view.
    "appLock.title", "appLock.description", "appLock.prompt", "appLock.unlock", "appLock.authenticating",
    "appLock.unavailable", "appLock.cancelled", "appLock.failed",
    // Attachments (Attachments.kt): the editor's field and the project card, the link sheet, the preview and the player; the rows are core's.
    "attachments.addFile", "attachments.addPhoto", "attachments.addLink", "attachments.download", "attachments.missing", "attachments.remove",
    "attachments.linkPlaceholder", "attachments.linkInputHint", "attachments.linkBatchHint", "common.validationRequired", "common.share",
    "share.unavailable", "common.play", "common.pause", "audio.loading", "quickAdd.audioNoteTitle", "quickAdd.audioErrorBody",
    // Project details (ProjectDetails.kt): the panel's labels and help, its pickers and the section manager; the values are core's.
    "projects.statusLabel", "projects.projectTypeLabel", "projects.projectTypeHelpLabel", "projects.projectTypeHelpText", "projects.sequentialScope",
    "projects.sequentialAcrossSections", "projects.sequentialWithinSections", "projects.sequentialScopeHelpLabel", "projects.sequentialScopeHelpText",
    "projects.sectionsLabel", "settings.manage", "projects.addSection", "projects.areaLabel", "project.notes", "projects.notesPlaceholder",
    "projects.reviewAt", "projects.sectionPlaceholder", "projects.moveUp", "projects.moveDown", "projects.deleteSectionConfirm", "common.add",
    // The welcome sheet's Sync and Data handoff card (RN's sync-settings-screen.tsx onboardingHandoffCard).
    "settings.gettingStartedContentContinueTitle", "settings.gettingStartedContentContinueDesc", "onboarding.startFreshTitle",
)

/** The label map: core's text for each of [LABEL_KEYS]. It has no fallback text; a key core lacks shows as the key. */
object Labels {
    /** Snapshot state: a language chosen in Settings reloads it, and every screen redraws in that language. */
    private var strings by mutableStateOf<Map<String, String>>(emptyMap())
    private val logged: MutableSet<String> = Collections.synchronizedSet(HashSet())
    /** Core's language of the loaded map: a synced language core switched to without a device key write reloads it too. */
    @Volatile var language: String? = null
        private set

    /** Replaces the map with a getStrings reply. Core already put English in for a key the language lacks. */
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

/** Core's text for one of [LABEL_KEYS]. */
fun t(name: String): String = Labels[name]
