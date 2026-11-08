package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.net.toUri
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Context
import android.content.Intent
import android.view.ContextThemeWrapper
import android.text.format.DateFormat
import org.json.JSONArray
import kotlinx.coroutines.delay
import org.json.JSONObject
import org.json.JSONTokener
import java.util.UUID


fun draftLiteral(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is String -> JSONObject.quote(value)
    else -> value.toString()
}

private fun draftValue(literal: String?): Any = JSONTokener(literal ?: "null").nextValue()


fun draftJson(values: Map<String, String?>): String =
    JSONObject().apply { values.forEach { (field, literal) -> put(field, draftValue(literal)) } }.toString()

private fun JSONArray.texts() = List(length()) { getString(it) }
private fun JSONArray.objects() = List(length()) { getJSONObject(it) }


data class EditorSection(val id: String, val titleKey: String?, val fields: List<String>, val filledCount: Int, val open: Boolean,

                         val help: JSONObject? = null)
data class EditorChoice(val id: String, val title: String)

data class SomedayChoice(val id: String, val title: String, val selected: Boolean, val viewSectionIds: String)


class EditorModel(val source: String) {
    private val root = JSONObject(source)
    private val reply = root.getJSONObject("model").also { check(it.getInt("version") == 1) { "Unsupported core contract" } }
    val id: String = reply.getString("id")
    val readOnly = reply.getBoolean("readOnly")
    val canPreserveChecklistOnRepeat = reply.optBoolean("canPreserveChecklistOnRepeat")

    val canCancel = reply.optBoolean("canCancel")
    val canSkipOccurrence = reply.optBoolean("canSkipOccurrence")
    val cancelLabel: String = reply.optString("cancelLabel")

    val scheduleBase: JSONObject? = reply.optJSONObject("scheduleBase")
    val recurrenceBase: JSONObject? = reply.optJSONObject("recurrenceBase")
    val focusStar: JSONObject = reply.getJSONObject("focusStar")

    val draft: Map<String, String> = reply.getJSONObject("draft").let { d -> d.keys().asSequence().associateWith { draftLiteral(d.get(it)) } }
    private val layout = reply.getJSONObject("layout")
    val sections = layout.getJSONArray("sections").objects().map {
        EditorSection(it.getString("id"), if (it.isNull("titleKey")) null else it.getString("titleKey"),
            it.getJSONArray("fields").texts(), it.getInt("filledCount"), it.getBoolean("open"), it.optJSONObject("help"))
    }
    val showSomedaySection = layout.getBoolean("showSomedaySection")
    val dailyInterval = layout.getJSONObject("recurrence").getInt("dailyInterval")
    val monthlyPattern: String = layout.getJSONObject("recurrence").getString("monthlyPattern")
    private val options = reply.getJSONObject("options")
    val statuses = options.getJSONArray("statuses").texts()
    val priorities = options.getJSONArray("priorities").texts()
    val energyLevels = options.getJSONArray("energyLevels").texts()

    val recurrences = options.getJSONArray("recurrences").objects().map { it.getString("value") to it.getString("labelKey") }

    val timeEstimates = options.getJSONArray("timeEstimates").objects().map { it.getString("value") to it.getString("label") }
    val projects = options.getJSONArray("projects").objects().map { EditorChoice(it.getString("id"), it.getString("title")) }
    val deferredProjectIds = options.getJSONArray("projects").objects().filter { it.optBoolean("deferred") }.map { it.getString("id") }.toSet()
    val projectSections = options.getJSONArray("sections").objects().map { EditorChoice(it.getString("id"), it.getString("title")) }
    val areas = options.getJSONArray("areas").objects().map { EditorChoice(it.getString("id"), it.getString("name")) }
    val somedaySections = options.getJSONArray("somedaySections").objects().map {
        SomedayChoice(it.getString("id"), it.getString("title"), it.getBoolean("selected"), draftLiteral(it.opt("viewSectionIds")))
    }
    private val content = root.getJSONObject("content")

    val checklistBase: String = content.getJSONArray("checklistBase").toString()

    val attachmentsBase: String = content.optJSONArray("attachmentsBase")?.toString() ?: "[]"

    val taskRevision: String = content.optString("taskRevision")

    val checklistField: JSONObject? = root.optJSONObject("field")

    val fields = EditorFields(reply.getJSONObject("fields"))


    fun edited(model: JSONObject, field: JSONObject?) = of(model, content, field)

    companion object {
        fun of(model: JSONObject, content: JSONObject, field: JSONObject? = null) =
            EditorModel(JSONObject().put("model", model).put("content", content).apply { field?.let { put("field", it) } }.toString())
    }
}


fun sameAttachments(left: String, right: String): Boolean {
    val print = { text: String -> JSONArray(text).objects().map { listOf(it.getString("id"), it.optString("uri"), it.optString("title"), it.optString("deletedAt")) } }
    return print(left) == print(right)
}


fun sameChecklist(left: String, right: String): Boolean {
    val items = { text: String -> JSONArray(text).objects().map { Triple(it.getString("id"), it.getString("title"), it.getBoolean("isCompleted")) } }
    return items(left) == items(right)
}


data class PendingEdit(val seq: Long, val edit: String, val field: String?)


data class QuickDate(val label: String, val selected: Boolean, val value: String)


class DatePart(json: JSONObject) {
    val value: String = json.getString("value")
    val label: String = json.getString("label")
    val hasTime = json.getBoolean("hasTime")
    val dateOnly: String = json.getString("dateOnly")
    val pickerDate: String = json.getJSONObject("picker").getString("date")
    val pickerTime: String = json.getJSONObject("picker").getString("time")
    val quickDates = json.getJSONArray("quickDates").objects().map { QuickDate(it.getString("label"), it.getBoolean("selected"), it.getString("value")) }
}


class EditorFields(json: JSONObject) {
    val dates = listOf("startTime", "dueDate", "reviewAt").associateWith { DatePart(json.getJSONObject(it)) }

    val dateIssue: String = json.getString("dateIssue")

    val relativeStart: JSONObject? = json.optJSONObject("relativeStart")
    val recurrence: JSONObject = json.getJSONObject("recurrence")
    val reminders: JSONObject = json.getJSONObject("reminders")
    val timeEstimate: JSONObject = json.getJSONObject("timeEstimate")
    val timeSpent = json.getJSONObject("timeSpent").getBoolean("enabled")
}


const val CHECKLIST_ADD = "checklistAdd"


val TYPED_FIELDS = listOf("contexts", "tags", "assignedTo")


internal fun committedTokens(typed: String, shown: EditorSuggestions?): String? =
    shown?.takeIf { it.text == typed }?.draftValue?.takeIf { it != typed }


data class EditorSuggestions(val text: String, val draftValue: String, val matches: List<Pair<String, String>>, val quick: List<Triple<String, Boolean, String>>) {
    companion object {
        fun parse(text: String, json: JSONObject) = EditorSuggestions(text, json.getString("draftValue"),
            json.getJSONArray("matches").objects().map { it.getString("value") to it.getString("text") },
            json.getJSONArray("quick").objects().map { Triple(it.getString("value"), it.getBoolean("selected"), it.getString("text")) })
    }
}


