package tech.dongdongbh.mindwtr.pilot

import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.draw.shadow
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/*
 * RN's capture popup (components/quick-capture-sheet.tsx and quick-capture-sheet/), drawn from core's
 * capture view (getQuickCaptureView): every label, chip, preview entry and picker row is core's, and
 * every control carries the exact edit core takes back. Kotlin keeps what RN's popup keeps: the typed
 * text, core's options as core last returned them, which picker is open with its search text, and
 * whether More is open.
 */

/** RN's ADD_ANOTHER_STORAGE_KEY: "Add another" stays on for the next open, per device. */
const val ADD_ANOTHER_KEY = "mindwtr:quickCapture:addAnother"

/** The three answer commands: a capture, several lines, and a project or area picker's create. */
val CAPTURE_KINDS = setOf("capture", "captureLines", "capturePicker")

/** A read of the view with the current text, options and picker (no edit). */
private val READ = JSONObject().put("read", true)

/**
 * The open popup. [view] is core's last view; [options] core's options, sent back with every call. [pending] is
 * an answer whose outcome is unknown (its exact request); [confirm] core's several-lines question with one capture
 * ID per line ([lineIds]); [snapshot] is the recovery snapshot the batch sends, the name as written ([snapshotTaken]:
 * taken, null in sandbox mode). [requests] are reads and edits with core or waiting, sent one at a time; the edits are
 * part of the durable draft and are sent again after process death. [queuedSave] is a Save tapped while they waited
 * ("save" or "edit" for Save and edit). [linesText] is an imported file's text while its several-lines question is open
 * (Create tasks sends it in place of the field's).
 */
data class CaptureDraft(
    val session: String,
    val text: String,
    val options: JSONObject,
    val view: JSONObject,
    val picker: JSONObject? = null,
    val expanded: Boolean = false,
    val captureId: String = UUID.randomUUID().toString(),
    val pickerRequestId: String = UUID.randomUUID().toString(),
    val pending: FailedAction? = null,
    val confirm: JSONObject? = null,
    val lineIds: List<String> = emptyList(),
    val requests: List<JSONObject> = emptyList(),
    val queuedSave: String? = null,
    val snapshot: String? = null,
    val snapshotTaken: Boolean = false,
    val linesText: String? = null,
    /** An opener's preset core reads with every call (RN's initialProps): a project's "+" sends its project and the Next status. */
    val preset: JSONObject? = null,
) {
    /** A read queued behind whatever is queued, unless one is already last. */
    fun reading(): CaptureDraft = if (requests.lastOrNull() === READ) this else copy(requests = requests + READ)

    fun state(): JSONObject = JSONObject().put("session", session).put("text", text).put("options", options).put("view", view)
        .put("picker", picker ?: JSONObject.NULL).put("expanded", expanded).put("captureId", captureId).put("pickerRequestId", pickerRequestId)
        .put("confirm", confirm ?: JSONObject.NULL).put("lineIds", lineIds.joinToString(","))
        .put("edits", org.json.JSONArray().apply { requests.forEach { request -> request.optJSONObject("edit")?.let(::put) } })
        .put("snapshot", snapshot ?: JSONObject.NULL).put("snapshotTaken", snapshotTaken)
        .put("linesText", linesText ?: JSONObject.NULL).put("preset", preset ?: JSONObject.NULL)
        .put("pending", pending?.let { JSONObject().put("kind", it.kind).put("id", it.id).put("title", it.title).put("patch", JSONObject(it.patch)) } ?: JSONObject.NULL)

    companion object {
        fun opened(view: JSONObject) = CaptureDraft(UUID.randomUUID().toString(), "", view.getJSONObject("options"), view)

        fun restore(saved: JSONObject): CaptureDraft = CaptureDraft(
            saved.getString("session"), saved.getString("text"), saved.getJSONObject("options"), saved.getJSONObject("view"),
            saved.optJSONObject("picker"), saved.getBoolean("expanded"), saved.getString("captureId"), saved.getString("pickerRequestId"),
            saved.optJSONObject("pending")?.let { action ->
                val patch = action.getJSONObject("patch")
                FailedAction(action.getString("kind"), action.getString("id"), action.getString("title"),
                    patch = patch.keys().asSequence().associateWith<String, String?> { patch.getString(it) })
            },
            saved.optJSONObject("confirm"), saved.getString("lineIds").split(",").mapNotNull { it.ifEmpty { null } },
            // Edits core had not answered go again, in order.
            requests = saved.optJSONArray("edits")?.let { edits -> List(edits.length()) { JSONObject().put("edit", edits.getJSONObject(it)) } }.orEmpty(),
            snapshot = if (saved.isNull("snapshot")) null else saved.optString("snapshot"), snapshotTaken = saved.optBoolean("snapshotTaken"),
            linesText = if (saved.isNull("linesText")) null else saved.optString("linesText").ifEmpty { null },
            preset = saved.optJSONObject("preset"),
        )
    }
}

