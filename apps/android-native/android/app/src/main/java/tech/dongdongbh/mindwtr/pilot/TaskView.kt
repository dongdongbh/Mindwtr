package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import kotlinx.coroutines.delay
import android.util.Log
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/*
 * RN's task editor tabs (TaskEditTabs), its View tab (TaskEditViewTab) on core's getTaskView, the Markdown preview
 * (markdown-text.tsx) on core's resolved blocks, and the Form tab's checklist field (TaskEditContentField's checklist) on core's
 * editTaskChecklist field. Every word, row, label and link is core's; every checklist change is core's edit on the draft, saved
 * with it in one write.
 */

/** RN's TaskEditTabs: Edit and Preview in one bordered track under the header; the open one is filled with the tint. */
@Composable
fun EditorTabs(model: InboxViewModel, editor: TaskEditor) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(Modifier.weight(1f).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)) {
            for ((tab, icon, key) in listOf(Triple("task", SettingsLucide.Pencil, "markdown.edit"), Triple("view", Lucide.Eye, "markdown.preview"))) {
                val open = editor.tab == tab
                val label = t(key)
                Row(Modifier.weight(1f).clip(shape).background(if (open) c.tint else c.filterBg)
                    .clearAndSetSemantics { contentDescription = label; role = Role.Tab; selected = open; onClick { model.editorTab(tab); true } }
                    .clickable { model.editorTab(tab) }.padding(vertical = 10.dp),
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(icon, null, tint = if (open) c.onTint else c.text, modifier = Modifier.size(16.dp))
                    Text(label, style = rnText(14, 600), color = if (open) c.onTint else c.text, modifier = Modifier.padding(start = 6.dp))
                }
            }
        }
    }
}

/**
 * RN's View tab: core's rows for the editor's draft and checklist (the saved task when read-only), read again whenever either
 * changes. The status opens the status choices ([pickStatus]); the project, a context or tag, and a Markdown link go to
 * [follow] (core's link target, or `{ kind: "token", value }`). A tick or the add input is core's checklist edit on the draft.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaskViewTab(model: InboxViewModel, editor: TaskEditor, locked: Boolean, pickStatus: () -> Unit, follow: (JSONObject) -> Unit, modifier: Modifier) = with(model) {
    val c = LocalTheme.current.colors
    val draftKey = draftJson(editor.fullDraft()) + editor.checklistNow + editor.attachments.orEmpty()
    LaunchedEffect(editor.id, draftKey, busy, failedAction) { if (!busy && failedAction == null) readTaskView() }
    val view = taskView?.takeIf { it.getString("id") == editor.id }
    Column(modifier.imePadding().verticalScroll(rememberScrollState()).padding(20.dp).testTag("task-view")) {
        if (view == null) return@Column
        view.menuText("readOnlyHint")?.let { Text(it, style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 16.dp)) }
        val labels = view.getJSONObject("markdownLabels")
        for (row in view.menuObjects("rows")) when (row.getString("type")) {
            "title" -> ViewCard(row.getString("label")) { Text(row.getString("value"), style = rnText(17, 700, 23), color = c.text) }
            "status" -> ViewCard(row.getString("label")) {
                val editable = row.getBoolean("editable") && !locked
                val status = row.menuText("status")
                // RN's TaskStatusBadge: a long-press on Done picks the draft's completion time (bca5e3e7e).
                if (row.getBoolean("editable") && status != null) StatusPill(status, row.getString("value"), editable, pickStatus,
                    if (status == "done") { { completedAt.openEditor() } } else null)
                else Text(row.getString("value"), style = rnText(14, 600, 20), color = c.text)
            }
            "field" -> {
                val project = row.optJSONObject("project")
                val value = row.getString("value")
                val spoken = project?.getString("accessibilityLabel") ?: "${row.getString("label")}: $value"
                ViewCard(row.getString("label"), spoken, onClick = project?.let { p -> { follow(JSONObject().put("kind", "project").put("id", p.getString("id"))) } }) {
                    Text(value, style = rnText(14, 600, 20), color = c.text)
                }
            }
            "tokens" -> Column(Modifier.padding(bottom = 16.dp)) {
                ViewLabel(row.getString("label"))
                FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (item in row.menuObjects("items")) {
                        val value = item.getString("value")
                        val spoken = item.getString("accessibilityLabel")
                        val shape = RoundedCornerShape(12.dp)
                        val open = { follow(JSONObject().put("kind", "token").put("value", value)) }
                        Text(value, style = rnText(12, 600), color = c.text, modifier = Modifier.clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape)
                            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; onClick { open(); true } }
                            .clickable { open() }.padding(horizontal = 10.dp, vertical = 6.dp))
                    }
                }
            }
            "description" -> Column(Modifier.padding(bottom = 16.dp)) {
                ViewLabel(row.getString("label"))
                val shape = RoundedCornerShape(10.dp)
                Box(Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(12.dp)) {
                    MarkdownBlocks(row.menuObjects("blocks"), labels, follow)
                }
            }
            "checklist" -> ViewChecklist(model, row, labels, locked, follow)
            "attachments" -> Column(Modifier.padding(bottom = 16.dp)) {
                ViewLabel(row.getString("label"))
                // RN's attachment grid: an image's picture, else the title and core's note (Loading, Download, Missing); a tap opens it.
                FlowRow(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp), maxItemsInEachRow = 2) {
                    for (item in row.menuObjects("items")) {
                        val shape = RoundedCornerShape(12.dp)
                        val enabled = !item.getBoolean("disabled")
                        val owner = AttachmentOwner("task", editor.id)
                        Column(Modifier.weight(1f).heightIn(min = 90.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                            .clickable(enabled = enabled, role = Role.Button) { attachments.open(owner, item.getString("id")) }.padding(10.dp),
                            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                            if (item.getBoolean("image")) AttachmentThumbnail(item.getString("uri"), item.getString("title"))
                            else {
                                Text(item.getString("title"), style = rnText(12, 600), color = c.text, textAlign = TextAlign.Center, maxLines = 2)
                                item.menuText("note")?.let { Text(it, style = rnText(11, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 6.dp)) }
                            }
                        }
                    }
                }
            }
        }
        Spacer(Modifier.heightIn(min = 100.dp))
    }
}

/** RN's viewLabel: 12/700 capitals, the secondary text color. */
@Composable
private fun ViewLabel(label: String) =
    Text(label.uppercase(), style = rnText(12, 700, letterSpacing = 0.4f), color = LocalTheme.current.colors.secondaryText)