data class TaskEditor(
    val model: EditorModel, val edited: Map<String, String>, val inputs: Map<String, String> = emptyMap(),
    val resolved: Map<String, String> = emptyMap(), val bases: Map<String, String> = emptyMap(), val waitingFor: String? = null,

    val view: EditorModel = model,

    val session: String = UUID.randomUUID().toString(),

    val pending: List<PendingEdit> = emptyList(),
    val nextSeq: Long = 1,
    val checklist: String? = null,
    val tab: String = "task",


    val attachments: String? = null,
    val attachmentsFrom: String? = null,


    val checklistFrom: String? = null,

    val checklistAdd: String = "",
) {
    val id get() = model.id
    val readOnly get() = model.readOnly
    private fun loaded(field: String) = model.draft[field] ?: "null"
    private fun base(field: String) = bases[field] ?: loaded(field)
    fun value(field: String): Any = draftValue(edited[field] ?: loaded(field))
    fun text(field: String) = value(field) as? String ?: ""
    fun flag(field: String) = value(field) == true

    val patch: Map<String, String?> get() = edited.filter { (field, literal) -> literal != base(field) }

    val base: Map<String, String?> get() = patch.keys.associateWith { base(it) }

    private fun withEdits(changes: Map<String, String>) =
        copy(edited = edited + changes, bases = bases + changes.keys.associateWith { base(it) })

    fun edit(changes: Map<String, Any?>) = withEdits(changes.mapValues { draftLiteral(it.value) })


    fun input(field: String) = inputs[field] ?: (draftValue(loaded(field)) as? String ?: "")

    fun unresolved(field: String) = input(field) != (resolved[field] ?: (draftValue(loaded(field)) as? String ?: ""))
    val waiting get() = TYPED_FIELDS.any(::unresolved)

    val checklistNow get() = checklist ?: model.checklistBase
    val checklistChanged get() = checklist != null && !sameChecklist(checklist, checklistFrom ?: model.checklistBase)

    val checklistSave: String get() = if (!checklistChanged) "" else
        JSONObject().put("base", JSONArray(checklistFrom ?: model.checklistBase)).put("value", JSONArray(checklistNow)).toString()

    val attachmentsNow get() = attachments ?: model.attachmentsBase
    val attachmentsChanged get() = attachments != null && !sameAttachments(attachments, attachmentsFrom ?: model.attachmentsBase)

    val attachmentsSave: String get() = if (!attachmentsChanged) "" else
        JSONObject().put("base", JSONArray(attachmentsFrom ?: model.attachmentsBase)).put("value", JSONArray(attachmentsNow)).toString()

    fun withAttachments(next: String) = copy(attachments = next, attachmentsFrom = attachmentsFrom ?: model.attachmentsBase)

    fun withChecklist(next: String?) = copy(checklist = next, checklistFrom = if (next == null) checklistFrom else checklistFrom ?: model.checklistBase)

    val dirty get() = patch.isNotEmpty() || waiting || checklistChanged || attachmentsChanged || checklistAdd.isNotBlank()


    fun closesOnNavigation(editsPending: Boolean, covered: Boolean) = readOnly || (!dirty && !editsPending && waitingFor == null && !covered)


    fun checklistAddQueued(): TaskEditor = checklistAdd.trim().takeIf { it.isNotEmpty() }?.let { title ->
        copy(checklistAdd = "").queued(JSONObject().put("checklist", JSONObject().put("kind", "append").put("title", title)).toString(), CHECKLIST_ADD)
    } ?: this


    fun refused(edit: PendingEdit): TaskEditor = copy(pending = pending.drop(1)).let { next ->
        if (edit.field != CHECKLIST_ADD || next.checklistAdd.isNotBlank()) next
        else next.copy(checklistAdd = JSONObject(edit.edit).getJSONObject("checklist").getString("title"))
    }

    fun typed(field: String, text: String) = copy(inputs = inputs + (field to text))


    val checklistStructurePending get() = pending.any { queued ->
        JSONObject(queued.edit).optJSONObject("checklist")?.let { checklist ->
            when (checklist.optString("kind")) {
                "move", "remove", "insertAfter", "add", "append" -> true
                "rename" -> checklist.optString("text").any { it == '\n' || it == '\r' }
                else -> false
            }
        } == true
    }


    fun queued(edit: String, field: String?): TaskEditor {
        val checklist = JSONObject(edit).optJSONObject("checklist")
        if (checklist != null && (checklist.has("index") || checklist.has("from")) && checklistStructurePending) return this
        return copy(pending = pending + PendingEdit(nextSeq, edit, field), nextSeq = nextSeq + 1)
    }

    fun pendingFor(field: String) = pending.any { it.field == field }


    fun fullDraft(): Map<String, String> = (model.draft.keys + edited.keys).associateWith { edited[it] ?: loaded(it) }


    fun viewed(reply: EditorModel, sent: Map<String, String>): TaskEditor {
        val current = fullDraft()
        val combined = (reply.draft.keys + current.keys).associateWith { field ->
            if ((current[field] ?: "null") != (sent[field] ?: "null")) current[field] ?: "null" else reply.draft[field] ?: "null"
        }
        return withEdits(combined.filter { (field, literal) -> literal != (edited[field] ?: loaded(field)) }).copy(view = reply)
    }


    fun resolve(field: String, text: String, draftValue: String) =
        if (field !in inputs || input(field) != text) this
        else withEdits(mapOf(field to draftLiteral(draftValue))).copy(resolved = resolved + (field to text))


    fun assignWaiting(person: String) =
        copy(inputs = inputs + ("assignedTo" to person), resolved = resolved + ("assignedTo" to person), waitingFor = null)


    fun reloaded(fresh: EditorModel, keepChecklist: Boolean = false): TaskEditor {
        val kept = { field: String -> (fresh.draft[field] ?: "null") == base(field) }

        val list = checklist?.takeIf { keepChecklist || sameChecklist(fresh.checklistBase, model.checklistBase) }


        return TaskEditor(fresh, edited.filterKeys(kept), inputs.filterKeys(kept), resolved.filterKeys(kept), waitingFor = waitingFor, view = view,
            checklist = list, tab = tab, attachments = attachments, attachmentsFrom = attachmentsFrom, checklistFrom = checklistFrom.takeIf { list != null },
            checklistAdd = checklistAdd)
    }


    fun state(): JSONObject = JSONObject().put("id", id).put("edited", JSONObject(edited)).put("bases", JSONObject(edited.keys.associateWith { base(it) }))
        .put("inputs", JSONObject(inputs)).put("resolved", JSONObject(resolved)).put("waitingFor", waitingFor ?: JSONObject.NULL)
        .put("edits", JSONArray().apply { pending.forEach { put(JSONObject().put("seq", it.seq).put("edit", it.edit).put("field", it.field ?: JSONObject.NULL)) } })
        .put("nextSeq", nextSeq).put("checklist", checklist ?: JSONObject.NULL).put("tab", tab)
        .put("attachments", attachments ?: JSONObject.NULL).put("attachmentsFrom", attachmentsFrom ?: JSONObject.NULL)
        .put("checklistFrom", checklistFrom ?: JSONObject.NULL)
        .put("checklistAdd", checklistAdd)

    companion object {
        fun open(model: EditorModel, tab: String) = TaskEditor(model, emptyMap(), tab = tab)


        fun restore(model: EditorModel, saved: JSONObject): TaskEditor {
            fun map(name: String) = saved.getJSONObject(name).let { m -> m.keys().asSequence().associateWith { m.getString(it) } }

            val edits = saved.optJSONArray("edits")?.objects().orEmpty().map {
                PendingEdit(it.getLong("seq"), it.getString("edit"), if (it.isNull("field")) null else it.getString("field"))
            }
            return TaskEditor(model, map("edited"), map("inputs"), map("resolved"), map("bases"),
                if (saved.isNull("waitingFor")) null else saved.getString("waitingFor"),
                pending = edits, nextSeq = saved.optLong("nextSeq", (edits.maxOfOrNull { it.seq } ?: 0) + 1),
                checklist = if (saved.isNull("checklist")) null else saved.optString("checklist").ifEmpty { null }, tab = saved.optString("tab", "task"),
                attachments = saved.optString("attachments").takeIf { saved.has("attachments") && !saved.isNull("attachments") },
                attachmentsFrom = saved.optString("attachmentsFrom").takeIf { saved.has("attachmentsFrom") && !saved.isNull("attachmentsFrom") },

                checklistFrom = saved.optString("checklistFrom").takeIf { saved.has("checklistFrom") && !saved.isNull("checklistFrom") },
                checklistAdd = saved.optString("checklistAdd"))
        }
    }
}


internal fun pickedDay(year: Int, month: Int, day: Int): String =
    "$year-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"


internal fun pickedTime(hour: Int, minute: Int) = "${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}"


internal val PROJECT_DATE_FIELDS = listOf(Triple("startDate", "taskEdit.startDateLabel", "Start"), Triple("dueDate", "taskEdit.dueDateLabel", "Due"),
    Triple("reviewAt", "projects.reviewAt", "Review"))

private val PICKER_DAY = Regex("""(\d{4})-(\d{2})-(\d{2})""")


internal fun pickerStart(coreDate: String?): Triple<Int, Int, Int>? =
    coreDate?.let { PICKER_DAY.matchEntire(it) }?.destructured?.let { (year, month, day) -> Triple(year.toInt(), month.toInt() - 1, day.toInt()) }


internal fun pickerClock(coreTime: String): Pair<Int, Int> =
    coreTime.split(":").mapNotNull { it.toIntOrNull() }.let { if (it.size == 2) it[0] to it[1] else 0 to 0 }


private val STATUS_ICONS = mapOf("inbox" to Lucide.Inbox, "next" to Lucide.ArrowRight, "waiting" to Lucide.CirclePause,
    "someday" to Lucide.CircleArrowUp, "reference" to Lucide.Book, "done" to Lucide.Check)
private val ENERGY_ICONS = mapOf("low" to Lucide.BatteryLow, "medium" to Lucide.BatteryMedium, "high" to Lucide.BatteryFull)


