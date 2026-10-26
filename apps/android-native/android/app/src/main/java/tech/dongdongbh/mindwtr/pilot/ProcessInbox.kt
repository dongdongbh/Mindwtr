package tech.dongdongbh.mindwtr.pilot

import android.content.Intent
import android.content.SharedPreferences
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/*
 * RN's Process Inbox (components/inbox-processing-modal.tsx and inbox-processing/), drawn from core's
 * step view (getInboxProcessingStep): every label, choice, chip, date and suggestion is core's, and
 * each chip carries the exact edit core takes back. Kotlin keeps only what RN's screen keeps: the
 * typed text, the open note, and which date picker is up.
 */

/** RN's INBOX_PROCESSING_MODE_STORAGE_KEY: guided or quick, per device, never synced. */
const val PROCESSING_MODE_KEY = "mindwtr:view:inboxProcessingMode:v1"

/** RN's readInboxProcessingMode: anything else is guided. */
fun readProcessingMode(prefs: SharedPreferences): String =
    prefs.getString(PROCESSING_MODE_KEY, null)?.takeIf { it == "guided" || it == "quick" } ?: "guided"

/** The two answer commands: a step's choice and Skip. */
val STEP_KINDS = setOf("inboxCommit", "inboxSkip")

/**
 * Process Inbox on screen: core's session, its step view, and an answer whose outcome is unknown
 * ([pending], its exact request). [edits] are control edits with core or waiting for it, sent one at
 * a time; [queued] is an answer tapped while they were. A [hidden] record has no screen: after process
 * death the app lands on the Inbox while the owed request is sent again, and the record stays on disk
 * until core acknowledges or refuses it.
 */
data class InboxProcessing(
    val sessionId: String,
    val view: JSONObject,
    val pending: FailedAction? = null,
    val edits: List<JSONObject> = emptyList(),
    val queued: Pair<String, String>? = null,
    val hidden: Boolean = false,
) {
    val taskId: String get() = view.getString("taskId")
    val step: String get() = view.getString("step")

    fun state(): JSONObject = JSONObject().put("sessionId", sessionId).put("view", view).put("hidden", hidden).put("pending", pending?.let {
        JSONObject().put("kind", it.kind).put("id", it.id).put("title", it.title).put("patch", JSONObject(it.patch))
    } ?: JSONObject.NULL)

    companion object {
        /** Core's startInboxProcessing reply; null when the queue is empty. */
        fun started(reply: JSONObject): InboxProcessing? =
            reply.optJSONObject("view")?.let { InboxProcessing(reply.getString("sessionId"), it) }

        fun restore(saved: JSONObject): InboxProcessing = InboxProcessing(saved.getString("sessionId"), saved.getJSONObject("view"),
            saved.optJSONObject("pending")?.let { action ->
                val patch = action.getJSONObject("patch")
                FailedAction(action.getString("kind"), action.getString("id"), action.getString("title"),
                    patch = patch.keys().asSequence().associateWith<String, String?> { patch.getString(it) })
            }, hidden = saved.optBoolean("hidden"))
    }
}

/** The screen state in the app's no-backup folder: each write is synced and renamed into place, like the editor's draft. */
class ProcessingStore(private val dir: File) {
    private val file = File(dir, "processing")
    fun read(): InboxProcessing? = runCatching { InboxProcessing.restore(JSONObject(file.readText())) }.getOrNull()
    fun write(state: JSONObject) {
        dir.mkdirs()
        val partial = File(dir, "processing-partial")
        FileOutputStream(partial).use { out -> out.write(state.toString().toByteArray()); out.fd.sync() }
        check(partial.renameTo(file)) { "Cannot save Process Inbox" }
    }
    fun delete() { file.delete() }
}

private fun JSONObject.text(name: String): String? = if (!has(name) || isNull(name)) null else getString(name)
private fun JSONObject.items(name: String): List<JSONObject> = optJSONArray(name)?.let { list -> List(list.length()) { list.getJSONObject(it) } }.orEmpty()
private fun JSONObject.child(name: String): JSONObject? = if (!has(name) || isNull(name)) null else getJSONObject(name)

/** RN's CHOICE_ICONS (InboxStepFlow), keyed by core's choice icon. */
private val CHOICE_ICONS = mapOf("done" to Lucide.CheckCircle2, "project" to Lucide.Folder, "later" to Lucide.Clock3,
    "delegate" to Lucide.UserRound, "someday" to Lucide.CircleArrowUp, "incubate" to Lucide.CalendarClock, "reference" to Lucide.Book)

/** RN's step layout: the entry questions lay their choices out in two columns (InboxStepFlow renderPrompt). */
private val GRID_STEPS = setOf("decisions", "actionable")