/** RN's viewRow: a bordered input-colored card with the label over the value; tappable (the project row) when [onClick] is set. */
@Composable
private fun ViewCard(label: String, spoken: String? = null, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(bottom = 12.dp).fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape)
        .then(if (onClick != null) Modifier.clearAndSetSemantics { contentDescription = spoken ?: label; role = Role.Button; onClick { onClick(); true } }
            .clickable(onClick = onClick) else Modifier)
        .padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ViewLabel(label)
        content()
    }
}

/**
 * RN's TaskStatusBadge in the View tab: core's status label in core's status colors; a tap opens the status choices, a
 * long-press on Done runs [backdate] (RN's onBackdatedComplete), named for TalkBack as RN's accessibilityHint.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StatusPill(status: String, label: String, enabled: Boolean, open: () -> Unit, backdate: (() -> Unit)? = null) {
    val colors = LocalTheme.current.status(status)
    val shape = RoundedCornerShape(8.dp)
    val spoken = t("task.aria.changeStatus").replace("{{status}}", label)
    Row(Modifier.fade(if (enabled) 1f else 0.6f).heightIn(min = 32.dp).clip(shape).background(colors.bg).rnBorder(1.dp, colors.border, shape)
        .clearAndSetSemantics {
            contentDescription = spoken; role = Role.Button
            if (enabled) onClick { open(); true } else disabled()
            if (enabled && backdate != null) onLongClick(t("task.completeBackdateHintMobile")) { backdate(); true }
        }
        .combinedClickable(enabled = enabled, onLongClick = backdate, onClick = open).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = rnText(12, 600), color = colors.text)
        Icon(Lucide.ChevronDown, null, tint = colors.text, modifier = Modifier.padding(start = 4.dp).size(12.dp))
    }
}

/**
 * The View tab's checklist: core's items (a reference list too), a tap ticks one (core's toggle by its position) where
 * core makes them tappable, core's add input (append on Done), and More while core has more items than read.
 */