@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun TaskEditorScreen(model: InboxViewModel, editor: TaskEditor) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors


    val failed = failedAction != null
    val locked = busy || failed || editor.readOnly
    var confirmLeave by rememberSaveable { mutableStateOf(false) }

    var linkAfterLeave by rememberSaveable { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    var help by rememberSaveable { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf<String?>(null) }
    var destinationQuery by rememberSaveable(picker) { mutableStateOf("") }

    var formViewport by remember { mutableIntStateOf(0) }
    val checklistFormScroll = rememberScrollState()
    var checklistFormBounds by remember { mutableStateOf(Rect.Zero) }
    var checklistDragging by remember { mutableStateOf(false) }

    var pickDate by rememberSaveable { mutableStateOf<String?>(null) }
    var pickTime by rememberSaveable { mutableStateOf<String?>(null) }

    var descriptionExpanded by rememberSaveable(editor.id) { mutableStateOf(false) }

    val pickerOpen = picker != null || pickDate != null || pickTime != null || descriptionExpanded
    DisposableEffect(pickerOpen) { editorPickerOpen = pickerOpen; onDispose { editorPickerOpen = false } }

    val leave = { if (editor.readOnly || (!editor.dirty && !editsPending)) closeEditor() else confirmLeave = true }
    BackHandler(enabled = !failed) { if (!busy) leave() }


    val go = { target: JSONObject ->
        when (target.getString("kind")) {
            "project" -> { closeEditor(); menu.openProjects(target.getString("id")) }
            "task" -> { closeEditor(); openEditor(target.getString("id"), "view") }
            else -> { closeEditor(); menu.openContexts(target.getString("value")) }
        }
    }
    val follow = { target: JSONObject ->
        if (target.getString("kind") == "external") {
            openExternalLink(context, target.getString("href"), ::t) { outcome -> anyTime({ it.logLinkHandoff(outcome, "markdown") }, {}) }
        }
        else if (editor.readOnly || (!editor.dirty && !editsPending)) go(target)
        else { linkAfterLeave = target.toString(); confirmLeave = true }
        Unit
    }

    LaunchedEffect(busy, failed) { if (!busy && !failed) pumpEdits() }

    LaunchedEffect(editor.id, busy, failed) { if (!busy && !failed) TYPED_FIELDS.forEach { suggest(it, editor.input(it)) } }

    val aiDraft = editor.fullDraft().toString()
    LaunchedEffect(editor.session, aiDraft, busy) { if (!busy) { delay(150); ai.readEditor() } }

    Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("task-editor")) {


        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).background(c.cardBg).rnBorderBottom(c.border).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (!editor.readOnly) {
                val closeLabel = t("common.close")
                Box(Modifier.size(44.dp).clickable(enabled = !busy && !failed, role = Role.Button, onClick = leave)
                    .semantics { contentDescription = closeLabel }, contentAlignment = Alignment.CenterStart) {
                    Icon(Lucide.X, null, tint = c.tint, modifier = Modifier.size(22.dp).fade(if (!busy && !failed) 1f else 0.5f))
                }

                Spacer(Modifier.width(1.dp))
            }

            EditorMoreButton(model, editor)
            Spacer(Modifier.weight(1f))

            val saveEnabled = if (editor.readOnly) true else writable && !busy &&
                (failedAction == null || failedAction == saveDraftAction(editor))
            Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp)
                .clickable(enabled = saveEnabled, role = Role.Button) { if (editor.readOnly) closeEditor() else saveEditor() },
                contentAlignment = Alignment.CenterEnd) {
                Text(t(if (editor.readOnly) "common.close" else "common.save"), style = rnText(18, 700), color = c.tint,
                    modifier = Modifier.fade(if (saveEnabled) 1f else 0.5f))
            }
        }

        error?.let { message ->

            FailureBanner(message) {
                if (conflict) RetryButton(model::reloadEditor, !busy && !failed && !editsPending)
                else OwedRetry(model)
            }
        }

        if (!editor.readOnly) EditorTabs(model, editor)
        if (editor.readOnly || editor.tab == "view") TaskViewTab(model, editor, locked, { picker = "status" }, follow, Modifier.weight(1f))
        else Column(Modifier.weight(1f).imePadding().onSizeChanged { formViewport = it.height }
            .onGloballyPositioned { checklistFormBounds = it.boundsInWindow() }
            .verticalScroll(checklistFormScroll, enabled = !checklistDragging).padding(20.dp)) {
            CompositionLocalProvider(LocalFormViewport provides formViewport,
                LocalChecklistFormScroll provides ChecklistFormScroll(checklistFormScroll, checklistFormBounds) { checklistDragging = it }) {
                if (editor.readOnly) Text(t("projects.archivedReadOnlyHint"), style = rnText(14, 400), color = c.secondaryText,
                    modifier = Modifier.padding(bottom = 16.dp))
                FormGroup {
                    Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        FieldHeading(Lucide.Type, t("taskEdit.titleLabel"), Modifier.weight(1f), bottom = 0)

                        if (!editor.readOnly && editor.text("status") != "archived") {
                            val focused = editor.flag("focusedToday")
                            val star = editor.view.focusStar
                            val blocked = star.optString("blockedText").takeIf { it.isNotEmpty() && it != "null" }
                            val starEnabled = !locked && (focused || star.getBoolean("canToggle"))
                            val actionLabel = t(if (focused) "agenda.removeFromFocus" else "agenda.addToFocus")
                            val starLabel = blocked ?: if (star.getBoolean("queued")) {
                                if (focused) "$actionLabel. ${t("agenda.focusWhenAvailable")}" else t("agenda.focusWhenAvailable")
                            } else actionLabel
                            Box(Modifier.padding(end = 12.dp).size(28.dp).clip(RoundedCornerShape(7.dp)).background(c.filterBg).rnBorder(1.dp, c.border, RoundedCornerShape(7.dp))
                                .clickable(enabled = starEnabled, role = Role.Button) { editFields(mapOf("focusedToday" to !focused)) }
                                .semantics { contentDescription = starLabel; selected = focused; if (!starEnabled) disabled() }
                                .testTag("task-edit-focus-star"), contentAlignment = Alignment.Center) {
                                FocusStar(focused, !starEnabled, 18, Modifier)
                            }
                        }
                        val helpLabel = t("taskEdit.editorLayoutHelpLabel")
                        Box(Modifier.size(28.dp).clip(RoundedCornerShape(7.dp)).background(c.filterBg).rnBorder(1.dp, c.border, RoundedCornerShape(7.dp))
                            .clickable(role = Role.Button) { help = true }.semantics { contentDescription = helpLabel }, contentAlignment = Alignment.Center) {
                            Icon(Lucide.CircleHelp, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
                        }
                    }

                    EditorInput(editor.text("title"), { editText("title", it.replace(Regex("[\r\n]+"), " ")) }, null, !locked)
                }

                EditorAIRows(model, locked)

                val destination = editor.view.sections.flatMap { it.fields }.firstOrNull { it == "project" || it == "area" }
                val field = @Composable { id: String -> EditorField(model, editor, id, locked, id == destination, { picker = it }, { pickDate = it }, { pickTime = it },
                    { descriptionExpanded = true }, follow) }
                for (section in editor.view.sections) {
                    if (section.titleKey == null) {
                        section.fields.forEach { field(it) }
                        if (editor.view.showSomedaySection) SomedaySections(model, editor, locked)
                    } else {
                        CollapsibleSection(editor.id, section) { section.fields.forEach { field(it) } }
                    }
                }
                Spacer(Modifier.heightIn(min = 100.dp))
            }
        }
    }

    when (picker) {
        "destination" -> PickerDialog(t("task.destination"), { picker = null }, search = {
            ModalInput(destinationQuery, t("common.search"), t("task.destination"), Modifier.testTag("editor-destination-search")) { destinationQuery = it }
        }) {
            PickerItem(t("common.none")) { editFields(mapOf("projectId" to "", "areaId" to "")); picker = null }

            val query = destinationQuery.trim().lowercase()
            val projects = editor.view.projects.filter { query.isEmpty() || it.title.trim().lowercase().contains(query) }
            val areas = editor.view.areas.filter { query.isEmpty() || it.title.lowercase().contains(query) }
            val (deferred, active) = projects.partition { it.id in editor.view.deferredProjectIds }
            PickerHeading(t("nav.projects"))
            for (project in active) PickerItem(project.title, "destination-project") { editFields(mapOf("projectId" to project.id)); picker = null }
            if (deferred.isNotEmpty()) PickerHeading(t("projects.deferredSection"))
            for (project in deferred) PickerItem(project.title, "destination-project") { editFields(mapOf("projectId" to project.id)); picker = null }
            PickerHeading(t("taskEdit.areaLabel"))
            for (area in areas) PickerItem(area.title) { editFields(mapOf("projectId" to "", "areaId" to area.id)); picker = null }
            if (projects.isEmpty() && areas.isEmpty()) Text(t("common.noMatches"), style = rnText(16, 400), color = LocalTheme.current.colors.secondaryText,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp).semantics { liveRegion = LiveRegionMode.Polite })
        }

        "status" -> PickerDialog(t("taskEdit.statusLabel"), { picker = null }) {
            for (status in editor.view.statuses) PickerItem(t("status.$status")) {
                picker = null
                if (status == "waiting" && editor.text("status") != status) openWaitingPrompt() else editFields(mapOf("status" to status))
            }
        }
        "section" -> PickerDialog(t("taskEdit.sectionLabel"), { picker = null }) {
            PickerItem(t("taskEdit.noSectionOption")) { editFields(mapOf("sectionId" to "")); picker = null }
            for (section in editor.view.projectSections) PickerItem(section.title) { editFields(mapOf("sectionId" to section.id)); picker = null }
        }
        MONTHLY_CUSTOM -> MonthlyCustomDialog(model, editor, locked) { picker = null }
    }

    if (descriptionExpanded && !editor.readOnly) DescriptionFullscreen(model, editor, locked, follow) { descriptionExpanded = false }
    pickDate?.let { target ->

        val start = if (target == "until") editor.view.fields.recurrence.getString("until") else editor.view.fields.dates.getValue(target).pickerDate
        DayPickerDialog(start, { pickDate = null }) { day ->

            editDraft(if (target == "until") recurrenceEdit(JSONObject().put("kind", "until").put("date", day))
                else JSONObject().put("type", "pickDate").put("field", target).put("date", day))
        }
    }
    pickTime?.let { target ->

        val (hour, minute) = pickerClock(editor.view.fields.dates.getValue(target).pickerTime)
        ClockPickerDialog(hour, minute, { pickTime = null }) { time -> editDraft(JSONObject().put("type", "pickTime").put("field", target).put("time", time)) }
    }

    if (editor.waitingFor != null) WaitingPrompt(model, editor.waitingFor, locked)
    AIOverlays(model)

    if (help) AlertDialog(
        onDismissRequest = { help = false },
        title = { Text(t("taskEdit.editorLayoutHelpLabel")) },
        text = { Text(t("taskEdit.editorLayoutHelpText")) },
        confirmButton = { TextButton(onClick = { help = false }) { Text(t("common.ok")) } },
    )

    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text(t("taskEdit.discardChanges")) },
            text = { Text(t("taskEdit.discardChangesDesc")) },
            confirmButton = { TextButton(onClick = { confirmLeave = false; linkAfterLeave = null; saveEditor() }) { Text(t("common.save")) } },
            dismissButton = {
                Row {
                    TextButton(onClick = { confirmLeave = false; linkAfterLeave = null }) { Text(t("common.cancel")) }
                    TextButton(onClick = {
                        confirmLeave = false
                        val link = linkAfterLeave?.let(::JSONObject)
                        linkAfterLeave = null
                        if (link != null) go(link) else closeEditor()
                    }) { Text(t("common.discard")) }
                }
            },
        )
    }
}


