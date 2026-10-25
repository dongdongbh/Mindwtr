package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
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

/** What a list shows at a row's right edge, as RN's lists do: nothing, the status glyph (one-status lists), or the status badge. */
enum class RowStatus { Hidden, Icon, Badge }

/** RN's Focus star: none or shown. A shown star is disabled with core's reason when its section sends one (Upcoming). */
enum class RowStar { Hidden, Shown }

/** RN's status menu order (QUICK_STATUS_OPTIONS). */
private val MENU_STATUSES = listOf("inbox", "next", "waiting", "someday", "done", "reference")

/**
 * One row on any list, as RN's task row (SwipeableTaskItemContent) draws it: a card with core's
 * priority strip, the title, [RowStar] beside it, and core's meta line; [RowStatus] at the right
 * edge. Every word and date is core's text. A tap opens the editor. A swipe right completes
 * (RN's swipe reveals its action; here the swipe itself runs it), and TalkBack has the same
 * Done as a custom action. An Upcoming row also shows core's reveal date, and a project row
 * core's sequence cue as [note]; [available] marks core's available next action. A read-only
 * project's rows are not [completable]. [focusHighlight] outlines a starred row, as RN does
 * outside Today's Focus. [starBlocked] is core's reason the star can only refuse (the section's
 * focusBlockedLabel): an unstarred row's star is then drawn disabled with that label, as RN does.
 * [details] shows core's detail parts too, where RN's list does (Waiting, and Someday's Details toggle).
 * [actions] is a list whose own contract writes its rows (Contexts, Review, the Weekly and Daily Review): see [RowActions].
 */
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
    // Core's swipe action (meta.swipe): the status it sets, its label, and its icon.
    val target = meta.swipe.target
    val swipeLabel = meta.swipe.label
    val canComplete = writable && !busy &&
        (failedAction == null || failedAction == completeAction(task.id, task.taskRevision))
    val canEdit = writable && !busy && failedAction == null
    // Done keeps its own command (core's completeTask) on every list, with RN's Undo toast; Restore and Next are RN's status change,
    // with its exact retry. A list whose contract writes its rows sends that list's own action for them; a selecting list has no swipe.
    val canMove = writable && !busy && (failedAction == null || failedAction == statusAction(task, target))
    val selecting = actions?.selecting == true
    val listed = actions?.status
    val swipeOn = !selecting && if (target == "done") completable && canComplete else if (listed != null) canEdit else completable && canMove
    val onSwipe = if (target == "done") { { complete(task.id, task.taskRevision) } } else listed?.let { status -> { status(target) } } ?: { changeStatus(task, target) }
    val onDelete = actions?.delete?.takeIf { canEdit && !selecting }
    val onTap = { if (selecting) actions?.select?.invoke() else openEditor(task.id) }
    val shape = RoundedCornerShape(theme.rowRadius)
    val strip = theme.priority(meta.priority)
    val showStar = star != RowStar.Hidden && meta.canFocus
    val showStatus = status != RowStatus.Hidden && meta.statusLabel != null
    // RN outlines a starred row outside Today's Focus, and a task opened from search on the task list it opened on (not on Contexts
    // or the Review screens, whose rows RN draws without it), both in the tint.
    val highlighted = (focusHighlight && showStar && task.isFocusedToday || listed == null && isHighlighted(task.id)) && !selecting
    val picked = selecting && actions?.selected == true
    Box(Modifier.padding(bottom = 6.dp)) {
        SwipeAction(enabled = swipeOn, swipe = meta.swipe, shape = shape, onSwipe = onSwipe, onMenu = { showStatusMenu(task) }, onDelete = onDelete) {
            Row(
                Modifier.fillMaxWidth().clip(shape).background(c.bg).background(if (available && !selecting) theme.availableBg else c.taskItemBg)
                    .rnBorder(if (highlighted || selecting) 2.dp else 1.dp,
                        if (highlighted || picked) c.tint else if (available && !selecting) theme.availableBorder else c.border, shape)
                    // RN's long-press on a list with selection selects the row (and starts selecting).
                    .pointerInput(canEdit, selecting) {
                        detectTapGestures(onLongPress = actions?.select?.let { select -> { _: Offset -> if (canEdit) select() } }) { if (canEdit) onTap() }
                    }
                    .drawBehind {
                        // RN's priority strip: 3 wide, 6 in from the start, 8 from the top and the bottom.
                        if (strip != null) drawRoundRect(strip, Offset(6.dp.toPx(), 8.dp.toPx()),
                            Size(3.dp.toPx(), size.height - 16.dp.toPx()), CornerRadius(2.dp.toPx()))
                    }
                    .padding(start = 16.dp, top = 10.dp, bottom = 10.dp, end = if (showStatus || showStar) 4.dp else 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // RN's selection circle: tint ring, filled with a check when the row is selected.
                if (selecting) Box(Modifier.padding(end = 12.dp).size(22.dp).clip(CircleShape).rnBorder(1.5.dp, c.tint, CircleShape)
                    .background(if (picked) c.tint else c.taskItemBg), contentAlignment = Alignment.Center) {
                    if (picked) Icon(Lucide.CheckBold, null, tint = theme.onAction, modifier = Modifier.size(12.dp))
                }
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // The title carries the row for TalkBack: core's label, Edit, and the swipe's action as a custom action.
                        Text(task.title, style = rnText(15, 500, 20).copy(textDirection = if (meta.rtl) TextDirection.Rtl else TextDirection.Ltr),
                            color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                            textAlign = if (meta.rtl) TextAlign.Right else TextAlign.Left,
                            modifier = Modifier.weight(1f).testTag("task-row")
                                .combinedClickable(enabled = canEdit, onClickLabel = t(if (!selecting) "common.edit" else if (picked) "task.deselect" else "task.select"),
                                    onLongClick = actions?.select) { onTap() }
                                .semantics {
                                    contentDescription = meta.accessibilityLabel
                                    if (selecting) selected = picked
                                    // RN's accessibility actions: the swipe's action, and the status menu its long-press opens.
                                    if (swipeOn) customActions = listOf(CustomAccessibilityAction(swipeLabel) { onSwipe(); true },
                                        CustomAccessibilityAction(t("taskStatus.changeStatus")) { showStatusMenu(task); true }) +
                                        listOfNotNull(onDelete?.let { delete -> CustomAccessibilityAction(t("common.delete")) { delete(); true } })
                                })
                        if (meta.parts.any { it.kind == "recurrence" }) {
                            Icon(Lucide.Repeat, null, tint = c.secondaryText,
                                modifier = Modifier.padding(start = 4.dp).size(12.dp))
                        }
                        // Hidden details keep one cue that the task has more to read (#1287).
                        if (!details && meta.hasDescription) {
                            Icon(Lucide.AlignLeft, null, tint = c.secondaryText,
                                modifier = Modifier.padding(start = 4.dp).size(12.dp))
                        }
                        if (showStar) StarButton(model, task, starBlocked?.takeIf { !task.isFocusedToday })
                    }
                    // TalkBack hears the line in core's label above, so it is not read twice.
                    val parts = if (details) meta.parts else meta.parts.filter { !it.detail }
                    if (parts.isNotEmpty()) {
                        FlowRow(Modifier.padding(top = 2.dp).clearAndSetSemantics { }, horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                            for (part in parts) MetaPartView(part)
                        }
                    }
                    note?.let { MetaText(it, if (available) c.tint else c.secondaryText, 600, Modifier.padding(top = 2.dp)) }
                    task.revealLabel?.let { MetaText(it, c.secondaryText, 600, Modifier.padding(top = 4.dp)) }
                    actions?.footer?.invoke()
                }
                if (showStatus) StatusControl(model, task, status == RowStatus.Icon, completable && !selecting)
            }
        }
    }
}