@Composable
private fun ViewChecklist(model: InboxViewModel, row: JSONObject, labels: JSONObject, locked: Boolean, follow: (JSONObject) -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    val tappable = row.getBoolean("tappable") && !locked
    val items = row.menuObjects("items")
    Column(Modifier.padding(bottom = 16.dp)) {
        ViewLabel(row.getString("label"))
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (item in items) {
                val done = item.getBoolean("completed")
                val spoken = item.menuText("accessibilityLabel")
                Row(Modifier.fillMaxWidth().heightIn(min = 32.dp)
                    .then(if (row.getBoolean("tappable")) Modifier.clearAndSetSemantics {
                        contentDescription = spoken ?: item.getString("title"); role = Role.Checkbox
                        toggleableState = ToggleableState(done)
                        if (tappable) onClick { editChecklist(JSONObject().put("kind", "toggle").put("itemId", item.getString("id"))); true } else disabled()
                    }.clickable(enabled = tappable) { editChecklist(JSONObject().put("kind", "toggle").put("itemId", item.getString("id"))) }
                    else if (spoken != null) Modifier.clearAndSetSemantics { contentDescription = spoken } else Modifier)
                    .padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (done) SettingsLucide.CheckSquare else SettingsLucide.Square, null, tint = if (done) c.tint else c.secondaryText, modifier = Modifier.size(18.dp))
                    Text(inline(item.menuObjects("inline"), labels, c.tint, c.secondaryText, c.cardBg, follow), style = rnText(14, 400), color = c.text,
                        modifier = Modifier.weight(1f).padding(start = 8.dp))
                }
            }
            if (items.size < row.getInt("total")) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                PillButton(t("common.more"), onClick = { readTaskView(more = true) }, enabled = !busy)
            }
            row.optJSONObject("add")?.let { add -> ChecklistAddInput(model, add, !locked) }
        }
    }
}

/**
 * RN's View tab add input: the typed text is the draft's (kept with it, counted as unsaved on Close, added by Save); Done appends it
 * (core's append edit) and clears the field.
 */
@Composable
private fun ChecklistAddInput(model: InboxViewModel, add: JSONObject, enabled: Boolean) {
    val c = LocalTheme.current.colors
    val text = model.editor?.checklistAdd.orEmpty()
    val placeholder = add.getString("placeholder")
    val label = add.getString("label")
    BasicTextField(text, model::typeChecklistAdd, enabled = enabled, singleLine = true, textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { model.submitChecklistAdd() }),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = label }.testTag("view-checklist-add").padding(start = 26.dp, top = 6.dp, bottom = 6.dp),
        decorationBox = { inner -> Box { if (text.isEmpty()) Text(placeholder, style = rnText(14, 400), color = c.secondaryText); inner() } })
}

/**
 * RN's Markdown preview on core's resolved blocks: blank lines, headings, rules, code with its copy button, task lists, bullet and
 * numbered lists, and paragraphs, each block's text drawn from core's inline runs.
 */