/** The popup in the app's no-backup folder: each write synced and renamed into place; the Bundle holds only whether it is open. */
class CaptureStore(private val dir: File) {
    private val file = File(dir, "capture")
    fun read(): CaptureDraft? = runCatching { CaptureDraft.restore(JSONObject(file.readText())) }.getOrNull()
    fun write(state: JSONObject) {
        dir.mkdirs()
        val partial = File(dir, "capture-partial")
        FileOutputStream(partial).use { out -> out.write(state.toString().toByteArray()); out.fd.sync() }
        check(partial.renameTo(file)) { "Cannot save the capture draft" }
    }
    fun delete() { file.delete() }
}

private fun JSONObject.text(name: String): String? = if (!has(name) || isNull(name)) null else getString(name)
private fun JSONObject.child(name: String): JSONObject? = if (!has(name) || isNull(name)) null else getJSONObject(name)
private fun JSONObject.items(name: String): List<JSONObject> = optJSONArray(name)?.let { list -> List(list.length()) { list.getJSONObject(it) } }.orEmpty()

/** RN's Switch at a call site with RN's [props] (MindwtrTheme's *Switch); its touch area is the switch, as RN's. */
@Composable
internal fun RnSwitch(on: Boolean, enabled: Boolean, label: String, props: RnSwitchProps, toggle: () -> Unit) {
    Box(Modifier.toggleable(on, enabled = enabled, role = Role.Switch) { toggle() }.semantics { contentDescription = label }) {
        RnSwitchGraphic(on, enabled, props)
    }
}

/**
 * RN's Switch on Android (SwitchCompat) as drawn, measured on the test phone: a 46.67x27dp view, a 24x14dp track in RN's track
 * color, solid, and a raised 20dp thumb 10dp either side of the center, in RN's thumb color or AppCompat's where RN sets none.
 * A disabled switch changes only AppCompat's thumb, as in RN.
 */
@Composable
internal fun RnSwitchGraphic(on: Boolean, enabled: Boolean, props: RnSwitchProps) {
    val theme = LocalTheme.current
    Box(Modifier.size(46.67.dp, 27.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(24.dp, 14.dp).clip(CircleShape).background(if (on) props.trackOn else props.trackOff))
        val thumb = theme.switchThumbShade((if (on) props.thumbOn else props.thumbOff) ?: theme.switchThumb(on, enabled, isSystemInDarkTheme()))
        Box(Modifier.offset(x = if (on) 10.dp else (-10).dp).size(20.dp).shadow(2.dp, CircleShape).clip(CircleShape).background(thumb))
    }
}

/** RN's QuickAddPreview: at most 6 chips, then "+N". */
private const val PREVIEW_CHIPS = 6