/**
 * A list whose contract writes its rows (Contexts, Review, the Weekly and Daily Review), as RN's rowActions there: the swipe and
 * the status menu send [status] (core's setTaskStatus for that list), RN's swipe left reveals Delete ([delete], core's trashTask
 * with its Undo), and a long-press selects the row ([select]) where the list offers bulk actions; while [selecting], a tap
 * toggles the row and the swipes rest. [footer] sits under the meta line (the Daily Review's Follow up today). Without
 * [status] (the lists with core's bulk contract: Inbox, Waiting, Someday, Reference, Done) the row keeps its own swipe and
 * status menu, and only selection comes from here.
 */
class RowActions(
    val status: ((String) -> Unit)? = null, val delete: (() -> Unit)? = null, val selecting: Boolean = false, val selected: Boolean = false,
    val select: (() -> Unit)? = null, val footer: (@Composable () -> Unit)? = null,
)

/** One meta part as RN's renderMetaPart draws it: its icon, color, and weight; core's text as is. */
@Composable
private fun MetaPartView(part: MetaPart) {
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
        // The person is what a Waiting row is read for, so the name stands out, as on RN (#1282).
        "assignedTo" -> Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Lucide.UserRound, null, tint = c.secondaryText, modifier = Modifier.size(12.dp))
            MetaText(part.text, c.text, 600, Modifier.padding(start = 4.dp))
        }
        "recurrence" -> MetaIcon(Lucide.Repeat, part.text)
        "timeSpent" -> MetaIcon(Lucide.History, part.text)
        "attachments" -> MetaIcon(Lucide.Paperclip, part.text)
        else -> MetaText(part.text, c.secondaryText, 500) // start, estimate, completed, cancelled
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

