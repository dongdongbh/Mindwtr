package tech.dongdongbh.mindwtr.pilot

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.ExperimentalFoundationApi
import kotlinx.coroutines.delay
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import kotlin.math.roundToInt
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.lazy.LazyListLayoutInfo
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.foundation.selection.selectable
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.net.toUri
import org.json.JSONObject
import java.util.UUID
import android.util.Log
import org.json.JSONArray
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import android.os.Handler
import android.os.Looper


val PROJECT_DETAIL_KINDS = setOf("projectEdit")


private val PROJECT_STATUSES = listOf("active" to "status.active", "waiting" to "status.waiting", "someday" to "status.someday")


data class SectionDraft(val sectionId: String?, val title: String)


class ProjectDetailsModel(private val shell: InboxViewModel) : FilterSheetHost {

    var projectId by mutableStateOf<String?>(null); private set
    var open by mutableStateOf(false)
    var statusMenu by mutableStateOf(false)

    var raw by mutableStateOf<JSONObject?>(null); private set
    var notesExpanded by mutableStateOf(false)
    var notesPreview by mutableStateOf(false)
    var notesFullscreen by mutableStateOf(false)

    var notesDraft by mutableStateOf<String?>(null)

    var titleDraft by mutableStateOf<String?>(null)

    private var sentTitle: String? = null

    private var openedTitle: String? = null
    private var sentNotes: String? = null

    var notesView by mutableStateOf<JSONObject?>(null); private set
    var areaPicker by mutableStateOf<JSONObject?>(null); private set
    var tagPicker by mutableStateOf<JSONObject?>(null); private set
    var tagDraft by mutableStateOf("")

    var datePicker by mutableStateOf<Pair<String, JSONObject>?>(null); private set

    var sections by mutableStateOf<JSONObject?>(null); private set
    var sectionDraft by mutableStateOf<SectionDraft?>(null)
    var sectionDelete by mutableStateOf<JSONObject?>(null)

    var actionsOpen by mutableStateOf(false)
    var actionConfirm by mutableStateOf<String?>(null)

    var reviewCompletion by mutableStateOf<JSONObject?>(null); private set


    var listFilterState by mutableStateOf(JSONObject()); private set

    var listFilterSheet by mutableStateOf<JSONObject?>(null); private set

    private var tokenPages by mutableStateOf<Pair<String, List<JSONObject>>?>(null)
    override var pickerFound by mutableStateOf<JSONObject?>(null); private set
    private var filterTyped = 0

    fun keepFilters(state: JSONObject) { listFilterState = state }

    override val idle: Boolean get() = shell.writable && !shell.busy && shell.failedAction == null
    override val filterRevision: String? get() = shell.project?.revision
    private val listFilters: JSONObject? get() = shell.project?.listFilters

    override fun collection(name: String): List<JSONObject> {
        if (name != "tokens") return emptyList()
        tokenPages?.takeIf { it.first == filterRevision }?.let { return it.second }
        return listFilters?.getJSONObject("filters")?.optJSONObject("tokens")?.menuObjects("items").orEmpty()
    }

    override fun collectionTotal(name: String): Int =
        if (name == "tokens") listFilters?.getJSONObject("filters")?.optJSONObject("tokens")?.optInt("total") ?: 0 else 0


    fun openFilters() {
        viewOptionsOpen = false
        listFilterSheet = JSONObject().put("kind", "filters")
        shell.refreshProjects()
    }

    override fun closeFilters() {
        listFilterSheet = null
        tokenPages = null
        pickerFound = null
    }

    override fun filterEdit(edit: JSONObject) {
        val type = edit.optString("type")
        if (type == "clear" || type == "setSearch" || type == "setLocation") {
            listFilterSheet?.let { listFilterSheet = JSONObject(it.toString()).apply { remove("typed:setSearch"); remove("typed:setLocation") } }
        }
        shell.editProjectFilters(edit)
    }

    override fun removeChip(action: JSONObject) { action.optJSONObject("filterEdit")?.let(::filterEdit) }


    override fun typeFilter(type: String, text: String) {
        listFilterSheet?.let { listFilterSheet = JSONObject(it.toString()).put("typed:$type", text) }
        val mine = ++filterTyped
        main.postDelayed({ if (mine == filterTyped) shell.editProjectFilters(JSONObject().put("type", type).put("value", text)) }, 200)
    }

    override fun toggleDisclosure(id: String) {
        val open = listFilterSheet ?: return
        listFilterSheet = JSONObject(open.toString()).put(id, !open.optBoolean(id))
    }

    override fun dialogPage(page: String?) {
        pickerFound = null
        listFilterSheet?.let { listFilterSheet = JSONObject(it.toString()).apply { remove("query"); if (page == null) remove("page") else put("page", page) } }
    }

    override fun pickerQuery(name: String, text: String) {
        listFilterSheet?.let { listFilterSheet = JSONObject(it.toString()).put("query", text) }
        val mine = ++filterTyped
        main.postDelayed({ if (mine == filterTyped) searchPicker(name, text) }, 200)
    }


    override fun searchPicker(name: String, query: String, depth: Int) {
        val revision = filterRevision ?: return
        if (name != "tokens" || query.isBlank()) { pickerFound = null; return }
        val read = tokenRead(query) ?: return
        shell.background(emptyList(), { runtime -> collectTokens(runtime, read, 0, depth) }) { (total, items), _ ->
            if (filterRevision == revision && listFilterSheet?.optString("query") == query) {
                pickerFound = JSONObject().put("name", name).put("query", query).put("revision", revision).put("total", total).put("items", JSONArray(items))
            }
        }
    }


    override fun loadCollection(name: String) {
        val revision = filterRevision ?: return
        if (name != "tokens") return
        val have = collection("tokens")
        val read = tokenRead("") ?: return
        shell.background(emptyList(), { runtime -> collectTokens(runtime, read, have.size, have.size + 100) }) { (_, items), _ ->
            if (filterRevision == revision) tokenPages = revision to (have + items)
        }
    }


    private fun tokenRead(query: String): JSONObject? {
        val id = projectId ?: return null
        return input(id).put("showCompleted", shell.projectShowCompleted).put("completedCollapsed", shell.projectCompletedCollapsed)
            .put("filters", listFilterState).put("picker", "tokens").put("query", query)
    }


    private fun collectTokens(runtime: CoreHost, read: JSONObject, offset: Int, depth: Int): Pair<Int, List<JSONObject>> {
        val items = ArrayList<JSONObject>()
        var revision: String? = null
        var total: Int
        do {
            val window = runtime.menuRead("projectDetailFilterOptions", JSONObject(read.toString()).put("offset", offset + items.size).put("limit", 100)
                .apply { revision?.let { put("revision", it) } }.toString())
            revision = window.getString("revision")
            total = window.getInt("total")
            val next = window.menuObjects("items")
            items += next
        } while (next.isNotEmpty() && offset + items.size < minOf(depth, total))
        return total to items
    }


    var reorderMode by mutableStateOf(false); private set

    var viewedTaskId: String? = null

    var orderView by mutableStateOf<JSONObject?>(null); private set


    fun toggleReorder() {
        viewOptionsOpen = false
        reorderMode = !reorderMode
        if (!reorderMode) { orderView = null; shell.refreshProjects() }
    }

    fun readOrder() {
        val id = projectId ?: return
        val ticket = replies.ticket("order")
        val base = input(id).put("showCompleted", shell.projectShowCompleted).put("filters", listFilterState)
        shell.background(emptyList(), { runtime ->
            val items = JSONArray()
            var first: JSONObject? = null
            var revision: String? = null
            var total: Int
            do {
                val window = runtime.menuRead("projectTaskOrderView", JSONObject(base.toString()).put("offset", items.length()).put("limit", 100)
                    .apply { revision?.let { put("revision", it) } }.toString())
                if (first == null) first = window
                revision = window.getString("revision")
                total = window.getInt("total")
                val next = window.getJSONArray("items")
                for (index in 0 until next.length()) items.put(next.get(index))
            } while (next.length() > 0 && items.length() < total)
            JSONObject(checkNotNull(first).toString()).put("items", items)
        }) { reply, _ -> if (replies.current(ticket)) orderView = reply }
    }


    fun moveTask(taskId: String, after: JSONObject?) {
        val token = orderView?.optString("orderToken")?.takeIf { it.isNotEmpty() } ?: return
        edit(projectId, "taskOrder", refused = { readOrder() }, answer = { readOrder() }) {
            put("taskId", taskId).put("after", after ?: JSONObject.NULL).put("showCompleted", shell.projectShowCompleted)
                .put("filters", listFilterState).put("expectedOrder", token)
        }
    }


    fun moveOrderSection(sectionId: String, direction: String, order: List<String>) {
        edit(projectId, "sectionMove", answer = { readOrder() }) { put("sectionId", sectionId).put("direction", direction).put("order", JSONArray(order)) }
    }


    var viewOptionsOpen by mutableStateOf(false)
    var sortOpen by mutableStateOf(false)
    var sort by mutableStateOf<JSONObject?>(null); private set

    val customSort: Boolean get() = sort?.optString("effectiveSortBy", "default")?.let { it != "default" } == true

    var convertRow by mutableStateOf<JSONObject?>(null); private set

    var convert by mutableStateOf<JSONObject?>(null); private set
    var convertDestination by mutableStateOf<String?>(null); private set
    var convertTitle by mutableStateOf(""); private set

    var convertConfirm by mutableStateOf(false)

    private var convertExpected: String? = null

    private val answers = java.util.Collections.synchronizedMap(HashMap<String, (JSONObject) -> Unit>())

    private val refusals = java.util.Collections.synchronizedMap(HashMap<String, (String) -> Unit>())

    var help by mutableStateOf<Pair<String, String>?>(null)