internal fun systemDialogContext(context: Context, dark: Boolean): Context =
    ContextThemeWrapper(context, if (dark) android.R.style.Theme_Material_NoActionBar else android.R.style.Theme_Material_Light_NoActionBar)


@Composable
fun DayPickerDialog(start: String?, dismiss: () -> Unit, pick: (String) -> Unit) {
    val context = LocalContext.current
    val dark = LocalTheme.current.isDark
    val picked by rememberUpdatedState(pick)
    val dismissed by rememberUpdatedState(dismiss)
    DisposableEffect(start, dark) {
        val dialog = DatePickerDialog(systemDialogContext(context, dark))
        pickerStart(start)?.let { (year, month, day) -> dialog.updateDate(year, month, day) }
        dialog.setOnDateSetListener { _, year, month, day -> picked(pickedDay(year, month, day)) }
        dialog.setOnDismissListener { dismissed() }
        dialog.show()

        onDispose { dialog.setOnDismissListener(null); dialog.dismiss() }
    }
}


@Composable
fun ClockPickerDialog(hour: Int, minute: Int, dismiss: () -> Unit, pick: (String) -> Unit) {
    val context = LocalContext.current
    val dark = LocalTheme.current.isDark
    val picked by rememberUpdatedState(pick)
    val dismissed by rememberUpdatedState(dismiss)
    DisposableEffect(hour, minute, dark) {
        val dialog = TimePickerDialog(systemDialogContext(context, dark), { _, hour, minute -> picked(pickedTime(hour, minute)) }, hour, minute, DateFormat.is24HourFormat(context))
        dialog.setOnDismissListener { dismissed() }
        dialog.show()
        onDispose { dialog.setOnDismissListener(null); dialog.dismiss() }
    }
}


private fun recurrenceEdit(edit: JSONObject) = JSONObject().put("type", "recurrence").put("edit", edit)


