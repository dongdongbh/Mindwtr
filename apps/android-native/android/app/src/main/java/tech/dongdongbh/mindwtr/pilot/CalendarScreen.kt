package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.gestures.snapping.SnapLayoutInfoProvider
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
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
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/*
 * RN's Calendar (components/views/calendar-view.tsx, calendar/calendar-view.styles.ts, calendar-period-navigation.tsx,
 * calendar-task-composer-modal.tsx) drawn from core's getCalendarView: the header with its period navigation, mode switch and
 * Show completed; the month grid with its details pane; the week grid with its all-day row, timeline, now line and density
 * bar; the day timeline with its drag; and the schedule list. Every word, day, minute, position and tone is core's; Kotlin
 * only turns a finger's place into the grid cell core describes (its minutes, its day keys) and sends core's actions.
 */

/** RN's PIXELS_PER_MINUTE (dp) and its week time gutter's width. */
private const val PPM = 1.4f
private val GUTTER = 56.dp
/** Core's CALENDAR_SNAP_MINUTES and CALENDAR_TAP_DURATION_MINUTES: a drop or a tap lands on 5 minutes; a tap leaves room for 30. */
internal const val SNAP_MINUTES = 5
internal const val TAP_MINUTES = 30
/** RN's long presses before a drag: a timeline block's (140 ms) and a Board card's (180 ms). */
internal const val BLOCK_HOLD_MS = 140L
internal const val CARD_HOLD_MS = 180L

/** Core's entries in their places, in core's order: the day entries, each day's items by lane, and the task rows. */
private class Placed(val days: List<JSONObject>, private val lanes: Map<String, List<JSONObject>>, val tasks: List<JSONObject>) {
    fun lane(lane: String, dayKey: String): List<JSONObject> = lanes["$lane|$dayKey"].orEmpty()
}

private fun place(entries: List<JSONObject>): Placed {
    val days = ArrayList<JSONObject>()
    val lanes = LinkedHashMap<String, MutableList<JSONObject>>()
    val tasks = ArrayList<JSONObject>()
    for (entry in entries) when (entry.getString("type")) {
        "day" -> days.add(entry)
        "item" -> lanes.getOrPut("${entry.getString("lane")}|${entry.getString("dayKey")}") { ArrayList() }.add(entry.getJSONObject("item"))
        else -> tasks.add(entry)
    }
    return Placed(days, lanes, tasks)
}

/** A grid's extent in minutes: core's hour labels run from the grid's start to its end, one an hour. */
private fun JSONObject.extentMinutes(): Int = (getJSONArray("hourLabels").length() - 1) * 60

/** RN's long press, shortened to [millis] for the gestures below it (RN's activateAfterLongPress). */
@Composable
internal fun HoldFor(millis: Long, content: @Composable () -> Unit) {
    val base = LocalViewConfiguration.current
    val config = remember(base, millis) { object : ViewConfiguration by base { override val longPressTimeoutMillis: Long = millis } }
    CompositionLocalProvider(LocalViewConfiguration provides config, content = content)
}

/**
 * RN's Pressable without hitSlop (the day's and the week's all-day rows have none): each row takes touches only inside its own
 * bounds, as in RN. Compose widens a target under 48 dp (the day's all-day rows are 19 dp) and reports that widened box, less
 * the next row's, as the row's accessibility bounds, so every stacked row's node sat about 14 dp above the row it names
 * (TalkBack's box, and a tap at the node's centre missed).
 */
@Composable
private fun ExactTargets(content: @Composable () -> Unit) {
    val base = LocalViewConfiguration.current
    val config = remember(base) { object : ViewConfiguration by base { override val minimumTouchTargetSize: DpSize = DpSize.Zero } }
    CompositionLocalProvider(LocalViewConfiguration provides config, content = content)
}

/** RN's 1-wide border on one edge (its borderBottomWidth, borderTopWidth or borderLeftWidth). */
private fun Modifier.edge(color: Color, top: Boolean = false, bottom: Boolean = false) = drawBehind {
    val w = 1.dp.toPx()
    if (top) drawRect(color, Offset.Zero, Size(size.width, w))
    if (bottom) drawRect(color, Offset(0f, size.height - w), Size(size.width, w))
}

/** RN's left accent border ([width]), dashed where core says the item is projected. */
private fun Modifier.leftBorder(color: Color, width: Dp, dashed: Boolean = false) = drawBehind {
    val w = width.toPx()
    if (dashed) drawLine(color, Offset(w / 2, 0f), Offset(w / 2, size.height), w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(w * 2, w * 2)))
    else drawRect(color, Offset.Zero, Size(w, size.height))
}

/** The spoken text of an item: core's label where it gives one, else what the item shows. */
private fun JSONObject.spoken(): String = menuText("accessibilityLabel") ?: listOfNotNull(getString("title"), menuText("detail")).joinToString(", ")

/**
 * RN's Calendar under its header: core's view for the open place, read again each minute while shown, the item sheet and the
 * composer over it. Back closes the composer or the sheet first.
 */
@Composable
fun CalendarList(model: InboxViewModel) = with(model.menu.calendar) {
    val owner = LocalLifecycleOwner.current
    // A calendar changes with the clock: read again each minute while it shows (the screen reads on resume), as Focus does.
    LaunchedEffect(owner) { owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { while (true) { delay(60_000); refresh() } } }
    // A composer edit waits while a command runs or a retry is owed; it goes once none does.
    LaunchedEffect(model.busy, model.failedAction, composer) { pumpComposer() }
    BackHandler(enabled = composer != null || sheet != null) { if (composer != null) closeComposer() else closeSheet() }
    Box(Modifier.fillMaxSize().testTag("calendar")) {
        view?.let { shown ->
            val placed = remember(shown) { place(shown.menuObjects("items")) }
            val content = shown.getJSONObject("content")
            Column(Modifier.fillMaxSize()) {
                CalendarHeader(model, shown)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (content.getString("mode")) {
                        "month" -> MonthView(model, shown, content, placed)
                        "week" -> WeekView(model, shown, content, placed)
                        "day" -> DayView(model, shown, content, placed)
                        else -> ScheduleView(model, shown, content, placed)
                    }
                }
            }
        }
        sheet?.let { ItemSheet(model, it) }
        composer?.let { ComposerSheet(model, it) }
    }
}

// ---- The header ----

/** RN's calendar header card: the period navigation (the schedule's title and Today), the mode switch, and Show completed. */
@Composable
private fun CalendarHeader(model: InboxViewModel, view: JSONObject) {
    val c = LocalTheme.current.colors
    val header = view.getJSONObject("header")
    val day = header.getString("titleVariant") == "day"
    Column(Modifier.fillMaxWidth().background(c.cardBg).edge(c.border, bottom = true)
        .padding(horizontal = if (day) 12.dp else 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PeriodNavigation(model, header, day)
        ModeToggle(model, view)
        ShowCompleted(model, view.getJSONObject("showCompleted"))
    }
}

/** RN's CalendarPeriodNavigation: ‹, the title with Today under it, ›; the schedule has only the title and Today. */
@Composable
private fun PeriodNavigation(model: InboxViewModel, header: JSONObject, day: Boolean) = with(model.menu) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        header.optJSONObject("previous")?.let { NavArrow(model, "‹", it) }
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(header.getString("title"), style = if (day) rnText(16, 800) else rnText(17, 700), color = c.text, maxLines = 1,
                overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.testTag("calendar-title").semantics { heading() })
            val today = header.getJSONObject("today")
            val label = today.getString("label")
            val todayState = today.getJSONObject("state")
            Text(label, style = rnText(11, 700), color = c.tint, modifier = Modifier.clip(CircleShape).rnBorder(1.dp, c.border, CircleShape)
                .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { if (idle) calendar.go(todayState); idle } }
                .clickable(enabled = idle) { calendar.go(todayState) }.padding(horizontal = 10.dp, vertical = 3.dp))
        }
        header.optJSONObject("next")?.let { NavArrow(model, "›", it) }
    }
}

