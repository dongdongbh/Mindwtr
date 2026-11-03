package tech.dongdongbh.mindwtr.pilot

import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject


const val FOCUS_VIEW_KEY = "mindwtr:view:focus:v1"

const val PROJECT_SHOW_COMPLETED_KEY = "mindwtr:view:project-detail:show-completed:v1"

const val PROJECTS_VIEW_KEY = "mindwtr:view:projects:v1"

val FOCUS_SECTION_KEYS = listOf("focus", "schedule", "next", "upcoming", "reviewDue", "reviewProjects")


class FocusViewState(private val raw: JSONObject, val expanded: Map<String, Boolean>) {
    fun isOpen(key: String) = expanded[key] ?: true


    val showDetails: Boolean get() = raw.optBoolean("showDetails", false)

    fun with(changes: Map<String, Boolean>): FocusViewState = FocusViewState(raw, expanded + changes)

    fun withDetails(on: Boolean): FocusViewState = FocusViewState(JSONObject(raw.toString()).put("showDetails", on), expanded)


    fun save(prefs: SharedPreferences) {
        val sections = JSONObject()
        for (key in FOCUS_SECTION_KEYS) sections.put(key, isOpen(key))
        sections.put("nextActions", isOpen("next"))
        val out = JSONObject(raw.toString()).put("showDetails", raw.optBoolean("showDetails", false)).put("expandedSections", sections)
        prefs.edit().putString(FOCUS_VIEW_KEY, out.toString()).apply()
    }

    companion object {

        fun read(prefs: SharedPreferences): FocusViewState {
            val raw = runCatching { JSONObject(prefs.getString(FOCUS_VIEW_KEY, null) ?: "{}") }.getOrDefault(JSONObject())
            val stored = raw.optJSONObject("expandedSections") ?: JSONObject()
            val expanded = HashMap<String, Boolean>()
            for (key in FOCUS_SECTION_KEYS) {

                val value = stored.opt(key).takeIf { it is Boolean } ?: if (key == "next") stored.opt("nextActions") else null
                if (value is Boolean) expanded[key] = value
            }
            return FocusViewState(raw, expanded)
        }
    }
}


data class ProjectsViewState(val collapsedAreas: Set<String>, val showDeferred: Boolean, val showArchived: Boolean) {
    fun save(prefs: SharedPreferences) {
        val areas = JSONObject()
        for (id in collapsedAreas) areas.put(id, true)
        prefs.edit().putString(PROJECTS_VIEW_KEY, JSONObject().put("collapsedAreas", areas)
            .put("showArchivedProjects", showArchived).put("showDeferredProjects", showDeferred).toString()).apply()
    }

    companion object {

        fun read(prefs: SharedPreferences): ProjectsViewState {
            val raw = runCatching { JSONObject(prefs.getString(PROJECTS_VIEW_KEY, null) ?: "{}") }.getOrDefault(JSONObject())
            val areas = raw.optJSONObject("collapsedAreas")
            val collapsed = areas?.keys()?.asSequence()?.filter { it.isNotBlank() && areas.opt(it) == true }?.toSet().orEmpty()
            return ProjectsViewState(collapsed, raw.opt("showDeferredProjects") == true, raw.opt("showArchivedProjects") == true)
        }
    }
}


const val DONE_VIEW_KEY = "mindwtr:view:done:v1"

const val REFERENCE_GROUP_BY_KEY = "mindwtr:view:reference:groupBy:v1"

val REFERENCE_GROUP_BY_OPTIONS = setOf("none", "context", "area", "project", "tag")


fun referenceGroupBy(visit: String?, saved: String?): String? = visit ?: saved?.takeIf { it in REFERENCE_GROUP_BY_OPTIONS }

const val ARCHIVED_VIEW_KEY = "mindwtr:view:archived:v1"


const val WEEKLY_REVIEW_KEY = "mindwtr:weeklyReview:currentStep"
const val DAILY_REVIEW_KEY = "mindwtr:dailyReview:currentStep"


val LIST_VIEW_GROUP_OPTIONS = setOf("none", "completedDate", "context", "area", "project", "tag")

val LIST_VIEW_SORT_OPTIONS = setOf("default", "due", "start", "review", "timeEstimate", "title", "created", "created-desc", "completed")


data class ListViewState(val groupBy: String?, val sortBy: String?) {
    fun save(prefs: SharedPreferences, key: String) {
        prefs.edit().putString(key, into(JSONObject()).toString()).apply()
    }


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


fun clockReadAt(rows: List<TaskRow?>, view: JSONObject? = null): Long? =
    (rows.mapNotNull { it?.meta?.validUntil } + listOfNotNull(view?.takeIf { it.has("validUntil") && !it.isNull("validUntil") }?.getLong("validUntil"))).minOrNull()


@Composable
fun ReadAgainAt(at: Long?, read: () -> Unit) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner, at) {
        if (at == null) return@LaunchedEffect
        owner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            delay((at - System.currentTimeMillis()).coerceAtLeast(0))
            read()
        }
    }
}


object GroupCollapse {
    private fun key(list: String) = "mindwtr:view:group-collapse:$list:v1"


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


    fun toggle(prefs: SharedPreferences, list: String, axis: String, id: String) {
        val state = read(prefs, list)
        val ids = state.optJSONArray(axis) ?: JSONArray()
        val present = (0 until ids.length()).any { ids.getString(it) == id }
        val next = JSONArray().apply { for (index in 0 until ids.length()) if (ids.getString(index) != id) put(ids.getString(index)) }
        if (!present) next.put(id)
        prefs.edit().putString(key(list), state.put(axis, next).toString()).apply()
    }


    fun axis(prefs: SharedPreferences, list: String, axis: String, max: Int): JSONArray {
        val ids = read(prefs, list).optJSONArray(axis) ?: JSONArray()
        return JSONArray().apply { for (index in 0 until minOf(ids.length(), max)) put(ids.getString(index)) }
    }


    fun keep(prefs: SharedPreferences, list: String, axis: String, ids: JSONArray) {
        prefs.edit().putString(key(list), read(prefs, list).put(axis, ids).toString()).apply()
    }


    fun all(prefs: SharedPreferences, list: String, max: Int): JSONArray {
        val state = read(prefs, list)
        val all = JSONArray()
        for (axis in state.keys()) state.getJSONArray(axis).let { ids -> for (index in 0 until ids.length()) if (all.length() < max) all.put(ids.getString(index)) }
        return all
    }
}