    fun follow(id: String?) {
        if (id == projectId) return

        projectId?.let { old ->

            for ((kind, text) in editsOnLeave(titleDraft, titleBase(sentTitle, openedTitle, shell.projects?.title(old)), notesDraft,
                sentNotes ?: raw?.let { storedNotes() })) {
                if (kind == "projectRename") rename(text, old) else writeNotes(text, old)
            }
        }
        titleDraft = null
        sentTitle = null
        openedTitle = id?.let { shell.projects?.title(it) }
        sentNotes = null
        replies.close()
        projectId = id
        open = false; statusMenu = false; raw = null; notesExpanded = false; notesPreview = false; notesFullscreen = false
        notesDraft = null; notesView = null; areaPicker = null; tagPicker = null; tagDraft = ""; datePicker = null
        sections = null; sectionDraft = null; sectionDelete = null; help = null; actionsOpen = false; actionConfirm = null
        convertRow = null; convert = null; convertConfirm = false
        viewOptionsOpen = false; sortOpen = false; sort = null
        resetFilters()
        reorderMode = false; orderView = null
    }


    fun resetFilters() { listFilterState = JSONObject(); listFilterSheet = null; tokenPages = null; pickerFound = null }

    private fun input(id: String) = JSONObject().put("projectId", id)


    private val replies = ReplyGuard()


    fun read() {
        val id = projectId ?: return
        val ticket = replies.ticket("raw")
        shell.background(emptyList(), { runtime ->
            JSONObject().put("status", runtime.menuRead("projectStatusOptions", input(id).toString()))
                .put("flow", runtime.menuRead("projectFlowOptions", input(id).toString()))
                .put("notes", runtime.menuRead("projectNotesOptions", input(id).toString()))
        }) { reply, mine ->

            if (!replies.current(ticket) || !shell.fresh(mine, InboxViewModel.Part.ProjectDetails)) return@background
            raw = reply

            if (notesDraft == storedNotes()) notesDraft = null
        }
    }

    fun storedNotes(): String = raw?.getJSONObject("notes")?.getJSONObject("project")?.menuText("supportNotes").orEmpty()
    fun status(): String? = raw?.getJSONObject("status")?.getJSONObject("project")?.getString("status")
    fun flow(): JSONObject? = raw?.getJSONObject("flow")?.getJSONObject("project")
    fun flowMode(): String? = raw?.getJSONObject("flow")?.menuText("flowMode")


    fun readNotes() {
        val id = projectId ?: return
        val text = notesDraft ?: storedNotes()
        val ticket = replies.ticket("notes")
        shell.background(emptyList(), { runtime ->
            runtime.menuRead("projectNotesPreview", input(id).put("text", text).toString())
        }) { reply, _ -> if (replies.current(ticket)) notesView = reply }
    }


    fun openAreas() = choices("projectAreaOptions", JSONObject()) { areaPicker = it }
    fun closeAreas() { areaPicker = null }


    fun openTags() { tagDraft = ""; choices("projectTagsOptions", JSONObject()) { tagPicker = it } }
    fun readTags() {
        val id = projectId ?: return
        if (tagPicker == null) return
        val ticket = replies.ticket("tags")
        shell.background(emptyList(), { it.menuRead("projectTagsOptions", input(id).toString()) }) { reply, _ -> if (replies.current(ticket) && tagPicker != null) tagPicker = reply }
    }
    fun closeTags() { tagPicker = null }

    fun openDate(field: String) = choices("projectDateOptions", JSONObject().put("field", field)) { datePicker = field to it }
    fun closeDate() { datePicker = null }

    fun openSections() = choices("projectSectionOrderOptions", JSONObject()) { sections = it }
    fun readSections() {
        val id = projectId ?: return
        if (sections == null) return
        val ticket = replies.ticket("sections")
        shell.background(emptyList(), { it.menuRead("projectSectionOrderOptions", input(id).toString()) }) { reply, _ -> if (replies.current(ticket) && sections != null) sections = reply }
    }
    fun closeSections() { sections = null; sectionDraft = null; sectionDelete = null }


    fun closeOverlays() {
        replies.close()
        statusMenu = false; areaPicker = null; tagPicker = null; datePicker = null; help = null; notesFullscreen = false; closeSections()
    }


    private fun choices(read: String, extra: JSONObject, show: (JSONObject) -> Unit) {
        val id = projectId ?: return
        statusMenu = false

        val ticket = replies.ticket("picker")
        shell.perform { runtime ->
            val options = runtime.menuRead(read, JSONObject(extra.toString()).put("projectId", id).toString())
            shell.ui { if (replies.current(ticket)) show(options) }
        }
    }


    fun sawTitle(stored: String) { if (openedTitle == null) openedTitle = stored }


    fun commitTitle(stored: String) {
        titleToStore(titleDraft, titleBase(sentTitle, openedTitle, stored))?.let { titleDraft = it; rename(it) }
    }

    fun rename(title: String, projectId: String? = this.projectId) {
        val text = title.trim()
        if (text.isEmpty()) return
        if (projectId == this.projectId) sentTitle = text
        edit(projectId, "title") { put("title", text) }
    }


    fun lifecycle(action: String) {
        actionsOpen = false; actionConfirm = null

        edit(projectId, "lifecycle", refused = { message -> shell.showToast(t("common.error"), if (action == "cancel") t("projects.cancelFailed") else message, "error") }) {
            put("action", action)
        }
    }


    fun askCompleteFromReview(projectId: String) {
        shell.background(emptyList(), { runtime -> runtime.menuRead("weeklyProjectCompletion", JSONObject().put("projectId", projectId).toString()) }) { reply, _ ->
            val completion = reply.optJSONObject("completion") ?: return@background
            if (completion.isNull("confirm")) completeFromReview(projectId) else reviewCompletion = completion
        }
    }

    fun completeFromReview(projectId: String) {
        reviewCompletion = null
        edit(projectId, "lifecycle", refused = { message -> shell.showToast(t("common.error"), message, "error") }) { put("action", "complete") }
    }

    fun dismissReviewCompletion() { reviewCompletion = null }


    fun openActions() {
        storeTyped()
        actionsOpen = true
        readConvert("convertRow", null, shell.projects?.title(projectId.orEmpty()).orEmpty()) { convertRow = it.getJSONObject("row") }
    }

    private fun readConvert(kind: String, destination: String?, title: String, done: (JSONObject) -> Unit) {
        val id = projectId ?: return
        val ticket = replies.ticket(kind)
        val query = input(id).put("destinationId", destination ?: JSONObject.NULL).put("title", title).toString()
        shell.background(emptyList(), { runtime -> runtime.menuRead("projectToSectionOptions", query) }) { reply, _ -> if (replies.current(ticket)) done(reply) }
    }


    fun startConvert() {
        actionsOpen = false
        convertDestination = null; convertConfirm = false
        convertTitle = shell.projects?.title(projectId.orEmpty()).orEmpty()
        readConvert("convert", null, convertTitle) { convert = it }
    }

    fun pickDestination(id: String) {
        convertDestination = id
        readConvert("convert", id, convertTitle) { convert = it }
    }

    fun typeConvertTitle(text: String) {
        convertTitle = text
        readConvert("convert", convertDestination, text) { convert = it }
    }

    fun closeConvert() { convert = null; convertConfirm = false }


    fun confirmConvert(preview: JSONObject) {
        convertExpected = preview.getString("token")
        convertConfirm = true
    }


    private fun storeTyped() {
        val id = projectId ?: return
        for ((kind, text) in editsOnLeave(titleDraft, sentTitle ?: shell.projects?.title(id), notesDraft, sentNotes ?: raw?.let { storedNotes() })) {
            if (kind == "projectRename") rename(text, id) else writeNotes(text, id)
        }
    }


    fun convertNow() {
        val id = projectId ?: return
        val destination = convertDestination ?: return
        val expected = convertExpected ?: return
        val title = convertTitle
        closeConvert()
        var convertId = ""
        val failed = { message: String -> shell.showToast(t("common.notice"), message, "error") }
        convertId = edit(id, "toSection", refused = failed, answer = { reply ->
            val done = reply.optJSONObject("reply") ?: return@edit
            shell.openProject(done.getString("destinationProjectId"))
            shell.showToast(done.getString("title"), done.getString("message"), "success", done.getString("undoLabel")) {
                edit(id, "toSectionUndo", refused = failed, answer = { undone -> undone.optJSONObject("reply")?.let { shell.openProject(it.getString("sourceProjectId")) } }) {
                    put("convertRequestId", convertId)
                }
            }
        }) { put("destinationProjectId", destination).put("title", title).put("expected", expected) } ?: return
    }


    fun readSort() {
        val id = projectId ?: return
        val ticket = replies.ticket("sort")
        shell.background(emptyList(), { runtime -> runtime.menuRead("projectTaskSortOptions", input(id).toString()) }) { reply, _ ->
            if (replies.current(ticket)) sort = reply
        }
    }

    fun openViewOptions() {
        viewOptionsOpen = true
        readSort()
    }


    fun chooseSort(sortBy: String) {
        sortOpen = false
        edit(projectId, "sort", answer = { readSort() }) { put("sortBy", sortBy) }
    }


    fun duplicate() {
        actionsOpen = false
        edit(projectId, "duplicate", refused = { shell.showToast(t("common.notice"), t("projects.duplicateFailed"), "error") }, answer = { reply ->
            reply.optJSONObject("reply")?.let { copy -> shell.openProject(copy.getString("id")); shell.showToast(t("common.done"), copy.getString("message"), "success") }
        })
    }


    fun delete() {
        actionsOpen = false; actionConfirm = null
        val id = projectId ?: return
        var deleteId = ""
        deleteId = edit(id, "delete", refused = { shell.showToast(t("common.notice"), t("projects.deleteFailed"), "error") }, answer = { reply ->
            val deletion = reply.optJSONObject("reply")?.optJSONObject("deletion") ?: return@edit
            if (shell.openProjectId == id) shell.closeProject()
            shell.showToast(t("common.notice"), deletion.getString("message"), "info", deletion.getString("undoLabel"), 5_200) {
                edit(id, "deleteUndo", refused = { shell.showToast(t("common.notice"), t("projects.restoreFailed"), "error") }) { put("deleteRequestId", deleteId) }
            }
        }) ?: return
    }