private fun InboxViewModel.setDate(field: String, value: String) =
    editDraft(JSONObject().put("type", "date").put("field", field).put("value", value))


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditorField(model: InboxViewModel, editor: TaskEditor, id: String, locked: Boolean, destination: Boolean,
                        openPicker: (String) -> Unit, pickDate: (String) -> Unit, pickTime: (String) -> Unit,
                        expandDescription: () -> Unit, follow: (JSONObject) -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    when (id) {
        "status" -> FormGroup {
            FieldHeading(Lucide.ListTodo, t("taskEdit.statusLabel"))
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
                maxItemsInEachRow = 3) {
                for (status in editor.view.statuses) {
                    val active = editor.text("status") == status

                    val choose = { if (status == "waiting" && !active) openWaitingPrompt() else editFields(mapOf("status" to status)) }

                    val backdate = if (status == "done") t("task.completeBackdateHintMobile") to { completedAt.openEditor() } else null
                    Chip(active, !locked, "${t("taskEdit.statusLabel")}: ${t("status.$status")}", choose,
                        Modifier.weight(1f), RoundedCornerShape(14.dp), compact = true, longPress = backdate) { color ->
                        Icon(STATUS_ICONS[status] ?: Lucide.CircleDot, null, tint = color, modifier = Modifier.size(14.dp))
                        Text(t("status.$status"), style = rnText(13, 600), color = color, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(start = 6.dp))
                    }
                }
            }
        }
        "project", "area" -> if (destination) FormGroup {
            val project = editor.text("projectId")
            val area = editor.text("areaId")
            val value = when {
                project.isNotEmpty() -> editor.view.projects.firstOrNull { it.id == project }?.title ?: t("taskEdit.noProjectOption")
                area.isNotEmpty() -> editor.view.areas.firstOrNull { it.id == area }?.title ?: t("taskEdit.noAreaOption")
                else -> t("common.none")
            }
            FieldHeading(Lucide.Folder, t("task.destination"))
            DateButton(value, t("task.destination"), !locked, Modifier.fillMaxWidth()) { openPicker("destination") }
        }
        "section" -> if (editor.text("projectId").isNotEmpty()) FormGroup {
            FieldHeading(Lucide.Layers, t("taskEdit.sectionLabel"))

            val section = editor.view.projectSections.firstOrNull { it.id == editor.text("sectionId") }
            Row(verticalAlignment = Alignment.CenterVertically) {
                DateButton(section?.title ?: t("taskEdit.noSectionOption"), t("taskEdit.sectionLabel"), !locked, Modifier.weight(1f)) { openPicker("section") }
                if (editor.text("sectionId").isNotEmpty()) SmallButton(Lucide.X, "${t("common.clear")} ${t("taskEdit.sectionLabel")}", !locked) {
                    editFields(mapOf("sectionId" to ""))
                }
            }
        }
        "priority" -> FormGroup {
            FieldHeading(Lucide.Flag, t("taskEdit.priorityLabel"))
            ChoiceChips(editor, "priority", editor.view.priorities, !locked, t("taskEdit.priorityLabel"), { t("priority.$it") }) { value, color ->
                Icon(Lucide.Flag, null, tint = LocalTheme.current.priority(value) ?: color, modifier = Modifier.size(12.dp))
            }
        }
        "energyLevel" -> FormGroup {
            FieldHeading(Lucide.BatteryCharging, t("taskEdit.energyLevel"))
            ChoiceChips(editor, "energyLevel", editor.view.energyLevels, !locked, t("taskEdit.energyLevel"), { t("energyLevel.$it") }) { value, color ->
                Icon(ENERGY_ICONS[value] ?: Lucide.BatteryMedium, null, tint = color, modifier = Modifier.size(14.dp))
            }
        }
        "timeEstimate" -> FormGroup {
            FieldHeading(Lucide.Hourglass, t("taskEdit.timeEstimateLabel"))
            val current = editor.text("timeEstimate")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((value, label) in editor.view.timeEstimates) {
                    Chip(current == value, !locked, "${t("taskEdit.timeEstimateLabel")}: $label", { editFields(mapOf("timeEstimate" to value)) }) { color ->
                        if (value.isEmpty()) Icon(Lucide.CircleSlash, null, tint = color, modifier = Modifier.size(16.dp))
                        else Text(label, style = rnText(14, 400), color = color)
                    }
                }
                val estimate = editor.view.fields.timeEstimate
                val customLabel = estimate.getString("customLabel")
                Chip(estimate.getBoolean("customSelected"), !locked, "${t("taskEdit.timeEstimateLabel")}: $customLabel",
                    { editFields(mapOf("timeEstimate" to estimate.getString("customValue"))) }) { color ->
                    Text(customLabel, style = rnText(14, 400), color = color)
                }
            }
            val estimate = editor.view.fields.timeEstimate
            if (estimate.getBoolean("customSelected")) {

                TypedInput(estimate.getString("customText"), "${t("taskEdit.timeEstimateLabel")}: ${estimate.getString("customLabel")}", !locked,
                    editor.pendingFor("timeEstimate")) { editDraft(JSONObject().put("type", "timeEstimate").put("text", it), "timeEstimate") }
            }
            if (editor.view.fields.timeSpent) {
                FieldHeading(Lucide.History, t("taskEdit.timeSpentLabel"), Modifier.padding(top = 12.dp))
                val spent = (editor.value("timeSpentMinutes") as? Number)?.toInt()?.toString() ?: ""
                TypedInput(spent, t("taskEdit.timeSpentLabel"), !locked, editor.pendingFor("timeSpent")) {
                    editDraft(JSONObject().put("type", "timeSpent").put("text", it), "timeSpent")
                }
            }
        }
        "contexts", "tags" -> FormGroup {
            val contexts = id == "contexts"
            val label = t(if (contexts) "taskEdit.contextsLabel" else "taskEdit.tagsLabel")
            FieldHeading(if (contexts) Lucide.AtSign else Lucide.Tag, label)
            EditorInput(editor.input(id), { editInput(id, it) }, t(if (contexts) "taskEdit.contextsPlaceholder" else "taskEdit.tagsPlaceholder"),
                !locked, singleLine = true, description = label, tag = "editor-$id",
                commit = { committedTokens(editor.input(id), suggestions[id])?.let { editInput(id, it) } })
            val shown = suggestions[id]?.takeIf { it.text == editor.input(id) }
            if (shown != null && shown.matches.isNotEmpty()) SuggestionMenu(shown.matches, !locked) { editInput(id, it) }
            if (shown != null && shown.quick.isNotEmpty()) FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((token, selected, text) in shown.quick) {
                    Chip(selected, !locked, token, { editInput(id, text) }, shape = RoundedCornerShape(14.dp), horizontal = 10, toggle = true) { color ->
                        Text(token, style = rnText(13, 500), color = color)
                    }
                }
            }
        }
        "assignedTo" -> FormGroup {
            FieldHeading(Lucide.User, t("taskEdit.assignedTo"))
            EditorInput(editor.input(id), { editInput(id, it) }, t("taskEdit.assignedToPlaceholder"), !locked, description = t("taskEdit.assignedTo"))
            val shown = suggestions[id]?.takeIf { it.text == editor.input(id) }
            if (shown != null && shown.matches.isNotEmpty()) SuggestionMenu(shown.matches, !locked) { editInput(id, it) }
        }
        "location" -> FormGroup {
            FieldHeading(Lucide.Navigation, t("taskEdit.locationLabel"))
            EditorInput(editor.text("location"), { editText("location", it) }, t("taskEdit.locationPlaceholder"), !locked, description = t("taskEdit.locationLabel"))
        }
        "description" -> FormGroup {


            var previewing by rememberSaveable(editor.id) { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                FieldHeading(Lucide.AlignLeft, t("taskEdit.descriptionLabel"), Modifier.weight(1f), bottom = 0)
                Box(Modifier.offset(x = 10.dp).size(66.dp, 38.dp)) {
                    val previewLabel = t(if (previewing) "markdown.edit" else "markdown.preview")
                    Box(Modifier.align(Alignment.CenterStart).size(38.dp).clickable(role = Role.Button) { previewing = !previewing }
                        .semantics { contentDescription = previewLabel }, contentAlignment = Alignment.Center) {
                        Icon(if (previewing) Lucide.Pencil else Lucide.Eye, null, tint = c.tint, modifier = Modifier.size(18.dp))
                    }
                    val expandLabel = t("markdown.expand")
                    Box(Modifier.align(Alignment.CenterEnd).size(40.dp).clickable(enabled = !editor.readOnly, role = Role.Button, onClick = expandDescription)
                        .semantics { contentDescription = expandLabel }, contentAlignment = Alignment.Center) {
                        Icon(Ionicons.ExpandOutline, null, tint = c.tint, modifier = Modifier.size(20.dp))
                    }
                }
            }
            if (previewing) DescriptionPreview(model, editor, follow, Modifier.fillMaxWidth())
            else EditorInput(editor.text("description"), { editText("description", it) }, t("taskEdit.descriptionPlaceholder"), !locked,
                singleLine = false, minHeight = 100, description = t("taskEdit.descriptionLabel"))
        }
        "dueDate", "startTime", "reviewAt" -> FormGroup {
            val part = editor.view.fields.dates.getValue(id)
            val label = t(when (id) { "dueDate" -> "taskEdit.dueDateLabel"; "startTime" -> "taskEdit.startDateLabel"; else -> "taskEdit.reviewDateLabel" })
            val icon = when (id) { "dueDate" -> Lucide.CalendarDays; "startTime" -> Lucide.Calendar; else -> Lucide.CalendarClock }
            FieldHeading(icon, label)

            Row(verticalAlignment = Alignment.CenterVertically) {
                DateButton(part.label, label, !locked, Modifier.weight(1f)) { pickDate(id) }
                if (part.value.isNotEmpty()) {
                    SmallButton(Lucide.Clock, "${t("calendar.changeTime")} $label", !locked) { pickTime(id) }
                    if (part.hasTime) SmallTextButton(t("taskEdit.dateOnly"), "${t("taskEdit.dateOnly")} $label", !locked) { setDate(id, part.dateOnly) }
                    SmallButton(Lucide.CalendarX, "${t("common.clear")} $label", !locked) { setDate(id, "") }
                }
            }
            QuickDateChips(label, part.quickDates, !locked) { setDate(id, it) }
            if (id != "reviewAt" && editor.view.fields.dateIssue.isNotEmpty()) {
                Text(editor.view.fields.dateIssue, style = rnText(12, 600), color = c.warning, modifier = Modifier.padding(top = 8.dp))
            }
            if (id == "startTime") editor.view.fields.relativeStart?.let { RelativeStart(model, editor, it, locked) }
            if (id == "dueDate") Reminders(model, editor, locked)
        }
        "recurrence" -> FormGroup {
            FieldHeading(Lucide.Repeat, t("taskEdit.recurrenceLabel"))
            RecurrenceField(model, editor, locked, pickDate, openPicker)
        }

        "checklist" -> ChecklistField(model, editor, locked)

        "attachments" -> FormGroup {
            FieldHeading(Lucide.Paperclip, t("attachments.title"))
            EditorAttachments(model, editor, locked)
        }
        else -> Unit
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun QuickDateChips(fieldLabel: String, chips: List<QuickDate>, enabled: Boolean, minHeight: Int = 34, choose: (String) -> Unit) {
    val c = LocalTheme.current.colors
    FlowRow(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (chip in chips) {
            val shape = RoundedCornerShape(999.dp)
            Box(Modifier.weight(1f).widthIn(min = 92.dp).heightIn(min = minHeight.dp).clip(shape).background(if (chip.selected) c.tint else c.filterBg)
                .rnBorder(1.dp, if (chip.selected) c.tint else c.border, shape)
                .semantics { contentDescription = "$fieldLabel: ${chip.label}" }
                .selectable(selected = chip.selected, enabled = enabled, role = Role.Tab) { choose(chip.value) }
                .padding(horizontal = 10.dp, vertical = 7.dp), contentAlignment = Alignment.Center) {
                Text(chip.label, style = rnText(12, 600), color = if (chip.selected) c.onTint else c.secondaryText, textAlign = TextAlign.Center, maxLines = 2)
            }
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RelativeStart(model: InboxViewModel, editor: TaskEditor, state: JSONObject, locked: Boolean) = with(model) {
    val c = LocalTheme.current.colors
    val active = state.getBoolean("active")
    val amount = state.getInt("amount")
    val unit = state.getString("unit")
    Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Chip(!active, !locked, t("taskEdit.startModeAbsolute"), { editFields(mapOf("relativeStartOffset" to null)) }) { color ->
            Text(t("taskEdit.startModeAbsolute"), style = rnText(14, 400), color = color)
        }
        Chip(active, !locked, t("taskEdit.startModeRelative"), { relativeStart(null, null) }) { color ->
            Text(t("taskEdit.startModeRelative"), style = rnText(14, 400), color = color)
        }
    }
    if (active) {
        Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.widthIn(min = 74.dp, max = 74.dp)) { TypedInput("$amount", t("taskEdit.relativeStartAmount"), !locked, editor.pendingFor(RELATIVE_AMOUNT)) { relativeStart(it, null) } }
            Text(t("taskEdit.relativeStartBeforeDue"), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(start = 8.dp))
        }
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in state.getJSONArray("units").objects()) {
                val value = option.getString("unit")
                val unitLabel = option.getString("label")
                Chip(value == unit, !locked, unitLabel, { relativeStart(null, value) }) { color ->
                    Text(unitLabel, style = rnText(14, 400), color = color)
                }
            }
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Reminders(model: InboxViewModel, editor: TaskEditor, locked: Boolean) = with(model) {
    val c = LocalTheme.current.colors
    val reminders = editor.view.fields.reminders
    if (reminders.getBoolean("showSkip")) {
        Text(reminders.getString("policyLabel"), style = rnText(13, 600), color = c.text, modifier = Modifier.padding(top = 8.dp))
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in reminders.getJSONArray("policyOptions").objects()) {
                val label = option.getString("label")
                Chip(option.getBoolean("selected"), !locked, label, {
                    editFields(mapOf("reminderPolicy" to option.getString("value")))
                }) { color -> Text(label, style = rnText(14, 400), color = color) }
            }
        }
        Text(reminders.getString("hint"), style = rnText(12, 400, 16), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
        if (!reminders.isNull("disabledHint")) Text(reminders.getString("disabledHint"), style = rnText(12, 400, 16), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
    }
    reminders.optJSONObject("startAdvance")?.let { start ->
        var startExpanded by rememberSaveable(editor.id) { mutableStateOf(false) }
        val enabled = start.getBoolean("enabled")
        val label = start.getString("label")
        TextButton(enabled = !locked && enabled, onClick = { startExpanded = !startExpanded }) {
            Text("$label: ${start.getString("valueLabel")}", style = rnText(13, 600))
        }
        if (!start.isNull("hint")) Text(start.getString("hint"), style = rnText(12, 400, 16), color = c.secondaryText)
        if (enabled && startExpanded) FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (option in start.getJSONArray("options").objects()) {
                val text = option.getString("label")
                Chip(option.getBoolean("selected"), !locked, text, {
                    editFields(mapOf("startReminderLeadMinutes" to option.getInt("value")))
                    startExpanded = false
                }) { color -> Text(text, style = rnText(14, 400), color = color) }
            }
        }
    }
    if (!reminders.getBoolean("showSkip") && editor.text("dueDate").isEmpty() && ((editor.value("dueReminderLeadMinutes") as? Number)?.toInt() ?: 0) == 0) return
    var advanceExpanded by rememberSaveable(editor.id) { mutableStateOf(false) }
    val advanceEnabled = reminders.getBoolean("showAdvance")
    val advanceLabel = reminders.getString("advanceLabel")
    val advanceValue = reminders.getString("advanceValueLabel")
    TextButton(enabled = !locked && advanceEnabled, onClick = { advanceExpanded = !advanceExpanded }) {
        Text("$advanceLabel: $advanceValue", style = rnText(13, 600))
    }
    if (!reminders.isNull("advanceHint")) Text(reminders.getString("advanceHint"), style = rnText(12, 400, 16), color = c.secondaryText)
    if (advanceEnabled && advanceExpanded) FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in reminders.getJSONArray("advanceOptions").objects()) {
            val text = option.getString("label")
            Chip(option.getBoolean("selected"), !locked, text, {
                editFields(mapOf("dueReminderLeadMinutes" to option.getInt("value")))
                advanceExpanded = false
            }) { color -> Text(text, style = rnText(14, 400), color = color) }
        }
    }
    if (!reminders.getBoolean("showRepeat")) return
    var expanded by rememberSaveable(editor.id) { mutableStateOf(false) }
    val options = reminders.getJSONArray("repeatOptions").objects()
    val on = options.any { it.getBoolean("selected") && !it.isNull("value") }
    val label = reminders.getString("repeatLabel")
    val value = reminders.getString("repeatValueLabel")
    val shape = RoundedCornerShape(10.dp)
    Row(Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(if (on) c.filterBg else c.cardBg)
        .rnBorder(1.dp, if (expanded || on) c.tint else c.border, shape)
        .clickable(enabled = !locked, role = Role.Button) { expanded = !expanded }.semantics { contentDescription = "$label: $value" }
        .padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = rnText(13, 600), color = c.text, modifier = Modifier.weight(1f), maxLines = 1)
        Text(value, style = rnText(13, 400), color = if (on) c.tint else c.secondaryText, maxLines = 1)
    }
    if (expanded) FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in options) {
            val text = option.getString("label")
            Chip(option.getBoolean("selected"), !locked, text, {
                editFields(mapOf("repeatReminderMinutes" to (if (option.isNull("value")) null else option.getInt("value"))))
                expanded = false
            }) { color -> Text(text, style = rnText(14, 400), color = color) }
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecurrenceField(model: InboxViewModel, editor: TaskEditor, locked: Boolean, pickDate: (String) -> Unit, openPicker: (String) -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    val rule = editor.text("recurrence")
    val details = editor.view.fields.recurrence
    val edit = { recurrence: JSONObject -> editDraft(recurrenceEdit(recurrence)) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, key) in editor.view.recurrences) {

            Chip(rule == value, !locked, "${t("taskEdit.recurrenceLabel")}: ${t(key)}", {
                if (value != rule) edit(JSONObject().put("kind", "rule").put("rule", value))
            }) { color -> Text(t(key), style = rnText(14, 400), color = color) }
        }
    }
    if (rule.isEmpty()) return
    val unit = when (rule) { "daily" -> "recurrence.dayUnit"; "weekly" -> "recurrence.weekUnit"; "monthly" -> "recurrence.monthUnit"; else -> "recurrence.yearUnit" }
    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(t("recurrence.repeatEvery"), style = rnText(13, 600), color = c.secondaryText)
        Box(Modifier.padding(horizontal = 8.dp).widthIn(min = 64.dp, max = 80.dp)) {
            TypedInput("${details.getInt("interval")}", t("recurrence.repeatEvery"), !locked, editor.pendingFor("interval")) {
                editDraft(recurrenceEdit(JSONObject().put("kind", "interval").put("text", it)), "interval")
            }
        }
        Text(t(unit), style = rnText(13, 600), color = c.secondaryText)
    }
    if (rule == "weekly") Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for (day in details.getJSONArray("weekdays").objects()) {
            val on = day.getBoolean("selected")
            val short = day.getString("label")
            val long = day.getString("longLabel")
            Box(Modifier.size(44.dp).clip(CircleShape).background(if (on) c.tint else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, CircleShape)
                .semantics { contentDescription = long }
                .toggleable(value = on, enabled = !locked, role = Role.Checkbox) { edit(JSONObject().put("kind", "weekday").put("day", day.getString("day"))) },
                contentAlignment = Alignment.Center) {
                Text(short, style = rnText(12, 600), color = if (on) c.onTint else c.text)
            }
        }
    }
    if (rule == "monthly") Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val custom = editor.view.monthlyPattern == "custom"
        Chip(!custom, !locked, t("recurrence.monthlyOnDay"), { edit(JSONObject().put("kind", "monthlyOnDay")) }) { color ->
            Text(t("recurrence.monthlyOnDay"), style = rnText(14, 400), color = color)
        }

        Chip(custom, !locked, t("recurrence.custom"), { openPicker(MONTHLY_CUSTOM) }) { color -> Text(t("recurrence.custom"), style = rnText(14, 400), color = color) }
    }
    Text(t("recurrence.endsLabel"), style = rnText(13, 600), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
    val ends = details.getString("ends")
    FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((mode, key) in listOf("never" to "recurrence.endsNever", "until" to "recurrence.endsOnDate", "count" to "recurrence.endsAfterCount")) {
            Chip(ends == mode, !locked, t(key), {
                edit(JSONObject().put("kind", "ends").put("ends", mode))
                if (mode == "until") pickDate("until")
            }) { color -> Text(t(key), style = rnText(14, 400), color = color) }
        }
    }
    if (ends == "until") Box(Modifier.padding(top = 8.dp)) {
        DateButton(details.getString("untilLabel"), t("recurrence.endsOnDate"), !locked, Modifier.fillMaxWidth()) { pickDate("until") }
    }
    if (ends == "count") Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.widthIn(min = 64.dp, max = 80.dp)) {
            TypedInput("${details.getInt("count")}", t("recurrence.endsAfterCount"), !locked, editor.pendingFor("count")) {
                editDraft(recurrenceEdit(JSONObject().put("kind", "count").put("text", it)), "count")
            }
        }
        Text(t("recurrence.occurrenceUnit"), style = rnText(13, 600), color = c.secondaryText, modifier = Modifier.padding(start = 8.dp))
    }
    val fluid = editor.text("recurrenceStrategy") == "fluid"
    Row(Modifier.padding(top = 8.dp)) {
        Chip(fluid, !locked, t("recurrence.afterCompletion"), { edit(JSONObject().put("kind", "strategy")) }, toggle = true) { color ->
            Text(t("recurrence.afterCompletion"), style = rnText(14, 400), color = color)
        }
    }
    val future = editor.flag("showFutureRecurrence")
    SwitchRow(t("recurrence.showFutureInCalendar"), t("recurrence.showFutureInCalendarHint"), future, !locked) {
        editFields(mapOf("showFutureRecurrence" to !future))
    }
}