/**
 * RN's capture popup, from the bottom over a dimmed screen: Add Task and Close, the field, core's preview, the
 * project or contexts chip with Focus and More, More's panel (the note, the option chips, the syntax help, the due
 * dates), and "Add another" with Save and edit and Save. While a capture's retry is owed the draft is locked,
 * only its Save runs, and Back is left to the system.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CapturePopup(model: InboxViewModel, draft: CaptureDraft) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = draft.view
    val copy = view.getJSONObject("text")
    val failed = failedAction != null
    val locked = busy || failed
    val canSave = view.getBoolean("canSave") && writable && !busy && (failedAction == null || failedAction == draft.pending && draft.pending?.kind == "capture")
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val titleFocus = remember { FocusRequester() }
    var pickDay by rememberSaveable { mutableStateOf(false) }
    var pickTime by rememberSaveable { mutableStateOf(false) }
    var helpOpen by rememberSaveable(draft.session) { mutableStateOf(false) }
    // RN's Android expand: More waits until the keyboard is gone, so the tall panel never pushes the field off screen.
    var expandPending by remember { mutableStateOf(false) }
    val imeVisible = WindowInsets.isImeVisible
    LaunchedEffect(expandPending, imeVisible) {
        if (!expandPending) return@LaunchedEffect
        if (imeVisible) delay(500) // RN's ANDROID_OPTIONS_EXPAND_FALLBACK_MS
        expandPending = false
        setCaptureExpanded(true)
    }
    // As RN's modal does, the keyboard leaves with the popup.
    DisposableEffect(Unit) { onDispose { keyboard?.hide() } }
    // RN focuses the field 120 ms after it opens, and keeps it (and the keyboard) for the next capture after an
    // Add another save. A save locks the field, which drops its focus; the field takes it back once the save is done.
    // Without this the keyboard went down after each Add another save and the sheet slid under the next tap (run 33).
    LaunchedEffect(draft.session, locked) { if (!draft.expanded && !locked) { delay(120); runCatching { titleFocus.requestFocus() } } }
    // Debug builds only: the capture check puts its several lines on the clipboard (`debug.mindwtr.native.clipboard`,
    // "\n" for a new line) so it pastes them through the field's real Paste, the only way RN's popup gets several lines.
    val clipboard = LocalClipboardManager.current
    LaunchedEffect(draft.session) {
        withContext(Dispatchers.IO) { debugProperty("clipboard") }.takeIf { it.isNotEmpty() }?.let { clipboard.setText(AnnotatedString(it.replace("\\n", "\n"))) }
    }
    // Reads and edits wait while an action runs; they go on once none does.
    LaunchedEffect(busy, failed) { if (!busy && !failed) pumpCapture() }
    val closable = !busy && !failed
    // RN's Import .txt: the system's document picker for a text file (DocumentPicker, type text/plain).
    val importText = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(::importCaptureText) }
    BackHandler(enabled = !failed) {
        if (busy) return@BackHandler
        when {
            draft.confirm != null -> cancelCaptureLines()
            draft.picker != null -> closeCapturePicker()
            else -> closeCapture()
        }
    }
    val toggleMore = {
        if (draft.expanded) setCaptureExpanded(false) else {
            focusManager.clearFocus()
            keyboard?.hide()
            expandPending = true
        }
    }

    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    BoxWithConstraints(Modifier.fillMaxSize().testTag("quick-capture")) {
        val sheetMax = maxHeight - 8.dp
        Box(Modifier.fillMaxSize().background(theme.scrim).pointerInput(closable) { detectTapGestures { if (closable) closeCapture() } })
        Column(Modifier.align(Alignment.BottomCenter).imePadding().widthIn(max = 860.dp).fillMaxWidth().heightIn(max = sheetMax)
            .clip(RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp)).background(c.cardBg).pointerInput(Unit) { detectTapGestures { } }
            .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = if (draft.expanded) 20.dp else 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(copy.getString("title"), style = rnText(16, 700), color = c.text, maxLines = 2, modifier = Modifier.weight(1f).semantics { heading() })
                val close = copy.getString("close")
                Box(Modifier.size(48.dp).clip(CircleShape).clickable(enabled = closable, role = Role.Button) { closeCapture() }
                    .semantics { contentDescription = close }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
                }
            }
            val footer = @Composable {
                // RN's footer: the Add another switch, then Save and edit and Save.
                Column(Modifier.padding(top = if (draft.expanded) 10.dp else 8.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val addAnother = view.getJSONObject("addAnother")
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val on = addAnother.getBoolean("value")
                        val label = addAnother.getString("label")
                        RnSwitch(on, enabled = !locked, label = label, props = theme.captureSwitch) { setCaptureAddAnother(addAnother) }
                        Text(label, style = rnText(12, 600), color = c.text, maxLines = 2, modifier = Modifier.padding(start = 8.dp))
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalAlignment = Alignment.CenterVertically) {
                        val pill = RoundedCornerShape(999.dp)
                        val saveAndEdit = copy.getString("saveAndEdit")
                        // RN fades each button whole (opacity 0.5) while the text is blank: the layer comes before the pill's border and fill.
                        Box(Modifier.fade(if (canSave) 1f else 0.5f).widthIn(min = 112.dp).heightIn(min = 48.dp).clip(pill).border(1.dp, c.border, pill)
                            .clickable(enabled = canSave, role = Role.Button) { focusManager.clearFocus(); saveCapture(openAfterSave = true) }
                            .padding(horizontal = 16.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                            Text(saveAndEdit, style = rnText(13, 700), color = c.text, maxLines = 1)
                        }
                        Box(Modifier.fade(if (canSave) 1f else 0.5f).widthIn(min = 104.dp).heightIn(min = 48.dp).clip(pill).background(theme.filledBg)
                            .clickable(enabled = canSave, role = Role.Button) { saveCapture(openAfterSave = false) }
                            .padding(horizontal = 16.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                            Text(copy.getString("save"), style = rnText(13, 700), color = theme.filledText, maxLines = 1)
                        }
                    }
                }
            }
            // In landscape everything under the header scrolls, so Save stays reachable above the keyboard and a failure
            // banner; in portrait only More's panel scrolls, and the footer stays put, as in RN.
            Column(if (landscape) Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).testTag("capture-scroll")
                else Modifier.weight(1f, fill = false)) {
                // RN's field: Return saves (Add another keeps the keyboard up for the next capture). RN's mic is not built.
                TitleField(draft.text, copy.getString("inputLabel"), !locked, Modifier.focusRequester(titleFocus)) { typed -> typeCapture(typed) }
                val preview = view.items("preview")
                if (preview.isNotEmpty()) PreviewStrip(preview, Modifier.padding(top = 8.dp))
                FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
                    itemVerticalAlignment = Alignment.CenterVertically) {
                    if (!draft.expanded) {
                        val project = view.getJSONObject("project")
                        if (project.getBoolean("selected")) {
                            OptionChip(Lucide.Folder, project.getString("label"), project.getString("accessibilityLabel"), !locked, collapsed = true,
                                onLongClick = { editCapture(project.getJSONObject("reset")) }) { openCapturePicker("project") }
                        } else {
                            val contexts = view.getJSONObject("contexts")
                            OptionChip(Lucide.AtSign, contexts.getString("label"), contexts.getString("accessibilityLabel"), !locked, collapsed = true,
                                onLongClick = { editCapture(contexts.getJSONObject("reset")) }) { openCapturePicker("context") }
                        }
                        FocusChip(model, view, collapsed = true, locked = locked)
                    }
                    val moreLabel = copy.getString(if (draft.expanded) "hideOptions" else "more")
                    val pill = RoundedCornerShape(999.dp)
                    Row(Modifier.heightIn(min = 40.dp).widthIn(min = 96.dp).clip(pill).background(c.filterBg).border(1.dp, c.border, pill)
                        .clickable(role = Role.Button) { toggleMore() }.semantics { contentDescription = moreLabel }.padding(horizontal = 12.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Lucide.SlidersHorizontal, null, tint = c.text, modifier = Modifier.size(16.dp))
                        Text(moreLabel, style = rnText(12, 700), color = c.text, maxLines = 1)
                        Icon(if (draft.expanded) Lucide.ChevronUp else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                    }
                }
                if (draft.expanded) Column(if (landscape) Modifier else Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    val noteLabel = copy.getString("noteLabel")
                    Text(noteLabel, style = rnText(12, 600), color = c.secondaryText, maxLines = 1, modifier = Modifier.padding(top = 10.dp))
                    NoteField(draft, copy.getString("notePlaceholder"), noteLabel, !locked) { note ->
                        editCapture(JSONObject().put("type", "setNote").put("value", note))
                    }
                    FlowRow(Modifier.padding(top = 10.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        FocusChip(model, view, collapsed = false, locked = locked)
                        view.getJSONObject("due").child("time")?.let { time ->
                            OptionChip(Lucide.Clock, null, time.getString("accessibilityLabel"), !locked, iconOnly = true,
                                onLongClick = { editCapture(time.getJSONObject("clear")) }) { focusManager.clearFocus(); pickTime = true }
                        }
                        val contexts = view.getJSONObject("contexts")
                        OptionChip(Lucide.AtSign, contexts.getString("label"), contexts.getString("accessibilityLabel"), !locked,
                            onLongClick = { editCapture(contexts.getJSONObject("reset")) }) { openCapturePicker("context") }
                        val area = view.getJSONObject("area")
                        OptionChip(Lucide.Layers, area.getString("label"), area.getString("accessibilityLabel"), !locked,
                            onLongClick = { editCapture(area.getJSONObject("reset")) }) { openCapturePicker("area") }
                        val project = view.getJSONObject("project")
                        OptionChip(Lucide.Folder, project.getString("label"), project.getString("accessibilityLabel"), !locked,
                            onLongClick = { editCapture(project.getJSONObject("reset")) }) { openCapturePicker("project") }
                        view.child("priority")?.let { priority ->
                            OptionChip(Lucide.Flag, priority.getString("label"), priority.getString("accessibilityLabel"), !locked,
                                iconTint = theme.priority(priority.text("value")),
                                onLongClick = { editCapture(priority.getJSONObject("reset")) }) { openCapturePicker("priority") }
                        }
                    }
                    val help = copy.getString("syntaxHelp")
                    Row(Modifier.padding(top = 8.dp).clickable(role = Role.Button) { helpOpen = !helpOpen }.semantics { contentDescription = help }
                        .padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (helpOpen) Lucide.ChevronUp else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
                        Text(help, style = rnText(11, 600), color = c.secondaryText, modifier = Modifier.padding(start = 4.dp))
                    }
                    if (helpOpen) Text(copy.getString("syntaxHelpText"), style = rnText(11, 500, 15), color = c.secondaryText, modifier = Modifier.padding(top = 4.dp))
                    ImportTextButton(!locked) { importText.launch(arrayOf("text/plain")) }
                    DueDates(view.getJSONObject("due"), !locked, { editCapture(it) }) { focusManager.clearFocus(); pickDay = true }
                }

                if (landscape) footer()
            }
            if (!landscape) footer()
        }
        // RN's toasts inside the popup, above the keyboard.
        ToastCard(model, Modifier.align(Alignment.BottomCenter).imePadding().padding(bottom = 16.dp))
        draft.picker?.let { picker -> view.child("picker")?.takeIf { it.getString("kind") == picker.getString("kind") }?.let { CapturePicker(model, draft, it, locked) } }
        draft.confirm?.let { LinesConfirm(model, it, locked) }
    }
    // The pickers open where core says, as RN's value={dueDate ?? new Date()}: the day, and the due date's clock time.
    val due = view.getJSONObject("due")
    if (pickDay) DayPickerDialog(due.getJSONObject("custom").getString("startDay"), { pickDay = false }) { day ->
        editCapture(JSONObject().put("type", "setDueDay").put("day", day))
    }
    if (pickTime) {
        val (hour, minute) = due.child("time")?.getString("start")?.split(":")?.mapNotNull { it.toIntOrNull() }?.takeIf { it.size == 2 }?.let { it[0] to it[1] } ?: (0 to 0)
        ClockPickerDialog(hour, minute, { pickTime = false }) { time -> editCapture(JSONObject().put("type", "setDueTime").put("time", time)) }
    }
}

/** RN's field: the input background, a 12 radius, 15 text, up to about four lines. Text the app puts in leaves the cursor at its end. */
@Composable
private fun InboxViewModel.TitleField(value: String, label: String, enabled: Boolean, modifier: Modifier, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    var field by remember { mutableStateOf(TextFieldValue(value, TextRange(value.length))) }
    if (field.text != value) field = TextFieldValue(value, TextRange(value.length))
    val shape = RoundedCornerShape(12.dp)
    BasicTextField(field, { typed -> field = typed; if (typed.text != value) onChange(typed.text) }, enabled = enabled,
        textStyle = rnText(15, 400).copy(color = if (enabled) c.text else c.secondaryText), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { saveCapture(openAfterSave = false) }),
        modifier = modifier.fillMaxWidth().heightIn(min = 44.dp, max = 120.dp).clip(shape).background(c.inputBg).border(1.dp, c.border, shape)
            .testTag("capture-title").semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(label, style = rnText(15, 400), color = c.secondaryText)
                inner()
            }
        })
}