/**
 * RN's full-screen Process Inbox: the progress header (Close, progress, the mode switch, Skip), the item's
 * card, the step, Back, RN's inline toast, and File it. While an answer's retry is owed only that answer
 * runs, the screen is locked, and Back is left to the system.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun ProcessInboxScreen(model: InboxViewModel, flow: InboxProcessing) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = flow.view
    val failed = failedAction != null
    val locked = busy || failed
    val send = { edit: JSONObject -> editStep(JSONObject().put("edit", edit)) }
    val canAnswer = { kind: String, choice: String ->
        writable && !busy && (failedAction == null || (failedAction == flow.pending && flow.pending?.kind == kind && flow.pending.title == choice))
    }
    var pickDate by rememberSaveable { mutableStateOf<String?>(null) }
    BackHandler(enabled = !failed) { if (!busy) closeProcessing() }
    // Edits and a queued answer wait while an action runs; they go on once none does.
    LaunchedEffect(busy, failed) { if (!busy && !failed) pumpStep() }
    // Each new question or item starts at the top, as RN's scrollProcessingToTop after every answer (#1445). The question last
    // shown survives a recreation (a rotation, a theme change), which keeps the user's place.
    val scroll = rememberScrollState()
    var shownTask by rememberSaveable { mutableStateOf<String?>(null) }
    var shownStep by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(flow.taskId, flow.step) {
        when (stepScroll(shownTask, shownStep, flow.taskId, flow.step)) {
            StepScroll.Animate -> scroll.animateScrollTo(0)
            StepScroll.Jump -> scroll.scrollTo(0)
            StepScroll.Keep -> {}
        }
        shownTask = flow.taskId
        shownStep = flow.step
    }

    Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("process-inbox")) {
        ProgressHeader(model, flow, canAnswer("inboxSkip", ""), locked)
        error?.let { message -> FailureBanner(message) { OwedRetry(model) } }
        Column(Modifier.weight(1f).fillMaxWidth().imePadding()) {
            Column(Modifier.weight(1f).verticalScroll(scroll).padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 16.dp)) {
                CaptureCard(flow, locked, send)
                StepBody(model, flow, locked, send, canAnswer) { pickDate = it }
                view.text("back")?.let { label ->
                    Box(Modifier.padding(top = 18.dp).heightIn(min = 44.dp).clickable(enabled = canAnswer("inboxCommit", "back"), role = Role.Button) {
                        answer("inboxCommit", "back")
                    }.padding(end = 12.dp), contentAlignment = Alignment.CenterStart) {
                        Text(label, style = rnText(14, 600), color = c.secondaryText)
                    }
                }
            }
            // RN reserves the toast's room above the footer, so feedback never covers a decision.
            ToastCard(model, Modifier.padding(bottom = 8.dp))
            view.text("fileIt")?.let { label ->
                Box(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 10.dp)) {
                    FilledButton(label, canAnswer("inboxCommit", "fileIt"), Modifier.fillMaxWidth()) { answer("inboxCommit", "fileIt") }
                }
            }
        }
    }

    AIOverlays(model)
    pickDate?.let { field ->
        val row = dateRows(view).firstOrNull { it.getString("field") == field }
        // The row's own picked-day edit (core's setPickedDate) with the picker's day; the row's clock picks a time.
        DayPickerDialog(row?.text("date"), { pickDate = null }) { day ->
            row?.let { send(JSONObject(it.getJSONObject("pick").toString()).put("day", day)) }
        }
    }
}

/** How Process Inbox's page scrolls when it shows a question: as it was, back to the top with RN's animation, or at once. */
internal enum class StepScroll { Keep, Animate, Jump }

/**
 * RN's scrollProcessingToTop (#1445): a new item jumps to the top, a new question on the same item scrolls there animated, and
 * the question already shown ([shownTask], [shownStep]: a recreated screen, after a rotation or a theme change) keeps its place.
 */
internal fun stepScroll(shownTask: String?, shownStep: String?, taskId: String, step: String): StepScroll = when {
    shownTask == null || (shownTask == taskId && shownStep == step) -> StepScroll.Keep
    shownTask != taskId -> StepScroll.Jump
    else -> StepScroll.Animate
}

/** Every date row the view shows: the step's own, the delegate's follow-up, and More options' scheduling. */
private fun dateRows(view: JSONObject): List<JSONObject> = listOfNotNull(view.child("dateRow"), view.child("delegate")?.child("followUp")) +
    (view.child("moreOptions")?.child("scheduling")?.items("rows") ?: emptyList())