    fun setStatus(status: String) {
        statusMenu = false
        edit(projectId, "status") { put("status", status) }
    }


    fun setFlowMode(mode: String) {
        val fields = flowModeEdit(flowMode(), mode) ?: return
        edit(projectId, "flowMode") { for (name in fields.keys()) put(name, fields.get(name)) }
    }


    fun setSectionFlow(sectionId: String, shownSequential: Boolean) =
        edit(projectId, "sectionFlow") { put("sectionId", sectionId).put("sequential", !shownSequential) }

    fun setScope(scope: String) = edit(projectId, "scope") { put("scope", scope) }


    fun move(projectId: String, direction: String, order: List<String>) =
        edit(projectId, "move", refused = { shell.showToast(t("common.notice"), t("projects.moveProjectFailed"), "error") }) {
            put("direction", direction).put("order", JSONArray(order))
        }


    fun setArea(area: JSONObject?) {
        areaPicker = null
        edit(projectId, "area") { put("areaId", area?.getString("id") ?: JSONObject.NULL) }
    }

    fun setColor(color: String?) {
        areaPicker = null
        edit(projectId, "color") { put("colorOverride", color ?: JSONObject.NULL) }
    }


    fun setTag(tag: String, present: Boolean) {
        if (tag.isBlank()) return
        edit(projectId, "tag") { put("tag", tag).put("present", present) }
    }


    fun addTag(tag: String) {
        setTag(tag, present = true)
    }


    fun commitNotes() {
        val text = notesDraft ?: return
        if (text == storedNotes()) { notesDraft = null; return }
        writeNotes(text, projectId)
    }

    private fun writeNotes(text: String, projectId: String?) {
        if (projectId == this.projectId) sentNotes = text
        edit(projectId, "notes") { put("text", text) }
    }


    fun setDate(field: String, day: String?, opened: String? = null) {
        datePicker = null
        edit(projectId, "date") { put("field", field).put("value", day ?: JSONObject.NULL).put("opened", opened ?: JSONObject.NULL) }
    }

    fun saveSection() {
        val draft = sectionDraft ?: return
        val title = draft.title.trim()
        if (title.isEmpty()) return
        sectionDraft = null
        if (draft.sectionId == null) edit(projectId, "sectionCreate") { put("title", title) }
        else edit(projectId, "sectionRename") { put("sectionId", draft.sectionId).put("title", title) }
    }

    fun deleteSection(sectionId: String) {
        sectionDelete = null
        edit(projectId, "sectionDelete") { put("sectionId", sectionId) }
    }


    fun moveSection(sectionId: String, direction: String) {
        val order = JSONArray().apply { sections?.menuObjects("sections")?.forEach { put(it.getString("id")) } }
        edit(projectId, "sectionMove") { put("sectionId", sectionId).put("direction", direction).put("order", order) }
    }

    private val main = Handler(Looper.getMainLooper())
    private val writes = WriteQueue<FailedAction> { action, done -> start(action, done) }
    private var pumping = false


    private fun edit(projectId: String?, kind: String, answer: ((JSONObject) -> Unit)? = null, refused: ((String) -> Unit)? = null,
                     fields: JSONObject.() -> Unit = {}): String? {
        val id = projectId ?: return null
        val requestId = UUID.randomUUID().toString()
        answer?.let { answers[requestId] = it }
        refused?.let { refusals[requestId] = it }
        val json = projectEdit(requestId, id, kind, JSONObject().apply(fields)).toString()
        runCatching { checkNotNull(shell.coreHost()).journalAhead("projectEdit", json) }
            .onFailure { Log.e(CoreHost.TAG, "Native Android project edit not journaled ahead ${failureForLog(it)}") }
        writes.add(FailedAction("projectEdit", requestId, json))
        pump()
        return requestId
    }


    private fun pump() {
        writes.pump()
        if (!writes.waiting || pumping) return
        pumping = true
        main.postDelayed({ pumping = false; pump() }, 250)
    }


    private fun start(action: FailedAction, done: () -> Unit): Boolean {
        if (shell.busy || shell.failedAction != null) return false
        return shell.tryPerform(action, finished = done) { runtime -> answered(action, sent(runtime, action)) }
    }


    private fun send(action: FailedAction) = shell.perform(action) { runtime -> answered(action, sent(runtime, action)) }


    private fun sent(runtime: CoreHost, action: FailedAction): JSONObject = try {
        runtime.menuCommand(action.kind, action.title)
    } catch (failure: Exception) {
        val message = failure.message.orEmpty()
        if (message.startsWith("STALE_REVISION")) {
            answers.remove(action.id)
            refusals.remove(action.id)?.let { refused -> shell.ui { refused(message.substringAfter(": ")) } }
        }
        throw failure
    }


    private fun answered(action: FailedAction, reply: JSONObject) {
        shell.acknowledged(action)
        refusals.remove(action.id)

        answers.remove(action.id)?.let { answer -> shell.ui { shell.menu.whenIdle { answer(reply) } } }
    }

    fun retry(action: FailedAction) = send(action)
}


@Composable
private fun statusPalette(status: String?): Triple<Color, Color, Color> {
    val theme = LocalTheme.current
    val c = theme.colors
    return when (status) {
        "active" -> Triple(c.tint, c.tint.copy(alpha = 0x22 / 255f), c.tint)
        "waiting" -> Triple(theme.projectWaiting, theme.projectWaiting.copy(alpha = 0x22 / 255f), theme.projectWaiting)
        "someday" -> Triple(theme.projectSomeday, theme.projectSomeday.copy(alpha = 0x22 / 255f), theme.projectSomeday)
        else -> Triple(c.secondaryText, c.filterBg, c.border)
    }
}


@Composable
private fun DetailsBlock(vertical: Int = 12, tag: String? = null, content: @Composable () -> Unit) {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).then(if (tag != null) Modifier.testTag(tag) else Modifier)
        .padding(horizontal = 16.dp, vertical = vertical.dp)) { content() }
}

@Composable
private fun DetailsLabel(text: String, modifier: Modifier = Modifier) =
    Text(text, style = rnText(14, 600), color = LocalTheme.current.colors.text, modifier = modifier)


@Composable
internal fun SmallButton(label: String, enabled: Boolean, tag: String? = null, color: Color = LocalTheme.current.colors.tint,
                         modifier: Modifier = Modifier, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Text(label, style = rnText(12, 700), color = color, modifier = modifier.fade(if (enabled) 1f else 0.5f).clip(shape).background(c.cardBg)
        .rnBorder(1.dp, c.border, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .then(if (tag != null) Modifier.testTag(tag) else Modifier).padding(horizontal = 10.dp, vertical = 6.dp))
}


@Composable
private fun HelpButton(label: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.size(30.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).clickable(role = Role.Button, onClick = onClick)
        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Icon(Ionicons.HelpCircleOutline, null, tint = c.secondaryText, modifier = Modifier.size(17.dp))
    }
}


@Composable
private fun MetadataRow(label: String, value: String, enabled: Boolean, tag: String, divider: Boolean, clear: (() -> Unit)? = null, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BoxWithConstraints(Modifier.fillMaxWidth().then(if (divider) Modifier.padding(top = 8.dp).hairline(c.border, top = true).padding(top = 8.dp) else Modifier)) {

    val most = maxWidth * 0.68f
    Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
        DetailsLabel(label, Modifier.padding(end = 12.dp))
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.widthIn(max = most).fade(if (enabled) 1f else 0.5f).heightIn(min = 34.dp).clip(shape)
                .background(c.inputBg).rnBorder(1.dp, c.border, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                .semantics { contentDescription = "$label: $value" }.testTag(tag).padding(horizontal = 10.dp, vertical = 6.dp),
                contentAlignment = Alignment.CenterStart) {
                Text(value, style = rnText(13, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (clear != null) {
                val clearLabel = "${t("common.clear")} $label"
                Box(Modifier.padding(start = 4.dp).size(32.dp).fade(if (enabled) 1f else 0.5f).clickable(enabled = enabled, role = Role.Button, onClick = clear)
                    .semantics { contentDescription = clearLabel }, contentAlignment = Alignment.Center) {
                    Icon(Ionicons.CloseCircleOutline, null, tint = c.secondaryText, modifier = Modifier.size(19.dp))
                }
            }
        }
    }
    }
}


fun LazyListScope.projectDetailsItems(model: InboxViewModel, projectId: String, detail: ProjectDetail?) {
    val metadata = detail?.metadata?.takeIf { detail.projectId == projectId } ?: return

    detail.gettingStarted?.let { actions -> item(key = "getting-started") { GettingStartedActions(model, actions) } }
    item(key = "details") { DetailsToggle(model, detail, metadata) }
    if (!model.projectDetails.open) return
    item(key = "details-status") { DetailsStatus(model, detail, metadata) }
    if (metadata.menuText("sequentialScopeLabel") != null) item(key = "details-scope") { DetailsScope(model, detail, metadata) }
    item(key = "details-sections") { DetailsSections(model, detail, metadata) }
    item(key = "details-area") { DetailsArea(model, detail, metadata) }
    item(key = "details-notes") { ProjectNotes(model, projectId, detail.readOnly) }
    item(key = "details-attachments") { ProjectAttachments(model, projectId) }
    item(key = "details-dates") { DetailsDates(model, detail, metadata) }
}


@Composable
private fun DetailsToggle(model: InboxViewModel, detail: ProjectDetail, metadata: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = detail.readOnly
    val enabled = !archived && !model.busy && model.failedAction == null
    LaunchedEffect(detail.projectId, detail, model.busy) { if (!model.busy) read() }
    val toggleShape = RoundedCornerShape(10.dp)
    val detailsLabel = t("taskEdit.details")
    Row(Modifier.padding(top = 6.dp, bottom = 8.dp).fillMaxWidth().clip(toggleShape).background(c.cardBg).rnBorder(1.dp, c.border, toggleShape)
        .clickable(role = Role.Button) { open = !open }
        .semantics { contentDescription = detailsLabel; stateDescription = t(if (open) "markdown.collapse" else "markdown.expand") }
        .testTag("project-details-toggle").padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (open) SettingsIonicons.ChevronDown else SettingsIonicons.ChevronForward, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
        Text(detailsLabel, style = rnText(14, 600), color = c.text, modifier = Modifier.padding(start = 6.dp, end = 12.dp))
        if (!open) Text(metadata.getString("summary"), style = rnText(12, 400, 16), color = c.secondaryText, textAlign = TextAlign.End, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).testTag("project-details-summary"))
    }
}