/** The More panel's Description: typed text stays as typed; core's note replaces it only when no edit is still with core. */
@Composable
private fun NoteField(draft: CaptureDraft, placeholder: String, label: String, enabled: Boolean, send: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val coreValue = draft.options.optString("note")
    val pending = draft.requests.isNotEmpty()
    var field by remember(draft.session) { mutableStateOf(TextFieldValue(coreValue, TextRange(coreValue.length))) }
    LaunchedEffect(draft.session, coreValue) { if (!pending && field.text != coreValue) field = TextFieldValue(coreValue, TextRange(coreValue.length)) }
    val shape = RoundedCornerShape(12.dp)
    BasicTextField(field, { typed -> val changed = typed.text != field.text; field = typed; if (changed) send(typed.text) }, enabled = enabled,
        textStyle = rnText(15, 400).copy(color = if (enabled) c.text else c.secondaryText), cursorBrush = SolidColor(c.tint), minLines = 2,
        modifier = Modifier.padding(top = 6.dp).fillMaxWidth().heightIn(min = 64.dp, max = 120.dp).clip(shape).background(c.inputBg)
            .border(1.dp, c.border, shape).semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                if (field.text.isEmpty()) Text(placeholder, style = rnText(15, 400), color = c.secondaryText)
                inner()
            }
        })
}

