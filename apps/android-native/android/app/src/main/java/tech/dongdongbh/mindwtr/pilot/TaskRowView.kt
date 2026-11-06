package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import kotlin.math.abs
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import kotlinx.coroutines.launch
import kotlin.math.roundToInt
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject


enum class RowStatus { Hidden, Icon, Badge }


enum class RowStar { Hidden, Shown }


private val MENU_STATUSES = listOf("inbox", "next", "waiting", "someday", "done", "reference")


@OptIn(ExperimentalLayoutApi::class, ExperimentalFoundationApi::class)
@Composable
fun TaskRowItem(
    model: InboxViewModel, task: TaskRow, status: RowStatus = RowStatus.Hidden, star: RowStar = RowStar.Hidden,
    completable: Boolean = true, note: String? = null, available: Boolean = false, focusHighlight: Boolean = false,
    starBlocked: String? = null, details: Boolean = false, actions: RowActions? = null,
) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val meta = task.meta

    val canComplete = writable && !busy &&
        (failedAction == null || failedAction == completeAction(task.id, task.taskRevision))
    val canEdit = writable && !busy && failedAction == null
    val selecting = actions?.selecting == true
    val listed = actions?.status
    val tray = SwipeTrays.of(task.status, task.isFocusedToday)?.takeIf { completable && !selecting }
    val trayEnabled = { action: TrayAction ->
        when (action.id) {
            "done" -> canComplete
            "restore", "next" -> if (listed != null) canEdit else writable && !busy && (failedAction == null || failedAction == statusAction(task, action.status.orEmpty()))
            else -> canEdit
        }
    }
    val runTray = { action: TrayAction ->
        when (action.id) {
            "done" -> complete(task.id, task.taskRevision, askNext = true)
            "focus" -> swipeFocus(task)
            "organize" -> showStatusMenu(task)
            "dates" -> openDates(task)
            "delete" -> actions?.delete?.invoke() ?: editorMenu.deleteRow(task.id, task.taskRevision)
            else -> action.status?.let { target -> listed?.invoke(target) ?: changeStatus(task, target) }
        }
        Unit
    }
    val trayActions = tray?.let { it.swipeRight + it.swipeLeft }.orEmpty().filter(trayEnabled)
    val onLongDone = if (task.status != "done" && canComplete) { { completedAt.open(task, "complete") } } else null

    val editCompleted = if (canEdit && !selecting && meta.parts.any { it.kind == "completed" }) { { completedAt.open(task, "edit") } } else null
    val onTap = { if (selecting) actions?.select?.invoke() else openEditor(task.id) }
    val shape = RoundedCornerShape(theme.rowRadius)
    val strip = theme.priority(meta.priority)
    val showStar = star != RowStar.Hidden && meta.canFocus
    val showStatus = status != RowStatus.Hidden && meta.statusControl != null


    val highlighted = (focusHighlight && showStar && task.isFocusedToday || listed == null && isHighlighted(task.id)) && !selecting
    val picked = selecting && actions?.selected == true
    Box(Modifier.padding(bottom = 6.dp)) {
        SwipeTray(tray, enabled = trayActions.isNotEmpty(), shape = shape, isEnabled = trayEnabled, run = runTray, onLongDone = onLongDone) {
            Row(
                Modifier.fillMaxWidth().clip(shape).background(c.bg).background(if (available && !selecting) theme.availableBg else c.taskItemBg)
                    .rnBorder(if (highlighted || selecting) 2.dp else 1.dp,
                        if (highlighted || picked) c.tint else if (available && !selecting) theme.availableBorder else c.border, shape)

                    .pointerInput(canEdit, selecting) {
                        detectTapGestures(onLongPress = actions?.select?.let { select -> { _: Offset -> if (canEdit) select() } }) { if (canEdit) onTap() }
                    }
                    .drawBehind {

                        if (strip != null) drawRoundRect(strip, Offset(6.dp.toPx(), 8.dp.toPx()),
                            Size(3.dp.toPx(), size.height - 16.dp.toPx()), CornerRadius(2.dp.toPx()))
                    }
                    .padding(start = 16.dp, top = 10.dp, bottom = 10.dp, end = if (showStatus || showStar) 4.dp else 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {

                if (selecting) Box(Modifier.padding(end = 12.dp).size(22.dp).clip(CircleShape).rnBorder(1.5.dp, c.tint, CircleShape)
                    .background(if (picked) c.tint else c.taskItemBg), contentAlignment = Alignment.Center) {
                    if (picked) Icon(Lucide.CheckBold, null, tint = theme.onAction, modifier = Modifier.size(12.dp))
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {

                        Text(task.title, style = rnText(15, 500, 20).copy(textDirection = if (meta.rtl) TextDirection.Rtl else TextDirection.Ltr),
                            color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            textAlign = if (meta.rtl) TextAlign.Right else TextAlign.Left,
                            modifier = Modifier.weight(1f).testTag("task-row")
                                .combinedClickable(enabled = canEdit, onClickLabel = t(if (!selecting) "common.edit" else if (picked) "task.deselect" else "task.select"),
                                    onLongClick = actions?.select) { onTap() }
                                .semantics {
                                    contentDescription = meta.accessibilityLabel
                                    if (selecting) selected = picked

                                    val all = trayActions.map { action -> CustomAccessibilityAction(action.label) { runTray(action); true } } +
                                        listOfNotNull(editCompleted?.let { edit -> CustomAccessibilityAction(t("task.editCompletedAt")) { edit(); true } })
                                    if (all.isNotEmpty()) customActions = all
                                })
                        if (meta.parts.any { it.kind == "recurrence" }) {
                            Icon(Lucide.Repeat, null, tint = c.secondaryText,
                                modifier = Modifier.padding(start = 4.dp).size(12.dp))
                        }

                        if (!details && meta.hasDescription) {
                            Icon(Lucide.AlignLeft, null, tint = c.secondaryText,
                                modifier = Modifier.padding(start = 4.dp).size(12.dp))
                        }
                        if (showStar) StarButton(model, task, starBlocked?.takeIf { !task.isFocusedToday })
                    }

                    val parts = if (details) meta.parts else meta.parts.filter { !it.detail }
                    if (parts.isNotEmpty()) {
                        FlowRow(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                            for (part in parts) {
                                if (part.kind == "checklist") ChecklistBadge(part) { toggleRowChecklist(task.id) }
                                else Box(Modifier.clearAndSetSemantics { }) { MetaPartView(part, if (part.kind == "completed") editCompleted else null) }
                            }
                        }
                    }
                    note?.let { MetaText(it, if (available) c.tint else c.secondaryText, 600, Modifier.padding(top = 2.dp)) }
                    task.revealLabel?.let { MetaText(it, c.secondaryText, 600, Modifier.padding(top = 4.dp)) }
                    actions?.footer?.invoke()
                    if (rowChecklistOpen[task.id] == true) {
                        LaunchedEffect(task.taskRevision) { readRowChecklist(task.id) }
                        RowChecklistItems(model, task.id, selecting)
                    }
                }
                if (showStatus) StatusControl(model, task, status == RowStatus.Icon, completable && !selecting)
            }
        }
    }
}


class RowActions(
    val status: ((String) -> Unit)? = null, val delete: (() -> Unit)? = null, val selecting: Boolean = false, val selected: Boolean = false,
    val select: (() -> Unit)? = null, val footer: (@Composable () -> Unit)? = null,
)


@Composable
private fun MetaPartView(part: MetaPart, onClick: (() -> Unit)? = null) {
    val theme = LocalTheme.current
    val c = theme.colors
    when (part.kind) {
        "project", "area" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(6.dp).clip(CircleShape).background(coreColorOrNull(part.dotColor) ?: c.tint))
            MetaText(part.text, c.secondaryText, 500, Modifier.padding(start = 4.dp))
        }
        "projectDeadline", "dateIssue" -> MetaText(part.text, theme.metaAmber, 600, maxLines = if (part.kind == "dateIssue") 1 else 2)
        "context", "tag" -> Row(verticalAlignment = Alignment.CenterVertically) {
            MetaText(part.text, if (part.kind == "context") theme.context else theme.tag, 500)
            if (part.overflow > 0) MetaText("+${part.overflow}", c.secondaryText, 500, Modifier.padding(start = 4.dp))
        }
        "due" -> MetaText(part.text, when (part.tone) { "overdue" -> c.danger; "dueSoon" -> c.warning; else -> c.secondaryText }, 600)
        "checklist" -> MetaIcon(Lucide.ListChecks, "${part.done}/${part.of}", 13)

        "assignedTo" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Lucide.UserRound, null, tint = c.secondaryText, modifier = Modifier.size(12.dp))
            MetaText(part.text, c.text, 600, Modifier.padding(start = 4.dp))
        }
        "recurrence" -> MetaIcon(Lucide.Repeat, part.text)
        "timeSpent" -> MetaIcon(Lucide.History, part.text)
        "attachments" -> MetaIcon(Lucide.Paperclip, part.text)

        "completed" -> MetaText(part.text, c.secondaryText, 500, if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick).testTag("row-completed-at") else Modifier)
        else -> MetaText(part.text, c.secondaryText, 500)
    }
}