@Composable
internal fun MarkdownBlocks(blocks: List<JSONObject>, labels: JSONObject, follow: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    val clipboard = LocalClipboardManager.current
    val runs = { block: JSONObject -> inline(block.menuObjects("inline"), labels, c.tint, c.secondaryText, c.cardBg, follow) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        for (block in blocks) when (block.getString("type")) {
            "blank" -> Spacer(Modifier.height(12.dp).clearAndSetSemantics { })
            "heading" -> {
                val level = block.getInt("level")
                Text(runs(block), style = rnText(if (level == 1) 16 else if (level == 2) 15 else 14, 700, 20), color = c.text)
            }
            "rule" -> Box(Modifier.padding(vertical = 4.dp).fillMaxWidth().height(1.dp).background(c.border))
            "code" -> Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(c.filterBg).rnBorder(1.dp, c.border, RoundedCornerShape(8.dp))) {
                Text(block.getString("text"), style = rnText(12, 400, 18).copy(fontFamily = FontFamily.Monospace), color = c.text,
                    modifier = Modifier.padding(start = 10.dp, top = 8.dp, bottom = 8.dp, end = 38.dp))
                val copy = labels.getString("copyCode")
                Box(Modifier.align(Alignment.TopEnd).padding(6.dp).size(28.dp).clip(RoundedCornerShape(7.dp)).background(c.filterBg)
                    .rnBorder(1.dp, c.border, RoundedCornerShape(7.dp))
                    .clearAndSetSemantics { contentDescription = copy; role = Role.Button; onClick { clipboard.setText(AnnotatedString(block.getString("text"))); true } }
                    .clickable { clipboard.setText(AnnotatedString(block.getString("text"))) },
                    contentAlignment = Alignment.Center) {
                    Icon(SettingsIonicons.CopyOutline, null, tint = c.secondaryText, modifier = Modifier.size(15.dp))
                }
            }
            "taskList", "bulletList", "orderedList" -> Column(Modifier.padding(start = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val kind = block.getString("type")
                for (item in block.menuObjects("items")) Row(Modifier.padding(start = (item.getInt("depth") * 14).dp)) {
                    val marker = if (kind == "taskList") (if (item.getBoolean("checked")) "☑" else "☐") else item.getString("marker")
                    Text(marker, style = rnText(13, 400, 18), color = c.secondaryText,
                        modifier = if (kind == "orderedList") Modifier.widthIn(min = 22.dp) else Modifier.width(14.dp))
                    Text(runs(item), style = rnText(13, 400, 18), color = c.text, modifier = Modifier.padding(start = 6.dp).weight(1f))
                }
            }
            else -> Text(runs(block), style = rnText(13, 400, 18), color = c.text)
        }
    }
}

/**
 * Core's inline runs as one text: bold, italic, struck, code on the card color, a link in the tint and underlined that [follow]s
 * core's target when tapped, and a deleted reference struck with core's "(deleted task)" or "(deleted project)".
 */
private fun inline(runs: List<JSONObject>, labels: JSONObject, tint: androidx.compose.ui.graphics.Color, muted: androidx.compose.ui.graphics.Color,
                   codeBg: androidx.compose.ui.graphics.Color, follow: (JSONObject) -> Unit) = buildAnnotatedString {
    for (run in runs) {
        val text = run.getString("text")
        when (run.getString("type")) {
            "bold" -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text) }
            "italic" -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(text) }
            "strike" -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(text) }
            "code" -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) { append(if (text.isEmpty()) text else " $text ") }
            "link" -> {
                val target = run.getJSONObject("target")
                withLink(LinkAnnotation.Clickable(target.toString(), TextLinkStyles(SpanStyle(color = tint, textDecoration = TextDecoration.Underline))) { follow(target) }) { append(text) }
            }
            "deletedReference" -> withStyle(SpanStyle(color = muted)) {
                withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(text) }
                append(" (${labels.getString(if (run.getString("entityType") == "project") "deletedProject" else "deletedTask")})")
            }
            else -> append(text)
        }
    }
}

/**
 * RN's checklist field on the Form tab, as core's field model describes it: the heading with Reorder / Done, the items (a
 * checkbox, or a bullet for a reference list; the title as typed; ×), "+ Add item", and Reset checklist. In reorder mode each
 * item has Move up and Move down. Every change is core's checklist edit on the draft ([InboxViewModel.editChecklist]), naming
 * its item by the item's id (a move by its direction): the item's position is read only when the edit is sent, after the edits
 * queued before it. Reset checklist writes at once, as in RN.
 */
