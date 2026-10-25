package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
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
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import android.content.Intent
import org.json.JSONArray
import kotlinx.coroutines.delay
import org.json.JSONObject
import org.json.JSONTokener
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/** One draft value as JSON text: a draft compares, saves, and survives process death exactly as core sent it. */
fun draftLiteral(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is String -> JSONObject.quote(value)
    else -> value.toString()
}

private fun draftValue(literal: String?): Any = JSONTokener(literal ?: "null").nextValue()

/** Draft fields as JSON for core's saveTaskDraft: each value exactly as the draft holds it; null is JSON null. */
fun draftJson(values: Map<String, String?>): String =
    JSONObject().apply { values.forEach { (field, literal) -> put(field, draftValue(literal)) } }.toString()

private fun JSONArray.texts() = List(length()) { getString(it) }
private fun JSONArray.objects() = List(length()) { getJSONObject(it) }

/** One of core's layout sections: its fields in core's order, its badge, and whether it starts open. */
data class EditorSection(val id: String, val titleKey: String?, val fields: List<String>, val filledCount: Int, val open: Boolean,
                         /** Core's contextual help for the section (Scheduling and Details), or null. */
                         val help: JSONObject? = null)
data class EditorChoice(val id: String, val title: String)
/** A Someday section choice: [viewSectionIds] is core's draft value (JSON text) after choosing it. */
data class SomedayChoice(val id: String, val title: String, val selected: Boolean, val viewSectionIds: String)

/**
 * Core's getTaskEditorModel reply, core's getTaskView reply when the editor opened (the saved checklist and the attachment
 * titles), and core's checklist field for the draft (editTaskChecklist), parsed once. Kotlin reads it as sent: the fields to
 * show, their order and sections, and every list a control picks from.
 */
class EditorModel(val source: String) {
    private val root = JSONObject(source)
    private val reply = root.getJSONObject("model").also { check(it.getInt("version") == 1) { "Unsupported core contract" } }
    val id: String = reply.getString("id")
    val readOnly = reply.getBoolean("readOnly")
    val canPreserveChecklistOnRepeat = reply.optBoolean("canPreserveChecklistOnRepeat")
    val focusStar: JSONObject = reply.getJSONObject("focusStar")
    /** createTaskDraft(task), each field as JSON text. A field core left unset is absent here and reads as null. */
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
    /** Core's recurrence choices: the draft value and its label key. */
    val recurrences = options.getJSONArray("recurrences").objects().map { it.getString("value") to it.getString("labelKey") }
    /** Core's time estimates: the draft value and core's label in the host language. */
    val timeEstimates = options.getJSONArray("timeEstimates").objects().map { it.getString("value") to it.getString("label") }
    val projects = options.getJSONArray("projects").objects().map { EditorChoice(it.getString("id"), it.getString("title")) }
    val projectSections = options.getJSONArray("sections").objects().map { EditorChoice(it.getString("id"), it.getString("title")) }
    val areas = options.getJSONArray("areas").objects().map { EditorChoice(it.getString("id"), it.getString("name")) }
    val somedaySections = options.getJSONArray("somedaySections").objects().map {
        SomedayChoice(it.getString("id"), it.getString("title"), it.getBoolean("selected"), draftLiteral(it.opt("viewSectionIds")))
    }
    private val content = root.getJSONObject("content")
    /** The saved checklist (getTaskView's checklistBase), as JSON text: where the editor's checklist starts, and the save's base. */
    val checklistBase: String = content.getJSONArray("checklistBase").toString()
    /** The saved attachment records, removed ones included (getTaskView's attachmentsBase): where the editor's attachments start. */
    val attachmentsBase: String = content.optJSONArray("attachmentsBase")?.toString() ?: "[]"
    /** The saved task's revision as the editor read it (getTaskView's taskRevision): a Discard's draft settlement sends it. */
    val taskRevision: String = content.optString("taskRevision")
    /** Core's Form tab checklist field for the draft and the editor's checklist; null for a read-only task. */
    val checklistField: JSONObject? = root.optJSONObject("field")
    /** Core's schedule and estimate controls for this draft: date labels, picker starts, quick dates, recurrence, reminders. */
    val fields = EditorFields(reply.getJSONObject("fields"))

    /** Core's model for an edited draft (editTaskDraft) and its checklist field, with this task's saved checklist and attachments. */
    fun edited(model: JSONObject, field: JSONObject?) = of(model, content, field)

    companion object {
        fun of(model: JSONObject, content: JSONObject, field: JSONObject? = null) =
            EditorModel(JSONObject().put("model", model).put("content", content).apply { field?.let { put("field", it) } }.toString())
    }
}

/**
 * RN's areDraftAttachmentsDirty (core's task-draft.ts attachmentFingerprint): two attachment lists differ for the editor when an
 * attachment's id, uri, title or removal differs, in order. A download's availability alone is no unsaved edit.
 */
fun sameAttachments(left: String, right: String): Boolean {
    val print = { text: String -> JSONArray(text).objects().map { listOf(it.getString("id"), it.optString("uri"), it.optString("title"), it.optString("deletedAt")) } }
    return print(left) == print(right)
}

/** Two checklists as core sends them hold the same items (id, title, done) in the same order. */
fun sameChecklist(left: String, right: String): Boolean {
    val items = { text: String -> JSONArray(text).objects().map { Triple(it.getString("id"), it.getString("title"), it.getBoolean("isCompleted")) } }
    return items(left) == items(right)
}

/** One control's edit for core's editTaskDraft, numbered in its session; [field] names a typed input it came from. */
data class PendingEdit(val seq: Long, val edit: String, val field: String?)

/** One quick date chip: core's label, whether it is on, and the field's draft value after a tap. */
data class QuickDate(val label: String, val selected: Boolean, val value: String)

/**
 * A date field as core shows it: [label] in the user's settings, whether it [hasTime], the value after
 * "Date only", where the pickers start (`yyyy-MM-dd`, `HH:mm`), and RN's quick date chips.
 */
class DatePart(json: JSONObject) {
    val value: String = json.getString("value")
    val label: String = json.getString("label")
    val hasTime = json.getBoolean("hasTime")
    val dateOnly: String = json.getString("dateOnly")
    val pickerDate: String = json.getJSONObject("picker").getString("date")
    val pickerTime: String = json.getJSONObject("picker").getString("time")
    val quickDates = json.getJSONArray("quickDates").objects().map { QuickDate(it.getString("label"), it.getBoolean("selected"), it.getString("value")) }
}