@Composable
private fun NavArrow(model: InboxViewModel, glyph: String, target: JSONObject) = with(model.menu) {
    val label = target.getString("label")
    val state = target.getJSONObject("state")
    Box(Modifier.heightIn(min = 44.dp).clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { if (idle) calendar.go(state); idle } }
        .clickable(enabled = idle) { calendar.go(state) }.padding(horizontal = 10.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
        Text(glyph, style = rnText(26, 700), color = LocalTheme.current.colors.text)
    }
}

/** RN's mode switch: core's four modes, the open one filled with the tint; a mode is core's state for it and its setViewMode. */
@Composable
private fun ModeToggle(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        for (option in view.menuObjects("modes")) {
            val active = option.getBoolean("selected")
            val label = option.getString("label")
            val pick = { if (!active) calendar.mode(option) }
            Box(Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(if (active) c.tint else Color.Transparent)
                .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = active; onClick { if (idle) pick(); idle } }
                .clickable(enabled = idle) { pick() }.padding(vertical = 6.dp), contentAlignment = Alignment.Center) {
                Text(label, style = rnText(12, 800), color = if (active) c.onTint else c.secondaryText, maxLines = 1)
            }
        }
    }
}

/** RN's Show completed pill (#955): the tint while on; TalkBack hears core's hint. */
@Composable
private fun ShowCompleted(model: InboxViewModel, toggle: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val on = toggle.getBoolean("on")
    val shape = RoundedCornerShape(10.dp)
    val hint = toggle.getString("hint")
    Text(toggle.getString("label"), style = rnText(12, 800), color = if (on) c.tint else c.secondaryText,
        modifier = Modifier.padding(top = 8.dp).clip(shape).background(if (on) theme.wash(c.tint, 0.14f, 0.24f) else c.inputBg)
            .rnBorder(1.dp, if (on) c.tint else c.border, shape)
            .clearAndSetSemantics { contentDescription = hint; role = Role.Button; selected = on; onClick { if (idle) calendar.showCompleted(!on); idle } }
            .clickable(enabled = idle) { calendar.showCompleted(!on) }.padding(horizontal = 10.dp, vertical = 6.dp))
}

/**
 * RN's swipe between periods (month and day): a horizontal drag of at least 28 moves to core's next (a swipe left) or previous
 * period; the content follows the finger up to 72 and springs back.
 */
@Composable
private fun Modifier.periodSwipe(model: InboxViewModel, header: JSONObject): Modifier {
    val density = LocalDensity.current
    val shift = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    return this.offset { IntOffset(shift.value.roundToInt(), 0) }.pointerInput(header.toString()) {
        var total = 0f
        val feedback = with(density) { 72.dp.toPx() }
        detectHorizontalDragGestures(
            onDragStart = { total = 0f },
            onDragEnd = {
                val target = if (total <= -28.dp.toPx()) header.optJSONObject("next") else if (total >= 28.dp.toPx()) header.optJSONObject("previous") else null
                scope.launch { shift.animateTo(0f) }
                if (target != null && model.menu.idle) model.menu.calendar.go(target.getJSONObject("state"))
            },
            onDragCancel = { scope.launch { shift.animateTo(0f) } },
        ) { change, amount ->
            change.consume()
            total += amount
            scope.launch { shift.snapTo((total * 0.7f).coerceIn(-feedback, feedback)) }
        }
    }
}

// ---- Month ----

/** RN's month: the weekday names, the grid (core's cells after its leading blanks), and the selected day's details pane. */
@Composable
private fun MonthView(model: InboxViewModel, view: JSONObject, content: JSONObject, placed: Placed) {
    val c = LocalTheme.current.colors
    val details = content.optJSONObject("details")
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxWidth().periodSwipe(model, view.getJSONObject("header"))) {
            Row(Modifier.fillMaxWidth().background(c.cardBg).edge(c.border, bottom = true).padding(vertical = 4.dp)) {
                for (name in content.getJSONArray("dayNames").let { names -> List(names.length()) { names.getString(it) } }) {
                    Text(name, style = rnText(12, 600), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
                }
            }
            val cells: List<JSONObject?> = List(content.getInt("leadingBlanks")) { null } + placed.days
            Column(Modifier.fillMaxWidth().padding(horizontal = if (details != null) 12.dp else 4.dp)) {
                for (week in cells.chunked(7)) {
                    Row(Modifier.fillMaxWidth()) {
                        for (cell in week) {
                            if (cell == null) Spacer(Modifier.weight(1f).aspectRatio(if (details != null) 0.88f else 1f))
                            else MonthCell(model, cell, details != null)
                        }
                        repeat(7 - week.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        details?.let { DetailsPane(model, view, it, placed) }
    }
}

/** RN's month cell: today's number in a tint circle, the selected cell washed, core's two previews, or core's counts. */
@Composable
private fun RowScope.MonthCell(model: InboxViewModel, cell: JSONObject, compact: Boolean) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val today = cell.getBoolean("isToday")
    val chosen = cell.getBoolean("selected")
    val key = cell.getString("key")
    val spoken = cell.menuText("accessibilityLabel") ?: cell.getString("title")
    Column(Modifier.weight(1f).aspectRatio(if (compact) 0.88f else 1f)
        .background(if (chosen) theme.wash(c.tint, 0.16f, 0.2f) else if (today) theme.wash(c.tint, 0.08f, 0.12f) else Color.Transparent)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; selected = chosen; onClick { if (idle) calendar.select(key); idle } }
        .clickable(enabled = idle) { calendar.select(key) }.padding(if (compact) 3.dp else 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(if (compact) 28.dp else 32.dp).clip(CircleShape).background(if (today) c.tint else Color.Transparent), contentAlignment = Alignment.Center) {
            Text(cell.getString("dayNumber"), style = rnText(if (compact) 13 else 14, if (today) 700 else 400), color = if (today) c.onTint else c.text)
        }
        val preview = cell.menuObjects("preview")
        if (preview.isNotEmpty()) Column(Modifier.fillMaxWidth().padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (item in preview) {
                val tones = item.getJSONObject("tones")
                val source = coreColorOrNull(item.menuText("sourceColor"))
                val fill = when (tones.menuText("fill")) { "tint" -> theme.wash(c.tint, 0.14f, 0.24f); "none" -> Color.Transparent; else -> theme.wash(c.secondaryText, 0.16f, 0.28f) }
                val accent = if (item.getString("kind") == "event") source ?: c.secondaryText else theme.calendarTone(tones.menuText("accent")) ?: c.text
                val struck = tones.optBoolean("struck")
                Text(item.getString("title"), style = rnText(9, 700, 11).copy(textDecoration = if (struck) TextDecoration.LineThrough else null),
                    color = theme.calendarTone(tones.menuText("text")) ?: c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).background(fill).leftBorder(accent, 2.dp, tones.optBoolean("dashed"))
                        .padding(start = 5.dp, end = 3.dp, top = 1.dp, bottom = 1.dp))
            }
        }
        cell.optJSONObject("counts")?.let { counts ->
            Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (counts.getInt("tasks") > 0) CountDot("${counts.getInt("tasks")}", c.tint, c.onTint)
                if (counts.getInt("events") > 0) CountDot("${counts.getInt("events")}", c.secondaryText, c.bg)
            }
        }
    }
}

@Composable
private fun CountDot(text: String, fill: Color, color: Color) {
    Box(Modifier.widthIn(min = 16.dp).clip(RoundedCornerShape(8.dp)).background(fill).padding(horizontal = 4.dp, vertical = 1.dp), contentAlignment = Alignment.Center) {
        Text(text, style = rnText(10, 600), color = color)
    }
}

/**
 * RN's day details pane over the month: a handle that resizes it between RN's three heights (a drag down past its lowest closes
 * it, core's `close` state), the selected day's title with Add task, the search with core's results, and core's events,
 * deadlines and scheduled tasks, each with Done where core offers it.
 */