/** RN's progress header: Close at the left, core's progress label and bar, then the mode switch and Skip. */
@Composable
private fun ProgressHeader(model: InboxViewModel, flow: InboxProcessing, canSkip: Boolean, locked: Boolean) = with(model) {
    val c = LocalTheme.current.colors
    val view = flow.view
    val progress = view.getJSONObject("progress")
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).hairline(c.border, top = false).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        val close = t("common.close")
        Box(Modifier.widthIn(min = 72.dp).heightIn(min = 44.dp).clickable(enabled = !locked, role = Role.Button) { closeProcessing() }
            .semantics { contentDescription = close }, contentAlignment = Alignment.CenterStart) {
            Icon(Lucide.X, null, tint = c.text, modifier = Modifier.size(22.dp).fade(if (locked) 0.5f else 1f))
        }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(progress.getString("label"), style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 4.dp))
            val total = progress.getInt("total")
            val done = if (total > 0) progress.getInt("processed").toFloat() / total else 0f
            Box(Modifier.fillMaxWidth(0.7f).height(4.dp).clip(RoundedCornerShape(2.dp)).background(c.border)) {
                Box(Modifier.fillMaxWidth(done).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(c.tint))
            }
        }
        val quick = view.getString("mode") == "quick"
        val modeLabel = view.getString("modeToggleLabel")
        Box(Modifier.size(44.dp).clickable(enabled = !locked, role = Role.Button) { switchProcessingMode(if (quick) "guided" else "quick") }
            .semantics { contentDescription = modeLabel }, contentAlignment = Alignment.Center) {
            Icon(if (quick) Lucide.LayoutList else Lucide.Layers, null, tint = c.tint, modifier = Modifier.size(20.dp))
        }
        val skip = view.getString("skip")
        Box(Modifier.widthIn(min = 72.dp).heightIn(min = 44.dp).clickable(enabled = canSkip, role = Role.Button) { answer("inboxSkip", "") }
            .semantics { contentDescription = skip }, contentAlignment = Alignment.CenterEnd) {
            Text(skip, style = rnText(16, 600), color = c.tint, modifier = Modifier.fade(if (canSkip) 1f else 0.5f))
        }
    }
}

/**
 * A text field whose value core's draft holds. The typed text stays as typed; core's value replaces it only
 * when it changes and no edit is still with core, so an older reply never resets newer typing.
 */
@Composable
private fun DraftInput(key: String, coreValue: String, pending: Boolean, placeholder: String?, description: String, enabled: Boolean,
                       modifier: Modifier, style: TextStyle, singleLine: Boolean = true, minLines: Int = 1,
                       onDone: (() -> Unit)? = null, send: (String) -> Unit) {
    val c = LocalTheme.current.colors
    var field by remember(key) { mutableStateOf(TextFieldValue(coreValue, TextRange(coreValue.length))) }
    // While the field has focus the typing wins: `pending` is read from an older frame, so a reply to an earlier keystroke could
    // reset the text mid-typing (the checklist field lost letters that way, S23 run 54).
    var typing by remember(key) { mutableStateOf(false) }
    // Keyed on `pending` too: a value core set while a later edit still waited (AI Clarify's title, then its context) shows once
    // that edit is answered, though the value itself did not change again.
    LaunchedEffect(key, coreValue, typing, pending) { if (!typing && !pending && field.text != coreValue) field = TextFieldValue(coreValue, TextRange(coreValue.length)) }
    BasicTextField(field, { typed -> val changed = typed.text != field.text; field = typed; if (changed) send(typed.text) },
        enabled = enabled, singleLine = singleLine, minLines = minLines, textStyle = style.copy(color = if (enabled) c.text else c.secondaryText),
        cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = if (onDone != null) ImeAction.Done else ImeAction.Default),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        modifier = modifier.onFocusChanged { typing = it.isFocused }.semantics { contentDescription = description },
        decorationBox = { inner ->
            Box {
                if (field.text.isEmpty() && placeholder != null) Text(placeholder, style = style, color = c.secondaryText)
                inner()
            }
        })
}

/** RN's bordered input (waitingInput, projectSearchInput, contextInput): radius 10, 10 by 8 padding. */
private fun Modifier.inputBox(c: ThemeColors, filled: Boolean = false) =
    fillMaxWidth().clip(RoundedCornerShape(10.dp)).then(if (filled) Modifier.background(c.inputBg) else Modifier)
        .rnBorder(1.dp, c.border, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp, vertical = 10.dp)