@Composable
private fun DetailsStatus(model: InboxViewModel, detail: ProjectDetail, metadata: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = detail.readOnly
    val enabled = !archived && !model.busy && model.failedAction == null
    DetailsBlock(tag = "project-details-status") {
        val status = if (archived) "archived" else status()
        val (text, bg, border) = statusPalette(status)
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            DetailsLabel(t("projects.statusLabel"), Modifier.weight(1f))
            val shape = RoundedCornerShape(8.dp)
            val label = metadata.getString("statusLabel")
            Row(Modifier.clip(shape).background(bg).rnBorder(1.dp, border, shape).clickable(enabled = enabled && status != null, role = Role.Button) { statusMenu = !statusMenu }
                .semantics { contentDescription = "${t("projects.statusLabel")}: $label"; if (archived) disabled() }
                .testTag("project-status-picker").padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = rnText(12, 600), color = text)
                Text("▾", style = rnText(12, 600), color = text, modifier = Modifier.padding(start = 6.dp))
            }
        }
        if (statusMenu && !archived) {
            val shape = RoundedCornerShape(8.dp)
            Column(Modifier.padding(top = 2.dp).fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape)) {
                for ((value, key) in PROJECT_STATUSES) {
                    val (itemText, _, itemBorder) = statusPalette(value)
                    Row(Modifier.fillMaxWidth().background(if (status == value) c.filterBg else Color.Transparent)
                        .clickable(enabled = enabled, role = Role.Button) { setStatus(value) }.semantics { selected = status == value }
                        .testTag("project-status-menu-item-$value").padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(itemBorder))
                        Text(t(key), style = rnText(12, 600), color = itemText, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            DetailsLabel(t("projects.projectTypeLabel"), Modifier.weight(1f))
            HelpButton(t("projects.projectTypeHelpLabel")) {
                help = t("projects.projectTypeHelpLabel") to "${t("projects.projectTypeHelpText")}\n\n${t("projects.perSectionTooltip")}"
            }
        }

        Choices(PROJECT_FLOW_MODES, flowMode(), archived, enabled && flowMode() != null, "project-flow-mode-", ::setFlowMode)
    }
}


@Composable
private fun Choices(choices: List<Pair<String, String>>, current: String?, archived: Boolean, enabled: Boolean, tagPrefix: String, onPick: (String) -> Unit) {
    val c = LocalTheme.current.colors
    Row(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, key) in choices) {
            val on = current == value
            val shape = RoundedCornerShape(8.dp)
            Box(Modifier.weight(1f).fade(if (archived) 0.5f else 1f).heightIn(min = 36.dp).clip(shape).background(if (on) c.tint else c.inputBg)
                .rnBorder(1.dp, if (on) c.tint else c.border, shape).clickable(enabled = enabled, role = Role.Button) { onPick(value) }
                .semantics { selected = on }.testTag("$tagPrefix$value").padding(8.dp), contentAlignment = Alignment.Center) {
                Text(t(key), style = rnText(12, 700), color = if (on) c.onTint else c.text, textAlign = TextAlign.Center)
            }
        }
    }
}


@Composable
private fun DetailsScope(model: InboxViewModel, detail: ProjectDetail, metadata: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = detail.readOnly
    val enabled = !archived && !model.busy && model.failedAction == null
    DetailsBlock(tag = "project-details-scope") {
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            DetailsLabel(t("projects.sequentialScope"), Modifier.weight(1f))
            HelpButton(t("projects.sequentialScopeHelpLabel")) { help = t("projects.sequentialScopeHelpLabel") to t("projects.sequentialScopeHelpText") }
        }
        val current = if (flow()?.menuText("sequentialScope") == "section") "section" else "project"
        Choices(listOf("project" to "projects.sequentialAcrossSections", "section" to "projects.sequentialWithinSections"), current, archived,
            enabled && flow() != null, "project-scope-") { setScope(it) }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DetailsSections(model: InboxViewModel, detail: ProjectDetail, metadata: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = detail.readOnly
    val enabled = !archived && !model.busy && model.failedAction == null
    DetailsBlock(tag = "project-details-sections") {
        val shown = metadata.menuObjects("sections")
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            DetailsLabel(t("projects.sectionsLabel"), Modifier.weight(1f))
            if (!archived || shown.isNotEmpty()) {
                SmallButton(t(if (shown.isNotEmpty()) "settings.manage" else "projects.addSection"), !model.busy && model.failedAction == null, "project-sections-button") { openSections() }
            }
        }
        if (shown.isNotEmpty()) FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (section in shown) Text(section.getString("title"), style = rnText(12, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.clip(CircleShape).background(c.inputBg).rnBorder(1.dp, c.border, CircleShape).padding(horizontal = 10.dp, vertical = 6.dp))
        }
    }
}


@Composable
private fun DetailsArea(model: InboxViewModel, detail: ProjectDetail, metadata: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = detail.readOnly
    val enabled = !archived && !model.busy && model.failedAction == null
    DetailsBlock(tag = "project-details-area") {
        MetadataRow(t("projects.color"), "", enabled, "project-color-picker", divider = false) { openAreas() }
        MetadataRow(t("projects.areaLabel"), metadata.getString("areaLabel"), enabled, "project-area-picker", divider = true) { openAreas() }
        MetadataRow(t("taskEdit.tagsLabel"), metadata.getString("tagsLabel"), enabled, "project-tag-picker", divider = true) { openTags() }
    }
}


@Composable
private fun DetailsDates(model: InboxViewModel, detail: ProjectDetail, metadata: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = detail.readOnly
    val enabled = !archived && !model.busy && model.failedAction == null
    DetailsBlock(tag = "project-details-dates") {
        for ((index, field) in PROJECT_DATE_FIELDS.withIndex()) {
            val set = metadata.getBoolean("has${field.third}Date")
            MetadataRow(t(field.second), metadata.getString("${field.third.replaceFirstChar { it.lowercase() }}DateLabel"), enabled,
                "project-${field.third.lowercase()}-date-picker", divider = index > 0, clear = if (set) ({ setDate(field.first, null) }) else null) { openDate(field.first) }
        }
    }
}


@Composable
private fun ProjectNotes(model: InboxViewModel, projectId: String, archived: Boolean) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    val preview = notesPreview || archived
    LaunchedEffect(projectId, model.project, notesExpanded, preview, notesDraft, model.busy) { if (notesExpanded && preview && !model.busy) readNotes() }
    val link = { target: JSONObject ->
        when (target.getString("kind")) {
            "external" -> openExternalLink(context, target.getString("href"), { t(it) }) { outcome -> model.anyTime({ it.logLinkHandoff(outcome, "markdown") }, {}) }
            "task" -> model.openEditor(target.getString("id"), "view")
            "project" -> model.openProject(target.getString("id"))
            else -> Unit
        }
        Unit
    }
    DetailsBlock(vertical = 8, tag = "project-details-notes") {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("${if (notesExpanded) "▾" else "▸"} ${t("project.notes")}", style = rnText(14, 600), color = c.text,
                modifier = Modifier.weight(1f).clickable(role = Role.Button) { if (notesExpanded) notesPreview = false; notesExpanded = !notesExpanded }
                    .testTag("project-notes-toggle").padding(vertical = 8.dp))
            if (notesExpanded) {

                SmallButton(t(if (notesPreview) "markdown.edit" else "markdown.preview"), !archived, "project-notes-mode") { notesPreview = !notesPreview }
                val expand = t("markdown.expand")
                Box(Modifier.padding(start = 8.dp).size(30.dp).fade(if (archived) 0.5f else 1f).clickable(enabled = !archived, role = Role.Button) { notesFullscreen = true }
                    .semantics { contentDescription = expand }, contentAlignment = Alignment.Center) {
                    Icon(Ionicons.ExpandOutline, null, tint = c.tint, modifier = Modifier.size(20.dp))
                }
            }
        }
        if (!notesExpanded) return@DetailsBlock
        val shape = RoundedCornerShape(10.dp)
        if (preview) Box(Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(12.dp)
            .testTag("project-notes-preview")) {
            notesView?.takeIf { it.getString("projectId") == projectId }?.let { MarkdownBlocks(it.menuObjects("blocks"), it.getJSONObject("markdownLabels"), link) }
        } else NotesField(model, Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 100.dp), RoundedCornerShape(8.dp), 14, 10) { !notesPreview }
    }
    if (notesFullscreen && !archived) NotesFullscreen(model, model.projects?.title(projectId).orEmpty(), link)
}


@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
private fun NotesField(model: InboxViewModel, modifier: Modifier, shape: RoundedCornerShape, size: Int, inner: Int, storeOnBlur: () -> Boolean) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val placeholder = t("projects.notesPlaceholder")
    var focused by remember { mutableStateOf(false) }
    val value = notesDraft ?: storedNotes()

    val reveal = remember { BringIntoViewRequester() }
    val keyboard = WindowInsets.isImeVisible
    LaunchedEffect(focused, keyboard, value.length) { if (focused) { delay(150); reveal.bringIntoView() } }
    BasicTextField(value, { notesDraft = it }, enabled = raw != null && !model.busy && model.failedAction == null,
        textStyle = rnText(size, 400, if (size == 16) 24 else null).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        modifier = modifier.bringIntoViewRequester(reveal).semantics { contentDescription = t("project.notes") }.testTag("project-notes-input").onFocusChanged { state ->

            if (focused && !state.isFocused && storeOnBlur()) commitNotes()
            focused = state.isFocused
        },
        decorationBox = { field ->
            Box(Modifier.clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(inner.dp)) {
                if (value.isEmpty()) Text(placeholder, style = rnText(size, 400), color = c.secondaryText)
                field()
            }
        })
}