@Composable
private fun DetailsPane(model: InboxViewModel, view: JSONObject, details: JSONObject, placed: Placed) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val density = LocalDensity.current
    val screen = LocalConfiguration.current.screenHeightDp
    val collapsed = (176f / screen.coerceAtLeast(1)).coerceIn(0.26f, 0.58f)
    val dayKey = view.getJSONObject("state").optString("selectedDate")
    var snap by rememberSaveable(dayKey) { mutableStateOf(collapsed) }
    val text = view.getJSONObject("text")
    val shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
    Box(Modifier.fillMaxSize()) {
        // The pane takes the touches it covers, as RN's pane does: a tap on it never reaches a day cell under it.
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height((screen * snap).dp).clip(shape).background(c.cardBg).edge(c.border, top = true)
            .pointerInput(Unit) { detectTapGestures { } }) {
            val handle = "${text.getString("detailsHandle")}. ${text.getString("detailsHandleHint")}"
            Box(Modifier.fillMaxWidth().draggable(rememberDraggableState { delta -> snap = (snap - with(density) { delta.toDp().value } / screen).coerceIn(0f, 0.9f) },
                Orientation.Vertical, onDragStopped = { velocity ->
                    if (snap <= 0.2f || velocity > with(density) { 900.dp.toPx() }) calendar.go(details.getJSONObject("close"))
                    else snap = listOf(collapsed, 0.58f, 0.9f).nearestTo(snap)
                }).semantics { contentDescription = handle }.padding(top = 10.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(42.dp, 4.dp).clip(CircleShape).background(c.border))
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 24.dp)) {
                Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(details.getString("title"), style = rnText(16, 600), color = c.text, modifier = Modifier.weight(1f).padding(bottom = 12.dp).semantics { heading() })
                    val add = text.getString("addTask")
                    Text(add, style = rnText(12, 600), color = c.tint, modifier = Modifier.clip(RoundedCornerShape(8.dp)).testTag("calendar-add")
                        .clearAndSetSemantics { contentDescription = add; role = Role.Button; onClick { if (idle) calendar.addTask(dayKey); idle } }
                        .clickable(enabled = idle) { calendar.addTask(dayKey) }.padding(horizontal = 8.dp, vertical = 4.dp))
                }
                ScheduleSearch(model, text.getString("schedulePlaceholder"), Modifier.padding(bottom = 16.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    TaskResults(model, details.menuText("searchTitle"), null, placed.tasks)
                    details.optJSONObject("events")?.let { events ->
                        Column(Modifier.padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(events.getString("title"), style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(horizontal = 2.dp))
                            events.menuText("loading")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText) }
                            events.menuText("error")?.let { Text(it, style = rnText(12, 400), color = c.danger, maxLines = 2) }
                            for (item in placed.lane("events", dayKey)) CalendarItemRow(model, item, "events")
                        }
                    }
                    for (item in placed.lane("deadlines", dayKey)) CalendarItemRow(model, item, "deadlines")
                    for (item in placed.lane("scheduled", dayKey)) CalendarItemRow(model, item, "scheduled")
                    details.menuText("empty")?.let { EmptyLine(it) }
                }
            }
        }
    }
}

/** The nearest of RN's snap heights to [value]. */
private fun List<Float>.nearestTo(value: Float): Float {
    var best = first()
    for (height in this) if (abs(height - value) < abs(best - value)) best = height
    return best
}

@Composable
private fun EmptyLine(text: String) = Text(text, style = rnText(14, 400), color = LocalTheme.current.colors.secondaryText, textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp).semantics { liveRegion = LiveRegionMode.Polite })

/** RN's schedule search under the selected day: the typed text, read by core once typing pauses. */
@Composable
private fun ScheduleSearch(model: InboxViewModel, placeholder: String, modifier: Modifier = Modifier) = with(model.menu.calendar) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(query, { typeQuery(it) }, singleLine = true, textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        modifier = modifier.fillMaxWidth().semantics { contentDescription = placeholder }.testTag("calendar-search"),
        decorationBox = { inner ->
            Box(Modifier.clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(12.dp), contentAlignment = Alignment.CenterStart) {
                if (query.isEmpty()) Text(placeholder, style = rnText(14, 400), color = c.secondaryText)
                inner()
            }
        })
}

/** RN's task rows to schedule (search results, the planning list): core's title and slot label; a tap opens core's composer. */
@Composable
private fun TaskResults(model: InboxViewModel, title: String?, subtitle: String?, tasks: List<JSONObject>, section: Boolean = false) = with(model.menu) {
    if (title == null || tasks.isEmpty()) return
    val c = LocalTheme.current.colors
    Column(Modifier.padding(bottom = if (section) 0.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (section) title.uppercase() else title, style = if (section) rnText(12, 900) else rnText(12, 600), color = c.secondaryText,
            modifier = Modifier.padding(horizontal = 2.dp).semantics { heading() })
        subtitle?.let { Text(it, style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(horizontal = 2.dp)) }
        for (task in tasks) {
            val spoken = "${task.getString("title")}, ${task.getString("detail")}"
            CalendarRow(task.getString("title"), task.getString("detail"), c.text, c.inputBg, c.tint, false, true, idle, spoken, "calendar-task",
                onClick = { calendar.schedule(task.getString("taskId")) })
        }
    }
}

/**
 * RN's taskItem row: a left accent (dashed for a projected occurrence), core's title and detail, and an optional trailing
 * control; one TalkBack node with its label, role and state.
 */
@Composable
private fun CalendarRow(title: String, detail: String?, titleColor: Color, fill: Color, accent: Color, dashed: Boolean, pressable: Boolean, enabled: Boolean,
                        spoken: String, tag: String, struck: Boolean = false, actions: List<CustomAccessibilityAction> = emptyList(), onClick: () -> Unit,
                        trailing: @Composable RowScope.() -> Unit = {}) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(fill).leftBorder(accent, 3.dp, dashed).testTag(tag)
        .clearAndSetSemantics {
            contentDescription = spoken; role = Role.Button
            if (pressable && enabled) onClick { onClick(); true } else disabled()
            if (actions.isNotEmpty()) customActions = actions
        }
        .then(if (pressable) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier)
        .padding(start = 15.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.weight(1f)) {
            Text(title, style = rnText(14, 400).copy(textDecoration = if (struck) TextDecoration.LineThrough else null), color = titleColor, maxLines = 1,
                overflow = TextOverflow.Ellipsis)
            detail?.let { Text(it, style = rnText(12, 400), color = c.secondaryText) }
        }
        trailing()
    }
}

/** A month details row (events, deadlines, scheduled): core's tones as RN's details rows paint them, and core's Done. */
@Composable
private fun CalendarItemRow(model: InboxViewModel, item: JSONObject, lane: String) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val tones = item.getJSONObject("tones")
    val projected = item.optBoolean("projected")
    val event = lane == "events"
    val source = coreColorOrNull(item.menuText("sourceColor"))
    val fill = if (!event && projected) theme.wash(c.tint, 0.1f, 0.18f) else c.inputBg
    val accent = if (event) source ?: c.secondaryText else c.tint
    val done = calendar.view?.getJSONObject("text")?.getString("done").orEmpty()
    val complete = { if (idle) calendar.complete(item.getString("taskId"), item.rowRevision()) }
    // RN's Done beside the row; TalkBack reaches it as the row's action.
    val actions = if (item.optBoolean("showDone")) listOf(CustomAccessibilityAction(done) { complete(); true }) else emptyList()
    CalendarRow(item.getString("title"), item.menuText("detail"), if (projected) c.tint else c.text, fill, accent, tones.optBoolean("dashed"),
        item.getBoolean("pressable"), idle, item.spoken(), "calendar-item", actions = actions, onClick = { calendar.openItem(item) }) {
        if (item.optBoolean("showDone")) {
            Text(done, style = rnText(12, 600), color = c.tint, modifier = Modifier.padding(start = 8.dp).clip(CircleShape)
                .background(c.tint.copy(alpha = 0.16f)).rnBorder(1.dp, c.tint.copy(alpha = 0.35f), CircleShape)
                .clickable(enabled = idle) { complete() }.padding(horizontal = 10.dp, vertical = 5.dp))
        }
    }
}

// ---- Week ----

/**
 * RN's week: a canvas of seven day columns that scrolls sideways, landing on whole days, with the time gutter pinned at its
 * left; the day headers (a tap opens that day), the all-day row, the timeline with core's timed blocks and the now line (a tap
 * on a column opens the composer for that day), and the density bar.
 */
