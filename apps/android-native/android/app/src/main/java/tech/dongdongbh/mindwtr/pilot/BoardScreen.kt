package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/*
 * RN's Board (components/views/board-view.tsx) drawn from core's getBoardView: the filter bar (search, Clear, Filters), the five
 * status columns stacked as RN stacks them on a phone, each with core's label, tone and count, core's cards (the title, project,
 * tags, contexts and estimate core puts on each), and core's empty line; RN's filter sheet on core's sheet view. A card opens
 * the editor on a tap; a swipe right past half duplicates, a swipe left past half deletes (RN's Swipeable); held for RN's
 * 180 ms it follows the finger (the Board scrolls at its edges) and its drop sends one core moveCard. TalkBack reaches every
 * action as the card's custom actions. Every word is core's.
 */

/** Where the Board's columns and cards are on screen (root coordinates), for a drop: measured as they lay out. */
private class Layouts {
    val columns = HashMap<String, Pair<Float, Float>>()
    val cards = HashMap<String, Pair<Float, Float>>()
}

@Composable
fun BoardList(model: InboxViewModel) = with(model.menu.board) {
    val shown = page ?: return
    BackHandler(enabled = sheet != null) { sheet?.let { if (it.has("page")) closePicker() else keepSheet(null) } }
    Box(Modifier.fillMaxSize().testTag("board")) {
        Column(Modifier.fillMaxSize()) {
            FilterBar(model, shown)
            Columns(model, shown)
        }
        sheet?.let { BoardFilterSheet(model, shown, it) }
    }
}

/** RN's filter bar: the search (its clear button while it holds text), then Clear while filters are on, then Filters. */
@Composable
private fun FilterBar(model: InboxViewModel, shown: BoardPage) = with(model.menu) {
    val c = LocalTheme.current.colors
    val bar = shown.view.getJSONObject("bar")
    val active = bar.getBoolean("active")
    val searching = bar.getBoolean("searchActive")
    Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        val placeholder = bar.getString("searchPlaceholder")
        val value = board.typed ?: bar.getString("searchQuery")
        val shape = RoundedCornerShape(8.dp)
        Box(Modifier.weight(1f).widthIn(min = 140.dp)) {
            BasicTextField(value, { board.typeSearch(it) }, singleLine = true, textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder }.testTag("board-search"),
                decorationBox = { inner ->
                    Box(Modifier.heightIn(min = 44.dp).clip(shape).background(if (searching) c.filterBg else c.inputBg).rnBorder(1.dp, if (searching) c.tint else c.border, shape)
                        .padding(start = 12.dp, end = if (searching) 44.dp else 12.dp, top = 8.dp, bottom = 8.dp), contentAlignment = Alignment.CenterStart) {
                        if (value.isEmpty()) Text(placeholder, style = rnText(14, 400), color = c.secondaryText, maxLines = 1)
                        inner()
                    }
                })
            if (searching) {
                val clear = bar.getString("clearLabel")
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp).size(28.dp).clip(CircleShape).background(c.cardBg)
                    .clearAndSetSemantics { contentDescription = clear; role = Role.Button; onClick { if (idle) board.clearSearch(); idle } }
                    .clickable(enabled = idle) { board.clearSearch() }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                }
            }
        }
        if (active) {
            val clear = bar.getString("clearLabel")
            Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp)
                .clearAndSetSemantics { contentDescription = clear; role = Role.Button; onClick { if (idle) board.clearFilters(); idle } }
                .clickable(enabled = idle) { board.clearFilters() }, contentAlignment = Alignment.Center) {
                Text(clear, style = rnText(13, 500), color = c.tint)
            }
        }
        val label = bar.getString("filterLabel")
        Row(Modifier.heightIn(min = 44.dp).clip(CircleShape).background(if (active) c.tint else c.filterBg).rnBorder(1.dp, if (active) c.tint else c.border, CircleShape)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { board.keepSheet(JSONObject()); true } }
            .clickable { board.keepSheet(JSONObject()) }.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Lucide.Filter, null, tint = if (active) c.onTint else c.secondaryText, modifier = Modifier.size(14.dp))
            Text(label, style = rnText(13, 600), color = if (active) c.onTint else c.text)
        }
    }
}