/** RN's InboxCaptureCard: the returning mark, the editable title, similar tasks, the note preview, and the note toggle. */
@Composable
private fun InboxViewModel.CaptureCard(flow: InboxProcessing, locked: Boolean, send: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    val capture = flow.view.getJSONObject("capture")
    val pending = flow.edits.isNotEmpty()
    var notesOpen by rememberSaveable(flow.taskId) { mutableStateOf(false) }
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.padding(bottom = 20.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        capture.text("returningLabel")?.let { label ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.CalendarClock, null, tint = c.secondaryText, modifier = Modifier.size(13.dp))
                Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(start = 4.dp))
            }
        }
        val titleLabel = capture.getString("titleLabel")
        DraftInput("${flow.taskId}:title", capture.getString("title"), pending, titleLabel, titleLabel, !locked, Modifier.fillMaxWidth().testTag("process-title"),
            rnText(17, 700, 24), singleLine = false) { send(JSONObject().put("type", "set").put("field", "title").put("value", it)) }
        val similar = capture.items("similarTasks")
        if (similar.isNotEmpty()) Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(capture.getString("similarTasksLabel"), style = rnText(12, 600), color = c.secondaryText)
            for (task in similar) Column {
                Text(task.getString("title"), style = rnText(13, 400, 18), color = c.text)
                Text(task.getString("meta"), style = rnText(11, 400, 15), color = c.secondaryText)
            }
        }
        val note = capture.getString("description")
        val preview = capture.getString("notePreview")
        // Core's Markdown-free preview, as RN shows it.
        if (!notesOpen && preview.isNotEmpty()) Text(preview, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 2)
        val noteLabel = capture.getString("descriptionLabel")
        // RN's anchorActionsRow: the notes toggle, and AI Clarify while AI is on (its spinner and "Working..." while it runs).
        val focus = LocalFocusManager.current
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.heightIn(min = 32.dp).clickable(role = Role.Button) { notesOpen = !notesOpen }
                .semantics { contentDescription = noteLabel }, verticalAlignment = Alignment.CenterVertically) {
                Text(noteLabel, style = rnText(12, 600), color = c.tint)
                Icon(if (notesOpen) Lucide.ChevronUp else Lucide.ChevronDown, null, tint = c.tint, modifier = Modifier.padding(start = 4.dp).size(14.dp))
            }
            flow.view.child("aiClarify")?.let { clarify ->
                val running = ai.working == "inbox"
                val label = if (running) clarify.getString("working") else clarify.getString("label")
                val enabled = !locked && ai.working == null
                Row(Modifier.heightIn(min = 32.dp).clickable(enabled = enabled, role = Role.Button) { focus.clearFocus(); ai.inboxClarify(flow) }
                    .semantics { contentDescription = label }.testTag("process-ai-clarify"),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (running) CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
                    else Icon(Lucide.Sparkles, null, tint = c.tint, modifier = Modifier.size(14.dp))
                    Text(label, style = rnText(12, 600), color = c.tint)
                }
            }
        }
        if (notesOpen) {
            DraftInput("${flow.taskId}:description", note, pending, capture.getString("descriptionPlaceholder"), noteLabel, !locked,
                Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(c.bg).rnBorder(1.dp, c.border, RoundedCornerShape(10.dp))
                    .padding(horizontal = 12.dp, vertical = 10.dp), rnText(14, 400), singleLine = false, minLines = 4) {
                send(JSONObject().put("type", "set").put("field", "description").put("value", it))
            }
            Text(capture.getString("refineHint"), style = rnText(13, 400, 18), color = c.secondaryText)
        }
    }
}

/** The step, in RN's order: its question and choices, the date row, the delegate section, project and contexts, Someday sections, More options. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StepBody(model: InboxViewModel, flow: InboxProcessing, locked: Boolean, send: (JSONObject) -> Unit,
                     canAnswer: (String, String) -> Boolean, pickDate: (String) -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    val view = flow.view
    view.text("question")?.let { Text(it, style = rnText(18, 700), color = c.text, modifier = Modifier.padding(bottom = 6.dp).semantics { heading() }) }
    view.text("hint")?.let { Text(it, style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp)) }
    val choices = view.items("choices")
    val main = choices.filterNot { it.getBoolean("danger") }
    if (main.isNotEmpty()) {
        val grid = view.getString("step") in GRID_STEPS
        Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (row in main.chunked(if (grid) 2 else 1)) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (choice in row) ChoiceButton(choice, grid, canAnswer("inboxCommit", choice.getString("id")), Modifier.weight(1f)) {
                    answer("inboxCommit", choice.getString("id"))
                }
                if (grid && row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
    for (choice in choices.filter { it.getBoolean("danger") }) {
        val id = choice.getString("id")
        val label = choice.getString("label")
        Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.Center) {
            val enabled = canAnswer("inboxCommit", id)
            Row(Modifier.heightIn(min = 44.dp).button(label, enabled) { answer("inboxCommit", id) }
                .clickable(enabled = enabled, role = Role.Button) { answer("inboxCommit", id) }.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.Trash2, null, tint = c.danger, modifier = Modifier.size(16.dp))
                Text(label, style = rnText(14, 600), color = c.danger, modifier = Modifier.padding(start = 6.dp))
            }
        }
    }
    view.child("dateRow")?.let { DateRow(it, locked, send, pickDate) }
    view.child("delegate")?.let { DelegateSection(flow, it, locked, send, pickDate) }
    val project = view.child("project")?.let { @Composable { ProjectSection(flow, it, locked, send, canAnswer) } }
    val contexts = view.child("contexts")?.let { @Composable { TokenSection(flow, it, locked, send) } }
    if (view.getBoolean("projectFirst")) { project?.invoke(); contexts?.invoke() } else { contexts?.invoke(); project?.invoke() }
    view.child("somedaySections")?.let { sections ->
        Column(Modifier.padding(top = 18.dp)) {
            Text(sections.getString("label"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp))
            FlowRow(Modifier.padding(top = 12.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (option in sections.items("options")) {
                    val on = option.getBoolean("selected")
                    val label = option.getString("label")
                    val shape = RoundedCornerShape(12.dp)
                    Box(Modifier.weight(1f).widthIn(min = 96.dp).heightIn(min = 48.dp).clip(shape).background(if (on) c.tint else c.cardBg)
                        .rnBorder(1.dp, if (on) c.tint else c.border, shape).semantics { contentDescription = label }
                        .selectable(selected = on, enabled = !locked, role = Role.Tab) { send(option.getJSONObject("edit")) }
                        .padding(horizontal = 10.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(label, style = rnText(14, 600), color = if (on) c.onTint else c.text, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
    view.child("moreOptions")?.let { MoreOptions(flow, it, locked, send, pickDate) }
}

/**
 * One accessibility node per button: its label, role and state together. A `.clickable` followed by a separate
 * `.semantics { contentDescription }` splits into two nodes, and the labelled one reads enabled while the button is
 * locked (S23 run 50: "Yes" announced enabled during an owed retry).
 */