@Composable
private fun WeekView(model: InboxViewModel, view: JSONObject, content: JSONObject, placed: Placed) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val density = LocalDensity.current
    val visible = content.getInt("visibleDays")
    val text = view.getJSONObject("text")
    val days = placed.days
    Column(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val hasDeadlines = days.any { placed.lane("deadlineMarker", it.getString("key")).isNotEmpty() }
            val column = ((maxWidth - GUTTER) / visible).coerceAtLeast(if (hasDeadlines) 260.dp else 40.dp)
            val compact = column < 86.dp
            val ultra = column < 58.dp
            val columnPx = with(density) { column.toPx() }
            val across = rememberScrollState()
            val snap = rememberSnapFlingBehavior(remember(across, columnPx) {
                object : SnapLayoutInfoProvider {
                    override fun calculateSnapOffset(velocity: Float): Float {
                        val rest = across.value % columnPx
                        return if (velocity > 0f || (velocity == 0f && rest > columnPx / 2)) columnPx - rest else -rest
                    }
                }
            })
            // RN's first place: the selected day (else today) at the left, as far as the week allows.
            val start = days.indexOfFirst { it.getBoolean("selected") }.takeIf { it >= 0 } ?: days.indexOfFirst { it.getBoolean("isToday") }.coerceAtLeast(0)
            val availablePx = with(density) { (maxWidth - GUTTER).toPx() }
            val keys = weekScrollKeys(days.firstOrNull()?.getString("key"), visible, start, days.size, columnPx, availablePx)
            LaunchedEffect(*keys.toTypedArray()) { across.settleTo(keys.last() as Int) }
            val pin = Modifier.offset { IntOffset(across.value, 0) }.zIndex(5f).background(c.bg)
            Row(Modifier.fillMaxHeight().horizontalScroll(across, flingBehavior = snap)) {
                Column(Modifier.width(GUTTER + column * days.size).fillMaxHeight()) {
                    Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).edge(c.border, bottom = true)) {
                        Box(pin.width(GUTTER).fillMaxHeight())
                        for (day in days) WeekDayHeader(model, day, column, compact)
                    }
                    Row(Modifier.fillMaxWidth().heightIn(min = 54.dp).height(IntrinsicSize.Min).edge(c.border, bottom = true)) {
                        Box(pin.width(GUTTER).fillMaxHeight()) {
                            Text(text.getString("allDay"), style = rnText(10, 900), color = c.secondaryText, textAlign = TextAlign.End,
                                modifier = Modifier.fillMaxWidth().padding(end = 6.dp, top = 10.dp))
                        }
                        for (day in days) WeekAllDay(model, placed.lane("allDay", day.getString("key")), column, compact)
                    }
                    WeekTimeline(model, content, placed, column, compact, ultra, pin)
                }
            }
        }
        DensityBar(model, content.getJSONObject("density"), text)
    }
}

/** RN's week day header: core's weekday (capitals) and day number, today in the tint on a wash; a tap opens core's day view. */
@Composable
private fun WeekDayHeader(model: InboxViewModel, day: JSONObject, width: Dp, compact: Boolean) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val today = day.getBoolean("isToday")
    val opens = day.optJSONObject("opens")
    val title = day.getString("title")
    Column(Modifier.width(width).fillMaxHeight().leftBorder(c.border, 1.dp).background(if (today) theme.wash(c.tint, 0.1f, 0.2f) else Color.Transparent)
        .clearAndSetSemantics { contentDescription = title; role = Role.Button; onClick { if (idle && opens != null) calendar.go(opens); idle } }
        .clickable(enabled = idle && opens != null) { opens?.let(calendar::go) }.padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally) {
        Text(day.getString("weekday").uppercase(), style = rnText(if (compact) 9 else 11, 800), color = c.secondaryText, maxLines = 1)
        Text(day.getString("dayNumber"), style = rnText(if (compact) 14 else 17, 900), color = if (today) c.tint else c.text, modifier = Modifier.padding(top = 2.dp))
    }
}

/** RN's all-day cell: core's all-day items with their tones; a tap opens the item's sheet where core allows it. */
@Composable
private fun WeekAllDay(model: InboxViewModel, items: List<JSONObject>, width: Dp, compact: Boolean) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    Column(Modifier.width(width).fillMaxHeight().leftBorder(c.border, 1.dp)
        .padding(horizontal = if (compact) 2.dp else 5.dp, vertical = if (compact) 4.dp else 5.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) { ExactTargets {
        for (item in items) {
            val tones = item.getJSONObject("tones")
            val fill = if (tones.menuText("fill") == "secondary") theme.wash(c.secondaryText, 0.14f, 0.28f) else c.inputBg
            val accent = if (item.getString("kind") == "event") coreColorOrNull(item.menuText("sourceColor")) ?: c.secondaryText
            else if (tones.menuText("accent") == "tint") c.tint else c.danger
            val pressable = item.getBoolean("pressable")
            val spoken = item.spoken()
            Text(item.getString("title"), style = rnText(if (compact) 8 else 10, 800), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(5.dp)).background(fill).leftBorder(accent, if (compact) 2.dp else 3.dp, tones.optBoolean("dashed"))
                    .testTag("calendar-block")
                    .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; if (pressable && idle) onClick { calendar.openItem(item); true } else disabled() }
                    .clickable(enabled = pressable && idle) { calendar.openItem(item) }
                    .padding(start = if (compact) 4.dp else 8.dp, end = if (compact) 2.dp else 5.dp, top = 2.dp, bottom = 2.dp))
        }
    } }
}

/**
 * RN's getCalendarWeekInitialScrollX: day [start] at the left, as far as the week allows. Deadline weeks widen the columns past
 * the density, so the bound is the week's overflow of the viewport, not the density's day count (which opened on Tuesday).
 */
internal fun weekStartScroll(start: Int, dayCount: Int, columnPx: Float, availablePx: Float): Int =
    minOf(start * columnPx, (dayCount * columnPx - availablePx).coerceAtLeast(0f)).roundToInt()

/**
 * When the week scrolls itself to its first place (RN's getCalendarWeekAutoScrollKey): a new week, density, or start offset. The
 * offset carries the selected day (Today in the same week) and the viewport (a resize under deadline-wide columns).
 */
internal fun weekScrollKeys(firstDay: String?, visible: Int, start: Int, dayCount: Int, columnPx: Float, availablePx: Float): List<Any?> =
    listOf(firstDay, visible, weekStartScroll(start, dayCount, columnPx, availablePx))

/** A scroll to [target] once the content is laid out (its extent known). */
private suspend fun androidx.compose.foundation.ScrollState.settleTo(target: Int) {
    if (target <= 0) { scrollTo(0); return }
    snapshotFlow { maxValue }.first { it > 0 }
    scrollTo(minOf(target, maxValue))
}

/** A timeline's vertical scroll: RN scrolls to [minutes] (now, or a saved task's start), 180 below the view's top. */
private suspend fun androidx.compose.foundation.ScrollState.toMinute(minutes: Int, density: androidx.compose.ui.unit.Density) {
    settleTo(with(density) { (minutes * PPM).dp.toPx() - 180.dp.toPx() }.roundToInt())
}