/**
 * The columns in one scrolling list, as RN's ScrollView: each card's drop is resolved against where the columns and cards are,
 * and a card held near the list's top or bottom edge scrolls it.
 */
@Composable
private fun Columns(model: InboxViewModel, shown: BoardPage) = with(model.menu) {
    val density = LocalDensity.current
    val scroll = rememberScrollState()
    val layouts = remember { Layouts() }
    var viewport by remember { mutableStateOf(0f to 0f) }
    var dragging by remember { mutableStateOf<String?>(null) }
    var edge by remember { mutableIntStateOf(0) }
    // RN's auto-scroll: while a held card sits within 72 of an edge, the Board scrolls toward it.
    LaunchedEffect(edge) {
        val step = with(density) { 8.dp.toPx() }
        while (edge != 0) { scroll.scrollBy(edge * step); withFrameNanos { } }
    }
    val columns = shown.view.menuObjects("columns")
    Column(Modifier.fillMaxSize().onGloballyPositioned { viewport = it.positionInRoot().y to it.positionInRoot().y + it.size.height }
        .verticalScroll(scroll).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        for (column in columns) {
            val status = column.getString("status")
            BoardColumn(model, shown, column, columns, layouts, isSource = dragging != null && shown.cards[status].orEmpty().any { it.getJSONObject("row").getString("id") == dragging },
                onDrag = { id, finger ->
                    dragging = id
                    val margin = with(density) { 72.dp.toPx() }
                    edge = if (id == null) 0 else if (finger <= viewport.first + margin) -1 else if (finger >= viewport.second - margin) 1 else 0
                })
        }
    }
}

/** RN's column: the tone's 4-high top, core's label and count badge, core's cards, core's empty line, and More for a long column. */
@Composable
private fun BoardColumn(model: InboxViewModel, shown: BoardPage, column: JSONObject, columns: List<JSONObject>, layouts: Layouts, isSource: Boolean,
                        onDrag: (String?, Float) -> Unit) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val status = column.getString("status")
    val tone = theme.columnTone(column.getString("tone"))
    val shape = RoundedCornerShape(12.dp)
    val cards = shown.cards[status].orEmpty()
    // Not clipped (RN's overflow visible): a held card is drawn outside its column, and its column is raised above the others.
    Column(Modifier.fillMaxWidth().zIndex(if (isSource) 500f else 0f).shadow(2.dp, shape, clip = false).background(c.cardBg, shape).heightIn(min = 100.dp)
        .onGloballyPositioned { layouts.columns[status] = it.positionInRoot().y to it.positionInRoot().y + it.size.height }) {
        Box(Modifier.fillMaxWidth().height(4.dp).background(tone, RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp)))
        val label = column.getString("label")
        val count = column.getInt("count")
        Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(12.dp).testTag("board-column")
            .clearAndSetSemantics { contentDescription = "$label · $count"; heading() },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = rnText(15, 600), color = c.text)
            Text("$count", style = rnText(12, 600), color = c.text, modifier = Modifier.clip(RoundedCornerShape(10.dp)).background(c.filterBg)
                .rnBorder(1.dp, tone, RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 2.dp))
        }
        Column(Modifier.fillMaxWidth().heightIn(min = 50.dp).padding(10.dp)) {
            cards.forEachIndexed { index, card ->
                val id = card.getJSONObject("row").getString("id")
                key(id) {
                    BoardCard(model, shown, card, status, cards.getOrNull(index - 1)?.getJSONObject("row")?.getString("id"), cards, columns, layouts, onDrag)
                }
            }
            column.menuText("empty")?.let {
                Text(it, style = rnText(13, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp))
            }
            if (cards.size < count) Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { MoreChip(idle) { board.more(status) } }
        }
    }
}