/**
 * RN's FocusStarIcon in its 44 x 44 button: amber and filled when starred, else the secondary
 * text color at 60%. With core's [blocked] reason it is drawn at 30%, disabled, and TalkBack hears
 * that reason (RN's focusToggleDisabledLabel). A tap asks core for the other state; while a
 * failed star's retry is owed, only that exact star works.
 */
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

/** RN's FocusStarIcon: amber and filled when [focused], else the secondary text color at 60% (30% when [disabled]). */
@Composable
fun FocusStar(focused: Boolean, disabled: Boolean, size: Int, modifier: Modifier) {
    val theme = LocalTheme.current
    Box(modifier, contentAlignment = Alignment.Center) {
        Icon(if (focused) Lucide.StarFilled else Lucide.Star, null, tint = if (focused) theme.star else theme.colors.secondaryText,
            modifier = Modifier.size(size.dp).fade(if (focused) 1f else if (disabled) 0.3f else 0.6f))
    }
}

/**
 * RN's status control: the CircleDot glyph on a one-status list (Inbox), else the status badge
 * with core's label, both in core's status colors. A tap opens RN's status menu. A read-only
 * row shows it disabled, as RN does.
 */
@Composable
private fun StatusControl(model: InboxViewModel, task: TaskRow, icon: Boolean, editable: Boolean) = with(model) {
    val theme = LocalTheme.current
    val colors = theme.status(task.status)
    val label = task.meta.statusLabel ?: return
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
        // RN's statusBadge sets a borderColor but no borderWidth: the row's badge is a plain fill (the editor's TaskStatusBadge has a border).
        Box(Modifier.padding(start = 12.dp, end = 12.dp).heightIn(min = 44.dp).clip(shape).background(colors.bg)
            .then(tap).padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
            Text(label.replaceFirstChar { it.uppercase() }, style = rnText(10, 600), color = colors.text)
        }
    }
}