/** RN's week timeline: the pinned hour labels, and per day its hour rules, the now line on today, and core's timed blocks. */
@Composable
private fun WeekTimeline(model: InboxViewModel, content: JSONObject, placed: Placed, column: Dp, compact: Boolean, ultra: Boolean, pin: Modifier) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val density = LocalDensity.current
    val labels = content.getJSONArray("hourLabels")
    val height = (content.extentMinutes() * PPM).dp
    val down = rememberScrollState()
    val weekKey = "week:${placed.days.firstOrNull()?.getString("key")}"
    var scrolledFor by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(weekKey) {
        // RN's first scroll for a week: to now.
        if (scrolledFor != weekKey) { content.optInt("nowMinutes", -1).takeIf { it >= 0 }?.let { down.toMinute(it, density) }; scrolledFor = weekKey }
    }
    // 7 above the first hour, so its label (centered on its rule) shows whole; RN cuts it (an RN bug, rn-calendar-visual-20260927-01).
    Column(Modifier.fillMaxWidth().verticalScroll(down).padding(top = 7.dp, bottom = 24.dp)) {
        Row(Modifier.fillMaxWidth()) {
            Box(pin.width(GUTTER).height(height)) {
                for (index in 0 until labels.length()) {
                    Text(labels.getString(index), style = rnText(10, 700), color = c.secondaryText, maxLines = 1, textAlign = TextAlign.End,
                        modifier = Modifier.fillMaxWidth().offset(y = (index * 60 * PPM).dp - 7.dp).padding(end = 6.dp))
                }
            }
            for (day in placed.days) {
                val key = day.getString("key")
                val today = day.getBoolean("isToday")
                Box(Modifier.width(column).height(height).leftBorder(c.border, 1.dp)
                    .background(if (today) theme.wash(c.tint, 0.05f, 0.1f) else Color.Transparent)
                    .pointerInput(key) { detectTapGestures { if (idle) calendar.addTask(key) } }) {
                    for (index in 0 until labels.length()) {
                        Box(Modifier.offset(y = (index * 60 * PPM).dp).fillMaxWidth().height(1.dp).background(c.border.copy(alpha = c.border.alpha * 0.7f)))
                    }
                    if (today) content.optInt("nowMinutes", -1).takeIf { it >= 0 }?.let { NowLine(it, Modifier.fillMaxWidth()) }
                    BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = if (ultra) 1.dp else if (compact) 2.dp else 4.dp)) {
                        val markers = placed.lane("deadlineMarker", key)
                        for (item in placed.lane("timed", key)) WeekBlock(model, item, if (markers.isEmpty()) maxWidth else maxWidth * 0.58f, compact, ultra)
                        DeadlineMarkers(model, markers, maxWidth)
                    }
                }
            }
        }
    }
}

/**
 * RN's now line: a red dot and a 2-high rule in a 10-high row, centered on core's minute [minutes] (RN draws it 5 lower, an RN
 * bug, rn-calendar-visual-20260927-01). [modifier] places it across.
 */
@Composable
private fun NowLine(minutes: Int, modifier: Modifier) {
    val theme = LocalTheme.current
    Row(Modifier.offset(y = (minutes * PPM).dp - 5.dp).then(modifier).height(10.dp).zIndex(30f), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(theme.nowLine))
        Box(Modifier.weight(1f).height(2.dp).background(theme.nowLine))
    }
}

/** A timed block's place in its lane: core's minutes and its column among overlapping blocks, with RN's 2 between columns. */
private class BlockBox(val x: Dp, val width: Dp, val top: Dp, val height: Dp)

private fun blockBox(item: JSONObject, lane: Dp, minHeight: Dp): BlockBox {
    val timed = item.getJSONObject("timed")
    val layout = timed.optJSONObject("column")
    val left = layout?.optDouble("leftPercent", 0.0)?.toFloat() ?: 0f
    val width = layout?.optDouble("widthPercent", 100.0)?.toFloat() ?: 100f
    val gapLeft = if (layout != null && layout.getInt("columnIndex") > 0) 2.dp else 0.dp
    val gapRight = if (layout != null && layout.getInt("columnIndex") < layout.getInt("columnCount") - 1) 2.dp else 0.dp
    val start = timed.getInt("startMinutes").coerceAtLeast(0)
    return BlockBox(lane * (left / 100f) + gapLeft, lane * (width / 100f) - gapLeft - gapRight, (start * PPM).dp,
        maxOf(minHeight, ((timed.getInt("endMinutes") - start) * PPM).dp))
}

/** RN's week block: an event on a gray wash with its calendar's color, or a task filled with the tint (a projected one dashed). */
@Composable
private fun WeekBlock(model: InboxViewModel, item: JSONObject, lane: Dp, compact: Boolean, ultra: Boolean) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val place = blockBox(item, lane, 24.dp)
    val event = item.getString("kind") == "event"
    val projected = item.optBoolean("projected")
    val pressable = item.getBoolean("pressable")
    val fill = when {
        event -> theme.wash(c.secondaryText, 0.16f, 0.32f)
        projected -> theme.wash(c.tint, 0.1f, 0.18f)
        theme.isDark -> c.tint.copy(alpha = 0.85f)
        else -> c.tint
    }
    val accent = if (event) coreColorOrNull(item.menuText("sourceColor")) ?: c.secondaryText else c.tint
    val titleColor = if (event) c.text else if (projected) c.tint else theme.blockText
    val timeColor = if (event || projected) c.secondaryText else theme.blockText.copy(alpha = 0.9f)
    val spoken = item.spoken()
    Column(Modifier.offset(x = place.x, y = place.top).width(place.width).height(place.height).clip(RoundedCornerShape(if (compact) 6.dp else 8.dp))
        .background(fill).leftBorder(accent, if (ultra) 2.dp else if (compact) 3.dp else 4.dp, projected).testTag("calendar-block")
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; if (pressable && idle) onClick { calendar.openItem(item); true } else disabled() }
        .pointerInput(item.getString("id"), pressable) { detectTapGestures { if (pressable && idle) calendar.openItem(item) } }
        .padding(start = if (ultra) 4.dp else if (compact) 6.dp else 11.dp, end = if (ultra) 2.dp else if (compact) 3.dp else 7.dp, top = if (compact) 3.dp else 5.dp)) {
        Text(item.getString("title"), style = if (compact) rnText(9, if (event) 800 else 900, 11) else rnText(12, if (event) 800 else 900), color = titleColor,
            maxLines = if (compact) 2 else 1, overflow = TextOverflow.Ellipsis)
        if (!compact) item.menuText("detail")?.let { Text(it, style = rnText(10, 400), color = timeColor, maxLines = 1, modifier = Modifier.padding(top = 1.dp)) }
    }
}

/**
 * RN's density bar: a track whose thumb sits on core's visible-day count (a drag picks the nearest of core's choices, sent once
 * it ends), and core's choices as ticks. TalkBack hears core's label, value and its More and Fewer actions.
 */
@Composable
private fun DensityBar(model: InboxViewModel, density: JSONObject, text: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val choices = density.menuObjects("choices")
    if (choices.size < 2) return
    val current = choices.indexOfFirst { it.getBoolean("selected") }.coerceAtLeast(0)
    var dragged by remember(current) { mutableIntStateOf(current) }
    val progress = dragged / (choices.size - 1f)
    val pick = { index: Int -> if (index != current && idle) calendar.density(choices[index].getInt("days")) }
    Column(Modifier.fillMaxWidth().background(c.cardBg).edge(c.border, top = true).padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val label = text.getString("weekDensity")
        val value = density.getString("value")
        val more = text.getString("weekDensityMore")
        val fewer = text.getString("weekDensityFewer")
        BoxWithConstraints(Modifier.fillMaxWidth().padding(horizontal = 16.dp).height(22.dp)
            .clearAndSetSemantics {
                contentDescription = "$label. ${text.getString("weekDensityHint")}"; stateDescription = value
                customActions = listOf(
                    CustomAccessibilityAction(more) { if (current < choices.size - 1) pick(current + 1); true },
                    CustomAccessibilityAction(fewer) { if (current > 0) pick(current - 1); true },
                )
            }
            .pointerInput(choices.size, current) {
                val nearest = { x: Float -> ((x / size.width.coerceAtLeast(1)).coerceIn(0f, 1f) * (choices.size - 1)).roundToInt() }
                detectTapGestures { pick(nearest(it.x)) }
            }
            .pointerInput(choices.size, current, "drag") {
                val nearest = { x: Float -> ((x / size.width.coerceAtLeast(1)).coerceIn(0f, 1f) * (choices.size - 1)).roundToInt() }
                var x = 0f
                detectHorizontalDragGestures(onDragStart = { x = it.x; dragged = nearest(x) }, onDragEnd = { pick(dragged) }, onDragCancel = { dragged = current }) { change, amount ->
                    change.consume(); x += amount; dragged = nearest(x)
                }
            }, contentAlignment = Alignment.CenterStart) {
            val track = maxWidth
            Box(Modifier.fillMaxWidth().height(4.dp).clip(CircleShape).background(c.border))
            Box(Modifier.width(track * progress).height(4.dp).clip(CircleShape).background(c.tint))
            Box(Modifier.offset(x = track * progress - 11.dp).size(22.dp).clip(CircleShape).background(c.tint).rnBorder(3.dp, c.cardBg, CircleShape))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            choices.forEachIndexed { index, choice ->
                val active = choice.getBoolean("selected")
                val choiceLabel = choice.getString("label")
                val days = choice.getInt("days")
                Box(Modifier.widthIn(min = 32.dp).heightIn(min = 28.dp)
                    .clearAndSetSemantics { contentDescription = choiceLabel; role = Role.Button; selected = active; onClick { pick(index); true } }
                    .clickable(enabled = idle) { pick(index) }, contentAlignment = Alignment.Center) {
                    Text("$days", style = rnText(11, 800), color = if (active) c.tint else c.secondaryText)
                }
            }
        }
    }
}