private fun Modifier.button(label: String, enabled: Boolean, action: () -> Unit) = clearAndSetSemantics {
    contentDescription = label
    role = Role.Button
    if (enabled) onClick { action(); true } else disabled()
}

/** RN's ChoiceButton: a card-colored button with core's glyph and label. */
@Composable
private fun ChoiceButton(choice: JSONObject, compact: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val label = choice.getString("label")
    val shape = RoundedCornerShape(14.dp)
    Row(modifier.fade(if (enabled) 1f else 0.5f).heightIn(min = if (compact) 48.dp else 52.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .button(label, enabled, onClick).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(horizontal = if (compact) 12.dp else 16.dp, vertical = if (compact) 10.dp else 12.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        choice.text("icon")?.let(CHOICE_ICONS::get)?.let { Icon(it, null, tint = c.text, modifier = Modifier.padding(end = 8.dp).size(18.dp)) }
        Text(label, style = rnText(16, 600), color = c.text, textAlign = TextAlign.Center)
    }
}

/** RN's filled call to action (File it, Create project, Create). */
@Composable
private fun FilledButton(label: String, enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Box(modifier.fade(if (enabled) 1f else 0.5f).heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(theme.filledBg)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(horizontal = 12.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(16, 700), color = theme.filledText)
    }
}

/** A step section with RN's bottom rule (singleSection). */
@Composable
private fun Section(content: @Composable ColumnScope.() -> Unit) {
    val c = LocalTheme.current.colors
    Column(Modifier.padding(bottom = 18.dp).fillMaxWidth().hairline(c.border, top = false).padding(bottom = 18.dp), content = content)
}

@Composable
private fun SectionTitle(icon: ImageVector?, text: String) {
    val c = LocalTheme.current.colors
    Row(Modifier.padding(bottom = 6.dp).heightIn(min = 28.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { Icon(it, null, tint = c.text, modifier = Modifier.padding(end = 8.dp).size(20.dp)) }
        Text(text, style = rnText(18, 700), color = c.text, modifier = Modifier.semantics { heading() })
    }
}

/** RN's small outlined button (startDateButton, startDateClear). */
@Composable
private fun SmallOutlined(text: String, description: String, enabled: Boolean, filled: Boolean, icon: ImageVector? = null, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.clip(shape).then(if (filled) Modifier.background(c.cardBg) else Modifier).rnBorder(1.dp, c.border, shape)
        .button(description, enabled, onClick).clickable(enabled = enabled, role = Role.Button, onClick = onClick)
        .padding(horizontal = 10.dp, vertical = 8.dp)) {
        if (icon != null) Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
        else Text(text, style = rnText(if (filled) 13 else 12, 400), color = if (filled) c.text else c.secondaryText)
    }
}

/**
 * RN's InboxDateSelectorRow: the label, the date button (the system date picker), Clear, the clock (the system time picker, #1445),
 * the time mode, and core's quick dates.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DateRow(row: JSONObject, locked: Boolean, send: (JSONObject) -> Unit, pickDate: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val label = row.getString("label")
    Column(Modifier.padding(vertical = 12.dp)) {
        Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(bottom = 6.dp))
        FlowRow(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
            itemVerticalAlignment = Alignment.CenterVertically) {
            val display = row.getString("display")
            SmallOutlined(display, "$label: $display", !locked, filled = true) { pickDate(row.getString("field")) }
            val context = LocalContext.current
            row.child("clear")?.let { SmallOutlined(it.getString("label"), "$label: ${it.getString("label")}", !locked, filled = false) { send(it.getJSONObject("edit")) } }
            row.child("time")?.let { time ->
                SmallOutlined("", "$label: ${time.getString("label")}", !locked, filled = false, icon = Lucide.Clock) {
                    pickTime(context, time) { picked -> send(JSONObject(time.getJSONObject("edit").toString()).put("value", picked)) }
                }
            }
            row.child("timeMode")?.let { SmallOutlined(it.getString("label"), "$label: ${it.getString("label")}", !locked, filled = false) { send(it.getJSONObject("edit")) } }
        }
        FlowRow(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (chip in row.items("quickDates")) {
                val on = chip.getBoolean("selected")
                val text = chip.getString("label")
                val shape = RoundedCornerShape(999.dp)
                Box(Modifier.weight(1f).widthIn(min = 92.dp).heightIn(min = 34.dp).clip(shape).background(if (on) c.tint else c.filterBg)
                    .rnBorder(1.dp, if (on) c.tint else c.border, shape).semantics { contentDescription = "$label: $text" }
                    .selectable(selected = on, enabled = !locked, role = Role.Tab) { send(chip.getJSONObject("edit")) }
                    .padding(horizontal = 10.dp, vertical = 7.dp), contentAlignment = Alignment.Center) {
                    Text(text, style = rnText(12, 600), color = if (on) c.onTint else c.secondaryText, textAlign = TextAlign.Center, maxLines = 2)
                }
            }
        }
    }
}

/** RN's InboxSuggestionList: core's suggestions; a tap sends the edit core put on each. */
@Composable
private fun Suggestions(options: List<JSONObject>, locked: Boolean, send: (JSONObject) -> Unit) {
    if (options.isEmpty()) return
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.padding(top = 8.dp, bottom = 8.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (option in options) {
            Text(option.getString("label"), style = rnText(13, 600), color = c.text, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                .clickable(enabled = !locked, role = Role.Button) { send(option.getJSONObject("edit")) }.padding(horizontal = 10.dp, vertical = 8.dp))
        }
    }
}

/** RN's InboxExecutionSection: who, core's people, the follow-up date, and the hand-off message through the system share sheet. */
@Composable
private fun DelegateSection(flow: InboxProcessing, delegate: JSONObject, locked: Boolean, send: (JSONObject) -> Unit, pickDate: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    SectionTitle(Lucide.UserRound, delegate.getString("title"))
    Text(delegate.getString("hint"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp))
    val whoLabel = delegate.getString("whoLabel")
    Text(whoLabel, style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 4.dp))
    DraftInput("${flow.taskId}:delegateWho", delegate.getString("who"), flow.edits.isNotEmpty(), delegate.getString("whoPlaceholder"), whoLabel,
        !locked, Modifier.inputBox(c), rnText(14, 400)) { send(JSONObject().put("type", "set").put("field", "delegateWho").put("value", it)) }
    Suggestions(delegate.items("whoSuggestions"), locked, send)
    delegate.child("followUp")?.let { DateRow(it, locked, send, pickDate) }
    val request = delegate.getJSONObject("request")
    val shape = RoundedCornerShape(12.dp)
    Box(Modifier.padding(top = 12.dp).fillMaxWidth().heightIn(min = 44.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .clickable(role = Role.Button) {
            context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, request.getString("subject")).putExtra(Intent.EXTRA_TEXT, request.getString("message")), null))
        }.padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(delegate.getString("sendLabel"), style = rnText(14, 600), color = c.text)
    }
}