@Composable
fun ChecklistField(model: InboxViewModel, editor: TaskEditor, locked: Boolean) = with(model) {
    val field = editor.view.checklistField ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val labels = field.getJSONObject("labels")
    var ordering by rememberSaveable(editor.id) { mutableStateOf(false) }
    val reorder = field.getBoolean("canReorder")
    val session = remember(editor.session) { ChecklistRowSession(editor.session) }
    if (!editsPending) session.settle(field.menuObjects("items"), error == null)
    val rows = session.sync(field.menuObjects("items"))
    val frames = remember(editor.session) { mutableStateMapOf<String, Rect>() }
    val scroll = LocalChecklistFormScroll.current
    val latestScroll by rememberUpdatedState(scroll)
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val edge = with(LocalDensity.current) { 72.dp.toPx() }
    var dragRow by remember(editor.session) { mutableStateOf<String?>(null) }
    var dragTarget by remember(editor.session) { mutableStateOf<String?>(null) }
    var dragPointer by remember(editor.session) { mutableFloatStateOf(0f) }
    var actionRow by remember(editor.session) { mutableStateOf<String?>(null) }
    val structuralEnabled = !locked && !editsPending && dragRow == null
    fun dropIndex(): Int? {
        if (rows.any { frames[it.identity] == null }) return null
        return checklistDropIndex(rows.map { frames.getValue(it.identity).center.y }, dragPointer)
    }
    fun finishDrag(commit: Boolean) {
        val from = rows.indexOfFirst { it.identity == dragRow }
        val to = dropIndex()
        dragRow = null
        dragTarget = null
        scroll?.dragging?.invoke(false)
        if (commit && !locked && !editsPending && from >= 0 && to != null && from != to) {
            session.expectMove(from, to)
            editChecklist(JSONObject().put("kind", "move").put("from", from).put("to", to))
            Log.i(CoreHost.TAG, "Checklist handle drag submitted releaseCheck=v1.3.8/checklist-handle-drag")
        }
    }
    LaunchedEffect(dragRow) {
        if (dragRow == null) return@LaunchedEffect
        while (dragRow != null) {
            latestScroll?.let { adapter ->
                adapter.state.scrollBy(checklistEdgeScroll(dragPointer, adapter.viewport.top, adapter.viewport.bottom, edge))
            }
            dragTarget = dropIndex()?.let { rows[it].identity }
            delay(16)
        }
    }
    DisposableEffect(editor.session) { onDispose { scroll?.dragging?.invoke(false) } }
    Column(Modifier.fillMaxWidth().padding(bottom = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Lucide.ListChecks, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
            Text(field.getString("label").uppercase(), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(start = 6.dp).weight(1f))
            if (reorder) {
                val label = labels.getString(if (ordering) "done" else "reorder")
                val shape = RoundedCornerShape(8.dp)
                Box(Modifier.heightIn(min = 36.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (structuralEnabled) onClick { ordering = !ordering; true } else disabled() }
                    .clickable(enabled = structuralEnabled) { ordering = !ordering }.padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center) { Text(label, style = rnText(12, 700), color = c.tint) }
            }
        }
        if (editor.view.canPreserveChecklistOnRepeat && field.menuObjects("items").isNotEmpty()) {
            SwitchRow(t("taskEdit.resetChecklistOnRepeat"), t("taskEdit.resetChecklistOnRepeatHint"), !editor.flag("preserveChecklistOnRepeat"), !locked) {
                editFields(mapOf("preserveChecklistOnRepeat" to !editor.flag("preserveChecklistOnRepeat")))
            }
        }
        val shape = RoundedCornerShape(10.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(8.dp)) {
            for (row in rows) key(row.identity) {
                val item = row.item
                val index = item.getInt("index")
                Column(Modifier.fillMaxWidth().onGloballyPositioned { frames[row.identity] = it.boundsInWindow() }
                    .fade(if (dragRow == row.identity) 0.6f else 1f)
                    .background(if (dragTarget == row.identity) c.filterBg else c.cardBg)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Box {
                            var handleTop by remember(row.identity) { mutableFloatStateOf(0f) }
                            Box(Modifier.size(44.dp).onGloballyPositioned { handleTop = it.boundsInWindow().top }
                                .semantics { contentDescription = labels.getString("drag"); role = Role.Button }
                                .testTag("checklist-drag-$index")
                                .pointerInput(row.identity, !locked && !editsPending) {
                                    if (!locked && !editsPending && rows.size > 1) detectDragGestures(
                                        onDragStart = { offset ->
                                            focusManager.clearFocus(); keyboard?.hide(); actionRow = null
                                            dragPointer = handleTop + offset.y; dragRow = row.identity
                                            scroll?.dragging?.invoke(true)
                                        },
                                        onDragEnd = { finishDrag(true) }, onDragCancel = { finishDrag(false) },
                                        onDrag = { change, amount -> change.consume(); dragPointer += amount.y })
                                }
                                .clickable(enabled = structuralEnabled) { actionRow = row.identity }, contentAlignment = Alignment.Center) {
                                Text("≡", style = rnText(22, 400), color = c.secondaryText)
                            }
                            DropdownMenu(expanded = actionRow == row.identity, onDismissRequest = { actionRow = null }) {
                                fun move(to: Int) {
                                    actionRow = null; focusManager.clearFocus(); session.expectMove(index, to)
                                    editChecklist(JSONObject().put("kind", "move").put("from", index).put("to", to))
                                }
                                DropdownMenuItem(text = { Text(t("projects.moveUp")) }, enabled = structuralEnabled && index > 0, onClick = { move(index - 1) })
                                DropdownMenuItem(text = { Text(t("projects.moveDown")) }, enabled = structuralEnabled && index < rows.lastIndex, onClick = { move(index + 1) })
                                DropdownMenuItem(text = { Text(labels.getString("moveTop")) }, enabled = structuralEnabled && index > 0, onClick = { move(0) })
                                DropdownMenuItem(text = { Text(labels.getString("moveBottom")) }, enabled = structuralEnabled && index < rows.lastIndex, onClick = { move(rows.lastIndex) })
                                DropdownMenuItem(text = { Text(labels.getString("addBelow")) }, enabled = structuralEnabled && item.getString("title").isNotBlank(), onClick = {
                                    actionRow = null; focusManager.clearFocus()
                                    editChecklist(JSONObject().put("kind", "insertAfter").put("index", index))
                                })
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            if (ordering && reorder) Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).rnBorderBottom(c.border), verticalAlignment = Alignment.CenterVertically) {
                                Text(item.getString("orderTitle"), style = rnText(16, 500), color = c.text, maxLines = 1, modifier = Modifier.weight(1f))
                                for ((up, icon) in listOf(true to SettingsIonicons.ChevronUp, false to SettingsIonicons.ChevronDown)) {
                                    val to = index + if (up) -1 else 1
                                    val can = structuralEnabled && to in rows.indices
                                    val moveLabel = if (up) item.getString("moveUpLabel") else item.getString("moveDownLabel")
                                    Box(Modifier.size(44.dp).semantics { contentDescription = moveLabel }
                                        .clickable(enabled = can) {
                                            session.expectMove(index, to)
                                            editChecklist(JSONObject().put("kind", "move").put("from", index).put("to", to))
                                        }, contentAlignment = Alignment.Center) { Icon(icon, null, tint = if (can) c.tint else c.secondaryText, modifier = Modifier.size(18.dp)) }
                                }
                            } else ChecklistItemRow(model, editor, field, item, locked || dragRow != null, row.identity) { session.expectRemove(index) }
                        }
                    }
                }
            }
            if (!ordering || !reorder) {
                val addLabel = labels.getString("add")
                val addItem = { editChecklist(JSONObject().put("kind", "add")) }
                val add = RoundedCornerShape(8.dp)
                Row(Modifier.padding(top = 6.dp).fillMaxWidth().clip(add).background(c.cardBg).rnBorder(1.dp, c.border, add)
                    .clearAndSetSemantics { contentDescription = addLabel; role = Role.Button; testTag = "checklist-add-item"; if (structuralEnabled) onClick { addItem(); true } else disabled() }
                    .clickable(enabled = structuralEnabled) { addItem() }
                    .padding(vertical = 9.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    Icon(Lucide.PlusPlain, null, tint = c.tint, modifier = Modifier.size(14.dp))
                    Text(addLabel, style = rnText(12, 700), color = c.tint, modifier = Modifier.padding(start = 5.dp))
                }
                if (field.getBoolean("canReset")) Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 6.dp)) {
                    val reset = labels.getString("reset")
                    val box = RoundedCornerShape(12.dp)
                    val canReset = !locked && writable && failedAction == null
                    Box(Modifier.fade(if (canReset) 1f else 0.5f).heightIn(min = 44.dp).clip(box).background(c.cardBg).rnBorder(1.dp, c.border, box)
                        .clearAndSetSemantics { contentDescription = reset; role = Role.Button; testTag = "checklist-reset"; if (canReset) onClick { resetChecklist(); true } else disabled() }
                        .clickable(enabled = canReset) { resetChecklist() }
                        .padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                        Text(reset, style = rnText(12, 500), color = c.secondaryText)
                    }
                }
            }
        }
    }
}