/** Core's `fields` block of the editor model, read as sent. */
class EditorFields(json: JSONObject) {
    val dates = listOf("startTime", "dueDate", "reviewAt").associateWith { DatePart(json.getJSONObject(it)) }
    /** "Starts after due date", or "". */
    val dateIssue: String = json.getString("dateIssue")
    /** The start's absolute/relative control; null without a due date. */
    val relativeStart: JSONObject? = json.optJSONObject("relativeStart")
    val recurrence: JSONObject = json.getJSONObject("recurrence")
    val reminders: JSONObject = json.getJSONObject("reminders")
    val timeEstimate: JSONObject = json.getJSONObject("timeEstimate")
    val timeSpent = json.getJSONObject("timeSpent").getBoolean("enabled")
}

/** The token and person fields: their text is typed freely, and core's getTaskEditorSuggestions turns it into the draft value. */
val TYPED_FIELDS = listOf("contexts", "tags", "assignedTo")

/** Core's suggestions for [text]: the draft value it stands for, RN's matches, and the quick chips (value, selected, text after a tap). */
data class EditorSuggestions(val text: String, val draftValue: String, val matches: List<Pair<String, String>>, val quick: List<Triple<String, Boolean, String>>) {
    companion object {
        fun parse(text: String, json: JSONObject) = EditorSuggestions(text, json.getString("draftValue"),
            json.getJSONArray("matches").objects().map { it.getString("value") to it.getString("text") },
            json.getJSONArray("quick").objects().map { Triple(it.getString("value"), it.getBoolean("selected"), it.getString("text")) })
    }
}

/**
 * An open editor: core's model and the user's edits of its draft, each field as JSON text.
 * Kotlin never validates, reshapes, or fills in a value, and runs no cascade: core applies
 * its rules when it saves. [bases] holds, for each edited field, the value it was loaded
 * with, so a draft restored onto a fresh model still saves against its own base and core
 * refuses a field another writer changed. [inputs] holds the typed text of the token and
 * person fields, and [resolved] the text whose draft value core already gave, so Save waits
 * for core. [waitingFor] is RN's "waiting for" prompt text while that prompt is open. [checklist] is RN's draft
 * checklist (core's items as JSON text, edited only through core's editTaskChecklist), saved with the draft in one write,
 * and [tab] is RN's open tab, the Form ("task") or the View tab.
 */