@Composable
private fun ChecklistBadge(part: MetaPart, toggle: () -> Unit) {
    val label = t("checklist.progress")
    Box(Modifier.clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = "row-checklist-toggle"; onClick { toggle(); true } }
        .clickable(role = Role.Button, onClick = toggle)) {
        MetaIcon(Lucide.ListChecks, "${part.done}/${part.of}", 13)
    }
}


@Composable
private fun RowChecklistItems(model: InboxViewModel, taskId: String, selecting: Boolean) = with(model) {
    val c = LocalTheme.current.colors
    val read = rowChecklists[taskId] ?: return
    val items = shownRowChecklistItems(taskId)
    if (items.isEmpty()) return
    val tappable = writable && !read.optBoolean("readOnly")
    val labels = read.optJSONObject("markdownLabels") ?: JSONObject()
    Column(Modifier.padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (item in items) {
            val text = buildAnnotatedString {
                append(if (item.completed) "\u2713 " else "\u25CB ")
                append(inline(item.inline, labels, c.tint, c.secondaryText, c.cardBg) { })
            }
            Text(text, style = rnText(11, 400).copy(textDecoration = if (item.completed) TextDecoration.LineThrough else null),
                color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().fade(if (item.completed) 0.6f else 1f)
                    .clearAndSetSemantics {
                        contentDescription = item.title; role = Role.Checkbox; toggleableState = ToggleableState(item.completed); testTag = "row-checklist-item"
                        if (tappable) onClick { tickRowChecklistItem(taskId, item); true } else disabled()
                    }
                    .clickable(enabled = tappable) { tickRowChecklistItem(taskId, item) }
                    .padding(vertical = 2.dp))
        }
        if (!selecting && tappable) {
            val draft = rowChecklistDrafts[taskId].orEmpty()
            val addLabel = read.getString("addLabel")
            BasicTextField(draft, { typeRowChecklistDraft(taskId, it) }, singleLine = true, textStyle = rnText(11, 400).copy(color = c.text),
                cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (!submitRowChecklistDraft(taskId)) defaultKeyboardAction(ImeAction.Done) }),
                modifier = Modifier.fillMaxWidth().heightIn(min = 28.dp).semantics { contentDescription = addLabel }.testTag("row-checklist-add").padding(vertical = 4.dp),
                decorationBox = { inner -> Box(contentAlignment = Alignment.CenterStart) { if (draft.isEmpty()) Text("+ $addLabel", style = rnText(11, 400), color = c.secondaryText); inner() } })
        }
    }
}