// ---- Day ----

/**
 * RN's day: core's all-day items pinned above the timeline, the timeline card (a tap opens the composer at that time; a block
 * held for RN's 140 ms follows the finger and its drop sends core's moveTask), and the search card with core's results.
 */
@Composable
private fun DayView(model: InboxViewModel, view: JSONObject, content: JSONObject, placed: Placed) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val density = LocalDensity.current
    val text = view.getJSONObject("text")
    val dayKey = content.getString("dayKey")
    val allDay = placed.lane("allDay", dayKey)
    val down = rememberScrollState()
    var scrolledFor by rememberSaveable { mutableStateOf("") }
    val pending = calendar.scrollTo
    LaunchedEffect(pending, dayKey) {
        // RN's first scroll into the day view goes to now; a saved composer's start goes there.
        if (pending != null) { down.toMinute(pending, density); calendar.scrolled(); scrolledFor = "day" }
        else if (scrolledFor != "day") { content.optInt("nowMinutes", -1).takeIf { it >= 0 }?.let { down.toMinute(it, density) }; scrolledFor = "day" }
    }
    Column(Modifier.fillMaxSize().periodSwipe(model, view.getJSONObject("header"))) {
        if (allDay.isNotEmpty()) {
            val shape = RoundedCornerShape(12.dp)
            Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(12.dp)) {
                Text(text.getString("allDay").uppercase(), style = rnText(12, 800), color = c.secondaryText, modifier = Modifier.padding(bottom = 8.dp))
                Column(Modifier.heightIn(max = 132.dp).verticalScroll(rememberScrollState())) { ExactTargets {
                    for (item in allDay) {
                        val pressable = item.getBoolean("pressable")
                        val spoken = item.spoken()
                        Text(item.getString("title"), style = rnText(13, 400), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            color = theme.calendarTone(item.getJSONObject("tones").menuText("text")) ?: c.text,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).testTag("calendar-block")
                                .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; if (pressable && idle) onClick { calendar.openItem(item); true } else disabled() }
                                .clickable(enabled = pressable && idle) { calendar.openItem(item) }.padding(vertical = 2.dp))
                    }
                } }
            }
        }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(down).padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            DayTimeline(model, content, placed, dayKey)
            val shape = RoundedCornerShape(12.dp)
            Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ScheduleSearch(model, text.getString("schedulePlaceholder"))
                TaskResults(model, content.menuText("searchTitle"), null, placed.tasks)
            }
        }
    }
}

/** RN's day timeline card: the hour lines with core's labels, the now line on today, and core's timed events and tasks. */
@Composable
private fun DayTimeline(model: InboxViewModel, content: JSONObject, placed: Placed, dayKey: String) = with(model.menu) {
    val c = LocalTheme.current.colors
    val labels = content.getJSONArray("hourLabels")
    val extent = content.extentMinutes()
    val shape = RoundedCornerShape(12.dp)
    Box(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)) {
        // 9 above and below the grid, so the first and last hour rows (centered on their lines) show whole.
        Box(Modifier.fillMaxWidth().padding(vertical = 9.dp).height((extent * PPM).dp).testTag("calendar-timeline")
            // A tap: the minute under the finger, snapped to core's 5 and early enough for a 30-minute task (core's snapCalendarTimelineMinutes).
            .pointerInput(dayKey, extent) {
                detectTapGestures { at ->
                    val minutes = ((at.y / density / PPM / SNAP_MINUTES).roundToInt() * SNAP_MINUTES).coerceIn(0, extent - TAP_MINUTES)
                    if (idle) calendar.addAt(dayKey, minutes)
                }
            }) {
            for (index in 0 until labels.length()) {
                // The 18-high row is centered on its hour, so the line lies exactly at the minute (RN draws it 9 lower, an RN bug).
                Row(Modifier.offset(y = (index * 60 * PPM).dp - 9.dp).fillMaxWidth().height(18.dp).padding(end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(labels.getString(index), style = rnText(11, 700), color = c.secondaryText, maxLines = 1, textAlign = TextAlign.End,
                        modifier = Modifier.width(56.dp).padding(end = 8.dp))
                    Box(Modifier.weight(1f).height(1.dp).background(c.border))
                }
            }
            content.optInt("nowMinutes", -1).takeIf { it >= 0 }?.let { NowLine(it, Modifier.offset(x = 50.dp).padding(end = 62.dp).fillMaxWidth()) }
            BoxWithConstraints(Modifier.fillMaxSize().padding(start = 56.dp, end = 12.dp)) {
                val markers = placed.lane("deadlineMarker", dayKey)
                for (item in placed.lane("timed", dayKey)) DayBlock(model, item, dayKey, extent, if (markers.isEmpty()) maxWidth else maxWidth * 0.58f)
                DeadlineMarkers(model, markers, maxWidth)
            }
        }
    }
}

/** Deadline points and a separate scrollable label rail; no drag or work duration. */
@Composable
private fun DeadlineMarkers(model: InboxViewModel, markers: List<JSONObject>, lane: Dp) = with(model.menu) {
    val c = LocalTheme.current.colors
    for (marker in markers) {
        Text("◆", style = rnText(10, 700), color = c.tint,
            modifier = Modifier.offset(x = lane * 0.6f, y = maxOf(0f, marker.getJSONObject("deadline").getInt("startMinutes") * PPM - 6).dp).zIndex(11f))
    }
    for (first in markers.filter { it.getJSONObject("deadline").getInt("groupIndex") == 0 }) {
        val geometry = first.getJSONObject("deadline")
        val group = markers.filter { it.getJSONObject("deadline").getString("groupId") == geometry.getString("groupId") }
        Box(Modifier.offset(x = lane * 0.6f, y = (geometry.getDouble("labelMinutes").toFloat() * PPM).dp)
            .width(lane * 0.4f).height((minOf(3, group.size) * 32 * PPM).dp).background(c.cardBg).zIndex(10f)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 10.dp)) {
                for (item in group) {
                    val pressable = item.optBoolean("pressable")
                    Column(Modifier.fillMaxWidth().height((32 * PPM).dp)
                        .clickable(enabled = idle && pressable) { calendar.openItem(item) }
                        .semantics { contentDescription = item.getString("accessibilityLabel") }
                        .testTag("calendar-deadline-${item.getString("taskId")}"), verticalArrangement = Arrangement.Center) {
                        Text(item.getString("title"), style = rnText(11, 400), color = c.text, maxLines = 1)
                        Text(item.getString("detail"), style = rnText(11, 700), color = c.tint, maxLines = 1)
                    }
                }
            }
        }
    }
}

/**
 * RN's ScheduledTaskBlock and event block. A task held for 140 ms follows the finger (RN's scale and lift); let go, its new start
 * is the minute under it snapped to core's 5 and kept inside core's day, sent as one moveTask. A tap opens the item's sheet.
 * A projected occurrence neither moves nor opens.
 */