data class TaskEditor(
    val model: EditorModel, val edited: Map<String, String>, val inputs: Map<String, String> = emptyMap(),
    val resolved: Map<String, String> = emptyMap(), val bases: Map<String, String> = emptyMap(), val waitingFor: String? = null,
    /** Core's model for the current draft (editTaskDraft's reply): the layout, options, and fields to show. */
    val view: EditorModel = model,
    /** This editor session. A reply from core counts only for the session and the first pending edit it answers. */
    val session: String = UUID.randomUUID().toString(),
    /** Control edits not yet answered by core, in order; kept in the draft file before they are sent. */
    val pending: List<PendingEdit> = emptyList(),
    val nextSeq: Long = 1,
    val checklist: String? = null,
    val tab: String = "task",
    /**
     * RN's draft attachments: the list core's attachment commands answered (JSON), and the saved list it started from, kept with
     * it so a reload never changes what Save compares against (core's mergeTaskDraftAttachments applies only the editor's changes).
     * Null while the attachments are untouched.
     */
    val attachments: String? = null,
    val attachmentsFrom: String? = null,
    /**
     * The saved checklist the edited one started from, kept with it as [attachmentsFrom] is: after a restart the model is read
     * again, and a change synced meanwhile must not become Save's base (core then merges it instead of losing it).
     */
    val checklistFrom: String? = null,
    /** The View tab's add-item text, typed but not yet added (RN's checklistDraftRef): Save adds it, and Close counts it as unsaved. */
    val checklistAdd: String = "",
) {
    val id get() = model.id
    val readOnly get() = model.readOnly
    private fun loaded(field: String) = model.draft[field] ?: "null"
    private fun base(field: String) = bases[field] ?: loaded(field)
    fun value(field: String): Any = draftValue(edited[field] ?: loaded(field))
    fun text(field: String) = value(field) as? String ?: ""
    fun flag(field: String) = value(field) == true
    /** Only the fields whose draft differs from the value they were loaded with, as JSON text. */
    val patch: Map<String, String?> get() = edited.filter { (field, literal) -> literal != base(field) }
    /** The loaded values of exactly the patched fields. */
    val base: Map<String, String?> get() = patch.keys.associateWith { base(it) }

    private fun withEdits(changes: Map<String, String>) =
        copy(edited = edited + changes, bases = bases + changes.keys.associateWith { base(it) })

    fun edit(changes: Map<String, Any?>) = withEdits(changes.mapValues { draftLiteral(it.value) })

    /** A field's text as typed; it starts as the draft's own text. */
    fun input(field: String) = inputs[field] ?: (draftValue(loaded(field)) as? String ?: "")
    /** Core has not yet said which draft value the typed text stands for. */
    fun unresolved(field: String) = input(field) != (resolved[field] ?: (draftValue(loaded(field)) as? String ?: ""))
    val waiting get() = TYPED_FIELDS.any(::unresolved)
    /** The checklist as edited, or the saved one. */
    val checklistNow get() = checklist ?: model.checklistBase
    val checklistChanged get() = checklist != null && !sameChecklist(checklist, checklistFrom ?: model.checklistBase)
    /** saveTaskDraft's `checklist`: the saved checklist the edit started from and the edited items; "" while unchanged. */
    val checklistSave: String get() = if (!checklistChanged) "" else
        JSONObject().put("base", JSONArray(checklistFrom ?: model.checklistBase)).put("value", JSONArray(checklistNow)).toString()
    /** The attachments as the draft holds them, or the saved ones. */
    val attachmentsNow get() = attachments ?: model.attachmentsBase
    val attachmentsChanged get() = attachments != null && !sameAttachments(attachments, attachmentsFrom ?: model.attachmentsBase)
    /** saveTaskDraft's `attachments`: the list the draft started from and the edited one; "" while unchanged. */
    val attachmentsSave: String get() = if (!attachmentsChanged) "" else
        JSONObject().put("base", JSONArray(attachmentsFrom ?: model.attachmentsBase)).put("value", JSONArray(attachmentsNow)).toString()
    /** The draft list after a core attachment command's answer [next]; the first change remembers the list it started from. */
    fun withAttachments(next: String) = copy(attachments = next, attachmentsFrom = attachmentsFrom ?: model.attachmentsBase)
    /** The draft checklist after core's answer [next] (null keeps the saved one); the first change remembers where it started. */
    fun withChecklist(next: String?) = copy(checklist = next, checklistFrom = if (next == null) checklistFrom else checklistFrom ?: model.checklistBase)
    /** Unsaved: a changed field, checklist or attachment, or typed text core has not turned into a draft value yet (RN asks before closing any). */
    val dirty get() = patch.isNotEmpty() || waiting || checklistChanged || attachmentsChanged || checklistAdd.isNotBlank()

    /** The View tab's typed item as core's append edit, queued like any checklist edit; the field empties. Nothing typed: unchanged. */
    fun checklistAddQueued(): TaskEditor = checklistAdd.trim().takeIf { it.isNotEmpty() }?.let { title ->
        copy(checklistAdd = "").queued(JSONObject().put("checklist", JSONObject().put("kind", "append").put("title", title)).toString(), null)
    } ?: this

    fun typed(field: String, text: String) = copy(inputs = inputs + (field to text))

    /** A control's edit joins the queue with the next number of this session. */
    fun queued(edit: String, field: String?) = copy(pending = pending + PendingEdit(nextSeq, edit, field), nextSeq = nextSeq + 1)
    /** A typed input with an edit still waiting for core keeps its own text. */
    fun pendingFor(field: String) = pending.any { it.field == field }

    /** The whole draft as JSON text, for core's editTaskDraft. */
    fun fullDraft(): Map<String, String> = (model.draft.keys + edited.keys).associateWith { edited[it] ?: loaded(it) }

    /**
     * Core's model for the draft [sent]: its draft becomes the editor's, except a field typed into
     * locally while core answered, which keeps the newer local value.
     */
    fun viewed(reply: EditorModel, sent: Map<String, String>): TaskEditor {
        val current = fullDraft()
        val combined = (reply.draft.keys + current.keys).associateWith { field ->
            if ((current[field] ?: "null") != (sent[field] ?: "null")) current[field] ?: "null" else reply.draft[field] ?: "null"
        }
        return withEdits(combined.filter { (field, literal) -> literal != (edited[field] ?: loaded(field)) }).copy(view = reply)
    }

    /**
     * Core's draft value for [text], applied only while [text] is still what the field shows. A field
     * nobody typed in keeps the draft core sent, so opening the editor never makes an edit.
     */
    fun resolve(field: String, text: String, draftValue: String) =
        if (field !in inputs || input(field) != text) this
        else withEdits(mapOf(field to draftLiteral(draftValue))).copy(resolved = resolved + (field to text))

    /** RN's waiting prompt closes with the person as the field's text; core sets Waiting and the person (InboxViewModel.confirmWaiting). */
    fun assignWaiting(person: String) =
        copy(inputs = inputs + ("assignedTo" to person), resolved = resolved + ("assignedTo" to person), waitingFor = null)

    /**
     * After STALE_REVISION: the fresh model becomes the base. An edit stays only where the stored
     * value still equals its old base; where another writer changed a field, the draft takes the
     * stored value, and its typed text starts again from it.
     */
    fun reloaded(fresh: EditorModel, keepChecklist: Boolean = false): TaskEditor {
        val kept = { field: String -> (fresh.draft[field] ?: "null") == base(field) }
        // The edited checklist stays while the saved one is unchanged, or after Reset checklist (its items are then reopened).
        val list = checklist?.takeIf { keepChecklist || sameChecklist(fresh.checklistBase, model.checklistBase) }
        // A new session: a reply to an edit sent before the reload never enters the reloaded editor.
        // The draft attachments stay with the list they started from: core's save merge applies only their own changes.
        return TaskEditor(fresh, edited.filterKeys(kept), inputs.filterKeys(kept), resolved.filterKeys(kept), waitingFor = waitingFor, view = view,
            checklist = list, tab = tab, attachments = attachments, attachmentsFrom = attachmentsFrom, checklistFrom = checklistFrom.takeIf { list != null },
            checklistAdd = checklistAdd)
    }

    /** The draft's own state, without the model: the edits with their bases, the typed text, and the open prompt. */
    fun state(): JSONObject = JSONObject().put("id", id).put("edited", JSONObject(edited)).put("bases", JSONObject(edited.keys.associateWith { base(it) }))
        .put("inputs", JSONObject(inputs)).put("resolved", JSONObject(resolved)).put("waitingFor", waitingFor ?: JSONObject.NULL)
        .put("edits", JSONArray().apply { pending.forEach { put(JSONObject().put("seq", it.seq).put("edit", it.edit).put("field", it.field ?: JSONObject.NULL)) } })
        .put("nextSeq", nextSeq).put("checklist", checklist ?: JSONObject.NULL).put("tab", tab)
        .put("attachments", attachments ?: JSONObject.NULL).put("attachmentsFrom", attachmentsFrom ?: JSONObject.NULL)
        .put("checklistFrom", checklistFrom ?: JSONObject.NULL)
        .put("checklistAdd", checklistAdd)

    companion object {
        fun open(model: EditorModel, tab: String) = TaskEditor(model, emptyMap(), tab = tab)

        /** A saved draft onto a model read again from core: the edits keep their own bases, so core still checks them. */
        fun restore(model: EditorModel, saved: JSONObject): TaskEditor {
            fun map(name: String) = saved.getJSONObject(name).let { m -> m.keys().asSequence().associateWith { m.getString(it) } }
            // Edits core had not answered come back, in order, and are sent again on the fresh model.
            val edits = saved.optJSONArray("edits")?.objects().orEmpty().map {
                PendingEdit(it.getLong("seq"), it.getString("edit"), if (it.isNull("field")) null else it.getString("field"))
            }
            return TaskEditor(model, map("edited"), map("inputs"), map("resolved"), map("bases"),
                if (saved.isNull("waitingFor")) null else saved.getString("waitingFor"),
                pending = edits, nextSeq = saved.optLong("nextSeq", (edits.maxOfOrNull { it.seq } ?: 0) + 1),
                checklist = if (saved.isNull("checklist")) null else saved.optString("checklist").ifEmpty { null }, tab = saved.optString("tab", "task"),
                attachments = saved.optString("attachments").takeIf { saved.has("attachments") && !saved.isNull("attachments") },
                attachmentsFrom = saved.optString("attachmentsFrom").takeIf { saved.has("attachmentsFrom") && !saved.isNull("attachmentsFrom") },
                // A draft saved before this field existed falls back to the model's checklist, as it always did.
                checklistFrom = saved.optString("checklistFrom").takeIf { saved.has("checklistFrom") && !saved.isNull("checklistFrom") },
                checklistAdd = saved.optString("checklistAdd"))
        }
    }
}