@Composable
private fun MetaIcon(icon: ImageVector, text: String, size: Int = 12) = Row(verticalAlignment = Alignment.CenterVertically) {
    val c = LocalTheme.current.colors
    Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(size.dp))
    MetaText(text, c.secondaryText, 500, Modifier.padding(start = 4.dp))
}

@Composable
fun MetaText(text: String, color: Color, weight: Int, modifier: Modifier = Modifier, maxLines: Int = 2) =
    Text(text, style = rnText(12, weight, 16), color = color, maxLines = maxLines, overflow = TextOverflow.Ellipsis, modifier = modifier)


@Composable
private fun StarButton(model: InboxViewModel, task: TaskRow, blocked: String?) = with(model) {
    val disabled = blocked != null
    val target = !task.isFocusedToday
    val enabled = !disabled && writable && !busy && (failedAction == null || failedAction == taskFocusAction(task.id, target, task.taskRevision))
    val label = blocked ?: t(if (task.isFocusedToday) "agenda.removeFromFocus" else "agenda.addToFocus")
    FocusStar(task.isFocusedToday, disabled, 22, Modifier.size(44.dp)
        .clickable(enabled = enabled, role = Role.Button) { setTaskFocus(task.id, target, task.taskRevision) }
        .semantics { contentDescription = label; if (disabled) disabled() })
}