@Composable
private fun DayBlock(model: InboxViewModel, item: JSONObject, dayKey: String, extent: Int, lane: Dp) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val haptics = LocalHapticFeedback.current
    val event = item.getString("kind") == "event"
    val place = blockBox(item, lane, if (event) 16.dp else 24.dp)
    val projected = item.optBoolean("projected")
    val pressable = item.getBoolean("pressable")
    val movable = !event && !projected && item.optString("taskId").isNotEmpty()
    var shift by remember(item.getString("id")) { mutableFloatStateOf(0f) }
    var dragging by remember(item.getString("id")) { mutableStateOf(false) }
    val compact = !event && place.height < 48.dp
    val showTime = event || place.height >= 44.dp
    val fill = when {
        event -> theme.wash(c.secondaryText, 0.18f, 0.35f)
        projected -> theme.wash(c.tint, 0.1f, 0.18f)
        theme.isDark -> c.tint.copy(alpha = 0.85f)
        else -> c.tint
    }
    val border = when {
        event -> coreColorOrNull(item.menuText("sourceColor")) ?: c.secondaryText
        projected -> theme.wash(c.tint, 0.45f, 0.7f)
        else -> theme.wash(c.tint, 0.3f, 0.6f)
    }
    val shape = RoundedCornerShape(12.dp)
    val spoken = item.spoken()
    // The gesture outlives a recomposition: a drop reads the block and its day as core shows them now.
    val itemNow by rememberUpdatedState(item)
    val dayNow by rememberUpdatedState(dayKey)
    HoldFor(BLOCK_HOLD_MS) {
        Column(Modifier.offset(x = place.x, y = place.top).offset { IntOffset(0, shift.roundToInt()) }.zIndex(if (dragging) 50f else 1f)
            .graphicsLayer { if (dragging) { scaleX = 1.02f; scaleY = 1.02f } }
            .width(place.width).height(place.height).clip(shape).background(fill)
            .then(if (projected) Modifier.drawBehind {
                val w = 1.dp.toPx()
                drawRoundRect(border, Offset(w / 2, w / 2), Size(size.width - w, size.height - w), androidx.compose.ui.geometry.CornerRadius(12.dp.toPx()),
                    style = androidx.compose.ui.graphics.drawscope.Stroke(w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(4 * w, 4 * w))))
            } else Modifier.rnBorder(1.dp, border, shape))
            .testTag("calendar-block")
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; if (pressable && idle) onClick { calendar.openItem(item); true } else disabled() }
            .pointerInput(item.getString("id"), pressable) { detectTapGestures { if (pressable && idle) calendar.openItem(item) } }
            .then(if (movable) Modifier.pointerInput(item.getString("id"), extent) {
                detectDragGesturesAfterLongPress(
                    onDragStart = { dragging = true; shift = 0f; haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) },
                    onDragEnd = {
                        val timed = itemNow.getJSONObject("timed")
                        val top = timed.getInt("startMinutes").coerceAtLeast(0) * PPM + shift / density
                        val minutes = ((top / PPM / SNAP_MINUTES).roundToInt() * SNAP_MINUTES).coerceIn(0, extent - timed.getInt("durationMinutes"))
                        dragging = false
                        shift = 0f
                        if (idle) calendar.move(itemNow, dayNow, minutes)
                    },
                    onDragCancel = { dragging = false; shift = 0f },
                ) { change, amount -> change.consume(); shift += amount.y }
            } else Modifier)
            .padding(horizontal = 10.dp, vertical = if (compact) 2.dp else 8.dp),
            verticalArrangement = if (compact) Arrangement.Center else Arrangement.Top) {
            val titleColor = if (event) c.text else if (projected) c.tint else theme.blockText
            Text(item.getString("title"), style = if (event) rnText(13, 700) else if (compact) rnText(12, 800, 14) else rnText(13, 800), color = titleColor,
                maxLines = if (event || compact) 1 else 2, overflow = TextOverflow.Ellipsis)
            if (showTime) item.menuText("detail")?.let {
                Text(it, style = rnText(11, 400), color = if (event || projected) c.secondaryText else theme.blockText.copy(alpha = 0.9f), maxLines = 1,
                    modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
}

// ---- Schedule ----

/** RN's schedule: core's days with their items, then the planning list for the selected day, or core's empty line. */
@Composable
private fun ScheduleView(model: InboxViewModel, view: JSONObject, content: JSONObject, placed: Placed) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    LazyColumn(Modifier.fillMaxSize().testTag("calendar-schedule"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp)) {
        items(placed.days, key = { it.getString("key") }) { day ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(day.getString("title").uppercase(), style = rnText(12, 900), color = c.secondaryText, modifier = Modifier.padding(horizontal = 2.dp).semantics { heading() })
                for (item in placed.lane("list", day.getString("key"))) {
                    val tones = item.getJSONObject("tones")
                    val event = item.getString("kind") == "event"
                    val fill = if (!event && tones.menuText("fill") == "tint") theme.wash(c.tint, 0.12f, 0.2f) else c.inputBg
                    val accent = if (event) coreColorOrNull(item.menuText("sourceColor")) ?: c.secondaryText
                    else when (tones.menuText("accent")) { "secondary" -> c.secondaryText; "tint" -> c.tint; else -> c.danger }
                    Box(Modifier.fade(if (tones.optBoolean("faded")) 0.7f else 1f)) {
                        CalendarRow(item.getString("title"), item.menuText("detail"), if (tones.menuText("text") == "secondary") c.secondaryText else c.text, fill, accent,
                            tones.optBoolean("dashed"), item.getBoolean("pressable"), idle, item.spoken(), "calendar-item", tones.optBoolean("struck"), onClick = { calendar.openItem(item) })
                    }
                }
            }
        }
        content.optJSONObject("planning")?.let { planning ->
            item(key = "planning") { TaskResults(model, planning.getString("title"), planning.getString("subtitle"), placed.tasks, section = true) }
        }
        content.menuText("empty")?.let { item(key = "empty") { EmptyLine(it) } }
    }
}

// ---- The item sheet and the composer ----

/**
 * RN's item sheet: its Alert, which RN draws as its themed alert (components/themed-alert.tsx): a card over a dark backdrop (a
 * tap on it closes), core's title, a projected occurrence's message, and every button core offers, stacked when more than two
 * (a destructive one in red, the last plain one filled with the tint).
 */