/** Names the day the picker chose; it returns that day's UTC midnight. Only picker output comes here, never a stored value. */
private fun pickedDay(pickerMillis: Long): String =
    SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(pickerMillis))

/** The picker's hour and minute as core's pickTime takes them, `HH:mm`. */
internal fun pickedTime(hour: Int, minute: Int) = "${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}"

/** Project details' date rows: core's field, its label key, and its name in core's details metadata (`has<Name>Date`, `<name>DateLabel`). */
internal val PROJECT_DATE_FIELDS = listOf(Triple("startDate", "taskEdit.startDateLabel", "Start"), Triple("dueDate", "taskEdit.dueDateLabel", "Due"),
    Triple("reviewAt", "projects.reviewAt", "Review"))

/** Where core says the date picker starts (`yyyy-MM-dd`), as the picker's UTC midnight: the reverse of [pickedDay]. */
private fun pickerStart(coreDate: String): Long? =
    runCatching { SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(coreDate)?.time }.getOrNull()

/** Where core says the time picker starts (`HH:mm`), as the picker's hour and minute. */
internal fun pickerClock(coreTime: String): Pair<Int, Int> =
    coreTime.split(":").mapNotNull { it.toIntOrNull() }.let { if (it.size == 2) it[0] to it[1] else 0 to 0 }

/** RN's editor field glyphs (TaskEditOrganizationField and friends). */
private val STATUS_ICONS = mapOf("inbox" to Lucide.Inbox, "next" to Lucide.ArrowRight, "waiting" to Lucide.CirclePause,
    "someday" to Lucide.CircleArrowUp, "reference" to Lucide.Book, "done" to Lucide.Check)
private val ENERGY_ICONS = mapOf("low" to Lucide.BatteryLow, "medium" to Lucide.BatteryMedium, "high" to Lucide.BatteryFull)