@Composable
fun FocusStar(focused: Boolean, disabled: Boolean, size: Int, modifier: Modifier) {
    val theme = LocalTheme.current
    Box(modifier, contentAlignment = Alignment.Center) {
        Icon(if (focused) Lucide.StarFilled else Lucide.Star, null, tint = if (focused) theme.star else theme.colors.secondaryText,
            modifier = Modifier.size(size.dp).fade(if (focused) 1f else if (disabled) 0.3f else 0.6f))
    }
}


@Composable
private fun StatusControl(model: InboxViewModel, task: TaskRow, icon: Boolean, editable: Boolean) = with(model) {
    val theme = LocalTheme.current
    val colors = theme.status(task.status)
    val label = task.meta.statusControl ?: return
    val owed = failedAction
    val enabled = editable && writable && !busy && (owed == null || (owed.kind == "update" && owed.id == task.id && owed.base == mapOf("status" to task.status)))
    val spoken = t("task.aria.changeStatus").replace("{{status}}", label)
    val tap = Modifier.clickable(enabled = enabled, role = Role.Button, onClickLabel = t("task.aria.changeStatusHint")) { showStatusMenu(task) }
        .semantics { contentDescription = spoken }
    if (icon) {
        Box(Modifier.padding(start = 8.dp).size(44.dp).then(tap), contentAlignment = Alignment.Center) {
            Icon(Lucide.CircleDot, null, tint = colors.text, modifier = Modifier.size(20.dp))
        }
    } else {
        val shape = RoundedCornerShape(8.dp)

        Box(Modifier.padding(start = 12.dp, end = 12.dp).heightIn(min = 44.dp).clip(shape).background(colors.bg)
            .then(tap).padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
            Text(label.replaceFirstChar { it.uppercase() }, style = rnText(10, 600), color = colors.text)
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StatusMenu(model: InboxViewModel) = with(model) {
    DestinationPicker(model)
    DatesSheet(model)
    val task = statusMenu ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler { showStatusMenu(null) }
    Box(Modifier.fillMaxSize().background(theme.menuScrim).pointerInput(Unit) { detectTapGestures { showStatusMenu(null) } }
        .padding(20.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 340.dp).fillMaxWidth().shadow(5.dp, RoundedCornerShape(16.dp)).clip(RoundedCornerShape(16.dp))
            .background(c.cardBg).pointerInput(Unit) { detectTapGestures { } }.padding(20.dp)) {
            Text(t("taskStatus.changeStatus"), style = rnText(18, 600), color = c.text, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp).semantics { heading() })
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterHorizontally),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                for (status in MENU_STATUSES) {
                    val colors = theme.status(status)
                    val current = status == task.status
                    val enabled = writable && !busy && (failedAction == null
                        || failedAction == if (status == "done") completeAction(task.id, task.taskRevision) else statusAction(task, status))

                    val backdate = if (status == "done" && task.status != "done" && failedAction == null) { { showStatusMenu(null); completedAt.open(task, "complete") } } else null
                    Row(
                        Modifier.fade(if (enabled) 1f else 0.5f).fillMaxWidth(0.42f).clip(RoundedCornerShape(20.dp)).then(if (current) Modifier.background(colors.bg) else Modifier)
                            .rnBorder(1.dp, colors.text, RoundedCornerShape(20.dp))
                            .combinedClickable(enabled = enabled, role = Role.Button, onLongClickLabel = backdate?.let { t("task.completeBackdateHintMobile") },
                                onLongClick = backdate) { chooseStatus(task, status) }
                            .semantics { selected = current }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(colors.text))
                        Text(t("status.$status").replaceFirstChar { it.uppercase() }, style = rnText(14, 500), color = c.text,
                            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
                    }
                }
            }
            val idle = writable && !busy && failedAction == null

            Column(Modifier.fillMaxWidth().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(t("task.destination"), style = rnText(13, 600), color = c.secondaryText, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().semantics { heading() })
                StatusMenuAction(t("task.moveToProjectOrArea"), idle) { openDestination(task) }
                menu.moveLabel(task)?.let { moveLabel ->
                    StatusMenuAction(moveLabel, idle) { showStatusMenu(null); menu.openMove(listOf(task.id), JSONObject().put(task.id, task.taskRevision)) }
                }
            }

            val context = LocalContext.current
            Column(Modifier.fillMaxWidth().padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                StatusMenuAction(t("task.copyTaskLink"), true) { showStatusMenu(null); copyTaskReference(context, task.id, link = true) }
                StatusMenuAction(t("task.copyTaskId"), true) { showStatusMenu(null); copyTaskReference(context, task.id, link = false) }
            }
        }
    }
}