/** RN's projectChip: selected on the filter background with a tint border; an area or project dot, none for "No area" and "No project". */
@Composable
private fun OptionChip(option: JSONObject, prefix: String, locked: Boolean, send: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    val on = option.getBoolean("selected")
    val label = option.getString("label")
    val edit = option.getJSONObject("edit")
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.padding(bottom = 8.dp).fillMaxWidth().clip(shape).background(if (on) c.filterBg else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, shape)
        .semantics { contentDescription = "$prefix: $label" }.selectable(selected = on, enabled = !locked, role = Role.Tab) { send(edit) }
        .padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        if (!edit.isNull("value")) Box(Modifier.padding(end = 8.dp).size(8.dp).clip(CircleShape).background(coreColorOrNull(option.text("color")) ?: c.secondaryText))
        Text(label, style = rnText(14, 600), color = c.text)
    }
}

/** RN's InboxProjectSection: the current project, the area picker, the search with Create, and core's projects; or the project conversion card. */
@Composable
private fun InboxViewModel.ProjectSection(flow: InboxProcessing, project: JSONObject, locked: Boolean, send: (JSONObject) -> Unit,
                                          canAnswer: (String, String) -> Boolean) = Section {
    val c = LocalTheme.current.colors
    val pending = flow.edits.isNotEmpty()
    SectionTitle(Lucide.Folder, project.getString("title"))
    val conversion = project.child("conversion")
    val projectLabel = t("taskEdit.projectLabel")
    if (conversion == null) project.child("current")?.let { OptionChip(it, projectLabel, locked, send) }
    project.text("areaLabel")?.let { areaLabel ->
        Text(areaLabel, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(bottom = 6.dp))
        for (area in project.items("areas")) OptionChip(area, areaLabel, locked, send)
    }
    if (conversion != null) {
        val nextLabel = conversion.getString("nextActionLabel")
        Text(nextLabel, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(bottom = 6.dp))
        val titleHint = flow.view.getJSONObject("capture").getString("titleLabel")
        DraftInput("${flow.taskId}:nextAction", conversion.getString("nextAction"), pending, titleHint, nextLabel, !locked, Modifier.inputBox(c, filled = true),
            rnText(14, 400), onDone = { conversion.child("nextActionSubmit")?.let(send) }) {
            send(JSONObject().put("type", "set").put("field", "nextAction").put("value", it))
        }
        conversion.items("rows").forEachIndexed { index, row ->
            Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                DraftInput("${flow.taskId}:action$index", row.getString("value"), pending, titleHint, nextLabel, !locked,
                    Modifier.weight(1f).inputBox(c, filled = true), rnText(14, 400), onDone = { row.child("submit")?.let(send) }) {
                    send(JSONObject().put("type", "setExtraAction").put("index", index).put("value", it))
                }
                val remove = conversion.getString("removeActionLabel")
                Box(Modifier.padding(start = 8.dp).size(36.dp).clickable(enabled = !locked, role = Role.Button) { send(row.getJSONObject("remove")) }
                    .semantics { contentDescription = remove }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                }
            }
        }
        val add = conversion.getJSONObject("addAction")
        Text(add.getString("label"), style = rnText(13, 600), color = c.tint, modifier = Modifier.padding(top = 6.dp)
            .clickable(enabled = !locked, role = Role.Button) { send(add.getJSONObject("edit")) }.padding(vertical = 4.dp))
        FilledButton(conversion.getString("createLabel"), canAnswer("inboxCommit", "createProject"), Modifier.padding(top = 12.dp).fillMaxWidth()) {
            answer("inboxCommit", "createProject")
        }
        return@Section
    }
    project.child("search")?.let { search ->
        Row(Modifier.padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            val submit = { answer("inboxCommit", "submitProjectSearch") }
            DraftInput("${flow.taskId}:projectSearch", search.getString("value"), pending, search.getString("placeholder"), search.getString("label"),
                !locked, Modifier.weight(1f).inputBox(c, filled = true), rnText(14, 400), onDone = submit) {
                send(JSONObject().put("type", "set").put("field", "projectSearch").put("value", it))
            }
            search.text("createLabel")?.let { create ->
                FilledButton(create, canAnswer("inboxCommit", "submitProjectSearch"), Modifier.padding(start = 8.dp), submit)
            }
        }
    }
    for (option in project.items("projects")) OptionChip(option, projectLabel, locked, send)
}