/**
 * RN's task editor, Form tab (task-edit-modal.tsx, TaskEditFormTab and its field components): the
 * header, the title, then core's sections and fields in core's order with RN's controls. Every
 * value shown is the draft as core defined it; dates are shown as the draft holds them.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun TaskEditorScreen(model: InboxViewModel, editor: TaskEditor) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    // After a failed save only its exact retry may run: the draft is locked,
    // and Back leaves the app as it does on the lists, so reopening finds it.
    val failed = failedAction != null
    val locked = busy || failed || editor.readOnly
    var confirmLeave by rememberSaveable { mutableStateOf(false) }
    // A task, project, context or tag link tapped while the draft has unsaved edits: followed after Discard.
    var linkAfterLeave by rememberSaveable { mutableStateOf<String?>(null) }
    val context = LocalContext.current
    var help by rememberSaveable { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf<String?>(null) }
    // The open date picker (a date field, or "until" for the recurrence end) and the open time picker (a date field).
    var pickDate by rememberSaveable { mutableStateOf<String?>(null) }
    var pickTime by rememberSaveable { mutableStateOf<String?>(null) }
    // As in the mobile editor: with nothing to save it closes; unsaved edits (typed text core has not resolved included) ask first.
    val leave = { if (editor.readOnly || (!editor.dirty && !editsPending)) closeEditor() else confirmLeave = true }
    BackHandler(enabled = !failed) { if (!busy) leave() }
    // Where a link goes: a web, mail or phone link opens outside the app; a project, a task, a context or a tag closes this editor
    // first (asking, as Close does, when there are unsaved edits), as RN's links navigate away from it.
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
    // Edits queued while a command ran (Reset checklist's reopened items) go to core once it ends.
    LaunchedEffect(busy, failed) { if (!busy && !failed) pumpEdits() }
    // Core's quick chips and the draft value of restored typed text, whenever no action runs.
    LaunchedEffect(editor.id, busy, failed) { if (!busy && !failed) TYPED_FIELDS.forEach { suggest(it, editor.input(it)) } }
    // Core's AI parts (Clarify, Break down, the copilot) for the draft as it changes; the copilot asks once typing pauses.
    val aiDraft = editor.fullDraft().toString()
    LaunchedEffect(editor.session, aiDraft, busy) { if (!busy) { delay(150); ai.readEditor() } }

    Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("task-editor")) {
        // RN's TaskEditHeader: Close at the left, Save at the right (Close alone when read-only). Its More menu is not built yet.
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (!editor.readOnly) {
                val closeLabel = t("common.close")
                Box(Modifier.size(44.dp).clickable(enabled = !busy && !failed, role = Role.Button, onClick = leave)
                    .semantics { contentDescription = closeLabel }, contentAlignment = Alignment.CenterStart) {
                    Icon(Lucide.X, null, tint = c.tint, modifier = Modifier.size(22.dp).fade(if (!busy && !failed) 1f else 0.5f))
                }
            }
            Spacer(Modifier.weight(1f))
            // Typed text core has not resolved yet queues the save until it has (saveEditor).
            val saveEnabled = if (editor.readOnly) true else writable && !busy &&
                (failedAction == null || failedAction == saveDraftAction(editor))
            Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp)
                .clickable(enabled = saveEnabled, role = Role.Button) { if (editor.readOnly) closeEditor() else saveEditor() },
                contentAlignment = Alignment.CenterEnd) {
                Text(t(if (editor.readOnly) "common.close" else "common.save"), style = rnText(18, 700), color = c.tint,
                    modifier = Modifier.fade(if (saveEnabled) 1f else 0.5f))
            }
        }
        // Core's message; after a conflict, "Try again" takes the stored values of the fields core named and keeps the other edits.
        error?.let { message ->
            // Reload waits while control edits are with core, so it never leaves them unsent.
            FailureBanner(message) {
                if (conflict) TextButton(onClick = model::reloadEditor, enabled = !busy && !failed && !editsPending) { Text(t("common.retry")) }
                else OwedRetry(model)
            }
        }
        // RN's tabs under the header; a read-only task shows only its View tab.
        if (!editor.readOnly) EditorTabs(model, editor)
        if (editor.readOnly || editor.tab == "view") TaskViewTab(model, editor, locked, { picker = "status" }, follow, Modifier.weight(1f))
        else Column(Modifier.weight(1f).imePadding().verticalScroll(rememberScrollState()).padding(20.dp)) {
            if (editor.readOnly) Text(t("projects.archivedReadOnlyHint"), style = rnText(14, 400), color = c.secondaryText,
                modifier = Modifier.padding(bottom = 16.dp))
            FormGroup {
                Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    FieldHeading(Lucide.Type, t("taskEdit.titleLabel"), Modifier.weight(1f), bottom = 0)
                    // RN's Focus star sits in the Title row beside the layout help, styled like it (15c42df63 moved it from the top bar).
                    if (!editor.readOnly && editor.text("status") != "archived") {
                        val focused = editor.flag("focusedToday")
                        val star = editor.view.focusStar
                        val blocked = star.optString("blockedText").takeIf { it.isNotEmpty() && it != "null" }
                        val starEnabled = !locked && (focused || star.getBoolean("canToggle"))
                        val actionLabel = t(if (focused) "agenda.removeFromFocus" else "agenda.addToFocus")
                        val starLabel = blocked ?: if (star.getBoolean("queued")) {
                            if (focused) "$actionLabel. ${t("agenda.focusWhenAvailable")}" else t("agenda.focusWhenAvailable")
                        } else actionLabel
                        Box(Modifier.padding(end = 12.dp).size(28.dp).clip(RoundedCornerShape(7.dp)).background(c.filterBg).border(1.dp, c.border, RoundedCornerShape(7.dp))
                            .clickable(enabled = starEnabled, role = Role.Button) { editFields(mapOf("focusedToday" to !focused)) }
                            .semantics { contentDescription = starLabel; selected = focused; if (!starEnabled) disabled() }
                            .testTag("task-edit-focus-star"), contentAlignment = Alignment.Center) {
                            FocusStar(focused, !starEnabled, 18, Modifier)
                        }
                    }
                    val helpLabel = t("taskEdit.editorLayoutHelpLabel")
                    Box(Modifier.size(28.dp).clip(RoundedCornerShape(7.dp)).background(c.filterBg).border(1.dp, c.border, RoundedCornerShape(7.dp))
                        .clickable(role = Role.Button) { help = true }.semantics { contentDescription = helpLabel }, contentAlignment = Alignment.Center) {
                        Icon(Lucide.CircleHelp, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
                    }
                }
                // RN's title input is multiline, and a typed line break becomes a space.
                EditorInput(editor.text("title"), { editText("title", it.replace(Regex("[\r\n]+"), " ")) }, null, !locked)
            }
            // RN's AI row and the copilot's pills under the title (TaskEditFormTab.tsx), while AI is on.
            EditorAIRows(model, locked)
            // The Destination row stands for both Project and Area, at the first of them in core's order (RN's destinationFields).
            val destination = editor.view.sections.flatMap { it.fields }.firstOrNull { it == "project" || it == "area" }
            val field = @Composable { id: String -> EditorField(model, editor, id, locked, id == destination, { picker = it }, { pickDate = it }, { pickTime = it }) }
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

    when (picker) {
        "destination" -> PickerDialog(t("task.destination"), { picker = null }) {
            PickerItem(t("common.none")) { editFields(mapOf("projectId" to "", "areaId" to "")); picker = null }
            // Core finishes the move when it saves: a project clears the area, and a section outside the project is dropped.
            PickerHeading(t("nav.projects"))
            for (project in editor.view.projects) PickerItem(project.title, "destination-project") { editFields(mapOf("projectId" to project.id)); picker = null }
            PickerHeading(t("taskEdit.areaLabel"))
            for (area in editor.view.areas) PickerItem(area.title) { editFields(mapOf("projectId" to "", "areaId" to area.id)); picker = null }
        }
        // The View tab's status badge: RN's status menu, with the Form tab's rule (Waiting asks who or what first).
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
    }

    pickDate?.let { target ->
        // The picker starts where core says: the field's date (else today), or the recurrence end.
        val start = if (target == "until") editor.view.fields.recurrence.getString("until") else editor.view.fields.dates.getValue(target).pickerDate
        DayPickerDialog(start, { pickDate = null }) { day ->
            // Core keeps an existing time on a new day, and moves a relative start with a due date.
            editDraft(if (target == "until") recurrenceEdit(JSONObject().put("kind", "until").put("date", day))
                else JSONObject().put("type", "pickDate").put("field", target).put("date", day))
        }
    }
    pickTime?.let { target ->
        // The time picker starts on core's time for the field: its time, else now.
        val (hour, minute) = pickerClock(editor.view.fields.dates.getValue(target).pickerTime)
        val state = rememberTimePickerState(initialHour = hour, initialMinute = minute)
        AlertDialog(
            onDismissRequest = { pickTime = null },
            confirmButton = {
                TextButton(onClick = {
                    editDraft(JSONObject().put("type", "pickTime").put("field", target).put("time", pickedTime(state.hour, state.minute)))
                    pickTime = null
                }) { Text(t("common.ok")) }
            },
            dismissButton = { TextButton(onClick = { pickTime = null }) { Text(t("common.cancel")) } },
            text = { TimePicker(state) },
        )
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

/**
 * The system date picker, starting on core's `yyyy-MM-dd` [start] (null: this month, nothing chosen). OK hands
 * [pick] the chosen day as `yyyy-MM-dd`, read from the picker's own fields; the editor and Process Inbox share it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DayPickerDialog(start: String?, dismiss: () -> Unit, pick: (String) -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = start?.let { pickerStart(it) })
    DatePickerDialog(
        onDismissRequest = dismiss,
        confirmButton = {
            TextButton(onClick = {
                state.selectedDateMillis?.let { pickerMillis -> pick(pickedDay(pickerMillis)) }
                dismiss()
            }, enabled = state.selectedDateMillis != null) { Text(t("common.ok")) }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text(t("common.cancel")) } },
    ) { DatePicker(state) }
}

/**
 * The system time picker starting at [hour]:[minute]; OK hands [pick] the time as core's `HH:mm`, read from the
 * picker's own fields. The capture popup's due time uses it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClockPickerDialog(hour: Int, minute: Int, dismiss: () -> Unit, pick: (String) -> Unit) {
    val state = rememberTimePickerState(initialHour = hour, initialMinute = minute)
    AlertDialog(
        onDismissRequest = dismiss,
        confirmButton = { TextButton(onClick = { pick(pickedTime(state.hour, state.minute)); dismiss() }) { Text(t("common.ok")) } },
        dismissButton = { TextButton(onClick = dismiss) { Text(t("common.cancel")) } },
        text = { TimePicker(state) },
    )
}

/** A recurrence control's edit for core's editTaskDraft. */
private fun recurrenceEdit(edit: JSONObject) = JSONObject().put("type", "recurrence").put("edit", edit)