/** RN's Import .txt pill in More's panel: the file glyph and the label, on the filter background with a border. */
@Composable
private fun ImportTextButton(enabled: Boolean, pick: () -> Unit) {
    val c = LocalTheme.current.colors
    val pill = RoundedCornerShape(999.dp)
    val label = t("quickAdd.bulkImportTextFileLabel")
    Row(Modifier.padding(top = 8.dp).heightIn(min = 38.dp).clip(pill).background(c.filterBg).border(1.dp, c.border, pill)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = "capture-import-text"; if (enabled) onClick { pick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = pick).padding(horizontal = 10.dp, vertical = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Lucide.FileText, null, tint = c.text, modifier = Modifier.size(16.dp))
        Text(t("quickAdd.bulkImportTextFile"), style = rnText(12, 700), color = c.text, maxLines = 2)
    }
}

/** RN's QuickAddPreview (the popup's and the capture screen's): core's entries as passive chips (a warning in the danger color), at most six, then "+N". */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PreviewStrip(entries: List<JSONObject>, modifier: Modifier) {
    val theme = LocalTheme.current
    val c = theme.colors
    val pill = RoundedCornerShape(999.dp)
    FlowRow(modifier.fillMaxWidth().testTag("quick-add-preview"), horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (entry in entries.take(PREVIEW_CHIPS)) {
            val warning = entry.getString("tone") == "warning"
            // RN's chip: its padding (8, 2) inside a 1 dp border, and RN's Android text line (font padding) of 13.
            Row(Modifier.clip(pill).background(if (warning) theme.dangerWash else c.filterBg).border(1.dp, if (warning) c.danger else c.border, pill)
                .padding(horizontal = 9.dp, vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                entry.text("label")?.let { Text(it, style = rnText(11, 400, 13), color = if (warning) c.danger else c.secondaryText, maxLines = 1) }
                Text(entry.getString("value"), style = rnText(11, 600, 13), color = if (warning) c.danger else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (entries.size > PREVIEW_CHIPS) Box(Modifier.clip(pill).background(c.filterBg).border(1.dp, c.border, pill).padding(horizontal = 9.dp, vertical = 3.dp)) {
            Text("+${entries.size - PREVIEW_CHIPS}", style = rnText(11, 600, 13), color = c.secondaryText)
        }
    }
}

/**
 * RN's option chip: a pill with a glyph and core's label; a tap opens its picker, a long press sends core's reset.
 * [collapsed] is the chip row above More (RN's collapsedProjectChip / collapsedContextChip), else More's grid.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RowScope.OptionChip(icon: ImageVector, label: String?, description: String, enabled: Boolean, collapsed: Boolean = false,
                                iconOnly: Boolean = false, iconTint: Color? = null, onLongClick: () -> Unit, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val pill = RoundedCornerShape(999.dp)
    Row(Modifier.then(if (collapsed || iconOnly) Modifier else Modifier.weight(1f).widthIn(min = 120.dp))
        .heightIn(min = if (collapsed) 40.dp else 44.dp).clip(pill).background(c.filterBg).border(1.dp, c.border, pill)
        .combinedClickable(enabled = enabled, role = Role.Button, onLongClick = onLongClick, onClick = onClick)
        .semantics { contentDescription = description }.padding(horizontal = if (collapsed) 12.dp else 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = iconTint ?: c.text, modifier = Modifier.size(16.dp))
        if (label != null) Text(label, style = rnText(12, if (collapsed) 700 else 600), color = c.text, textAlign = TextAlign.Center,
            maxLines = if (collapsed) 1 else 2, overflow = TextOverflow.Ellipsis)
    }
}

/** RN's focus chip: the star and core's Focus label; on, the star's amber wash and border. At the limit core refuses with a toast. */
@Composable
private fun RowScope.FocusChip(model: InboxViewModel, view: JSONObject, collapsed: Boolean, locked: Boolean) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val focus = view.getJSONObject("focus")
    val on = focus.getBoolean("selected")
    val label = focus.getString("accessibilityLabel")
    val pill = RoundedCornerShape(999.dp)
    Row(Modifier.then(if (collapsed) Modifier else Modifier.weight(1f).widthIn(min = 120.dp)).heightIn(min = if (collapsed) 40.dp else 44.dp)
        .clip(pill).background(if (on) theme.starWash else c.filterBg).border(1.dp, if (on) theme.star else c.border, pill)
        .clickable(enabled = !locked, role = Role.Button) { editCapture(focus.getJSONObject("edit")) }
        .semantics { contentDescription = label; selected = on }.padding(horizontal = if (collapsed) 12.dp else 10.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        FocusStar(on, !focus.getBoolean("enabled"), 16, Modifier)
        Text(focus.getString("label"), style = rnText(12, 600), color = if (on) theme.star else c.text, maxLines = 1)
    }
}

/** RN's QuickDateChips (Today, Tomorrow, Next week; the chosen one clears) and the Custom chip (the system date picker; a long press clears). */
@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
private fun DueDates(due: JSONObject, enabled: Boolean, send: (JSONObject) -> Unit, pick: () -> Unit) {
    val c = LocalTheme.current.colors
    val pill = RoundedCornerShape(999.dp)
    FlowRow(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (chip in due.items("quickDates")) {
            val on = chip.getBoolean("selected")
            val label = chip.getString("label")
            Box(Modifier.weight(1f).widthIn(min = 92.dp).heightIn(min = 34.dp).clip(pill).background(if (on) c.tint else c.filterBg)
                .border(1.dp, if (on) c.tint else c.border, pill).clickable(enabled = enabled, role = Role.Button) { send(chip.getJSONObject("edit")) }
                .semantics { contentDescription = label; selected = on }.padding(horizontal = 10.dp, vertical = 7.dp), contentAlignment = Alignment.Center) {
                Text(label, style = rnText(12, 600), color = if (on) c.onTint else c.secondaryText, textAlign = TextAlign.Center, maxLines = 2)
            }
        }
        val custom = due.getJSONObject("custom")
        Row(Modifier.weight(1f).widthIn(min = 120.dp).heightIn(min = 34.dp).clip(pill).border(1.dp, c.border, pill)
            .combinedClickable(enabled = enabled, role = Role.Button, onLongClick = { send(due.getJSONObject("clear")) }, onClick = pick)
            .semantics { contentDescription = custom.getString("accessibilityLabel") }.padding(horizontal = 10.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
            Icon(Lucide.CalendarDays, null, tint = c.secondaryText, modifier = Modifier.size(14.dp))
            Text(custom.getString("label"), style = rnText(12, 600), color = c.secondaryText, maxLines = 2, textAlign = TextAlign.Center)
        }
    }
}

/** RN's picker card over the popup (and the capture screen's several-lines question): its title, then its content. */
@Composable
internal fun PickerCard(title: String, dismiss: () -> Unit, content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    Box(Modifier.fillMaxSize().imePadding().background(theme.scrim).pointerInput(Unit) { detectTapGestures { dismiss() } }.padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
            .padding(16.dp)) {
            Text(title, style = rnText(14, 700), color = c.text, modifier = Modifier.padding(bottom = 8.dp).semantics { heading() })
            content()
        }
    }
}

@Composable
private fun PickerRow(label: String, description: String, selected: Boolean = false, color: Color? = null, leading: ImageVector? = null,
                      leadingTint: Color? = null, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).then(if (selected) Modifier.background(c.filterBg) else Modifier)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = description; this.selected = selected }
        .padding(horizontal = 12.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        leading?.let { Icon(it, null, tint = leadingTint ?: color ?: c.text, modifier = Modifier.size(16.dp)) }
        Text(label, style = rnText(14, 600), color = color ?: c.text, modifier = Modifier.weight(1f, fill = false))
        if (selected) Icon(Lucide.Check, null, tint = c.tint, modifier = Modifier.size(16.dp))
    }
}

/** RN's pickers: project and area (search, create, list), contexts (search, add, chosen chips, clear, list), and priority. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InboxViewModel.CapturePicker(model: InboxViewModel, draft: CaptureDraft, picker: JSONObject, locked: Boolean) {
    val theme = LocalTheme.current
    val c = theme.colors
    val kind = picker.getString("kind")
    val listShape = RoundedCornerShape(10.dp)
    val list = @Composable { rows: @Composable () -> Unit ->
        Column(Modifier.padding(top = 10.dp).fillMaxWidth().heightIn(max = 220.dp).clip(listShape).border(1.dp, c.border, listShape)
            .verticalScroll(rememberScrollState()).padding(vertical = 6.dp)) { rows() }
    }
    PickerCard(picker.getString("title"), this::closeCapturePicker) {
        if (kind != "priority") {
            val query = draft.picker?.optString("query").orEmpty()
            val submit = {
                when (kind) {
                    "context" -> picker.child("add")?.let { add -> pickCapture(add.getJSONObject("edit"), close = false, clearQuery = true) }
                    else -> if (query.isNotBlank()) submitCapturePicker()
                }
            }
            var field by remember(kind) { mutableStateOf(TextFieldValue(query, TextRange(query.length))) }
            if (field.text != query) field = TextFieldValue(query, TextRange(query.length))
            BasicTextField(field, { typed -> field = typed; if (typed.text != query) captureQuery(typed.text) }, enabled = !locked, singleLine = true,
                textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }),
                modifier = Modifier.fillMaxWidth().clip(listShape).background(c.inputBg).border(1.dp, c.border, listShape)
                    .semantics { contentDescription = picker.getString("title") },
                decorationBox = { inner ->
                    Box(Modifier.padding(horizontal = 10.dp, vertical = 8.dp)) {
                        if (field.text.isEmpty()) Text(picker.getString("placeholder"), style = rnText(14, 400), color = c.secondaryText)
                        inner()
                    }
                })
            (picker.child("create") ?: picker.child("add"))?.let { row ->
                PickerRow(row.getString("label"), row.getString("accessibilityLabel"), color = c.tint, leading = Lucide.PlusMedium, enabled = !locked) { submit() }
            }
        }
        when (kind) {
            "context" -> {
                val chosen = picker.items("selected")
                if (chosen.isNotEmpty()) FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (chip in chosen) {
                        val pill = RoundedCornerShape(999.dp)
                        Text(chip.getString("label"), style = rnText(12, 600), color = c.text, modifier = Modifier.clip(pill).background(c.filterBg)
                            .border(1.dp, c.border, pill).clickable(enabled = !locked, role = Role.Button) { pickCapture(chip.getJSONObject("edit"), close = false) }
                            .semantics { contentDescription = chip.getString("accessibilityLabel") }.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
                list {
                    val clear = picker.getJSONObject("clear")
                    PickerRow(clear.getString("label"), clear.getString("label"), enabled = !locked) { pickCapture(clear.getJSONObject("edit"), close = true, clearQuery = true) }
                    for (row in picker.items("items")) {
                        PickerRow(row.getString("label"), row.getString("accessibilityLabel"), selected = row.getBoolean("selected"), enabled = !locked) {
                            pickCapture(row.getJSONObject("edit"), close = false, clearQuery = true)
                        }
                    }
                }
            }
            "priority" -> {
                val none = picker.getJSONObject("none")
                PickerRow(none.getString("label"), none.getString("label"), leading = Lucide.Flag, enabled = !locked) { pickCapture(none.getJSONObject("edit"), close = true) }
                for (row in picker.items("items")) {
                    PickerRow(row.getString("label"), row.getString("label"), selected = row.getBoolean("selected"), leading = Lucide.Flag,
                        leadingTint = theme.priority(row.getString("value")), enabled = !locked) { pickCapture(row.getJSONObject("edit"), close = true) }
                }
            }
            else -> list {
                val none = picker.getJSONObject("none")
                PickerRow(none.getString("label"), none.getString("label"), enabled = !locked) { pickCapture(none.getJSONObject("edit"), close = true, clearQuery = true) }
                for (row in picker.items("items")) {
                    PickerRow(row.getString("label"), row.getString("label"), selected = row.optBoolean("selected"), enabled = !locked) {
                        pickCapture(row.getJSONObject("edit"), close = true, clearQuery = true)
                    }
                }
            }
        }
    }
}

/** RN's several-lines question inside the popup: core's title and lines, Cancel and Create tasks. */
@Composable
private fun InboxViewModel.LinesConfirm(model: InboxViewModel, confirm: JSONObject, locked: Boolean) {
    val c = LocalTheme.current.colors
    PickerCard(confirm.getString("title"), this::cancelCaptureLines) {
        Text(confirm.getString("message"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            // While the batch's retry is owed, only Create tasks runs, with the same capture IDs.
            val canCreate = writable && !busy && (failedAction == null || failedAction == capture?.pending)
            DialogAction(confirm.getString("cancelLabel"), c.secondaryText, !locked, this@LinesConfirm::cancelCaptureLines)
            DialogAction(confirm.getString("confirmLabel"), c.tint, canCreate, this@LinesConfirm::createCaptureLines)
        }
    }
}

@Composable
internal fun DialogAction(label: String, color: Color, enabled: Boolean, onClick: () -> Unit) =
    Box(Modifier.heightIn(min = 44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center) {
        Text(label, style = rnText(14, 600), color = color, modifier = Modifier.fade(if (enabled) 1f else 0.5f))
    }
