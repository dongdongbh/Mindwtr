package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.roundToInt


@Composable
fun ArchiveList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val c = LocalTheme.current.colors
    val own = own("archive")
    val tasks = view.getString("segment") == "tasks"
    val selecting = tasks && own.optBoolean("selecting")

    BackHandler(enabled = selecting && dialog == null && model.failedAction == null) { selecting(false) }
    val labels = view.getJSONObject("labels")
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        item(key = "segments") {
            Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (chip in view.menuObjects("segments")) {
                    val on = chip.getBoolean("selected")
                    val label = chip.getString("label")
                    val shape = RoundedCornerShape(16.dp)
                    Text(label, style = rnText(12, 600), color = if (on) c.onTint else c.text, modifier = Modifier.clip(shape)
                        .background(if (on) c.tint else c.filterBg).rnBorder(1.dp, c.border, shape).semantics { contentDescription = label }
                        .selectable(selected = on, enabled = idle, role = Role.Tab) { segment(chip.getString("id")) }
                        .padding(horizontal = 12.dp, vertical = 6.dp))
                }
            }
        }
        view.optJSONObject("search")?.let { row ->
            item(key = "search") {
                Row(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SearchBox(own.optString("search"), row.getString("placeholder"), Modifier.weight(1f)) { search(it) }
                    view.getJSONObject("filters").menuText("buttonLabel")?.let { ActiveFiltersButton(it, idle) { openDialog("filters") } }
                    OverflowTrigger(enabled = idle) { openDialog("overflow") }
                }
            }
        }
        view.menuText("summary")?.let { summary ->
            item(key = "summary") {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(summary, style = rnText(13, 500), color = c.secondaryText)
                    if (tasks) SmallButton(labels.getString(if (selecting) "done" else "select"), c.text, idle) { selecting(!selecting) }
                }
            }
        }
        if (selecting) item(key = "bulk") { BulkBar(model, view) }
        if (shown.items.isEmpty()) view.optJSONObject("empty")?.let { empty ->
            item(key = "empty") {
                IconEmptyState(Lucide.ArchiveThin, empty.getString("title"), empty.getString("message"), empty.menuText("clearLabel")) {
                    filterEdit(view.getJSONObject("filters").getJSONObject("clearEdit"))
                }
            }
        }
        items(shown.items, key = { it.key }) { item ->
            Box(Modifier.padding(horizontal = 16.dp)) {
                when (item.type) {
                    "section" -> GroupHeading(model, item.json, archive = true)
                    "project" -> ArchivedProject(model, item.json)
                    else -> ArchivedTask(model, item, labels, selecting, item.json.optBoolean("selected"))
                }
            }
        }
        if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
    }
}


@Composable
private fun ArchivedTask(model: InboxViewModel, item: MenuItem, labels: JSONObject, selecting: Boolean, isSelected: Boolean) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val row = item.row ?: return
    val json = item.json
    val trash = page?.view?.getJSONObject("confirmations")?.getJSONObject("trashTask")
    val struck = if (json.getBoolean("struck")) TextDecoration.LineThrough else null
    ArchiveSwipe(model, enabled = !selecting && idle, restore = labels.getString("restore"), delete = labels.getString("delete"),
        onRestore = { archive(JSONObject().put("type", "moveToInbox").put("taskId", row.id).put("taskRevision", row.taskRevision)) },
        onDelete = { trash?.let { confirm(it, JSONObject().put("type", "trashTask").put("taskId", row.id).put("taskRevision", row.taskRevision)) } }) { actions ->
        val shape = RoundedCornerShape(12.dp)
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape).background(c.taskItemBg)
            .rnBorder(if (selecting && isSelected) 2.dp else 1.dp, if (selecting && isSelected) c.tint else c.border, shape)
            .clickable(enabled = model.writable && !model.busy && model.failedAction == null) {
                if (selecting) toggleSelected(row.id) else model.openEditor(row.id)
            }

            .semantics {
                contentDescription = if (selecting) "${labels.getString("select")} ${row.title}" else row.title
                testTag = "task-row"
                if (!selecting) customActions = actions
            }.padding(16.dp)) {
            if (selecting) {
                Box(Modifier.padding(end = 12.dp).size(22.dp).clip(CircleShape).rnBorder(2.dp, c.tint, CircleShape).background(if (isSelected) c.tint else c.taskItemBg),
                    contentAlignment = Alignment.Center) { if (isSelected) Icon(Lucide.Check, null, tint = c.onTint, modifier = Modifier.size(14.dp)) }
            }
            Column(Modifier.weight(1f)) {
                Text(row.title, style = rnText(16, 600).copy(textDecoration = struck),
                    color = c.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 4.dp))
                json.menuText("descriptionMarkdown")?.let {
                    Text(it, style = rnText(14, 400), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 4.dp))
                }

                val picker = json.optJSONObject("completedAtPicker")?.takeIf { !selecting }
                val edit = labels.getString("editCompletedAt")
                val on = picker != null && model.writable && !model.busy && model.failedAction == null
                Text(json.getString("dateLabel"), style = rnText(12, 400).copy(fontStyle = FontStyle.Italic), color = c.secondaryText,
                    modifier = if (picker == null) Modifier else Modifier.clearAndSetSemantics {
                        contentDescription = edit; role = Role.Button
                        if (on) onClick { openCompletedAt(row, picker); true } else disabled()
                    }.clickable(enabled = on) { openCompletedAt(row, picker) }.padding(vertical = 2.dp))
            }
            Box(Modifier.padding(start = 12.dp).width(4.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(theme.gray))
        }
    }
}