/** RN's InboxContextSection for contexts (on the file step) or tags (in More options): the chosen tokens, the input with +, and core's suggestions. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TokenSection(flow: InboxProcessing, tokens: JSONObject, locked: Boolean, send: (JSONObject) -> Unit) = Section {
    val c = LocalTheme.current.colors
    Text(tokens.getString("title"), style = rnText(18, 700), color = c.text, modifier = Modifier.padding(bottom = 6.dp).semantics { heading() })
    for ((labelName, listName) in listOf("selectedContextsLabel" to "selectedContexts", "selectedTagsLabel" to "selectedTags")) {
        val label = tokens.text(labelName) ?: continue
        Column(Modifier.padding(bottom = 12.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.filterBg).padding(12.dp)) {
            Text(label, style = rnText(12, 400), color = c.tint, modifier = Modifier.padding(bottom = 4.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (chip in tokens.items(listName)) {
                    val text = chip.getString("label")
                    Text(text, style = rnText(12, 400), color = c.onTint, modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(c.tint)
                        .clickable(enabled = !locked, role = Role.Button) { send(chip.getJSONObject("edit")) }.padding(horizontal = 10.dp, vertical = 4.dp))
                }
            }
        }
    }
    val add = tokens.getJSONObject("add")
    val canAdd = !locked && add.getBoolean("enabled")
    Row(Modifier.padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        val placeholder = tokens.getString("placeholder")
        DraftInput("${flow.taskId}:tokenInput", flow.view.getJSONObject("draft").getString("tokenInput"), flow.edits.isNotEmpty(), placeholder,
            tokens.getString("title"), !locked, Modifier.weight(1f).inputBox(c), rnText(14, 400), onDone = { if (canAdd) send(add.getJSONObject("edit")) }) {
            send(JSONObject().put("type", "set").put("field", "tokenInput").put("value", it))
        }
        val addLabel = add.getString("label")
        Box(Modifier.fade(if (add.getBoolean("enabled")) 1f else 0.5f).padding(start = 8.dp).size(44.dp).clip(RoundedCornerShape(10.dp)).background(c.tint)
            .clickable(enabled = canAdd, role = Role.Button) { send(add.getJSONObject("edit")) }.semantics { contentDescription = addLabel },
            contentAlignment = Alignment.Center) {
            Text("+", style = rnText(18, 700), color = c.onTint)
        }
    }
    Suggestions(tokens.items("suggestions"), locked, send)
    for ((labelName, listName) in listOf("contextSuggestionsLabel" to "contextSuggestions", "tagSuggestionsLabel" to "tagSuggestions")) {
        val label = tokens.text(labelName) ?: continue
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.padding(bottom = 8.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(8.dp)) {
            Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(bottom = 6.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (chip in tokens.items(listName)) {
                    val chipShape = RoundedCornerShape(10.dp)
                    Text(chip.getString("label"), style = rnText(13, 600), color = c.text, modifier = Modifier.clip(chipShape).background(c.filterBg)
                        .rnBorder(1.dp, c.border, chipShape).clickable(enabled = !locked, role = Role.Button) { send(chip.getJSONObject("edit")) }
                        .padding(horizontal = 10.dp, vertical = 8.dp))
                }
            }
        }
    }
}

/** RN's More options disclosure: scheduling, organization, and (on the file step) tags. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MoreOptions(flow: InboxProcessing, more: JSONObject, locked: Boolean, send: (JSONObject) -> Unit, pickDate: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val open = more.getBoolean("open")
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.padding(bottom = 18.dp).fillMaxWidth().heightIn(min = 48.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .clickable(enabled = !locked, role = Role.Button) { send(more.getJSONObject("edit")) }.padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(more.getString("label"), style = rnText(15, 600), color = c.text, modifier = Modifier.weight(1f))
        Icon(if (open) Lucide.ChevronUp else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
    }
    more.child("scheduling")?.let { scheduling ->
        Section {
            Text(scheduling.getString("title"), style = rnText(18, 700), color = c.text, modifier = Modifier.padding(bottom = 6.dp).semantics { heading() })
            for (row in scheduling.items("rows")) DateRow(row, locked, send, pickDate)
        }
    }
    more.child("organization")?.let { organization ->
        Section {
            Text(organization.getString("title"), style = rnText(18, 700), color = c.text, modifier = Modifier.padding(bottom = 6.dp).semantics { heading() })
            for ((labelName, listName) in listOf("priorityLabel" to "priorities", "energyLabel" to "energyLevels", "timeEstimateLabel" to "timeEstimates")) {
                val label = organization.text(labelName) ?: continue
                Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp, bottom = 6.dp))
                FlowRow(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    for (option in organization.items(listName)) {
                        val on = option.getBoolean("selected")
                        val text = option.getString("label")
                        val chipShape = RoundedCornerShape(10.dp)
                        Box(Modifier.clip(chipShape).background(if (on) c.tint else c.filterBg).rnBorder(1.dp, if (on) c.tint else c.border, chipShape)
                            .semantics { contentDescription = "$label: $text" }
                            .selectable(selected = on, enabled = !locked, role = Role.Tab) { send(option.getJSONObject("edit")) }
                            .padding(horizontal = 10.dp, vertical = 8.dp)) {
                            Text(text, style = rnText(13, 600), color = if (on) c.onTint else c.text)
                        }
                    }
                }
            }
            organization.text("assignedToLabel")?.let { label ->
                Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp, bottom = 6.dp))
                DraftInput("${flow.taskId}:assignedTo", organization.getString("assignedTo"), flow.edits.isNotEmpty(),
                    organization.getString("assignedToPlaceholder"), label, !locked, Modifier.inputBox(c), rnText(14, 400)) {
                    send(JSONObject().put("type", "set").put("field", "assignedTo").put("value", it))
                }
                Suggestions(organization.items("assignedToSuggestions"), locked, send)
            }
        }
    }
    more.child("tags")?.let { TokenSection(flow, it, locked, send) }
}