@Composable
private fun NotesFullscreen(model: InboxViewModel, title: String, follow: (JSONObject) -> Unit) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    var editing by remember { mutableStateOf(true) }
    val close = { commitNotes(); notesFullscreen = false }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().imePadding().semantics { testTagsAsResourceId = true }.testTag("project-notes-fullscreen")) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                val collapse = t("markdown.collapse")
                Box(Modifier.align(Alignment.CenterStart).size(44.dp).clickable(role = Role.Button, onClick = close).semantics { contentDescription = collapse },
                    contentAlignment = Alignment.Center) { Icon(Ionicons.Close, null, tint = c.text, modifier = Modifier.size(24.dp)) }
                Text(title.ifEmpty { t("project.notes") }, style = rnText(15, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 60.dp).semantics { heading() })
                val modeLabel = t(if (editing) "markdown.preview" else "markdown.edit")
                val shape = RoundedCornerShape(8.dp)
                Box(Modifier.align(Alignment.CenterEnd).size(40.dp, 34.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                    .clickable(role = Role.Button) { editing = !editing }.semantics { contentDescription = modeLabel },
                    contentAlignment = Alignment.Center) { Icon(if (editing) Lucide.Eye else Lucide.Pencil, null, tint = c.tint, modifier = Modifier.size(18.dp)) }
            }

            val draft = remember { MarkdownDraft(notesDraft ?: storedNotes()) }
            draft.sync(notesDraft ?: storedNotes())
            val store = { text: String -> notesDraft = text }
            if (editing) {
                val shape = RoundedCornerShape(12.dp)

                MarkdownInput(draft, store, raw != null && !model.busy && model.failedAction == null, t("projects.notesPlaceholder"), t("project.notes"),
                    rnText(16, 400, 24).copy(color = c.text), Modifier.padding(16.dp).fillMaxWidth().weight(1f).testTag("project-notes-input"),
                    { field -> Box(Modifier.fillMaxSize().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(16.dp)) { field() } },
                    onBlur = { if (editing && notesFullscreen) commitNotes() })
                MarkdownToolbar(model, draft, store)
            }
            else {
                LaunchedEffect(model.project, notesDraft, model.busy) { if (!model.busy) readNotes() }
                val shape = RoundedCornerShape(12.dp)
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp)) {
                    Box(Modifier.fillMaxWidth().heightIn(min = 120.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(16.dp)) {
                        notesView?.let { MarkdownBlocks(it.menuObjects("blocks"), it.getJSONObject("markdownLabels"), follow) }
                    }
                }
            }
        }
    }
}


@Composable
private fun AreaRow(model: InboxViewModel, label: String, area: JSONObject?) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).clickable(role = Role.Button) { model.projectDetails.setArea(area) }.padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        if (area != null) Box(Modifier.padding(end = 8.dp).size(10.dp).clip(CircleShape).background(LocalTheme.current.identityColorOrNull(area.menuText("color")) ?: c.tint))
        Text(label, style = rnText(14, 600), color = c.text)
    }
}


@Composable
private fun Overlay(dismiss: () -> Unit, outsideCloses: Boolean, content: @Composable () -> Unit) {
    BackHandler(onBack = dismiss)
    Box(Modifier.fillMaxSize().background(LocalTheme.current.pickerScrim).then(if (outsideCloses) Modifier.pointerInput(Unit) { detectTapGestures { dismiss() } }
        else Modifier.pointerInput(Unit) { detectTapGestures { } }).imePadding().padding(20.dp).semantics { testTagsAsResourceId = true },
        contentAlignment = Alignment.Center) { content() }
}


@Composable
private fun PickerCard(title: String, dismiss: () -> Unit, tag: String, content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    Overlay(dismiss, outsideCloses = true) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(min = 280.dp, max = 360.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag(tag)) {
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            content()
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ProjectDetailsDialogs(model: InboxViewModel) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    LaunchedEffect(model.project, model.busy) { if (!model.busy) { readTags(); readSections() } }
    help?.let { (title, text) ->
        AlertDialog(onDismissRequest = { help = null }, title = { Text(title) }, text = { Text(text) },
            confirmButton = { TextButton(onClick = { help = null }) { Text(t("common.ok")) } })
    }
    areaPicker?.let { options ->
        PickerCard(t("projects.areaLabel"), ::closeAreas, "project-area-sheet") {
            Text(t("projects.color"), style = rnText(14, 600), color = c.secondaryText)
            TextButton(onClick = { setColor(null) }, enabled = !model.busy,
                modifier = Modifier.semantics { selected = options.isNull("colorOverride") }.testTag("project-color-area")) {
                Text(t("projects.useAreaColor"))
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val colors = options.getJSONArray("colors")
                for (index in 0 until colors.length()) {
                    val color = colors.getString(index)
                    val chosen = options.optString("colorOverride") == color
                    Box(Modifier.size(44.dp).clickable(enabled = !model.busy, role = Role.Button) { setColor(color) }
                        .semantics { contentDescription = t("projects.color") + ": " + color; selected = chosen }
                        .testTag("project-color-" + color), contentAlignment = Alignment.Center) {
                        Box(Modifier.size(30.dp).clip(CircleShape).background(coreColorOrNull(color) ?: c.tint)
                            .rnBorder(if (chosen) 3.dp else 1.dp, if (chosen) c.text else c.border, CircleShape))
                        if (chosen) Text("✓", color = c.text, style = rnText(16, 600))
                    }
                }
            }
            AreaRow(model, options.getString("noAreaLabel"), null)
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                for (area in options.menuObjects("areas")) AreaRow(model, area.getString("label"), area)
            }
        }
    }
    tagPicker?.let { options ->
        val focus = LocalFocusManager.current
        PickerCard(t("taskEdit.tagsLabel"), ::closeTags, "project-tag-sheet") {
            val current = options.getJSONObject("project").getJSONArray("tagIds").let { list -> List(list.length()) { list.getString(it) } }
            val shape = RoundedCornerShape(8.dp)
            Row(Modifier.padding(top = 10.dp).fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(start = 8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                val label = t("taskEdit.tagsLabel")
                BasicTextField(tagDraft, { tagDraft = it }, singleLine = true, textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),

                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { focus.clearFocus() }),
                    modifier = Modifier.weight(1f).padding(vertical = 8.dp).semantics { contentDescription = label }.testTag("project-tag-input"),
                    decorationBox = { field -> Box { if (tagDraft.isEmpty()) Text(label, style = rnText(14, 400), color = c.secondaryText); field() } })
                val add = t("common.add")
                Text("+", style = rnText(16, 700), color = c.tint, modifier = Modifier.drawBehind { drawLine(c.border, Offset(0f, 0f), Offset(0f, size.height), 1.dp.toPx()) }.clickable(role = Role.Button) { addTag(tagDraft); tagDraft = "" }
                    .semantics { contentDescription = add }.testTag("project-tag-add").padding(horizontal = 10.dp, vertical = 8.dp))
            }
            FlowRow(Modifier.padding(top = 12.dp).heightIn(max = 360.dp).verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (tag in options.getJSONArray("suggestions").let { list -> List(list.length()) { list.getString(it) } }) {
                    val on = tag in current
                    Text(tag, style = rnText(12, 600), color = c.text, modifier = Modifier.clip(CircleShape).background(if (on) c.filterBg else c.cardBg)
                        .rnBorder(1.dp, c.border, CircleShape).clickable(enabled = !model.busy, role = Role.Button) { setTag(tag, present = !on) }.semantics { selected = on }
                        .padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
        }
    }
    datePicker?.let { (field, options) ->
        val picker = options.getJSONObject("picker")
        DayPickerDialog(picker.getString("date"), ::closeDate) { day -> setDate(field, day, if (field == "reviewAt") picker.getString("instant") else null) }
    }
    sections?.let { options -> SectionManager(model, options) }
    if (actionsOpen) ProjectActionsSheet(model)
    if (viewOptionsOpen) ViewOptionsSheet(model)

    listFilterSheet?.let { open ->
        model.project?.listFilters?.let { view ->
            BackHandler { if (open.has("page")) dialogPage(null) else closeFilters() }
            FilterSheet(this, view, open)
        }
    }
    if (sortOpen) sort?.let { options ->
        BackHandler { sortOpen = false }
        ChoiceModal(model, options.getString("label"), options.menuObjects("choices").map { choice ->
            Choice(choice.getString("label"), choice.getBoolean("selected")) { chooseSort(choice.getString("id")) }
        }, dismiss = { sortOpen = false })
    }
    convert?.let { options -> ConvertSheet(model, options) }
    actionConfirm?.let { action ->

        val cancel = action == "cancel"
        val confirm = t(if (cancel) "projects.cancel" else "common.delete")
        AlertDialog(onDismissRequest = { actionConfirm = null },
            title = { Text(t(if (cancel) "projects.cancelConfirmTitle" else "projects.title")) },
            text = { Text(t(if (cancel) "projects.cancelConfirmBody" else "projects.deleteConfirm")) },
            dismissButton = { TextButton(onClick = { actionConfirm = null }) { Text(t("common.cancel")) } },
            confirmButton = { TextButton(onClick = { if (cancel) lifecycle("cancel") else delete() }) { Text(confirm, color = LocalTheme.current.colors.danger) } })
    }
}


@Composable
private fun ProjectActionsSheet(model: InboxViewModel) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = model.project?.readOnly == true
    val idle = !model.busy && model.failedAction == null
    Overlay({ actionsOpen = false }, outsideCloses = false) {
        val shape = RoundedCornerShape(14.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(14.dp).testTag("project-actions-sheet"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t("projects.actionsLabel"), style = rnText(17, 800), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                val close = t("common.close")
                Box(Modifier.size(34.dp).clickable(role = Role.Button) { actionsOpen = false }.semantics { contentDescription = close },
                    contentAlignment = Alignment.Center) { Icon(Ionicons.Close, null, tint = c.secondaryText, modifier = Modifier.size(20.dp)) }
            }
            val listShape = RoundedCornerShape(10.dp)
            Column(Modifier.fillMaxWidth().clip(listShape).rnBorder(1.dp, c.border, listShape)) {
                ProjectOptionRow(SettingsIonicons.CopyOutline, t("projects.duplicate"), "project-duplicate-button", idle) { duplicate() }

                convertRow?.let { row ->
                    ProjectOptionRow(Ionicons.FolderOpenOutline, row.getString("label"), "project-convert-to-section-button",
                        idle && row.getBoolean("eligible"), row.menuText("blocked")) { startConvert() }
                }
                if (archived) ProjectOptionRow(SettingsIonicons.RefreshOutline, t("projects.reactivate"), "project-reactivate-button", idle) { lifecycle("reactivate") }
                else ProjectOptionRow(Ionicons.ArchiveOutline, t("projects.complete"), "project-archive-button", idle, t("projects.archiveHelp")) { lifecycle("complete") }
                if (!archived) ProjectOptionRow(Ionicons.CloseCircleOutline, t("projects.cancel"), "project-cancel-button", idle, danger = true) {
                    actionsOpen = false; actionConfirm = "cancel"
                }
                ProjectOptionRow(SettingsIonicons.TrashOutline, t("common.delete"), "project-delete-button", idle, danger = true) {
                    actionsOpen = false; actionConfirm = "delete"
                }
            }
        }
    }
}


@Composable
private fun ConvertSheet(model: InboxViewModel, options: JSONObject) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val words = options.getJSONObject("words")
    val preview = options.optJSONObject("preview")
    val idle = !model.busy && model.failedAction == null
    Overlay(::closeConvert, outsideCloses = false) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.85f).dp).clip(shape)
            .background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("project-convert-sheet")) {
            Text(words.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                options.menuText("sequentialNote")?.let { Text(it, style = rnText(14, 400), color = c.secondaryText) }
                if (!convertConfirm) {
                    Text(words.getString("destination"), style = rnText(14, 400), color = c.text, modifier = Modifier.padding(bottom = 8.dp))
                    for (destination in options.menuObjects("destinations")) {
                        val on = destination.getString("id") == convertDestination
                        Text(destination.getString("title"), style = rnText(14, 400), color = if (on) c.tint else c.text, modifier = Modifier.fillMaxWidth()
                            .selectable(on, enabled = idle, role = Role.RadioButton) { pickDestination(destination.getString("id")) }.padding(vertical = 10.dp))
                    }
                    val nameLabel = words.getString("sectionName")
                    Text(nameLabel, style = rnText(14, 400), color = c.text, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                    val inputShape = RoundedCornerShape(10.dp)
                    BasicTextField(convertTitle, ::typeConvertTitle, enabled = idle, singleLine = true, textStyle = rnText(16, 400).copy(color = c.text),
                        cursorBrush = SolidColor(c.tint), modifier = Modifier.fillMaxWidth().clip(inputShape).background(c.inputBg).rnBorder(1.dp, c.border, inputShape)
                            .padding(horizontal = 12.dp, vertical = 10.dp).semantics { contentDescription = nameLabel }.testTag("project-convert-name"))
                }
                preview?.let { shown ->
                    val lines = shown.getJSONArray("lines")
                    Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(lines.getString(0), style = rnText(14, 400), color = c.text)
                        if (convertConfirm) Text(shown.getString("named"), style = rnText(14, 400), color = c.text)
                        for (index in 1 until lines.length()) {

                            if (index == lines.length() - 4) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Box(Modifier.size(12.dp).clip(CircleShape).background(shown.menuText("color")?.let(::coreColorOrNull) ?: Color.Transparent).rnBorder(1.dp, c.border, CircleShape))
                                Text(lines.getString(index), style = rnText(14, 400), color = c.secondaryText)
                            } else Text(lines.getString(index), style = rnText(14, 400), color = c.secondaryText)
                        }
                    }
                }
                options.menuText("blocked")?.let { Text(it, style = rnText(14, 400), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                val next = convertConfirm || (preview != null && convertTitle.isNotBlank())
                ConvertButton(words.getString(if (convertConfirm) "back" else "cancel"), idle) { if (convertConfirm) convertConfirm = false else closeConvert() }
                ConvertButton(words.getString(if (convertConfirm) "convert" else "next"), idle && next, "project-convert-next") {
                    if (convertConfirm) convertNow() else preview?.let(::confirmConvert)
                }
            }
        }
    }
}