@Composable
private fun DestinationPicker(model: InboxViewModel) = with(model) {
    destinationFor ?: return
    val picker = destinationPicker
    val c = LocalTheme.current.colors
    PickerDialog(picker?.getString("title") ?: t("task.destination"), { closeDestination() }, search = {
        ModalInput(destinationQuery, t("common.search"), picker?.getString("title") ?: t("task.destination"), Modifier.testTag("destination-search")) { searchDestination(it) }
    }) {
        picker ?: return@PickerDialog
        val enabled = writable && !busy && failedAction == null
        val row: @Composable (JSONObject, String?) -> Unit = { choice, description ->
            PickerItem(choice.getString("title"), description = description, selected = choice.getBoolean("selected")) {
                if (enabled) moveToDestination(choice.getJSONObject("destination"))
            }
        }
        row(picker.getJSONObject("none"), null)
        for (group in picker.menuObjects("projectGroups")) {
            PickerHeading(group.getString("title"))
            for (project in group.menuObjects("rows")) row(project, project.getString("accessibilityLabel"))
        }
        val areas = picker.getJSONObject("areas")
        PickerHeading(areas.getString("title"))
        for (area in areas.menuObjects("rows")) row(area, area.getString("accessibilityLabel"))
        picker.menuText("noMatches")?.let { Text(it, style = rnText(16, 400), color = c.secondaryText,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
    }
}


@Composable
private fun DatesSheet(model: InboxViewModel) = with(model) {
    val sheet = datesSheet ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler { closeDates() }
    Box(Modifier.fillMaxSize().background(theme.menuScrim).pointerInput(Unit) { detectTapGestures { closeDates() } }
        .padding(20.dp), contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 340.dp).fillMaxWidth().shadow(5.dp, RoundedCornerShape(16.dp)).clip(RoundedCornerShape(16.dp))
            .background(c.cardBg).pointerInput(Unit) { detectTapGestures { } }.padding(20.dp).testTag("dates-sheet")) {
            Text(sheet.getString("title"), style = rnText(18, 600), color = c.text, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp).semantics { heading() })
            Column(Modifier.heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.6f).dp).verticalScroll(rememberScrollState())) {
                for (part in sheet.menuObjects("fields")) {
                    val field = part.getString("field")
                    val label = part.getString("label")
                    val value = part.getString("value")
                    Text(label.replaceFirstChar { it.uppercase() }, style = rnText(14, 500), color = c.secondaryText, modifier = Modifier.padding(top = 12.dp))
                    val pill = RoundedCornerShape(20.dp)
                    Box(Modifier.padding(top = 6.dp).fillMaxWidth().heightIn(min = 48.dp).clip(pill).rnBorder(1.dp, c.border, pill)
                        .clickable(role = Role.Button) { datesPicker = field }.semantics { contentDescription = "$label, $value" }
                        .testTag("dates-$field").padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(value, style = rnText(14, 500), color = c.text, textAlign = TextAlign.Center)
                    }
                    val chips = part.menuObjects("quickDates").map { QuickDate(it.getString("label"), it.getBoolean("selected"), it.getString("value")) }
                    QuickDateChips(label, chips, enabled = true, minHeight = 48) { datesPicker = null; editDates(field, it) }
                    if (datesPicker == field) DayPickerDialog(part.getString("pickerStart"), { datesPicker = null }) { day -> pickDatesDay(field, day) }
                }
                sheet.menuText("issue")?.takeIf { it.isNotEmpty() }?.let { Text(it, style = rnText(14, 400), color = c.warning, modifier = Modifier.padding(top = 8.dp)) }
            }
            val canSave = writable && !busy && failedAction == null
            Row(Modifier.fillMaxWidth().padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val pill = RoundedCornerShape(20.dp)
                Box(Modifier.weight(1f).heightIn(min = 48.dp).clip(pill).rnBorder(1.dp, c.border, pill).clickable(role = Role.Button) { closeDates() }
                    .padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                    Text(sheet.getString("cancel"), style = rnText(14, 500), color = c.text)
                }
                Box(Modifier.weight(1f).fade(if (canSave) 1f else 0.5f).heightIn(min = 48.dp).clip(pill).background(c.tint).rnBorder(1.dp, c.tint, pill)
                    .clickable(enabled = canSave, role = Role.Button) { saveDates() }.testTag("dates-save")
                    .padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                    Text(sheet.getString("save"), style = rnText(14, 500), color = c.onTint)
                }
            }
        }
    }
}