/** A date control's value (a quick date, Date only, or '' to clear) for core's editTaskDraft, which runs the date's cascades. */
private fun InboxViewModel.setDate(field: String, value: String) =
    editDraft(JSONObject().put("type", "date").put("field", field).put("value", value))

/** One field with RN's control for it. A field whose control is not built shows its value read-only. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun EditorField(model: InboxViewModel, editor: TaskEditor, id: String, locked: Boolean, destination: Boolean,
                        openPicker: (String) -> Unit, pickDate: (String) -> Unit, pickTime: (String) -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    when (id) {
        "status" -> FormGroup {
            FieldHeading(Lucide.ListTodo, t("taskEdit.statusLabel"))
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
                maxItemsInEachRow = 3) {
                for (status in editor.view.statuses) {
                    val active = editor.text("status") == status
                    // RN's requestStatusChange: moving to Waiting first asks who or what it waits for.
                    val choose = { if (status == "waiting" && !active) openWaitingPrompt() else editFields(mapOf("status" to status)) }
                    Chip(active, !locked, "${t("taskEdit.statusLabel")}: ${t("status.$status")}", choose,
                        Modifier.weight(1f), RoundedCornerShape(14.dp), compact = true) { color ->
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
            CompactRow(Lucide.Folder, t("task.destination"), value, !locked) { openPicker("destination") }
        }
        "section" -> if (editor.text("projectId").isNotEmpty()) FormGroup {
            FieldHeading(Lucide.Layers, t("taskEdit.sectionLabel"))
            // Core lists the sections of the draft's project, read again after each edit.
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
                // RN's custom input: core parses the typed text ("2h30", "45"); text that does not parse keeps the estimate.
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
                !locked, description = label, tag = "editor-$id")
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
            FieldHeading(Lucide.AlignLeft, t("taskEdit.descriptionLabel"))
            EditorInput(editor.text("description"), { editText("description", it) }, t("taskEdit.descriptionPlaceholder"), !locked,
                singleLine = false, minHeight = 100, description = t("taskEdit.descriptionLabel"))
        }
        "dueDate", "startTime", "reviewAt" -> FormGroup {
            val part = editor.view.fields.dates.getValue(id)
            val label = t(when (id) { "dueDate" -> "taskEdit.dueDateLabel"; "startTime" -> "taskEdit.startDateLabel"; else -> "taskEdit.reviewDateLabel" })
            val icon = when (id) { "dueDate" -> Lucide.CalendarDays; "startTime" -> Lucide.Calendar; else -> Lucide.CalendarClock }
            if (id == "dueDate" && part.value.isEmpty()) {
                // RN's compact due row while no due date is set.
                CompactRow(icon, label, part.label, !locked) { pickDate(id) }
            } else {
                FieldHeading(icon, label)
                // RN's date row: core's label, the clock (not for review), Date only when it has a time, and Clear.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    DateButton(part.label, label, !locked, Modifier.weight(1f)) { pickDate(id) }
                    if (part.value.isNotEmpty()) {
                        if (id != "reviewAt") SmallButton(Lucide.Clock, "${t("calendar.changeTime")} $label", !locked) { pickTime(id) }
                        if (part.hasTime) SmallTextButton(t("taskEdit.dateOnly"), "${t("taskEdit.dateOnly")} $label", !locked) { setDate(id, part.dateOnly) }
                        SmallButton(Lucide.CalendarX, "${t("common.clear")} $label", !locked) { setDate(id, "") }
                    }
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
            RecurrenceField(model, editor, locked, pickDate)
        }
        // RN's checklist field on core's field model (TaskView.kt); every change is core's checklist edit on the draft.
        "checklist" -> ChecklistField(model, editor, locked)
        // RN's attachments field (TaskEditContentField): Add file, Add photo, Add link, and core's rows of the draft's list.
        "attachments" -> FormGroup {
            FieldHeading(Lucide.Paperclip, t("attachments.title"))
            EditorAttachments(model, editor, locked)
        }
        else -> Unit
    }
}


/** RN's QuickDateChips: core's presets for the field; a tap writes core's value (the selected chip, and No date, clear it). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuickDateChips(fieldLabel: String, chips: List<QuickDate>, enabled: Boolean, choose: (String) -> Unit) {
    val c = LocalTheme.current.colors
    FlowRow(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (chip in chips) {
            val shape = RoundedCornerShape(999.dp)
            Box(Modifier.weight(1f).widthIn(min = 92.dp).heightIn(min = 34.dp).clip(shape).background(if (chip.selected) c.tint else c.filterBg)
                .border(1.dp, if (chip.selected) c.tint else c.border, shape)
                .semantics { contentDescription = "$fieldLabel: ${chip.label}" }
                .selectable(selected = chip.selected, enabled = enabled, role = Role.Tab) { choose(chip.value) }
                .padding(horizontal = 10.dp, vertical = 7.dp), contentAlignment = Alignment.Center) {
                Text(chip.label, style = rnText(12, 600), color = if (chip.selected) c.onTint else c.secondaryText, textAlign = TextAlign.Center, maxLines = 2)
            }
        }
    }
}

/** RN's start mode: Absolute or Relative, then the lead time and its unit; core computes the start (relativeStart edit). */
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

/** RN's reminder policy and repeat controls under the due date, using core's labels and selected values. */
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
        .border(1.dp, if (expanded || on) c.tint else c.border, shape)
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

/** RN's recurrence field: the rule, its interval and days, the monthly pattern, the ends, the strategy, and the calendar preview switch. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecurrenceField(model: InboxViewModel, editor: TaskEditor, locked: Boolean, pickDate: (String) -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    val rule = editor.text("recurrence")
    val details = editor.view.fields.recurrence
    val edit = { recurrence: JSONObject -> editDraft(recurrenceEdit(recurrence)) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, key) in editor.view.recurrences) {
            // Core carries the count, the end date, and tokens the editor does not own across a rule change.
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
            Box(Modifier.size(44.dp).clip(CircleShape).background(if (on) c.tint else c.cardBg).border(1.dp, if (on) c.tint else c.border, CircleShape)
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
        // RN's Custom opens its custom monthly dialog, which is not built: a custom rule shows here, read-only.
        if (custom) Chip(true, false, t("recurrence.custom"), {}) { color -> Text(t("recurrence.custom"), style = rnText(14, 400), color = color) }
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

/**
 * A small number or text input whose value core owns (an interval, a count, a lead time, a custom estimate):
 * the typed text stays while the field is edited, each change goes to core, and core's value shows again
 * when it changes.
 */
