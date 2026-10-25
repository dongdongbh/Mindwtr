package tech.dongdongbh.mindwtr.pilot

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/*
 * Which sections are open, kept on this device as RN keeps them (workspaceSessionStorage):
 * the same keys, the same JSON, and the same defaults. RN's
 * app/(drawer)/(tabs)/focus.tsx and lib/view-state/project-list-view-state.ts are the spec.
 * It is UI state only, never synced and never core data.
 */

/** RN's FOCUS_VIEW_STATE_STORAGE_KEY. */
const val FOCUS_VIEW_KEY = "mindwtr:view:focus:v1"
/** RN's PROJECT_SHOW_COMPLETED_STORAGE_KEY (ProjectDetailModal): "true" or "false", device-wide. */
const val PROJECT_SHOW_COMPLETED_KEY = "mindwtr:view:project-detail:show-completed:v1"
/** RN's PROJECT_LIST_VIEW_STATE_STORAGE_KEY. */
const val PROJECTS_VIEW_KEY = "mindwtr:view:projects:v1"
/** RN's DEFAULT_EXPANDED_SECTIONS keys; every section starts open. */
val FOCUS_SECTION_KEYS = listOf("focus", "schedule", "next", "upcoming", "reviewDue", "reviewProjects")

/** RN's Focus view state. [raw] keeps fields this app does not show (RN's showDetails) as they were. */
class FocusViewState(private val raw: JSONObject, val expanded: Map<String, Boolean>) {
    fun isOpen(key: String) = expanded[key] ?: true

    /** RN's Show details (View options), kept in the same JSON. */
    val showDetails: Boolean get() = raw.optBoolean("showDetails", false)

    fun with(changes: Map<String, Boolean>): FocusViewState = FocusViewState(raw, expanded + changes)

    fun withDetails(on: Boolean): FocusViewState = FocusViewState(JSONObject(raw.toString()).put("showDetails", on), expanded)

    /** RN's serializeFocusViewState: it also writes the legacy `nextActions` twin of `next`. */
    fun save(prefs: SharedPreferences) {
        val sections = JSONObject()
        for (key in FOCUS_SECTION_KEYS) sections.put(key, isOpen(key))
        sections.put("nextActions", isOpen("next"))
        val out = JSONObject(raw.toString()).put("showDetails", raw.optBoolean("showDetails", false)).put("expandedSections", sections)
        prefs.edit().putString(FOCUS_VIEW_KEY, out.toString()).apply()
    }

    companion object {
        /** RN's readPersistedFocusExpandedSections: only boolean values count; `next` falls back to `nextActions`. */
        fun read(prefs: SharedPreferences): FocusViewState {
            val raw = runCatching { JSONObject(prefs.getString(FOCUS_VIEW_KEY, null) ?: "{}") }.getOrDefault(JSONObject())
            val stored = raw.optJSONObject("expandedSections") ?: JSONObject()
            val expanded = HashMap<String, Boolean>()
            for (key in FOCUS_SECTION_KEYS) {
                // A non-boolean (null, text) counts as absent, so `next` falls back to `nextActions`, as in RN.
                val value = stored.opt(key).takeIf { it is Boolean } ?: if (key == "next") stored.opt("nextActions") else null
                if (value is Boolean) expanded[key] = value
            }
            return FocusViewState(raw, expanded)
        }
    }
}

/** RN's ProjectListViewState: collapsed areas (by area id, "no-area" without one) and the two closed groups. */
data class ProjectsViewState(val collapsedAreas: Set<String>, val showDeferred: Boolean, val showArchived: Boolean) {
    fun save(prefs: SharedPreferences) {
        val areas = JSONObject()
        for (id in collapsedAreas) areas.put(id, true)
        prefs.edit().putString(PROJECTS_VIEW_KEY, JSONObject().put("collapsedAreas", areas)
            .put("showArchivedProjects", showArchived).put("showDeferredProjects", showDeferred).toString()).apply()
    }

    companion object {
        /** RN's readProjectListViewState: only `true` entries with a non-blank id; both groups start closed. */
        fun read(prefs: SharedPreferences): ProjectsViewState {
            val raw = runCatching { JSONObject(prefs.getString(PROJECTS_VIEW_KEY, null) ?: "{}") }.getOrDefault(JSONObject())
            val areas = raw.optJSONObject("collapsedAreas")
            val collapsed = areas?.keys()?.asSequence()?.filter { it.isNotBlank() && areas.opt(it) == true }?.toSet().orEmpty()
            return ProjectsViewState(collapsed, raw.opt("showDeferredProjects") == true, raw.opt("showArchivedProjects") == true)
        }
    }
}

/** RN's DONE_LIST_VIEW_STATE_STORAGE_KEY (lib/view-state/done-list-view-state.ts). */
const val DONE_VIEW_KEY = "mindwtr:view:done:v1"
/** RN's ReferenceScreen grouping preference. */
const val REFERENCE_GROUP_BY_KEY = "mindwtr:view:reference:groupBy:v1"
/** Valid values in core's Reference group picker, checked when reading the saved choice. */
val REFERENCE_GROUP_BY_OPTIONS = setOf("none", "context", "area", "project", "tag")
/** RN's ARCHIVED_LIST_VIEW_STATE_STORAGE_KEY (lib/view-state/archived-list-view-state.ts). */
const val ARCHIVED_VIEW_KEY = "mindwtr:view:archived:v1"