@Composable
private fun TypedInput(coreValue: String, description: String, enabled: Boolean, pending: Boolean, send: (String) -> Unit) {


    var text by remember { mutableStateOf(coreValue) }
    LaunchedEffect(coreValue) { if (!pending) text = coreValue }
    EditorInput(text, { text = it; send(it) }, null, enabled, singleLine = true, description = description)
}


@Composable
private fun SmallTextButton(text: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.padding(start = 8.dp).heightIn(min = 44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Box(Modifier.clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(horizontal = 10.dp, vertical = 8.dp)) {
            Text(text, style = rnText(12, 600), color = c.secondaryText)
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SomedaySections(model: InboxViewModel, editor: TaskEditor, locked: Boolean) = with(model) {
    val current = draftValue(editor.edited["viewSectionIds"] ?: "null").toString()
    FormGroup {
        Text(t("viewSections.somedaySection").uppercase(), style = rnText(14, 400), color = LocalTheme.current.colors.secondaryText,
            modifier = Modifier.padding(bottom = 8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (choice in editor.view.somedaySections) {

                val selected = if (editor.edited.containsKey("viewSectionIds")) draftValue(choice.viewSectionIds).toString() == current else choice.selected
                Chip(selected, !locked, choice.title, { editFields(mapOf("viewSectionIds" to draftValue(choice.viewSectionIds))) }) { color ->
                    Text(choice.title, style = rnText(14, 400), color = color)
                }
            }
        }
    }
}


@Composable
private fun CollapsibleSection(editorId: String, section: EditorSection, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalTheme.current.colors
    var open by rememberSaveable(editorId, section.id) { mutableStateOf(section.open) }
    var helpOpen by rememberSaveable(editorId, section.id, "help") { mutableStateOf(false) }
    val title = t(section.titleKey!!)
    Column(Modifier.padding(top = 8.dp).rnBorderTop(c.border)) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = t(if (open) "markdown.collapse" else "markdown.expand")) { open = !open }
            .semantics { contentDescription = title; heading() }.heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
            Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 0.6f), color = c.text, modifier = Modifier.padding(start = 8.dp).weight(1f, fill = false))
            section.help?.let { help ->

                Box(Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button) { helpOpen = !helpOpen }
                    .semantics { contentDescription = help.getString("label"); stateDescription = t(if (helpOpen) "markdown.collapse" else "markdown.expand") }
                    .testTag("contextual-help-${section.id}"), contentAlignment = Alignment.Center) {
                    Icon(Lucide.CircleHelp, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                }
            }
            Spacer(Modifier.weight(1f))
            if (section.filledCount > 0) Box(Modifier.clip(RoundedCornerShape(10.dp)).background(c.tint).padding(horizontal = 8.dp, vertical = 2.dp)) {
                Text("${section.filledCount}", style = rnText(12, 600), color = c.onTint)
            }
        }
        section.help?.let { if (helpOpen) ContextualHelpBody(editorId, section.id, it) }
        if (open) Column(Modifier.padding(bottom = 16.dp)) { content() }
    }
}


@Composable
private fun ContextualHelpBody(editorId: String, sectionId: String, help: JSONObject) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    var failed by rememberSaveable(editorId, sectionId, "helpError") { mutableStateOf(false) }
    Column(Modifier.padding(bottom = 8.dp).testTag("contextual-help-body-$sectionId")) {
        Text(help.getString("body"), style = rnText(14, 400, 21), color = c.secondaryText)
        val openGuide = { failed = runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, help.getString("guideUrl").toUri())) }.isFailure }
        Row(Modifier.heightIn(min = 44.dp).clickable(onClick = openGuide), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(guideLink(help.getString("readGuide"), c.tint, openGuide), style = rnText(14, 400), color = c.tint)
            Icon(HelpExternalLink, null, tint = c.tint, modifier = Modifier.size(14.dp))
        }
        if (failed) Text(help.getString("guideError"), style = rnText(14, 400), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
    }
}


private val HelpExternalLink = lucide("ExternalLink", "M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")