@Composable
private fun TypedInput(coreValue: String, description: String, enabled: Boolean, pending: Boolean, send: (String) -> Unit) {
    // The typed text stays as typed. Core's value replaces it only when core's value changes and no edit
    // from this input is still waiting: an older reply never resets newer typing, and refused text stays.
    var text by remember { mutableStateOf(coreValue) }
    LaunchedEffect(coreValue) { if (!pending) text = coreValue }
    EditorInput(text, { text = it; send(it) }, null, enabled, singleLine = true, description = description)
}

/** RN's clearDateBtn with a text label (Date only). */
@Composable
private fun SmallTextButton(text: String, description: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.padding(start = 8.dp).heightIn(min = 44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Box(Modifier.clip(shape).background(c.filterBg).border(1.dp, c.border, shape).padding(horizontal = 10.dp, vertical = 8.dp)) {
            Text(text, style = rnText(12, 600), color = c.secondaryText)
        }
    }
}

/** RN's Someday section picker (SomedaySectionPicker): No section, then core's sections, as chips. Its "New section…" is not built. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SomedaySections(model: InboxViewModel, editor: TaskEditor, locked: Boolean) = with(model) {
    val current = draftValue(editor.edited["viewSectionIds"] ?: "null").toString()
    FormGroup {
        Text(t("viewSections.somedaySection").uppercase(), style = rnText(14, 400), color = LocalTheme.current.colors.secondaryText,
            modifier = Modifier.padding(bottom = 8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (choice in editor.view.somedaySections) {
                // Core marks the loaded choice; after a tap, the choice whose value the draft now holds.
                val selected = if (editor.edited.containsKey("viewSectionIds")) draftValue(choice.viewSectionIds).toString() == current else choice.selected
                Chip(selected, !locked, choice.title, { editFields(mapOf("viewSectionIds" to draftValue(choice.viewSectionIds))) }) { color ->
                    Text(choice.title, style = rnText(14, 400), color = color)
                }
            }
        }
    }
}

/** RN's CollapsibleSection: a top rule, the chevron, the title in capitals, and core's badge. Open state lasts while the editor is open. */
@Composable
private fun CollapsibleSection(editorId: String, section: EditorSection, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalTheme.current.colors
    var open by rememberSaveable(editorId, section.id) { mutableStateOf(section.open) }
    val title = t(section.titleKey!!)
    Column(Modifier.padding(top = 8.dp).hairline(c.border, top = true)) {
        Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = t(if (open) "markdown.collapse" else "markdown.expand")) { open = !open }
            .semantics { contentDescription = title; heading() }.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
            Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 0.6f), color = c.text, modifier = Modifier.padding(start = 8.dp).weight(1f))
            if (section.filledCount > 0) Box(Modifier.clip(RoundedCornerShape(10.dp)).background(c.tint).padding(horizontal = 8.dp, vertical = 2.dp)) {
                Text("${section.filledCount}", style = rnText(12, 600), color = c.onTint)
            }
        }
        if (open) Column(Modifier.padding(bottom = 16.dp)) {
            section.help?.let { ContextualHelp(editorId, section.id, it) }
            content()
        }
    }
}

/**
 * RN's ContextualHelp (components/ContextualHelp.tsx) at the top of an editor section: the help icon, closed by default; open, its
 * label, core's hint, Read the guide (its failure line when no app opens it) and a close X. Closing only folds it: RN's stored
 * dismissal changes nothing while no surface reveals help on its own (O2e ruling).
 */
@Composable
private fun ContextualHelp(editorId: String, sectionId: String, help: JSONObject) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    var expanded by rememberSaveable(editorId, sectionId, "help") { mutableStateOf(false) }
    var failed by rememberSaveable(editorId, sectionId, "helpError") { mutableStateOf(false) }
    val label = help.getString("label")
    Column(Modifier.padding(vertical = 4.dp).testTag("contextual-help-$sectionId")) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Top) {
            Row((if (expanded) Modifier.weight(1f) else Modifier).heightIn(min = 44.dp).widthIn(min = 44.dp).clip(RoundedCornerShape(8.dp))
                .clickable(role = Role.Button) { expanded = !expanded }
                // RN's accessibilityState={{ expanded }}, worded as the app's other folding rows (Details, the review groups).
                .semantics { contentDescription = label; stateDescription = t(if (expanded) "markdown.collapse" else "markdown.expand") }
                .padding(8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, if (expanded) Alignment.Start else Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.CircleHelp, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                if (expanded) Text(label, style = rnText(14, 400), color = c.secondaryText)
            }
            if (expanded) Box(Modifier.size(44.dp).clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button) { expanded = false }
                .semantics { contentDescription = help.getString("dismiss") }, contentAlignment = Alignment.Center) {
                Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
            }
        }
        if (expanded) Column(Modifier.padding(start = 8.dp, end = 8.dp, bottom = 4.dp)) {
            Text(help.getString("body"), style = rnText(14, 400, 21), color = c.secondaryText)
            val openGuide = { failed = runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, help.getString("guideUrl").toUri())) }.isFailure }
            Row(Modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(8.dp)).clickable(onClick = openGuide).padding(8.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(guideLink(help.getString("readGuide"), c.tint, openGuide), style = rnText(14, 400), color = c.tint)
                Icon(HelpExternalLink, null, tint = c.tint, modifier = Modifier.size(14.dp))
            }
            if (failed) Text(help.getString("guideError"), style = rnText(14, 400), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        }
    }
}

/** RN's ContextualHelp draws ExternalLink at lucide's default stroke 2. */
private val HelpExternalLink = lucide("ExternalLink", "M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6")

@Composable
internal fun FormGroup(content: @Composable ColumnScope.() -> Unit) = Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), content = content)