@Composable
private fun ItemSheet(model: InboxViewModel, sheet: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val title = sheet.getString("title")
    Box(Modifier.fillMaxSize().background(theme.alertScrim).clickable(role = Role.Button) { calendar.closeSheet() }.semantics { contentDescription = title }
        .padding(24.dp), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(18.dp)
        Column(Modifier.fillMaxWidth().shadow(14.dp, shape).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.testTag("calendar-sheet").padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(title, style = rnText(20, 700), color = c.text, modifier = Modifier.semantics { heading() })
            sheet.menuText("message")?.let { Text(it, style = rnText(16, 400, 23), color = c.secondaryText, modifier = Modifier.heightIn(max = 240.dp).verticalScroll(rememberScrollState())) }
            val buttons = sheet.menuObjects("buttons")
            val stacked = buttons.size > 2
            val primary = buttons.indexOfLast { it.getString("style") == "default" }
            val content: @Composable (Modifier) -> Unit = { weight ->
                buttons.forEachIndexed { index, button ->
                    val style = button.getString("style")
                    val fill = when { style == "destructive" -> c.danger; index == primary -> c.tint; else -> c.filterBg }
                    val label = button.getString("label")
                    val enabled = style == "cancel" || button.getString("id") == "ok" || idle
                    Box(weight.fade(if (enabled) 1f else 0.5f).heightIn(min = 44.dp).clip(RoundedCornerShape(12.dp)).background(fill)
                        .rnBorder(1.dp, if (fill == c.filterBg) c.border else fill, RoundedCornerShape(12.dp))
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { calendar.press(button.getString("id")); true } else disabled() }
                        .clickable(enabled = enabled) { calendar.press(button.getString("id")) }.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                        Text(label, style = rnText(14, 700), color = if (fill == c.filterBg) c.text else c.onTint, textAlign = TextAlign.Center)
                    }
                }
            }
            if (stacked) Column(Modifier.padding(top = 8.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) { content(Modifier.fillMaxWidth()) }
            else Row(Modifier.padding(top = 8.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) { content(Modifier.weight(1f)) }
        }
    }
}

/**
 * RN's CalendarTaskComposerModal: a card from the bottom over a dark backdrop (a tap on it closes), core's title and date,
 * New or Existing task, the title with core's quick-add help or the search with core's candidates, the start and end fields
 * (core's clock labels, the raw text while typing), core's duration chips, core's error, Cancel and Save. Typed text goes to
 * core's editCalendarComposer; Save sends core's composer with its request UUID (Try again re-sends it while owed).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ComposerSheet(model: InboxViewModel, draft: ComposerDraft) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = draft.view
    val composer = view.getJSONObject("composer")
    val text = view.getJSONObject("text")
    val owed = calendar.owed(draft) != null
    val locked = model.busy || (model.failedAction != null && !owed)
    val close = text.getString("close")
    Box(Modifier.fillMaxSize().background(theme.composerScrim).clickable(role = Role.Button, enabled = !owed) { calendar.closeComposer() }
        .semantics { contentDescription = close }) {
        val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)
        Column(Modifier.align(Alignment.BottomCenter).imePadding().fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.82f).dp)
            .clip(shape).background(c.cardBg).edge(c.border, top = true).pointerInput(Unit) { detectTapGestures { } }.testTag("calendar-composer")
            .verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(text.getString("title"), style = rnText(18, 900), color = c.text, modifier = Modifier.semantics { heading() })
                    Text(view.getString("dateLabel"), style = rnText(12, 700), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                }
                Box(Modifier.size(36.dp).clearAndSetSemantics { contentDescription = close; role = Role.Button; onClick { if (!owed) calendar.closeComposer(); true } }
                    .clickable(enabled = !owed) { calendar.closeComposer() }, contentAlignment = Alignment.Center) {
                    Text("×", style = rnText(28, 600, 30), color = c.secondaryText)
                }
            }
            val mode = composer.getString("mode")
            val shapeToggle = RoundedCornerShape(10.dp)
            Row(Modifier.fillMaxWidth().clip(shapeToggle).background(c.inputBg).rnBorder(1.dp, c.border, shapeToggle).padding(2.dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                for ((value, label) in listOf("new" to text.getString("newTask"), "existing" to text.getString("existingTask"))) {
                    val active = mode == value
                    val choose = { if (!active) calendar.choose(JSONObject().put("type", "mode").put("mode", value)) }
                    Box(Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(if (active) c.tint else Color.Transparent)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = active; onClick { if (!locked) choose(); !locked } }
                        .clickable(enabled = !locked) { choose() }.padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                        Text(label, style = rnText(12, 900), color = if (active) c.onTint else c.secondaryText)
                    }
                }
            }
            if (mode == "new") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ComposerField(draft.typed["title"] ?: composer.getString("title"), text.getString("titlePlaceholder"), !locked, "calendar-composer-title") { calendar.typeTitle(it) }
                    Text(text.getString("help"), style = rnText(12, 400, 16), color = c.secondaryText)
                }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ComposerField(draft.typed["query"] ?: composer.getString("query"), text.getString("queryPlaceholder"), !locked, "calendar-composer-query") { calendar.typeCandidates(it) }
                    Column(Modifier.heightIn(max = 156.dp).verticalScroll(rememberScrollState())) {
                        val candidates = view.menuObjects("candidates")
                        if (candidates.isEmpty()) EmptyLine(text.getString("noMatchingTasks"))
                        for (candidate in candidates) {
                            val chosen = candidate.getBoolean("selected")
                            val title = candidate.getString("title")
                            val pick = { calendar.choose(JSONObject().put("type", "selectTask").put("taskId", candidate.getString("id"))) }
                            Text(title, style = rnText(14, 400), color = if (chosen) c.tint else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.padding(bottom = 6.dp).fillMaxWidth().clip(RoundedCornerShape(8.dp))
                                    .background(if (chosen) theme.wash(c.tint, 0.14f, 0.28f) else c.inputBg).leftBorder(if (chosen) c.tint else c.border, 3.dp)
                                    .clearAndSetSemantics { contentDescription = title; role = Role.Button; selected = chosen; onClick { if (!locked) pick(); !locked } }
                                    .clickable(enabled = !locked) { pick() }.padding(start = 13.dp, end = 10.dp, top = 10.dp, bottom = 10.dp))
                        }
                    }
                    view.menuText("selectedTaskTitle")?.let {
                        Text(it, style = rnText(13, 800), color = c.tint, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(theme.wash(c.tint, 0.12f, 0.22f))
                                .semantics { liveRegion = LiveRegionMode.Polite }.padding(horizontal = 10.dp, vertical = 8.dp))
                    }
                }
            }
            val labels = view.getJSONObject("timeLabels")
            val placeholders = view.getJSONObject("placeholders")
            Row(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TimeField(Modifier.weight(1f), text.getString("start"), draft.typed["start"] ?: composer.getString("startTimeValue"), labels.getString("start"),
                    placeholders.getString("start"), !locked) { calendar.typeTime("start", it) }
                TimeField(Modifier.weight(1f), text.getString("end"), draft.typed["end"] ?: composer.getString("endTimeValue"), labels.getString("end"),
                    placeholders.getString("end"), !locked) { calendar.typeTime("end", it) }
            }
            FlowRow(Modifier.padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (duration in view.menuObjects("durations")) {
                    val active = duration.getBoolean("selected")
                    val label = duration.getString("label")
                    val pick = { calendar.choose(JSONObject().put("type", "duration").put("minutes", duration.getInt("minutes"))) }
                    Text(label, style = rnText(12, 900), color = if (active) c.onTint else c.secondaryText, modifier = Modifier.clip(CircleShape)
                        .background(if (active) c.tint else c.inputBg).rnBorder(1.dp, if (active) c.tint else c.border, CircleShape)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = active; onClick { if (!locked) pick(); !locked } }
                        .clickable(enabled = !locked) { pick() }.padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
            view.menuText("error")?.let {
                Text(it, style = rnText(13, 700), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive })
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                val action = RoundedCornerShape(10.dp)
                val cancel = text.getString("cancel")
                Box(Modifier.widthIn(min = 96.dp).clip(action).background(c.inputBg)
                    .clearAndSetSemantics { contentDescription = cancel; role = Role.Button; onClick { if (!owed) calendar.closeComposer(); true } }
                    .clickable(enabled = !owed) { calendar.closeComposer() }.padding(horizontal = 14.dp, vertical = 11.dp), contentAlignment = Alignment.Center) {
                    Text(cancel, style = rnText(14, 900), color = c.text)
                }
                val canSave = !view.getBoolean("saveDisabled") && model.writable && !model.busy && (model.failedAction == null || owed)
                val save = if (owed) t("common.retry") else text.getString("save")
                Box(Modifier.fade(if (canSave) 1f else 0.5f).widthIn(min = 96.dp).clip(action).background(c.tint).testTag("calendar-composer-save")
                    .clearAndSetSemantics { contentDescription = save; role = Role.Button; if (canSave) onClick { calendar.save(); true } else disabled() }
                    .clickable(enabled = canSave) { calendar.save() }.padding(horizontal = 14.dp, vertical = 11.dp), contentAlignment = Alignment.Center) {
                    Text(save, style = rnText(14, 900), color = c.onTint)
                }
            }
        }
    }
}

/** RN's composer input: 46 high, bordered, the input background; [value] is the typed text, else core's. */
@Composable
private fun ComposerField(value: String, placeholder: String, enabled: Boolean, tag: String, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(value, onChange, enabled = enabled, singleLine = true, textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder }.testTag(tag),
        decorationBox = { inner ->
            Box(Modifier.heightIn(min = 46.dp).clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = rnText(14, 400), color = c.secondaryText)
                inner()
            }
        })
}

/** RN's time field: its label in capitals over a centered input showing core's clock label, and the raw text while focused. */
@Composable
private fun TimeField(modifier: Modifier, label: String, raw: String, shown: String, placeholder: String, enabled: Boolean, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    var focused by remember { mutableStateOf(false) }
    val value = if (focused) raw else shown
    val shape = RoundedCornerShape(8.dp)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label.uppercase(), style = rnText(11, 900), color = c.secondaryText)
        BasicTextField(value, onChange, enabled = enabled, singleLine = true, textStyle = rnText(14, 800).copy(color = c.text, textAlign = TextAlign.Center),
            cursorBrush = SolidColor(c.tint),
            modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label },
            decorationBox = { inner ->
                Box(Modifier.heightIn(min = 44.dp).clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(12.dp), contentAlignment = Alignment.Center) {
                    if (value.isEmpty()) Text(placeholder, style = rnText(14, 800), color = c.secondaryText)
                    inner()
                }
            })
    }
}