@Composable
internal fun FormGroup(content: @Composable ColumnScope.() -> Unit) = Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), content = content)


@Composable
internal fun FieldHeading(icon: ImageVector, label: String, modifier: Modifier = Modifier, bottom: Int = 8) {
    val c = LocalTheme.current.colors
    Row(modifier.padding(bottom = bottom.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
        Text(label.uppercase(), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(start = 6.dp))
    }
}


private val LocalFormViewport = compositionLocalOf { 0 }


internal fun focusRevealBottom(fieldHeight: Int, viewport: Int): Float = minOf(fieldHeight.toFloat(), viewport * 0.4f) + viewport * 0.18f


@Composable
private fun DescriptionPreview(model: InboxViewModel, editor: TaskEditor, follow: (JSONObject) -> Unit, modifier: Modifier) = with(model) {
    val c = LocalTheme.current.colors
    val draftKey = draftJson(editor.fullDraft()) + editor.checklistNow + editor.attachments.orEmpty()
    LaunchedEffect(editor.id, draftKey, busy, failedAction) { if (!busy && failedAction == null) readTaskView() }
    val view = taskView?.takeIf { it.getString("id") == editor.id }
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.heightIn(min = 44.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(12.dp).testTag("task-description-preview")) {
        val blocks = view?.menuObjects("rows")?.firstOrNull { it.getString("type") == "description" }?.menuObjects("blocks").orEmpty()
        view?.let { MarkdownBlocks(blocks, it.getJSONObject("markdownLabels"), follow) }
    }
}


@Composable
private fun DescriptionFullscreen(model: InboxViewModel, editor: TaskEditor, locked: Boolean, follow: (JSONObject) -> Unit, close: () -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    var editing by rememberSaveable(editor.id) { mutableStateOf(true) }
    val title = editor.text("title").trim().ifEmpty { t("taskEdit.descriptionLabel") }
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().imePadding().semantics { testTagsAsResourceId = true }.testTag("task-description-fullscreen")) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                val collapse = t("markdown.collapse")
                Box(Modifier.align(Alignment.CenterStart).size(44.dp).clickable(role = Role.Button, onClick = close).semantics { contentDescription = collapse },
                    contentAlignment = Alignment.Center) { Icon(Ionicons.Close, null, tint = c.text, modifier = Modifier.size(24.dp)) }
                Text(title, style = rnText(15, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center, modifier = Modifier.padding(horizontal = 60.dp).semantics { heading() })
                val modeLabel = t(if (editing) "markdown.preview" else "markdown.edit")
                val shape = RoundedCornerShape(8.dp)
                Box(Modifier.align(Alignment.CenterEnd).size(40.dp, 34.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                    .clickable(role = Role.Button) { editing = !editing }.semantics { contentDescription = modeLabel },
                    contentAlignment = Alignment.Center) { Icon(if (editing) Lucide.Eye else Lucide.Pencil, null, tint = c.tint, modifier = Modifier.size(18.dp)) }
            }

            val draft = remember(editor.id) { MarkdownDraft(editor.text("description")) }
            draft.sync(editor.text("description"))
            val store = { text: String -> editText("description", text) }
            if (editing) Box(Modifier.weight(1f).padding(16.dp)) {
                val shape = RoundedCornerShape(10.dp)
                MarkdownInput(draft, store, !locked, t("taskEdit.descriptionPlaceholder"), t("taskEdit.descriptionLabel"),
                    rnText(16, 400).copy(color = if (!locked) c.text else c.secondaryText), Modifier.fillMaxWidth().heightIn(min = 240.dp),
                    { field -> Box(Modifier.fillMaxWidth().heightIn(min = 240.dp).clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(12.dp)) { field() } })
            } else Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp)) {
                DescriptionPreview(model, editor, follow, Modifier.fillMaxWidth().heightIn(min = 120.dp))
            }
            if (editing) MarkdownToolbar(model, draft, store)
        }
    }
}


@Composable
private fun EditorInput(value: String, onChange: (String) -> Unit, placeholder: String?, enabled: Boolean, singleLine: Boolean = false,
                        minHeight: Int = 0, description: String? = null, tag: String? = null, commit: (() -> Unit)? = null, number: Boolean = false) {
    val c = LocalTheme.current.colors
    val focusManager = LocalFocusManager.current
    val shape = RoundedCornerShape(10.dp)


    val reveal = remember { BringIntoViewRequester() }
    val viewport = LocalFormViewport.current
    var focused by remember { mutableStateOf(false) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    LaunchedEffect(focused, viewport) {
        if (focused && viewport > 0) reveal.bringIntoView(Rect(0f, 0f, size.width.toFloat(), focusRevealBottom(size.height, viewport)))
    }


    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (field.text != value) field = TextFieldValue(value, TextRange(value.length))
    BasicTextField(field, { typed -> field = typed; if (typed.text != value) onChange(typed.text) }, enabled = enabled, singleLine = singleLine, textStyle = rnText(16, 400).copy(color = if (enabled) c.text else c.secondaryText),
        cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(keyboardType = if (number) KeyboardType.Number else KeyboardType.Unspecified,
            imeAction = if (commit != null) ImeAction.Done else ImeAction.Unspecified),
        keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() }),
        modifier = Modifier.bringIntoViewRequester(reveal).onSizeChanged { size = it }.onFocusChanged { if (focused && !it.isFocused) commit?.invoke(); focused = it.isFocused }.fillMaxWidth().heightIn(min = minHeight.dp).clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape)
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier),
        decorationBox = { inner ->
            Box(Modifier.padding(12.dp)) {
                if (value.isEmpty() && placeholder != null) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                inner()
            }
        })
}


@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Chip(active: Boolean, enabled: Boolean, description: String, onClick: () -> Unit, modifier: Modifier = Modifier,
                 shape: RoundedCornerShape = RoundedCornerShape(16.dp), compact: Boolean = false, horizontal: Int = if (compact) 10 else 12,
                 toggle: Boolean = false, longPress: Pair<String, () -> Unit>? = null, content: @Composable (androidx.compose.ui.graphics.Color) -> Unit) {
    val c = LocalTheme.current.colors
    Row(modifier.fade(if (enabled || active) 1f else 0.6f).heightIn(min = 44.dp).clip(shape).background(if (active) c.tint else c.filterBg).rnBorder(1.dp, if (active) c.tint else c.border, shape)

        .semantics { contentDescription = description }
        .then(if (toggle) Modifier.toggleable(value = active, enabled = enabled, role = Role.Button, onValueChange = { onClick() })

            else if (longPress != null) Modifier.semantics { selected = active }.combinedClickable(enabled = enabled, role = Role.Tab,
                onLongClickLabel = longPress.first, onLongClick = longPress.second, onClick = onClick)
            else Modifier.selectable(selected = active, enabled = enabled, role = Role.Tab, onClick = onClick))
        .padding(horizontal = horizontal.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = if (compact) Arrangement.Center else Arrangement.Start) {
        content(if (active) c.onTint else c.secondaryText)
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InboxViewModel.ChoiceChips(editor: TaskEditor, field: String, values: List<String>, enabled: Boolean, fieldLabel: String,
                                       label: (String) -> String, icon: @Composable (String, androidx.compose.ui.graphics.Color) -> Unit) {
    val current = editor.text(field)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Chip(current.isEmpty(), enabled, "$fieldLabel: ${t("common.none")}", { editFields(mapOf(field to "")) }) { color ->
            Icon(Lucide.CircleSlash, null, tint = color, modifier = Modifier.size(16.dp))
        }
        for (value in values) {
            Chip(current == value, enabled, "$fieldLabel: ${label(value)}", { editFields(mapOf(field to value)) }) { color ->
                icon(value, color)
                Text(label(value), style = rnText(14, 400), color = color, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
}

@Composable
private fun DateButton(text: String, label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = "$label: $text" }.padding(12.dp)) {
        Text(text, style = rnText(14, 400), color = c.text)
    }
}


@Composable
private fun SmallButton(icon: ImageVector, description: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.padding(start = 8.dp).size(44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Box(Modifier.clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(horizontal = 10.dp, vertical = 8.dp)) {
            Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
        }
    }
}


@Composable
internal fun SwitchRow(label: String, hint: String, on: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(if (on) c.filterBg else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, shape)
        .toggleable(value = on, enabled = enabled, role = Role.Switch, onValueChange = { onToggle() }).padding(12.dp)) {
        Text(label, style = rnText(13, 600), color = c.text)
        Text(hint, style = rnText(12, 400, 16), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
    }
}


@Composable
private fun SuggestionMenu(matches: List<Pair<String, String>>, enabled: Boolean, choose: (String) -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shape = RoundedCornerShape(10.dp)

    val reveal = remember { BringIntoViewRequester() }
    LaunchedEffect(matches) { reveal.bringIntoView() }
    Column(Modifier.bringIntoViewRequester(reveal).padding(top = 8.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)) {
        matches.forEachIndexed { index, (value, text) ->
            Text(value, style = rnText(14, 500), color = c.text, modifier = Modifier.fillMaxWidth()
                .clickable(enabled = enabled, role = Role.Button) { choose(text) }
                .then(if (index < matches.size - 1) Modifier.rnBorderBottom(theme.divider) else Modifier)
                .padding(horizontal = 12.dp, vertical = 10.dp))
        }
    }
}


@Composable
private fun WaitingPrompt(model: InboxViewModel, text: String, locked: Boolean) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler { closeWaitingPrompt() }
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { closeWaitingPrompt() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp)) {
            val title = t("process.waitingFor")
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Text(t("process.waitingForDesc"), style = rnText(13, 600), color = c.secondaryText, modifier = Modifier.padding(bottom = 8.dp))
            EditorInput(text, model::editWaitingPrompt, t("taskEdit.assignedToPlaceholder"), !locked, singleLine = true, description = title, tag = "editor-waiting-for")
            val shown = suggestions[WAITING_PROMPT]?.takeIf { it.text == text }
            if (shown != null && shown.matches.isNotEmpty()) SuggestionMenu(shown.matches, !locked, model::editWaitingPrompt)
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.End) {
                for ((label, action, color) in listOf(Triple("common.cancel", model::closeWaitingPrompt, c.secondaryText), Triple("common.save", model::confirmWaiting, c.tint))) {
                    Box(Modifier.heightIn(min = 44.dp).clickable(enabled = !locked, role = Role.Button) { action() }.padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center) {
                        Text(t(label), style = rnText(14, 700), color = color)
                    }
                }
            }
        }
    }
}