/** RN's FieldHeading: the glyph and the label in capitals, both in the secondary text color. */
@Composable
internal fun FieldHeading(icon: ImageVector, label: String, modifier: Modifier = Modifier, bottom: Int = 8) {
    val c = LocalTheme.current.colors
    Row(modifier.padding(bottom = bottom.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
        Text(label.uppercase(), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(start = 6.dp))
    }
}

/** RN's text input: 12 padding, radius 10, 16 text, the input background and border. [description] names it for TalkBack. */
@Composable
private fun EditorInput(value: String, onChange: (String) -> Unit, placeholder: String?, enabled: Boolean, singleLine: Boolean = false,
                        minHeight: Int = 0, description: String? = null, tag: String? = null) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    // One text-and-cursor state, the only one the field and the keyboard see. Text the app puts in (a chosen
    // suggestion or quick chip) replaces it at once with the cursor at its true end and no composing region, as
    // RN's TextInput does, so the next token types after ", ". Keyboard and IME cursor moves are kept as they come.
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (field.text != value) field = TextFieldValue(value, TextRange(value.length))
    BasicTextField(field, { typed -> field = typed; if (typed.text != value) onChange(typed.text) }, enabled = enabled, singleLine = singleLine, textStyle = rnText(16, 400).copy(color = if (enabled) c.text else c.secondaryText),
        cursorBrush = SolidColor(c.tint),
        modifier = Modifier.fillMaxWidth().heightIn(min = minHeight.dp).clip(shape).background(c.inputBg).border(1.dp, c.border, shape)
            .then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier),
        decorationBox = { inner ->
            Box(Modifier.padding(12.dp)) {
                if (value.isEmpty() && placeholder != null) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                inner()
            }
        })
}

/**
 * RN's chip (statusChip): the tint when active, else the filter background, with a border; 44 high.
 * [content] draws in the chip's text color. A one-of-many choice (the default) is selectable, so TalkBack
 * says "selected" as RN does and the checks read `selected`; an on/off chip ([toggle]) is toggleable.
 */
@Composable
private fun Chip(active: Boolean, enabled: Boolean, description: String, onClick: () -> Unit, modifier: Modifier = Modifier,
                 shape: RoundedCornerShape = RoundedCornerShape(16.dp), compact: Boolean = false, horizontal: Int = if (compact) 10 else 12,
                 toggle: Boolean = false, content: @Composable (androidx.compose.ui.graphics.Color) -> Unit) {
    val c = LocalTheme.current.colors
    Row(modifier.fade(if (enabled || active) 1f else 0.6f).heightIn(min = 44.dp).clip(shape).background(if (active) c.tint else c.filterBg).border(1.dp, if (active) c.tint else c.border, shape)
        // One node for TalkBack and the checks: the click, the label, and the state.
        .semantics { contentDescription = description }
        .then(if (toggle) Modifier.toggleable(value = active, enabled = enabled, role = Role.Button, onValueChange = { onClick() })
            else Modifier.selectable(selected = active, enabled = enabled, role = Role.Tab, onClick = onClick))
        .padding(horizontal = horizontal.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = if (compact) Arrangement.Center else Arrangement.Start) {
        content(if (active) c.onTint else c.secondaryText)
    }
}

/** RN's None chip (CircleSlash) and one chip per value core offers, with [icon] and core's label. */
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

/** RN's compact picker row: the glyph and label at the left, the value in the tint at the right. */
@Composable
private fun CompactRow(icon: ImageVector, label: String, value: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(shape).background(c.filterBg).border(1.dp, c.border, shape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = "$label: $value" }
        .padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
        Text(label.uppercase(), style = rnText(13, 700, 17), color = c.secondaryText, modifier = Modifier.padding(start = 6.dp))
        Text(value, style = rnText(14, 700, 18), color = c.tint, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End,
            modifier = Modifier.weight(1f).padding(start = 12.dp))
    }
}

@Composable
private fun DateButton(text: String, label: String, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.clip(shape).background(c.inputBg).border(1.dp, c.border, shape).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = "$label: $text" }.padding(12.dp)) {
        Text(text, style = rnText(14, 400), color = c.text)
    }
}

/** RN's clearDateBtn: a small filter-background button beside a date or section. */
@Composable
private fun SmallButton(icon: ImageVector, description: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.padding(start = 8.dp).size(44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Box(Modifier.clip(shape).background(c.filterBg).border(1.dp, c.border, shape).padding(horizontal = 10.dp, vertical = 8.dp)) {
            Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
        }
    }
}

/** RN's switch row (Skip reminders, Show future occurrences): the label, the hint, and the tint border when on. */
@Composable
internal fun SwitchRow(label: String, hint: String, on: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(if (on) c.filterBg else c.cardBg).border(1.dp, if (on) c.tint else c.border, shape)
        .toggleable(value = on, enabled = enabled, role = Role.Switch, onValueChange = { onToggle() }).padding(12.dp)) {
        Text(label, style = rnText(13, 600), color = c.text)
        Text(hint, style = rnText(12, 400, 16), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
    }
}

/** RN's token suggestion menu: core's matches; a tap puts core's `text` in the field. */
@Composable
private fun SuggestionMenu(matches: List<Pair<String, String>>, enabled: Boolean, choose: (String) -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shape = RoundedCornerShape(10.dp)
    // The menu opens under the field, where the keyboard can cover it: scroll it into view (run 48's tap hit the keyboard).
    val reveal = remember { BringIntoViewRequester() }
    LaunchedEffect(matches) { reveal.bringIntoView() }
    Column(Modifier.bringIntoViewRequester(reveal).padding(top = 8.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)) {
        matches.forEachIndexed { index, (value, text) ->
            Text(value, style = rnText(14, 500), color = c.text, modifier = Modifier.fillMaxWidth()
                .clickable(enabled = enabled, role = Role.Button) { choose(text) }
                .then(if (index < matches.size - 1) Modifier.hairline(theme.divider, top = false) else Modifier)
                .padding(horizontal = 12.dp, vertical = 10.dp))
        }
    }
}

/**
 * RN's waiting prompt (TaskEditWaitingAssignmentModal): the question, its hint, the person field
 * with core's people suggestions, Cancel and Save. Save sets Waiting and the person together.
 */
@Composable
private fun WaitingPrompt(model: InboxViewModel, text: String, locked: Boolean) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler { closeWaitingPrompt() }
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { closeWaitingPrompt() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
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

/** RN's picker modal (TaskEditDestinationPicker, TaskEditSectionPicker): a card over a dimmed screen, the list, and Cancel. Search and "New …" are not built. */
@Composable
private fun PickerDialog(title: String, dismiss: () -> Unit, items: @Composable ColumnScope.() -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler(onBack = dismiss)
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { dismiss() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp)) {
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.heightIn(max = 260.dp).fillMaxWidth().clip(shape).background(c.inputBg).border(1.dp, c.border, shape)
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
private fun PickerItem(text: String, tag: String? = null, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClick)
        .then(if (tag != null) Modifier.testTag(tag) else Modifier).padding(horizontal = 14.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
        Text(text, style = rnText(16, 400), color = c.text)
    }
}

@Composable
private fun PickerHeading(text: String) {
    Text(text, style = rnText(16, 700), color = LocalTheme.current.colors.secondaryText, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
}