/**
 * One card (RN's DraggableTask): the swipe panels behind it (Duplicate on the left, Delete on the right, each run once the card
 * is let go past half its width, as RN's Swipeable opens), and the card, which follows the finger once held. Its drop: into the
 * column under its middle (the nearest when between columns), and inside its own column after the last other card whose middle
 * is above it. A drop that changes nothing sends nothing.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BoardCard(model: InboxViewModel, shown: BoardPage, card: JSONObject, status: String, before: String?, cards: List<JSONObject>,
                      columns: List<JSONObject>, layouts: Layouts, onDrag: (String?, Float) -> Unit) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val haptics = LocalHapticFeedback.current
    val row = card.getJSONObject("row")
    val meta = card.getJSONObject("card")
    val id = row.getString("id")
    // The card's revision as core's view showed it: its moves and its Delete send it.
    val revision = row.optString("taskRevision")
    val title = row.getString("title")
    val swipes = shown.view.getJSONObject("cardActions").getJSONObject("swipes")
    val duplicateLabel = swipes.getJSONObject("left").getString("label")
    val deleteLabel = swipes.getJSONObject("right").getString("label")
    val swipe = remember(id) { Animatable(0f) }
    val scope = rememberCoroutineScope()
    var width by remember { mutableFloatStateOf(1f) }
    var top by remember { mutableFloatStateOf(0f) }
    var height by remember { mutableFloatStateOf(0f) }
    // A drag: the finger's place and the card's top when it began, and the finger's place now (root coordinates).
    var held by remember { mutableStateOf(false) }
    var grab by remember { mutableFloatStateOf(0f) }
    var startTop by remember { mutableFloatStateOf(0f) }
    var finger by remember { mutableFloatStateOf(0f) }
    val lift = if (held) (finger - grab) - (top - startTop) else 0f
    val canEdit = model.writable && !model.busy && model.failedAction == null
    val run = { action: String -> if (canEdit) { if (action == "duplicate") board.duplicate(id) else board.trash(id, revision) } }
    val swipeActions = listOf("left" to duplicateLabel, "right" to deleteLabel)
    val drop = {
        val center = startTop + height / 2 + (finger - grab)
        var target = status
        var nearest = Float.MAX_VALUE
        for (column in columns) {
            val (columnTop, columnBottom) = layouts.columns[column.getString("status")] ?: continue
            val distance = if (center < columnTop) columnTop - center else if (center > columnBottom) center - columnBottom else 0f
            if (distance < nearest) { nearest = distance; target = column.getString("status") }
        }
        if (target != status) board.move(id, revision, target, null, sameColumn = false)
        else {
            var after: String? = null
            for (other in cards) {
                val otherId = other.getJSONObject("row").getString("id")
                if (otherId == id) continue
                val (otherTop, otherHeight) = layouts.cards[otherId] ?: continue
                if (center > otherTop + otherHeight / 2) after = otherId
            }
            if (after != before) board.move(id, revision, status, after, sameColumn = true)
        }
    }
    // The gesture outlives a recomposition: it drops with the column as it is now.
    val dropNow by rememberUpdatedState(drop)
    val moveActions = columns.mapNotNull { column ->
        val target = column.getString("status")
        if (target == status) null else CustomAccessibilityAction("${t("bulk.moveTo")}: ${column.getString("label")}") { if (canEdit) board.move(id, revision, target, null, sameColumn = false); canEdit }
    }
    val spoken = listOfNotNull(title, meta.menuText("projectTitle")).plus(meta.optJSONArray("tags").ids()).plus(meta.optJSONArray("contexts").ids())
        .plus(listOfNotNull(meta.menuText("timeEstimateLabel"))).joinToString(", ")
    val shape = RoundedCornerShape(8.dp)
    Box(Modifier.padding(bottom = 8.dp).zIndex(if (held) 1000f else 1f)
        .onGloballyPositioned { coordinates ->
            top = coordinates.positionInRoot().y
            height = coordinates.size.height.toFloat()
            layouts.cards[id] = top to height
        }) {
        if (swipe.value > 0f) SwipePanel(duplicateLabel, c.tint, Alignment.CenterStart, Modifier.matchParentSize())
        if (swipe.value < 0f) SwipePanel(deleteLabel, c.danger, Alignment.CenterEnd, Modifier.matchParentSize())
        HoldFor(CARD_HOLD_MS) {
            Column(Modifier.fillMaxWidth().onSizeChanged { width = it.width.toFloat().coerceAtLeast(1f) }
                .testTag("board-card")
                .clearAndSetSemantics {
                    contentDescription = spoken; role = Role.Button
                    // While a command runs or a retry is owed, TalkBack hears the card disabled, with no actions, as every other control.
                    if (canEdit) {
                        onClick(t("common.edit")) { model.openEditor(id); true }
                        customActions = swipeActions.map { (side, label) -> CustomAccessibilityAction(label) { run(if (side == "left") "duplicate" else "trash"); true } } + moveActions
                    } else disabled()
                }
                .pointerInput(id, canEdit) { detectTapGestures { if (canEdit) model.openEditor(id) } }
                .pointerInput(id, canEdit, "hold") {
                    if (!canEdit) return@pointerInput
                    detectDragGesturesAfterLongPress(
                        onDragStart = { at ->
                            held = true; grab = top + at.y; finger = grab; startTop = top
                            haptics.performHapticFeedback(HapticFeedbackType.LongPress); onDrag(id, finger)
                        },
                        onDragEnd = { dropNow(); held = false; onDrag(null, 0f) },
                        onDragCancel = { held = false; onDrag(null, 0f) },
                    ) { change, _ -> change.consume(); finger = top + change.position.y; onDrag(id, finger) }
                }
                .draggable(rememberDraggableState { delta -> scope.launch { swipe.snapTo(swipe.value + delta) } }, Orientation.Horizontal, enabled = canEdit && !held,
                    onDragStopped = {
                        val side = if (swipe.value > width / 2) "left" else if (swipe.value < -width / 2) "right" else null
                        scope.launch { swipe.animateTo(0f) }
                        // RN's Swipeable runs the opened side's action, then closes (#S2 of the Board review).
                        side?.let { run(if (it == "left") "duplicate" else "trash") }
                    })
                .graphicsLayer { translationX = swipe.value; translationY = lift; if (held) { scaleX = 1.05f; scaleY = 1.05f; alpha = 0.85f } }
                .shadow(if (held) 12.dp else 3.dp, shape).clip(shape).background(c.taskItemBg).rnBorder(1.dp, c.border, shape).padding(12.dp)) {
                Text(title, style = rnText(14, 500), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (meta.optBoolean("showMetaRow")) {
                    FlowRow(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        meta.menuText("projectTitle")?.let { project ->
                            val color = coreColorOrNull(meta.menuText("projectColor")) ?: c.secondaryText
                            Row(Modifier.clip(RoundedCornerShape(10.dp)).background(c.filterBg).rnBorder(1.dp, color, RoundedCornerShape(10.dp))
                                .padding(horizontal = 8.dp, vertical = 1.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Icon(Lucide.Folder, null, tint = c.text, modifier = Modifier.size(12.dp))
                                Text(project, style = rnText(11, 700, 14), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        for (token in meta.optJSONArray("tags").ids() + meta.optJSONArray("contexts").ids()) {
                            Text(token, style = rnText(11, 400, 14), color = c.secondaryText, modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(c.filterBg)
                                .rnBorder(1.dp, c.border, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 1.dp))
                        }
                        meta.menuText("timeEstimateLabel")?.let { estimate ->
                            Row(Modifier.clip(RoundedCornerShape(4.dp)).background(c.filterBg).rnBorder(1.dp, c.border, RoundedCornerShape(4.dp))
                                .padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Icon(Lucide.Clock3, null, tint = c.secondaryText, modifier = Modifier.size(12.dp))
                                Text(estimate, style = rnText(11, 600, 14), color = c.secondaryText)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** RN's swipe panel behind a card: core's label on the screen's background, bordered in the action's color. */