@Composable
private fun ConvertButton(label: String, enabled: Boolean, tag: String? = null, onClick: () -> Unit) {
    Text(label, style = rnText(14, 700), color = LocalTheme.current.colors.text, modifier = Modifier.fade(if (enabled) 1f else 0.5f).clip(RoundedCornerShape(10.dp))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).then(if (tag != null) Modifier.testTag(tag) else Modifier)
        .padding(horizontal = 10.dp, vertical = 8.dp))
}


@Composable
private fun ViewOptionsSheet(model: InboxViewModel) = with(model.projectDetails) {
    val c = LocalTheme.current.colors
    val archived = model.project?.readOnly == true
    val idle = !model.busy && model.failedAction == null
    Overlay({ viewOptionsOpen = false }, outsideCloses = false) {
        val shape = RoundedCornerShape(14.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(14.dp).testTag("project-view-options-sheet"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(t("taskEdit.moreOptions"), style = rnText(17, 800), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                val close = t("common.close")
                Box(Modifier.size(34.dp).clickable(role = Role.Button) { viewOptionsOpen = false }.semantics { contentDescription = close },
                    contentAlignment = Alignment.Center) { Icon(Ionicons.Close, null, tint = c.secondaryText, modifier = Modifier.size(20.dp)) }
            }
            val listShape = RoundedCornerShape(10.dp)
            Column(Modifier.fillMaxWidth().clip(listShape).rnBorder(1.dp, c.border, listShape)) {

                model.project?.listFilters?.getJSONObject("filters")?.let { filters ->
                    val active = filters.optInt("activeCount")
                    ProjectOptionRow(Ionicons.FilterOutline, t("filters.label"), "project-view-filter-option", idle,
                        value = active.takeIf { it > 0 }?.toString(), selected = active > 0) { openFilters() }
                }
                sort?.let { options ->
                    val current = options.menuObjects("choices").firstOrNull { it.getBoolean("selected") }?.getString("label")
                    ProjectOptionRow(Ionicons.SwapVerticalOutline, options.getString("label"), "project-view-sort-option", idle && !archived,
                        if (archived) t("projects.reactivate") else null, value = current, selected = customSort) { viewOptionsOpen = false; sortOpen = true }
                }
                model.project?.controls?.takeIf { !archived }?.let { controls ->
                    val on = controls.getBoolean("showCompleted")
                    ProjectOptionRow(if (on) SettingsIonicons.EyeOutline else SettingsIonicons.EyeOffOutline, controls.getString("label"), "project-view-completed-option",
                        idle, selected = on) { viewOptionsOpen = false; model.showProjectCompleted(!on) }

                    if (controls.optBoolean("hasReorderTargets") || reorderMode) {
                        val off = customSort && !reorderMode
                        ProjectOptionRow(if (reorderMode) Ionicons.CheckmarkCircleOutline else Ionicons.ListOutline,
                            t(if (reorderMode) "common.done" else "projects.reorderTasks"), "project-view-reorder-option", idle && !off,
                            if (off) t("projects.reorderNeedsDefaultSort") else null, selected = reorderMode) { toggleReorder() }
                    }
                }
            }
        }
    }
}


@Composable
internal fun ProjectReorderList(model: InboxViewModel, modifier: Modifier) = with(model.projectDetails) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = orderView
    val items = remember(view) { view?.menuObjects("items").orEmpty() }
    val sectionIds = items.mapNotNull { item -> item.takeIf { it.getString("type") == "section" }?.menuText("sectionId") }
    val enabled = view?.optBoolean("canReorder") == true && !model.busy && model.failedAction == null
    Column(modifier.background(c.bg).testTag("project-reorder-list")) {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).background(c.cardBg).rnBorderBottom(c.border).padding(horizontal = 16.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(t(if (sectionIds.size > 1) "projects.projectOrder" else "projects.taskOrder"), style = rnText(13, 700), color = c.text,
                modifier = Modifier.weight(1f).semantics { heading() })
            val done = t("common.done")
            val shape = RoundedCornerShape(8.dp)
            Box(Modifier.heightIn(min = 36.dp).clip(shape).background(c.tint).rnBorder(1.dp, c.tint, shape).clickable(role = Role.Button) { toggleReorder() }
                .semantics { contentDescription = done }.testTag("project-task-reorder-toggle").padding(horizontal = 12.dp, vertical = 7.dp),
                contentAlignment = Alignment.Center) { Text(done, style = rnText(13, 700), color = c.onTint) }
        }
        val listState = rememberLazyListState()

        val anchor = remember { viewedTaskId }
        var anchored by remember { mutableStateOf(false) }
        LaunchedEffect(items) {
            if (anchored || items.isEmpty()) return@LaunchedEffect
            anchored = true
            val index = items.indexOfFirst { it.getString("type") == "task" && it.getJSONObject("row").getString("id") == anchor }
            if (index > 0) listState.scrollToItem(index)
        }

        var local by remember(view) { mutableStateOf<List<JSONObject>?>(null) }
        val shown = local ?: items


        val seen = remember { arrayOfNulls<List<JSONObject>>(1) }
        SideEffect {
            if (seen[0] != null && seen[0] !== shown) listState.requestScrollToItem(listState.firstVisibleItemIndex, listState.firstVisibleItemScrollOffset)
            seen[0] = shown
        }

        val moveRow = { from: Int, to: Int ->
            val moved = shown[from]
            val next = shown.toMutableList().apply { removeAt(from); add(to.coerceIn(0, size), moved) }
            local = next
            val prev = next.getOrNull(next.indexOf(moved) - 1)
            moveTask(moved.getJSONObject("row").getString("id"), prev?.let { row ->
                if (row.getString("type") == "section") JSONObject().put("type", "section").put("id", row.getString("id"))
                else JSONObject().put("type", "task").put("id", row.getJSONObject("row").getString("id"))
            })
        }

        var dragFrom by remember { mutableIntStateOf(-1) }
        var dragSize by remember { mutableFloatStateOf(0f) }
        var dragTop by remember { mutableFloatStateOf(0f) }
        val target = if (dragFrom < 0) -1 else dropTarget(listState.layoutInfo, dragFrom, dragTop, dragSize)


        val threshold = with(LocalDensity.current) { 80.dp.toPx() }
        val speed = with(LocalDensity.current) { 120.dp.toPx() }
        LaunchedEffect(dragFrom >= 0) {
            if (dragFrom < 0) return@LaunchedEffect
            while (dragFrom >= 0) {
                val height = listState.layoutInfo.viewportSize.height.toFloat()
                val toTop = maxOf(0f, dragTop)
                val toBottom = maxOf(0f, height - dragTop - dragSize)
                val step = when {
                    toTop <= threshold && listState.canScrollBackward -> -(1 - toTop / threshold) * speed
                    toBottom <= threshold && listState.canScrollForward -> (1 - toBottom / threshold) * speed
                    else -> 0f
                }
                if (step != 0f) listState.animateScrollBy(step) else withFrameNanos { }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth().pointerInput(enabled, shown) {
            if (!enabled) return@pointerInput
            val inset = 12.dp.toPx()
            val handle = 44.dp.toPx()
            val gap = 8.dp.toPx()

            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                val hit = listState.layoutInfo.visibleItemsInfo.firstOrNull { item ->
                    shown.getOrNull(item.index)?.getString("type") == "task" && down.position.x in (size.width - inset - handle)..(size.width - inset)
                        && down.position.y >= item.offset && down.position.y < item.offset + item.size - gap
                } ?: return@awaitEachGesture
                down.consume()
                val start = hit.offset.toFloat()
                dragSize = hit.size.toFloat(); dragTop = start; dragFrom = hit.index
                try {
                    while (true) {
                        val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: break
                        change.consume()
                        if (!change.pressed) {
                            val to = dropTarget(listState.layoutInfo, dragFrom, dragTop, dragSize)
                            val from = dragFrom
                            dragFrom = -1
                            if (to != from) moveRow(from, to)
                            break
                        }
                        dragTop = (start + change.position.y - down.position.y).coerceIn(0f, maxOf(0f, size.height - dragSize))
                    }
                } finally {
                    dragFrom = -1
                }
            }
        }) {
            LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp)) {
                itemsIndexed(shown, key = { _, item -> reorderKey(item) }) { index, item ->

                    val shift by animateFloatAsState(when {
                        dragFrom < 0 || index == dragFrom -> 0f
                        dragFrom < index && index <= target -> -dragSize
                        target <= index && index < dragFrom -> dragSize
                        else -> 0f
                    }, if (dragFrom < 0) snap() else spring(dampingRatio = 2.33f, stiffness = 1600f), label = "reorder-shift")
                    val placed = Modifier.graphicsLayer { translationY = shift; alpha = if (index == dragFrom) 0f else 1f }
                    if (item.getString("type") == "section") {
                        val title = item.getString("title")
                        val sectionId = item.menuText("sectionId")
                        Row(placed.fillMaxWidth().padding(start = 6.dp, end = 6.dp, top = 10.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically) {

                            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(title.uppercase(), style = rnText(13, 700, letterSpacing = 0.6f), color = if (item.optBoolean("muted")) c.secondaryText else c.text,
                                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false).semantics { heading() })
                                Text(item.optInt("count").toString(), style = rnText(11, 600), color = c.secondaryText)
                            }

                            val real = sectionId
                            val position = real?.let(sectionIds::indexOf) ?: -1
                            if (real != null && position >= 0 && sectionIds.size > 1) {
                                for ((direction, icon, key) in listOf(Triple("up", Lucide.ArrowUp, "projects.moveSectionUp"), Triple("down", Lucide.ArrowDown, "projects.moveSectionDown"))) {
                                    val can = enabled && (if (direction == "up") position > 0 else position < sectionIds.size - 1)
                                    val label = "${t(key)}: $title"
                                    val shape = RoundedCornerShape(8.dp)
                                    Box(Modifier.size(32.dp).fade(if (can) 1f else 0.4f).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
                                        .clickable(enabled = can, role = Role.Button) { moveOrderSection(real, direction, sectionIds) }
                                        .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
                                        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                                    }
                                }
                            }
                        }
                    } else {
                        val row = item.getJSONObject("row")
                        val title = row.getString("title")


                        val canUp = index > 0 && (shown[index - 1].getString("type") == "task" || index - 1 > 0)
                        val moves = listOfNotNull(
                            CustomAccessibilityAction(t("projects.moveUp")) { if (enabled) moveRow(index, index - 1); enabled }.takeIf { canUp },
                            CustomAccessibilityAction(t("projects.moveDown")) { if (enabled) moveRow(index, index + 1); enabled }.takeIf { index < shown.size - 1 },
                        )
                        val handle = "${t("board.dragTask")}: $title"
                        ReorderTaskRow(row, false, placed.testTag("project-task-reorder-row"), Modifier
                            .semantics { contentDescription = handle; role = Role.Button; if (enabled) customActions = moves else disabled() }
                            .testTag("project-task-drag-handle"))
                    }
                }
            }

            if (dragFrom >= 0) shown.getOrNull(dragFrom)?.takeIf { it.getString("type") == "task" }?.let { item ->
                ReorderTaskRow(item.getJSONObject("row"), true, Modifier.padding(horizontal = 12.dp).offset { IntOffset(0, dragTop.roundToInt()) }
                    .fade(0.92f), Modifier)
            }
        }
    }
}