/**
 * RN's status menu: a centered card over a dimmed screen, "Change Status", and the six statuses
 * with core's labels and colors. A choice runs core's updateTask with the status the row was
 * loaded with. On Someday's rows RN adds Move to section… (core's move dialog, MenuModel.openMove);
 * RN's Move to… needs a contract call this app lacks.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StatusMenu(model: InboxViewModel) = with(model) {
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
                    Row(
                        Modifier.fade(if (enabled) 1f else 0.5f).fillMaxWidth(0.42f).clip(RoundedCornerShape(20.dp)).then(if (current) Modifier.background(colors.bg) else Modifier)
                            .rnBorder(1.dp, colors.text, RoundedCornerShape(20.dp))
                            .clickable(enabled = enabled, role = Role.Button) { chooseStatus(task, status) }
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
            // RN's Move to section… pill, full width under the statuses (its text capitalized per word, as RN's menuText).
            menu.moveLabel(task)?.let { label ->
                val enabled = writable && !busy && failedAction == null
                Row(Modifier.fade(if (enabled) 1f else 0.5f).fillMaxWidth().clip(RoundedCornerShape(20.dp)).rnBorder(1.dp, c.border, RoundedCornerShape(20.dp))
                    .clickable(enabled = enabled, role = Role.Button) { showStatusMenu(null); menu.openMove(listOf(task.id), JSONObject().put(task.id, task.taskRevision)) }
                    .semantics { contentDescription = label }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(label.split(' ').joinToString(" ") { word -> word.replaceFirstChar { it.uppercase() } }, style = rnText(14, 500), color = c.text)
                }
            }
        }
    }
}

/** RN's toast: an optional title, the message, its tone (warning, error, success, or info), and an optional action (RN's Undo). */
data class Toast(val title: String?, val message: String, val tone: String, val action: String? = null, val onAction: () -> Unit = {})

/** RN's toast, above the tab bar: a card with the tone's accent bar, core's title, core's message, and its action in the accent. */
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
        // RN's accent: warning (a refused star, a Process Inbox notice), error, success, else the tint (info).
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

/**
 * RN's swipe right (swipeable-task-item.tsx): the row slides open over RN's labelled action button, 90 wide,
 * in the target status's color with core's icon and label (restore: RotateCcw, done: Check, next: ArrowRight).
 * A tap on the button runs the action; a long-press opens the status menu (#1275). Both close the row.
 * A drag past half the button's width opens it; less springs back. The row's own long-press stays free.
 * With [onDelete], a swipe left reveals RN's red Delete (Trash2) the same way.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SwipeAction(enabled: Boolean, swipe: RowSwipe, shape: RoundedCornerShape, onSwipe: () -> Unit, onMenu: () -> Unit,
                        onDelete: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val theme = LocalTheme.current
    val density = LocalDensity.current
    val open = with(density) { 98.dp.toPx() } // the 90 button and RN's 8 gap
    val left = if (onDelete != null) -open else 0f
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val settle = { to: Float -> scope.launch { offset.animateTo(to) }; Unit }
    // A row that can no longer act (a retry owed elsewhere, a read-only project) closes.
    LaunchedEffect(enabled) { if (!enabled) offset.snapTo(0f) }
    Box {
        if (offset.value < 0f && onDelete != null) {
            val delete = t("task.aria.delete")
            Column(Modifier.matchParentSize().padding(start = 8.dp).wrapContentWidth(Alignment.End).width(90.dp).clip(shape)
                .background(theme.deleteAction).clickable(role = Role.Button) { settle(0f); onDelete() }.semantics { contentDescription = delete },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(Lucide.Trash2, null, tint = theme.onAction, modifier = Modifier.size(20.dp))
                Text(t("common.delete"), style = rnText(12, 600), color = theme.onAction, maxLines = 1, modifier = Modifier.padding(top = 4.dp))
            }
        }
        if (offset.value > 0f) {
            val spoken = t("task.aria.action").replace("{{action}}", swipe.label)
            Column(Modifier.matchParentSize().padding(end = 8.dp).wrapContentWidth(Alignment.Start).width(90.dp).clip(shape)
                .background(theme.status(swipe.target).text).testTag("swipe-action")
                .combinedClickable(enabled = enabled, role = Role.Button, onLongClick = { settle(0f); onMenu() }) { settle(0f); onSwipe() }
                .semantics { contentDescription = spoken },
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(when (swipe.icon) { "restore" -> Lucide.RotateCcw; "done" -> Lucide.Check; else -> Lucide.ArrowRight }, null,
                    tint = theme.onAction, modifier = Modifier.size(20.dp))
                Text(swipe.label, style = rnText(12, 600), color = theme.onAction, maxLines = 1, modifier = Modifier.padding(top = 4.dp))
            }
        }
        Box(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.draggable(
            state = rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceIn(left, open)) } },
            orientation = Orientation.Horizontal, enabled = enabled,
            onDragStopped = { settle(if (offset.value > open / 2) open else if (offset.value < left / 2) left else 0f) },
        )) { content() }
    }
}