@Composable
private fun SwipePanel(label: String, border: Color, align: Alignment, modifier: Modifier) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Box(modifier.clip(shape).background(c.bg).rnBorder(1.dp, border, shape).padding(horizontal = 20.dp), contentAlignment = align) {
        Text(label, style = rnText(14, 600), color = c.text)
    }
}

/**
 * RN's filter sheet (task-filter-sheet.tsx with the Board's due-date section on top) on core's sheet view: the active filters
 * (core's chips, each removed by its edit), the due-date disclosure with core's presets, Contexts & tags and Projects (each a
 * picker page; the tokens page ends with the Any/All match controls core shows), Clear, and Done.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun BoardFilterSheet(model: InboxViewModel, shown: BoardPage, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = shown.view
    val sheetView = view.getJSONObject("sheet")
    val bar = view.getJSONObject("bar")
    val filters = shown.filters
    val picker = open.menuText("page")
    val all = t("common.all")
    val excluded = t("filters.excluded")
    val close = t("common.close")
    val setSheet = { value: JSONObject? -> board.keepSheet(value) }
    Box(Modifier.fillMaxSize().background(theme.scrim).clickable(role = Role.Button) { setSheet(null) }.semantics { contentDescription = close }) {
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        val tall = (LocalConfiguration.current.screenHeightDp * 0.82f).dp
        Column(Modifier.align(Alignment.BottomCenter).imePadding().fillMaxWidth().then(if (picker != null) Modifier.height(tall) else Modifier.heightIn(max = tall))
            .clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.testTag("board-filters")
            .semantics { contentDescription = t("filters.label") }.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (picker != null) Text(t("common.back"), style = rnText(13, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { board.closePicker() }.padding(end = 8.dp, top = 12.dp, bottom = 12.dp))
                val sheetTitle = t(when (picker) { "tokens" -> "filters.contexts"; "projects" -> "filters.projects"; else -> "filters.label" })
                Text(sheetTitle, style = rnText(16, 700), color = c.text,
                    modifier = Modifier.weight(1f).semantics { heading() })
                if (bar.getBoolean("active")) Text(t("filters.clear"), style = rnText(13, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(enabled = idle, role = Role.Button) { board.clearFilters() }.padding(horizontal = 10.dp, vertical = 12.dp))
            }
            if (picker != null) {
                // RN's picker search, as the Inbox's: core's matching options (the query from offset zero), read again whenever the
                // Board changes, since a tap changes the options' states.
                val query = open.optString("query")
                val found = board.found?.takeIf { it.getString("name") == picker && it.getString("query") == query && it.getString("revision") == shown.revision }
                LaunchedEffect(shown.revision, picker) { if (query.isNotBlank()) board.searchPicker(picker, query, board.found?.optJSONArray("items")?.length() ?: 0) }
                Box(Modifier.padding(bottom = 10.dp)) {
                    SheetField(query, t("common.search"), "${t("common.search")} ${t(if (picker == "tokens") "filters.contexts" else "filters.projects")}") { board.pickerQuery(picker, it) }
                }
                val options = if (query.isBlank()) shown.collection(picker) else found?.menuObjects("items").orEmpty()
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    if (options.isEmpty() && (query.isBlank() || found != null)) Text(t("search.noResults"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp))
                    for (option in options) {
                        val label = option.optString("title").ifEmpty { option.getString("value") }
                        val out = option.optString("state") == "excluded"
                        val on = option.optString("state") == "included" || option.optBoolean("selected")
                        val pick = { if (picker == "tokens") board.toggleToken(option.getString("value")) else board.toggleProject(option.getString("id")) }
                        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).hairline(c.border, top = false)
                            .clearAndSetSemantics { contentDescription = if (out) "$label ($excluded)" else label; role = Role.Button; selected = on; onClick { if (idle) pick(); idle } }
                            .clickable(enabled = idle) { pick() }.padding(horizontal = 4.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(label, style = rnText(14, 400, 19).copy(textDecoration = if (out) TextDecoration.LineThrough else null),
                                color = if (out) c.danger else c.text, maxLines = 2, modifier = Modifier.weight(1f))
                            if (on || out) Text(if (out) excluded else t("bulk.selected"), style = rnText(12, 600), color = if (out) c.danger else c.tint)
                        }
                    }
                    if (query.isBlank() && options.size < shown.collectionTotal(picker)) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { board.more(picker) } }
                    if (found != null && options.size < found.getInt("total")) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { board.searchPicker(picker, query, options.size + 100) } }
                    if (picker == "tokens") Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (sheetView.getBoolean("showContextMatchMode")) MatchMode(model, "context", t("filters.contextMatchMode"), filters.optString("contextMatchMode"))
                        if (sheetView.getBoolean("showTagMatchMode")) MatchMode(model, "tag", t("filters.tagMatchMode"), filters.optString("tagMatchMode"))
                    }
                }
            } else {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    val chips = shown.collection("chips")
                    val extra = sheetView.menuObjects("additionalChips")
                    if (chips.isNotEmpty() || extra.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SheetLabel(t("filters.active"))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (chip in chips + extra) {
                                val label = chip.getString("label")
                                SheetChip(label, true, chip.optBoolean("excluded"), remove = "${t("filters.remove")}: $label", enabled = idle) { board.filterEdit(chip.getJSONObject("edit")) }
                            }
                            if (chips.size < shown.collectionTotal("chips")) MoreChip(idle) { board.more("chips") }
                        }
                    }
                    DueSection(model, sheetView.getJSONObject("due"), open)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (shown.collectionTotal("tokens") > 0) {
                            val picked = filters.optJSONArray("tokens").ids() + filters.optJSONArray("excludedTokens").ids().map { "$excluded: $it" }
                            OverviewRow(t("filters.contexts"), picked.joinToString(", ").ifEmpty { all }, all, null) { setSheet(JSONObject(open.toString()).put("page", "tokens")) }
                        }
                        if (shown.collectionTotal("projects") > 0) {
                            val chosen = shown.collection("projects").mapNotNull { project -> project.getString("title").takeIf { project.optBoolean("selected") } }.joinToString(", ")
                            OverviewRow(t("filters.projects"), chosen.ifEmpty { all }, all, null) { setSheet(JSONObject(open.toString()).put("page", "projects")) }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                Text(t("common.done"), style = rnText(14, 700), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { setSheet(null) }.padding(horizontal = 10.dp, vertical = 12.dp))
            }
        }
    }
}

/** RN's due-date disclosure on top of the Board's sheet: core's label and summary (the tint once a preset is on), and core's presets while open. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DueSection(model: InboxViewModel, due: JSONObject, open: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val expanded = open.optBoolean("due")
    val presets = due.menuObjects("presets")
    val on = presets.any { it.getBoolean("selected") }
    val shape = RoundedCornerShape(12.dp)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val spoken = due.getString("accessibilityLabel")
        val fold = { board.keepSheet(JSONObject(open.toString()).put("due", !expanded)) }
        Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape)
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; onClick { fold(); true } }
            .clickable { fold() }.padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(due.getString("label"), style = rnText(15, 500), color = c.text)
                Text(due.getString("summary"), style = rnText(13, 400), color = if (on) c.tint else c.secondaryText)
            }
            Text(if (expanded) "−" else "+", style = rnText(20, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.widthIn(min = 20.dp))
        }
        if (expanded) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (preset in presets) SheetChip(preset.getString("label"), preset.getBoolean("selected"), false, enabled = idle) { board.duePreset(preset.getString("preset")) }
        }
    }
}

/** RN's Any/All control for a kind of token, shown once core says two of that kind are included. */
@Composable
private fun MatchMode(model: InboxViewModel, kind: String, label: String, mode: String) = with(model.menu) {
    val c = LocalTheme.current.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = rnText(12, 600), color = c.secondaryText)
        Row(Modifier.heightIn(min = 36.dp).clip(RoundedCornerShape(18.dp)).background(c.filterBg).rnBorder(1.dp, c.border, RoundedCornerShape(18.dp)).padding(2.dp)) {
            for ((value, text) in listOf("any" to t("filters.matchAny"), "all" to t("common.all"))) {
                val active = mode == value
                Box(Modifier.widthIn(min = 52.dp).heightIn(min = 30.dp).clip(RoundedCornerShape(15.dp)).background(if (active) c.tint else Color.Transparent)
                    .clearAndSetSemantics { contentDescription = "$label: $text"; role = Role.Button; selected = active; onClick { if (idle && !active) board.matchMode(kind, value); idle } }
                    .clickable(enabled = idle && !active) { board.matchMode(kind, value) }.padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(text, style = rnText(12, 700), color = if (active) c.onTint else c.secondaryText)
                }
            }
        }
    }
}