@Composable
private fun ReorderTaskRow(row: JSONObject, active: Boolean, modifier: Modifier, handleModifier: Modifier) {
    val c = LocalTheme.current.colors
    Row(modifier.fillMaxWidth().height(80.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val shape = RoundedCornerShape(8.dp)
        Column(Modifier.weight(1f).padding(bottom = 8.dp).fillMaxHeight().clip(shape).background(c.taskItemBg).rnBorder(1.dp, if (active) c.tint else c.border, shape)
            .padding(horizontal = 12.dp, vertical = 9.dp), verticalArrangement = Arrangement.Center) {
            Text(row.getString("title"), style = rnText(15, 700, 19), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text(t("status.${row.optString("status")}"), style = rnText(12, 600, 15), color = c.secondaryText, maxLines = 1, modifier = Modifier.padding(top = 3.dp))
        }
        Box(handleModifier.width(44.dp).padding(bottom = 8.dp).fillMaxHeight().clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape),
            contentAlignment = Alignment.Center) {
            Icon(Lucide.GripVertical, null, tint = if (active) c.tint else c.secondaryText, modifier = Modifier.size(20.dp))
        }
    }
}

private fun reorderKey(item: JSONObject): String =
    if (item.getString("type") == "section") "section:${item.getString("id")}" else "task:${item.getJSONObject("row").getString("id")}"


private fun dropTarget(info: LazyListLayoutInfo, from: Int, top: Float, size: Float): Int {
    val visible = info.visibleItemsInfo
    val first = visible.firstOrNull()?.index ?: return from
    val last = visible.last().index
    var after = maxOf(0, first - from - 1)
    var before = maxOf(0, from - last - 1)
    for (item in visible) {
        if (item.index == from) continue
        val middle = item.offset + item.size / 2f
        if (item.index > from && top + size >= middle) after++
        if (item.index < from && top < middle) before++
    }
    return from + after - before
}


@Composable
private fun ProjectOptionRow(icon: ImageVector, label: String, tag: String, enabled: Boolean, description: String? = null, danger: Boolean = false,
                             value: String? = null, selected: Boolean = false, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).fade(if (enabled) 1f else 0.45f).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { this.selected = selected }.hairline(c.border, top = false).padding(horizontal = 12.dp, vertical = 9.dp).testTag(tag),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(32.dp).clip(RoundedCornerShape(9.dp)).background(if (selected) c.tint.copy(alpha = 0x20 / 255f) else c.filterBg),
            contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = if (danger) c.danger else if (selected) c.tint else c.secondaryText, modifier = Modifier.size(19.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = rnText(14, 700), color = if (danger) c.danger else c.text)
            description?.let { Text(it, style = rnText(11, 400, 15), color = c.secondaryText) }
        }
        value?.let { Text(it, style = rnText(12, 600), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 140.dp)) }
        if (selected) Icon(SettingsIonicons.Checkmark, null, tint = c.tint, modifier = Modifier.size(18.dp))
    }
}