/**
 * Where a paused Weekly or Daily Review is kept on this device (core's WEEKLY_REVIEW_SESSION_STORAGE_KEY and
 * DAILY_REVIEW_SESSION_STORAGE_KEY, the keys RN's review modals use): core's checkpoint string, stored as core sends it.
 */
const val WEEKLY_REVIEW_KEY = "mindwtr:weeklyReview:currentStep"
const val DAILY_REVIEW_KEY = "mindwtr:dailyReview:currentStep"

/** Core's DONE_LIST_GROUP_OPTIONS and ARCHIVE_TASK_GROUP_OPTIONS (one list; check-boot-gates.mjs compares them). */
val LIST_VIEW_GROUP_OPTIONS = setOf("none", "completedDate", "context", "area", "project", "tag")
/** Core's DONE_TASK_LIST_SORT_OPTIONS: TASK_LIST_SORT_OPTIONS without priority, and completed (check-boot-gates.mjs compares). */
val LIST_VIEW_SORT_OPTIONS = setOf("default", "due", "start", "review", "timeEstimate", "title", "created", "created-desc", "completed")

/**
 * RN's Done and Archived list view state, `{ groupBy, sortBy? }`: the device's grouping and sort, kept as core's option
 * values. Absent means core's default. A stored value this build does not know (an older or newer app wrote it, or it is
 * broken) reads as absent, as RN's readDoneListViewState and readArchivedListViewState read it (57271148e): core refuses the
 * whole view for an unknown one.
 */
data class ListViewState(val groupBy: String?, val sortBy: String?) {
    fun save(prefs: SharedPreferences, key: String) {
        prefs.edit().putString(key, into(JSONObject()).toString()).apply()
    }

    /** The view's inputs: the grouping and, when chosen, the sort. */
    fun into(params: JSONObject): JSONObject = params.apply { groupBy?.let { put("groupBy", it) }; sortBy?.let { put("sortBy", it) } }

    companion object {
        fun read(prefs: SharedPreferences, key: String): ListViewState = parse(prefs.getString(key, null))

        fun parse(text: String?): ListViewState {
            val raw = runCatching { JSONObject(text ?: "{}") }.getOrDefault(JSONObject())
            return ListViewState((raw.opt("groupBy") as? String)?.takeIf { it in LIST_VIEW_GROUP_OPTIONS },
                (raw.opt("sortBy") as? String)?.takeIf { it in LIST_VIEW_SORT_OPTIONS })
        }
    }
}

/**
 * RN's task-group-collapse-state: one key per list ("inbox", "reference", "done", "archived"), each grouping axis → its folded
 * group ids, device-local and never synced.
 */
object GroupCollapse {
    private fun key(list: String) = "mindwtr:view:group-collapse:$list:v1"

    /** RN's readTaskGroupCollapseState: only arrays, only their strings, only non-empty lists. */
    private fun read(prefs: SharedPreferences, list: String): JSONObject {
        val raw = runCatching { JSONObject(prefs.getString(key(list), null) ?: "{}") }.getOrDefault(JSONObject())
        val state = JSONObject()
        for (axis in raw.keys()) {
            val ids = raw.optJSONArray(axis) ?: continue
            val kept = JSONArray().apply { for (index in 0 until ids.length()) (ids.opt(index) as? String)?.let(::put) }
            if (kept.length() > 0) state.put(axis, kept)
        }
        return state
    }

    /** RN's toggleGroup: [id] folds or unfolds under [axis], the grouping core showed it in. */
    fun toggle(prefs: SharedPreferences, list: String, axis: String, id: String) {
        val state = read(prefs, list)
        val ids = state.optJSONArray(axis) ?: JSONArray()
        val present = (0 until ids.length()).any { ids.getString(it) == id }
        val next = JSONArray().apply { for (index in 0 until ids.length()) if (ids.getString(index) != id) put(ids.getString(index)) }
        if (!present) next.put(id)
        prefs.edit().putString(key(list), state.put(axis, next).toString()).apply()
    }

    /** One grouping's folded ids (the Inbox sends only the current grouping's, as RN does), at most [max]. */
    fun axis(prefs: SharedPreferences, list: String, axis: String, max: Int): JSONArray {
        val ids = read(prefs, list).optJSONArray(axis) ?: JSONArray()
        return JSONArray().apply { for (index in 0 until minOf(ids.length(), max)) put(ids.getString(index)) }
    }

    /** Core's folds for [axis] after a tap (an Inbox heading's collapseEdit), written whole as RN writes them. */
    fun keep(prefs: SharedPreferences, list: String, axis: String, ids: JSONArray) {
        prefs.edit().putString(key(list), read(prefs, list).put(axis, ids).toString()).apply()
    }

    /**
     * Every folded id, whatever its axis: core's group ids carry their axis ("project:…", "context:…", "tag:…", an area's
     * id), so another grouping's ids match nothing and core folds only the current one's.
     * ponytail: core takes at most [max] ids; a person who folds more sends only the first [max].
     */
    fun all(prefs: SharedPreferences, list: String, max: Int): JSONArray {
        val state = read(prefs, list)
        val all = JSONArray()
        for (axis in state.keys()) state.getJSONArray(axis).let { ids -> for (index in 0 until ids.length()) if (all.length() < max) all.put(ids.getString(index)) }
        return all
    }
}