/**
 * One checklist item on the Form tab: the checkbox (core's toggle) or a bullet, the title input (each change is core's rename;
 * Next is core's insertAfter, which names the new item to focus), and × (core's remove). The typed text stays as typed while an
 * edit from this input waits for core, so an older reply never resets newer typing.
 */
@Composable
private fun ChecklistItemRow(model: InboxViewModel, editor: TaskEditor, field: JSONObject, item: JSONObject, locked: Boolean, identity: String, beforeRemove: () -> Unit) = with(model) {
    val c = LocalTheme.current.colors
    val id = item.getString("id")
    val title = item.getString("title")
    val index = item.getInt("index")
    val typed = "checklist:$identity"
    val structuralLocked = locked || editsPending
    val pending = editor.pendingFor(typed)
    // The field keeps its own cursor (TextFieldValue). While it has focus the typing wins: a reply to an earlier keystroke reset
    // the text mid-typing, and letters landed out of order or were lost (S23 runs 52 and 54). Core's title is taken when the
    // field is not being typed in and differs from what this field last sent (a rename core changed, a reset).
    var input by remember(identity) { mutableStateOf(TextFieldValue(title, TextRange(title.length))) }
    var sent by remember(identity) { mutableStateOf(title) }
    var typing by remember(identity) { mutableStateOf(false) }
    LaunchedEffect(title, typing) { if (!typing && !pending && title != sent) { input = TextFieldValue(title, TextRange(title.length)); sent = title } }
    val text = input.text
    val focus = remember { FocusRequester() }
    LaunchedEffect(checklistFocus) { if (checklistFocus == id) { runCatching { focus.requestFocus() }; checklistFocused() } }
    val struck = item.getBoolean("struck")
    Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        val done = item.getBoolean("completed")
        val label = item.getString("checkboxLabel")
        Box(Modifier.size(44.dp).clearAndSetSemantics {
            contentDescription = label; role = Role.Checkbox; toggleableState = ToggleableState(done)
            if (!structuralLocked) onClick { editChecklist(JSONObject().put("kind", "toggle").put("index", index)); true } else disabled()
        }.clickable(enabled = !structuralLocked) { editChecklist(JSONObject().put("kind", "toggle").put("index", index)) }, contentAlignment = Alignment.Center) {
            val box = RoundedCornerShape(6.dp)
            Box(Modifier.size(28.dp).clip(box).rnBorder(2.dp, c.tint, box).background(if (done) c.tint else c.cardBg), contentAlignment = Alignment.Center) {
                if (done) Icon(Lucide.CheckBold, null, tint = c.onTint, modifier = Modifier.size(12.dp))
            }
        }
        val inputLabel = item.getString("inputLabel")
        val placeholder = field.getJSONObject("labels").getString("placeholder")
        BasicTextField(input, { next ->
            if (model.editor?.checklistStructurePending != true) {
                val changed = next.text != input.text
                input = next
                if (changed) { sent = next.text; editChecklist(JSONObject().put("kind", "rename").put("index", index).put("text", next.text), typed) }
            }
        }, enabled = !locked && !editor.checklistStructurePending, singleLine = true, cursorBrush = SolidColor(c.tint),
            textStyle = rnText(16, 400).copy(color = if (struck) c.secondaryText else c.text, textDecoration = if (struck) TextDecoration.LineThrough else null),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
            keyboardActions = KeyboardActions(onNext = {
                if (model.editor?.checklistStructurePending != true) editChecklist(JSONObject().put("kind", "insertAfter").put("index", index).put("text", text), typed)
            }),
            modifier = Modifier.weight(1f).focusRequester(focus).onFocusChanged { typing = it.isFocused }.semantics { contentDescription = inputLabel }.testTag("checklist-item-input"),
            decorationBox = { inner -> Box { if (text.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText); inner() } })
        val remove = "${t("common.delete")}: ${item.getString("orderTitle")}"
        val drop = { beforeRemove(); editChecklist(JSONObject().put("kind", "remove").put("index", index)) }
        Box(Modifier.size(44.dp).clearAndSetSemantics { contentDescription = remove; role = Role.Button; if (!structuralLocked) onClick { drop(); true } else disabled() }
            .clickable(enabled = !structuralLocked) { drop() }, contentAlignment = Alignment.Center) {
            Text("×", style = rnText(20, 300), color = c.secondaryText)
        }
    }
}