const val MONTHLY_CUSTOM = "monthlyCustom"

internal val MONTH_GRID = (1..31).toList() + -1

internal val MONTHLY_ORDINALS = listOf("1", "2", "3", "4", "-1")

internal fun ordinalLabel(ordinal: String, t: (String) -> String) =
    t("recurrence.ordinal." + when (ordinal) { "-1" -> "last"; "2" -> "second"; "3" -> "third"; "4" -> "fourth"; else -> "first" })

internal data class MonthlyCustom(val interval: Int, val mode: String, val ordinal: String, val weekday: String, val monthDays: List<Int>,
                                  val intervalText: String) {
    fun toggleDay(day: Int) = copy(monthDays = MONTH_GRID.filter { (it == day) != (it in monthDays) }.ifEmpty { monthDays })

    fun monthDaysLabel(t: (String) -> String): String {
        val numbered = t("recurrence.onDayOfMonth").replace("{day}", monthDays.filter { it != -1 }.joinToString(", "))
        return if (-1 !in monthDays) numbered else if (monthDays.size > 1) "$numbered + ${t("recurrence.lastDay")}" else t("recurrence.lastDay")
    }

    fun nthLabel(t: (String) -> String, dayName: (String) -> String) = t("recurrence.onNthWeekday").replace("{ordinal}", ordinalLabel(ordinal, t))
        .replace("{weekday}", if (weekday == "WEEKDAY") t("recurrence.weekdayMonFri") else dayName(weekday))

    private fun custom() = JSONObject().put("interval", interval).put("mode", mode).put("ordinal", ordinal).put("weekday", weekday)
        .put("monthDays", JSONArray(monthDays))

    fun edit(): JSONObject = JSONObject().put("kind", "monthlyCustom").put("custom", custom()).put("intervalText", intervalText)

    fun save() = custom().put("intervalText", intervalText).toString()

    companion object {
        fun of(core: JSONObject) = MonthlyCustom(core.getInt("interval"), core.getString("mode"), core.getString("ordinal"),
            core.getString("weekday"), core.getJSONArray("monthDays").let { days -> List(days.length()) { days.getInt(it) } },
            core.optString("intervalText", "${core.getInt("interval")}"))

        fun restore(text: String) = of(JSONObject(text))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MonthlyCustomDialog(model: InboxViewModel, editor: TaskEditor, locked: Boolean, dismiss: () -> Unit) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val recurrence = editor.view.fields.recurrence
    var saved by rememberSaveable { mutableStateOf(MonthlyCustom.of(recurrence.getJSONObject("monthlyCustom")).save()) }
    val state = MonthlyCustom.restore(saved)
    val set = { next: MonthlyCustom -> saved = next.save() }
    val weekdays = recurrence.getJSONArray("weekdays").objects()
    BackHandler(onBack = dismiss)
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { dismiss() } }.imePadding().padding(20.dp)
        .semantics { testTagsAsResourceId = true }, contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.verticalScroll(rememberScrollState()).padding(16.dp).testTag("monthly-custom")) {
            Text(t("recurrence.customTitle"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(t("recurrence.repeatEvery"), style = rnText(13, 600), color = c.secondaryText)
                Box(Modifier.widthIn(min = 64.dp, max = 80.dp)) {
                    EditorInput(state.intervalText, { set(state.copy(intervalText = it)) }, null, !locked, singleLine = true,
                        description = "${t("recurrence.repeatEvery")}, ${t("recurrence.monthUnit")}", tag = "monthly-custom-interval", number = true)
                }
                Text(t("recurrence.monthUnit"), style = rnText(13, 600), color = c.secondaryText)
            }
            Text(t("recurrence.onLabel"), style = rnText(13, 600), color = c.secondaryText, modifier = Modifier.padding(top = 12.dp))
            FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val dayName = { day: String -> weekdays.firstOrNull { it.getString("day") == day }?.getString("longLabel") ?: day }
                for ((mode, label) in listOf("date" to state.monthDaysLabel(::t), "lastDay" to t("recurrence.lastDay"), "nth" to state.nthLabel(::t, dayName))) {
                    Chip(state.mode == mode, !locked, label, { set(state.copy(mode = mode)) }, Modifier.testTag("monthly-custom-mode-$mode")) { color ->
                        Text(label, style = rnText(14, 400), color = color)
                    }
                }
            }
            if (state.mode == "nth") {
                FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (ordinal in MONTHLY_ORDINALS) {
                        val label = ordinalLabel(ordinal, ::t)
                        DialogButton(label, label, state.ordinal == ordinal, !locked, "monthly-custom-ordinal-$ordinal", Modifier.widthIn(min = 54.dp)) {
                            set(state.copy(ordinal = ordinal))
                        }
                    }
                }
                FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (day in weekdays) {
                        val code = day.getString("day")
                        DialogButton(day.getString("label"), day.getString("longLabel"), state.weekday == code, !locked, "monthly-custom-weekday-$code",
                            Modifier.size(44.dp)) { set(state.copy(weekday = code)) }
                    }
                    val monFri = t("recurrence.weekdayMonFri")
                    DialogButton(monFri, monFri, state.weekday == "WEEKDAY", !locked, "monthly-custom-weekday-WEEKDAY", Modifier.widthIn(min = 54.dp)) {
                        set(state.copy(weekday = "WEEKDAY"))
                    }
                }
            }
            if (state.mode == "date") Column(Modifier.padding(top = 10.dp)) {
                for (row in MONTH_GRID.chunked(7)) Row(Modifier.fillMaxWidth()) {
                    for (day in row) {
                        val on = day in state.monthDays
                        val description = if (day == -1) t("recurrence.lastDayOfMonth") else t("recurrence.onDayOfMonth").replace("{day}", "$day")
                        Box(Modifier.weight(1f).heightIn(min = 44.dp).selectable(on, enabled = !locked, role = Role.Button) { set(state.toggleDay(day)) }
                            .semantics { contentDescription = description }.testTag("monthly-custom-day-$day").padding(2.dp)) {
                            val cell = RoundedCornerShape(12.dp)
                            Box(Modifier.fillMaxWidth().heightIn(min = 40.dp).clip(cell).background(if (on) c.tint else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, cell),
                                contentAlignment = Alignment.Center) {
                                Text(if (day == -1) t("recurrence.ordinal.last") else "$day", style = rnText(12, 600), color = if (on) c.onTint else c.text, maxLines = 1)
                            }
                        }
                    }
                    repeat(7 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                val save = { editDraft(recurrenceEdit(state.edit())); dismiss() }
                for ((label, action, color) in listOf(Triple("common.cancel", dismiss, c.secondaryText), Triple("common.save", save, c.tint))) {
                    Box(Modifier.heightIn(min = 44.dp).clickable(enabled = !locked || action == dismiss, role = Role.Button) { action() }
                        .testTag("monthly-custom-${label.substringAfter('.')}").padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                        Text(t(label), style = rnText(14, 700), color = color)
                    }
                }
            }
        }
    }
}

@Composable
private fun DialogButton(text: String, description: String, on: Boolean, enabled: Boolean, tag: String, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(modifier.heightIn(min = 44.dp).clip(CircleShape).background(if (on) c.tint else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, CircleShape)
        .selectable(on, enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description }.testTag(tag)
        .padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
        Text(text, style = rnText(12, 600), color = if (on) c.onTint else c.text, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun PickerDialog(title: String, dismiss: () -> Unit, search: (@Composable () -> Unit)? = null, items: @Composable ColumnScope.() -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler(onBack = dismiss)

    Box(Modifier.fillMaxSize().windowScrim(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { dismiss() } }.imePadding().padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp)) {
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            search?.let { Box(Modifier.padding(bottom = 12.dp)) { it() } }
            Column(Modifier.heightIn(max = 260.dp).fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape)
                .verticalScroll(rememberScrollState()).padding(vertical = 4.dp), content = items)
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.End) {
                Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = dismiss).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(t("common.cancel"), style = rnText(14, 700), color = c.secondaryText)
                }
            }
        }
    }
}

@Composable
internal fun PickerItem(text: String, tag: String? = null, description: String? = null, selected: Boolean? = null, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClick)
        .then(if (description != null || selected != null) Modifier.semantics {
            description?.let { contentDescription = it }
            selected?.let { this.selected = it }
        } else Modifier)
        .then(if (tag != null) Modifier.testTag(tag) else Modifier).padding(horizontal = 14.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
        Text(text, style = rnText(16, 400), color = c.text)
    }
}

@Composable
internal fun PickerHeading(text: String) {
    Text(text, style = rnText(16, 700), color = LocalTheme.current.colors.secondaryText)
}