@Composable
private fun StatusMenuAction(label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(20.dp)
    Box(Modifier.fade(if (enabled) 1f else 0.5f).fillMaxWidth().heightIn(min = 44.dp).clip(shape).rnBorder(1.dp, c.border, shape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
        .padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(14, 500), color = c.text, textAlign = TextAlign.Center)
    }
}


data class Toast(val title: String?, val message: String, val tone: String, val action: String? = null, val onAction: () -> Unit = {})


@Composable
fun ToastCard(model: InboxViewModel, modifier: Modifier) {
    val (title, message, tone, action, onAction) = model.toast ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val shape = RoundedCornerShape(18.dp)
    Row(
        modifier.padding(horizontal = 16.dp).widthIn(max = 520.dp).fillMaxWidth().heightIn(min = 56.dp)
            .shadow(10.dp, shape).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .clickable { model.dismissToast() }.semantics { liveRegion = LiveRegionMode.Polite }
            .padding(start = 16.dp, end = 14.dp, top = 14.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {

        val accent = when (tone) { "warning" -> c.warning; "error" -> c.danger; "success" -> c.success; else -> c.tint }
        Box(Modifier.size(width = 4.dp, height = 36.dp).clip(CircleShape).background(accent))
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            title?.let { Text(it, style = rnText(15, 700), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            Text(message, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = if (action != null) 4 else 5, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 3.dp))
        }
        action?.let { label ->
            Box(Modifier.padding(start = 12.dp).heightIn(min = 44.dp).widthIn(min = 44.dp)
                .clickable(role = Role.Button) { model.dismissToast(); onAction() }.padding(10.dp), contentAlignment = Alignment.Center) {
                Text(label, style = rnText(13, 700), color = accent)
            }
        }
    }
}


internal const val TRAY_FRICTION = 1.25f
internal const val TRAY_OPEN_THRESHOLD_DP = 72f
internal const val TRAY_DRAG_OFFSET_DP = 28f
private const val TRAY_BUTTON_DP = 76
private const val TRAY_GAP_DP = 6
private const val TRAY_MARGIN_DP = 8
internal const val TRAY_LABEL_MAX_FONT_SCALE = 1.2f
private const val TRAY_DRAG_TOSS = 0.05f

internal fun trayButtonColor(theme: MindwtrTheme, id: String): Color = when (id) {
    "done" -> theme.status("done").text
    "focus" -> theme.star
    "organize", "next" -> theme.status("next").text
    "dates" -> theme.status("someday").text
    "restore" -> theme.status("inbox").text
    else -> theme.einkSafe(theme.deleteAction)
}

internal fun trayWidthDp(buttons: Int): Int = if (buttons == 0) 0 else buttons * TRAY_BUTTON_DP + (buttons - 1) * TRAY_GAP_DP + TRAY_MARGIN_DP

internal fun trayDragOffset(start: Float, dragged: Float, dragOffset: Float, left: Float, right: Float): Float =
    if (abs(dragged) < dragOffset) start else (start + dragged / TRAY_FRICTION).coerceIn(-right, left)

internal fun settleTray(start: Float, offset: Float, velocity: Float, threshold: Float, left: Float, right: Float): Float {
    val moved = offset - start + TRAY_DRAG_TOSS * velocity / TRAY_FRICTION
    return when {
        start > 0f -> if (moved > -threshold) left else 0f
        start < 0f -> if (moved < threshold) -right else 0f
        moved > threshold && left > 0f -> left
        moved < -threshold && right > 0f -> -right
        else -> 0f
    }
}

internal fun releaseTray(start: Float, dragged: Float, velocity: Float, dragOffset: Float, threshold: Float, left: Float, right: Float): Float =
    if (abs(dragged) < dragOffset) start else settleTray(start, trayDragOffset(start, dragged, dragOffset, left, right), velocity, threshold, left, right)

private fun Tray?.buttonIds() = this?.let { listOf(it.swipeRight.map(TrayAction::id), it.swipeLeft.map(TrayAction::id)) }

internal fun trayOffsetAfterChange(offset: Float, before: Tray?, after: Tray?): Float = if (before.buttonIds() == after.buttonIds()) offset else 0f

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SwipeTray(tray: Tray?, enabled: Boolean, shape: RoundedCornerShape, isEnabled: (TrayAction) -> Boolean, run: (TrayAction) -> Unit,
                      onLongDone: (() -> Unit)?, content: @Composable () -> Unit) {
    val density = LocalDensity.current
    val left = with(density) { trayWidthDp(tray?.swipeRight?.size ?: 0).dp.toPx() }
    val right = with(density) { trayWidthDp(tray?.swipeLeft?.size ?: 0).dp.toPx() }
    val threshold = with(density) { TRAY_OPEN_THRESHOLD_DP.dp.toPx() }
    val dragOffset = with(density) { TRAY_DRAG_OFFSET_DP.dp.toPx() }
    val labels = density.fontScale <= TRAY_LABEL_MAX_FONT_SCALE
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var start by remember { mutableFloatStateOf(0f) }
    var dragged by remember { mutableFloatStateOf(0f) }
    val settle = { to: Float -> scope.launch { offset.animateTo(to) }; Unit }
    val view = LocalView.current
    val press = { action: TrayAction ->
        settle(0f)
        if (action.id in setOf("done", "restore", "next")) view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY)
        if (action.id == "delete" && Build.VERSION.SDK_INT >= 30) view.performHapticFeedback(HapticFeedbackConstants.REJECT)
        run(action)
    }
    LaunchedEffect(enabled) { if (!enabled) offset.snapTo(0f) }
    var shownTray by remember { mutableStateOf(tray) }
    LaunchedEffect(tray) {
        val kept = trayOffsetAfterChange(offset.targetValue, shownTray, tray)
        shownTray = tray
        if (kept != offset.targetValue) offset.snapTo(kept)
    }
    Box {
        if (tray != null && offset.value > 0f) TrayButtons(tray.swipeRight, Alignment.Start, shape, labels, isEnabled, press,
            onLongDone?.let { long -> { settle(0f); view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS); long() } })
        if (tray != null && offset.value < 0f) TrayButtons(tray.swipeLeft, Alignment.End, shape, labels, isEnabled, press, null)
        Box(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.draggable(
            state = rememberDraggableState { delta ->
                dragged += delta
                val to = trayDragOffset(start, dragged, dragOffset, left, right)
                scope.launch { offset.snapTo(to) }
            },
            orientation = Orientation.Horizontal, enabled = enabled,
            onDragStarted = { start = offset.targetValue; dragged = 0f },
            onDragStopped = { velocity -> settle(releaseTray(start, dragged, velocity, dragOffset, threshold, left, right)) },
        )) {
            content()
            if (offset.targetValue != 0f) Box(Modifier.matchParentSize().pointerInput(Unit) { detectTapGestures(onLongPress = { }) { settle(0f) } })
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BoxScope.TrayButtons(actions: List<TrayAction>, side: Alignment.Horizontal, shape: RoundedCornerShape, labels: Boolean,
                                 isEnabled: (TrayAction) -> Boolean, press: (TrayAction) -> Unit, onLongDone: (() -> Unit)?) {
    val theme = LocalTheme.current
    Row(Modifier.matchParentSize().wrapContentWidth(side), horizontalArrangement = Arrangement.spacedBy(TRAY_GAP_DP.dp)) {
        for (action in actions) {
            val enabled = isEnabled(action)
            val long = onLongDone?.takeIf { action.id == "done" && enabled }
            val spoken = if (action.id == "delete") t("task.aria.delete") else t("task.aria.action").replace("{{action}}", action.label)
            val color = trayButtonColor(theme, action.id)
            Column(Modifier.fade(if (enabled) 1f else 0.5f).width(TRAY_BUTTON_DP.dp).fillMaxHeight().heightIn(min = 48.dp).clip(shape).background(color)
                .testTag("swipe-${action.id}")
                .combinedClickable(enabled = enabled, role = Role.Button, onLongClick = long,
                    onLongClickLabel = long?.let { t("task.completeBackdateHintMobile") }) { press(action) }
                .semantics { contentDescription = spoken }.padding(horizontal = 4.dp),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterVertically)) {
                val icon = when (action.id) {
                    "done" -> Lucide.Circle
                    "focus" -> if (action.focused) Lucide.StarFilled else Lucide.Star
                    "organize" -> Lucide.FolderOpen
                    "dates" -> Lucide.CalendarDays
                    "restore" -> Lucide.RotateCcw
                    "next" -> Lucide.ArrowRight
                    else -> Lucide.Trash2
                }
                Icon(icon, null, tint = theme.onAction, modifier = Modifier.size(20.dp))
                if (labels) Text(action.label, style = rnText(12, 600), color = theme.onAction, textAlign = TextAlign.Center, maxLines = 2,
                    overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