@Composable
private fun SectionManager(model: InboxViewModel, options: JSONObject) = with(model.projectDetails) {
    val theme = LocalTheme.current
    val c = theme.colors
    val canManage = options.getJSONObject("project").getString("status") != "archived"
    val idle = !model.busy && model.failedAction == null
    val title = t("projects.sectionsLabel")
    Overlay(::closeSections, outsideCloses = false) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("project-section-manager"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = rnText(16, 800), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                val cancel = t("common.cancel")
                Box(Modifier.size(34.dp).clickable(role = Role.Button, onClick = ::closeSections).semantics { contentDescription = cancel },
                    contentAlignment = Alignment.Center) { Icon(Ionicons.Close, null, tint = c.secondaryText, modifier = Modifier.size(20.dp)) }
            }
            if (canManage) {
                val addShape = RoundedCornerShape(10.dp)
                Row(Modifier.fillMaxWidth().heightIn(min = 42.dp).fade(if (idle) 1f else 0.5f).clip(addShape).background(theme.filledBg)
                    .clickable(enabled = idle, role = Role.Button) { sectionDraft = SectionDraft(null, "") }.testTag("project-section-add-button")
                    .padding(horizontal = 12.dp, vertical = 9.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(SettingsIonicons.Add, null, tint = theme.filledText, modifier = Modifier.size(16.dp))
                    Text(t("projects.addSection"), style = rnText(14, 800), color = theme.filledText, modifier = Modifier.padding(start = 6.dp))
                }
            }
            val rows = options.menuObjects("sections")
            sectionDraft?.takeIf { canManage }?.let { draft ->
                val editorShape = RoundedCornerShape(10.dp)
                Column(Modifier.fillMaxWidth().clip(editorShape).background(c.filterBg).rnBorder(1.dp, c.border, editorShape).padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text((if (draft.sectionId != null) title else t("projects.addSection")).uppercase(), style = rnText(12, 700), color = c.secondaryText)
                    val inputShape = RoundedCornerShape(8.dp)
                    val placeholder = t("projects.sectionPlaceholder")
                    BasicTextField(draft.title, { sectionDraft = draft.copy(title = it) }, singleLine = true, textStyle = rnText(16, 400).copy(color = c.text),
                        cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { saveSection() }),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder }.testTag("project-section-title-input"),
                        decorationBox = { field ->
                            Box(Modifier.clip(inputShape).background(c.inputBg).rnBorder(1.dp, c.border, inputShape).padding(horizontal = 10.dp, vertical = 8.dp)) {
                                if (draft.title.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                                field()
                            }
                        })
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
                        SmallButton(t("common.cancel"), true, color = c.secondaryText) { sectionDraft = null }
                        val save = draft.title.isNotBlank() && idle
                        val saveShape = RoundedCornerShape(10.dp)
                        Text(t("common.save"), style = rnText(14, 700), color = theme.filledText, modifier = Modifier.fade(if (save) 1f else 0.5f).clip(saveShape)
                            .background(theme.filledBg).clickable(enabled = save, role = Role.Button) { saveSection() }.testTag("project-section-save-button")
                            .padding(horizontal = 10.dp, vertical = 8.dp))
                    }
                }
            }
            if (rows.isEmpty()) {
                val emptyShape = RoundedCornerShape(10.dp)
                Text(t("common.none"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.fillMaxWidth().clip(emptyShape).background(c.filterBg)
                    .rnBorder(1.dp, c.border, emptyShape).padding(horizontal = 12.dp, vertical = 10.dp))
            } else {
                val listShape = RoundedCornerShape(10.dp)
                Column(Modifier.fillMaxWidth().heightIn(max = 280.dp).clip(listShape).background(c.inputBg).rnBorder(1.dp, c.border, listShape)
                    .verticalScroll(rememberScrollState()).padding(vertical = 2.dp)) {
                    for (section in rows) {
                        val id = section.getString("id")
                        val name = section.getString("title")
                        Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(horizontal = 10.dp, vertical = 9.dp).testTag("project-section-row-$id"),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(name, style = rnText(14, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(end = 10.dp))
                            if (canManage) {
                                for ((direction, icon, key) in listOf(Triple("up", SettingsIonicons.ChevronUp, "projects.moveUp"), Triple("down", SettingsIonicons.ChevronDown, "projects.moveDown"))) {
                                    val can = section.getBoolean(if (direction == "up") "canMoveUp" else "canMoveDown") && idle
                                    val label = "${t(key)}: $name"
                                    val iconShape = RoundedCornerShape(8.dp)
                                    Box(Modifier.padding(end = 4.dp).size(30.dp).fade(if (can) 1f else 0.4f).clip(iconShape).background(c.cardBg).rnBorder(1.dp, c.border, iconShape)
                                        .clickable(enabled = can, role = Role.Button) { moveSection(id, direction) }.semantics { contentDescription = label }
                                        .testTag("project-section-move-$direction-$id"), contentAlignment = Alignment.Center) {
                                        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                                    }
                                }
                                Spacer(Modifier.size(2.dp))

                                if (!section.isNull("sequential")) {
                                    val sequential = section.getBoolean("sequential")
                                    val shown = t(if (sequential) "projects.sequential" else "projects.parallel")
                                    val label = "${t("projects.sequenceMode")}: $name"
                                    SmallButton(shown, idle, "project-section-flow-$id", color = c.secondaryText,
                                        Modifier.semantics { contentDescription = label; stateDescription = shown }) { setSectionFlow(id, sequential) }
                                    Spacer(Modifier.size(6.dp))
                                }
                                SmallButton(t("common.edit"), idle, "project-section-edit-$id") { sectionDraft = SectionDraft(id, name) }
                                Spacer(Modifier.size(6.dp))
                                SmallButton(t("common.delete"), idle, "project-section-delete-$id", color = c.danger) { sectionDelete = section }
                            }
                        }
                    }
                }
            }
        }
    }
    sectionDelete?.let { section ->
        AlertDialog(onDismissRequest = { sectionDelete = null }, title = { Text(title) }, text = { Text(t("projects.deleteSectionConfirm")) },
            dismissButton = { TextButton(onClick = { sectionDelete = null }) { Text(t("common.cancel")) } },
            confirmButton = { TextButton(onClick = { deleteSection(section.getString("id")) }) { Text(t("common.delete"), color = c.danger) } })
    }
}


@Composable
fun ProjectTitleField(model: InboxViewModel, stored: String, archived: Boolean, modifier: Modifier) = with(model.projectDetails) {
    val c = LocalTheme.current.colors

    LaunchedEffect(stored, titleDraft) { if (titleDraft == stored) titleDraft = null }
    LaunchedEffect(projectId) { sawTitle(stored) }
    val text = titleDraft ?: stored
    var focused by remember { mutableStateOf(false) }
    val commit = { commitTitle(stored) }
    BasicTextField(text, { titleDraft = it }, singleLine = true, enabled = !archived && !model.busy && model.failedAction == null,
        textStyle = rnText(18, 700).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { commit() }),
        modifier = modifier.semantics { heading() }.testTag("project-title-input").onFocusChanged { state ->
            if (focused && !state.isFocused) commit()
            focused = state.isFocused
        })
}


internal class WriteQueue<T>(private val start: (T, () -> Unit) -> Boolean) {
    private val items = ArrayDeque<T>()
    private var running = false


    val waiting: Boolean get() = !running && items.isNotEmpty()

    fun add(item: T) {
        items.addLast(item)
        pump()
    }

    fun pump() {
        if (running) return
        val next = items.removeFirstOrNull() ?: return
        running = true
        if (!start(next) { running = false; pump() }) {
            running = false
            items.addFirst(next)
        }
    }
}


internal fun titleToStore(typed: String?, stored: String?): String? =
    typed?.trim()?.takeIf { it.isNotEmpty() && it != stored?.trim() }


internal fun titleBase(sent: String?, opened: String?, stored: String?): String? = sent ?: opened ?: stored


internal fun editsOnLeave(title: String?, storedTitle: String?, notes: String?, storedNotes: String?): List<Pair<String, String>> = buildList {
    titleToStore(title, storedTitle)?.let { add("projectRename" to it) }
    if (notes != null && storedNotes != null && notes != storedNotes) add("projectNotes" to notes)
}


internal class ReplyGuard {
    data class Ticket(val session: Int, val kind: String, val number: Int)

    private var session = 0
    private var issued = 0
    private val newest = HashMap<String, Int>()

    fun ticket(kind: String): Ticket = Ticket(session, kind, ++issued).also { newest[kind] = it.number }

    fun current(ticket: Ticket): Boolean = ticket.session == session && newest[ticket.kind] == ticket.number

    fun close() { session += 1 }
}


internal val PROJECT_FLOW_MODES = listOf("parallel" to "projects.parallel", "sequential" to "projects.sequential", "perSection" to "projects.perSection")


internal fun flowModeEdit(shown: String?, picked: String): JSONObject? = if (shown == picked) null else JSONObject().put("mode", picked)


internal fun projectEdit(requestId: String, projectId: String, kind: String, fields: JSONObject): JSONObject =
    JSONObject().put("requestId", requestId).put("projectId", projectId).put("kind", kind).apply {
        for (name in fields.keys()) put(name, fields.get(name))
    }


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun GettingStartedActions(model: InboxViewModel, view: JSONObject) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    val actions = view.getJSONArray("actions")
    Column(Modifier.fillMaxWidth().padding(12.dp).testTag("getting-started-actions"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(view.getString("text"), style = rnText(14, 400, 21), color = c.secondaryText)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (index in 0 until actions.length()) {
                val action = actions.getJSONObject(index)
                val id = action.getString("id")
                val shape = RoundedCornerShape(8.dp)
                Row(Modifier.heightIn(min = 44.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                    .clickable(role = Role.Button) {
                        model.closeProject()
                        when (id) {
                            "capture" -> model.openCapture()
                            "inbox" -> { model.menu.toTabs(); model.show(Screen.Inbox) }
                            "focus" -> { model.menu.toTabs(); model.show(Screen.Focus) }
                        }
                    }.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(when (id) { "capture" -> GettingStartedPlus; "inbox" -> Lucide.Inbox; else -> Lucide.Star }, null, tint = c.text, modifier = Modifier.size(16.dp))
                    Text(action.getString("label"), style = rnText(14, 500), color = c.text)
                }
            }
        }
        val guide = view.getJSONObject("guide")
        val openGuide = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, guide.getString("url").toUri())) }; Unit }
        Row(Modifier.heightIn(min = 44.dp).clickable(onClick = openGuide), horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(guideLink(guide.getString("label"), c.tint, openGuide), style = rnText(14, 500).copy(textDecoration = TextDecoration.Underline), color = c.tint)
            Icon(GuideExternalLink, null, tint = c.tint, modifier = Modifier.size(14.dp))
        }
    }
}


internal fun guideLink(label: String, tint: Color, open: () -> Unit) =
    buildAnnotatedString { withLink(LinkAnnotation.Clickable("guide", TextLinkStyles(SpanStyle(color = tint))) { open() }) { append(label) } }


private val GettingStartedPlus = lucide("Plus", "M5 12h14", "M12 5v14")
private val GuideExternalLink = lucide("ExternalLink", "M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")