@Composable
private fun ArchivedProject(model: InboxViewModel, json: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val id = json.getString("id")
    val revision = json.optString("projectRevision")
    val labels = page?.view?.getJSONObject("labels") ?: return
    ArchiveSwipe(model, enabled = idle, restore = labels.getString("restore"), delete = labels.getString("delete"),
        onRestore = { archive(JSONObject().put("type", "reactivateProject").put("projectId", id).put("projectRevision", revision)) },
        onDelete = { confirm(json.getJSONObject("trashConfirmation"), JSONObject().put("type", "trashProject").put("projectId", id).put("projectRevision", revision)) }) { actions ->
        val shape = RoundedCornerShape(12.dp)
        val title = json.getString("title")
        val struck = if (json.getBoolean("struck")) TextDecoration.LineThrough else null
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape).background(c.taskItemBg).rnBorder(1.dp, c.border, shape)
            .clickable(enabled = model.failedAction == null && !model.busy) { openProjects(id) }
            .semantics { contentDescription = title; customActions = actions }.padding(16.dp)) {
            Column(Modifier.weight(1f)) {
                Text(title, style = rnText(16, 600).copy(textDecoration = struck),
                    color = c.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 4.dp))
                Text(json.getString("dateLabel"), style = rnText(12, 400).copy(fontStyle = FontStyle.Italic), color = c.secondaryText)
                json.menuText("areaName")?.let { Text(it, style = rnText(12, 400).copy(fontStyle = FontStyle.Italic), color = c.secondaryText) }
            }
            coreColorOrNull(json.menuText("indicatorColor"))?.let { color ->
                Box(Modifier.padding(start = 12.dp).width(4.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(color))
            }
        }
    }
}


@Composable
fun ArchiveSwipe(model: InboxViewModel, enabled: Boolean, restore: String, delete: String, onRestore: () -> Unit, onDelete: () -> Unit,
                 width: Dp = 100.dp, restoreColor: Color = LocalTheme.current.restoreAction, content: @Composable (List<CustomAccessibilityAction>) -> Unit) {
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val open = with(density) { (width + 8.dp).toPx() }
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val settle = { to: Float -> scope.launch { offset.animateTo(to) }; Unit }
    LaunchedEffect(enabled) { if (!enabled) offset.snapTo(0f) }
    val actions = if (enabled) listOf(CustomAccessibilityAction(restore) { onRestore(); true }, CustomAccessibilityAction(delete) { onDelete(); true }) else emptyList()
    Box(Modifier.padding(bottom = 12.dp)) {
        if (offset.value != 0f) {
            val right = offset.value > 0f
            val shape = RoundedCornerShape(12.dp)
            Column(Modifier.matchParentSize().wrapContentWidth(if (right) Alignment.Start else Alignment.End).width(width).clip(shape)
                .background(if (right) restoreColor else theme.deleteAction)
                .clickable(enabled = enabled, role = Role.Button) { settle(0f); if (right) onRestore() else onDelete() }
                .semantics { contentDescription = if (right) restore else delete },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(if (right) Lucide.RotateCcw else Lucide.Trash2, null, tint = theme.onAction, modifier = Modifier.size(18.dp))
                Text(if (right) restore else delete, style = rnText(14, 600), color = theme.onAction, modifier = Modifier.padding(top = 4.dp))
            }
        }
        Box(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.draggable(
            state = rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceIn(-open, open)) } },
            orientation = Orientation.Horizontal, enabled = enabled,
            onDragStopped = { settle(if (offset.value > open / 2) open else if (offset.value < -open / 2) -open else 0f) },
        )) { content(actions) }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BulkBar(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val labels = view.getJSONObject("labels")
    val shape = RoundedCornerShape(10.dp)
    val count = view.getInt("selectedCount")
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(labels.getString("selected"), style = rnText(12, 600), color = c.secondaryText)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val visible = view.getInt("visibleTaskCount")
            BulkButton(labels.getString("selectAll"), c.text, idle && visible > 0 && count != visible) { selectAll() }
            BulkButton(labels.getString("restoreSelected"), c.text, idle && count > 0) { archive(archiveSelection("moveTasksToInbox")) }
            BulkButton(labels.getString("delete"), c.danger, idle && count > 0) {
                confirm(view.getJSONObject("confirmations").getJSONObject("trashTasks"), archiveSelection("trashTasks"))
            }
        }
    }
}


@Composable
fun CompletedAtPicker(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    if (open.optString("step") != "time") {
        DayPickerDialog(open.getString("day"), { if (dialog?.optString("step") != "time") closeDialog("completedAt") }) { pickCompletedDay(it) }
    } else {
        val (hour, minute) = pickerClock(open.getString("time"))
        ClockPickerDialog(hour, minute, { closeDialog("completedAt") }) { pickCompletedTime(it) }
    }
}

@Composable
fun BulkButton(label: String, color: Color, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(label, style = rnText(12, 600), color = color, modifier = Modifier.fade(if (enabled) 1f else 0.5f).clip(RoundedCornerShape(8.dp)).background(c.taskItemBg)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 10.dp, vertical = 7.dp))
}


@Composable
fun SmallButton(label: String, color: Color, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Text(label, style = rnText(12, 600), color = color, modifier = Modifier.clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp))
}


@Composable
private fun SearchBox(value: String, placeholder: String, modifier: Modifier, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    BasicTextField(value, onChange, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), modifier = modifier.semantics { contentDescription = placeholder },
        decorationBox = { inner ->
            Box(Modifier.heightIn(min = 40.dp).clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 8.dp),
                contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = rnText(15, 400), color = c.secondaryText)
                inner()
            }
        })
}
