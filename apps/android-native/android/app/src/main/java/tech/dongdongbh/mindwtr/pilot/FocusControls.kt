package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
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
import org.json.JSONObject
import kotlin.math.roundToInt

/*
 * RN's Focus controls (app/(drawer)/(tabs)/focus.tsx) on core's controls view (NativeFocusControls, FocusModel.kt): the header
 * buttons, the saved Focus filters and the active chips over the sections, Today's Focus Reorder and its reorder screen, the
 * group headings of a grouped Next actions, and the sheets and dialogs: View options, the filter sheet with Save, the Save
 * filter dialog, and the delete questions. Every word, chip, option and edit is core's.
 */

/**
 * RN's View options (Settings2) and Filters (SlidersHorizontal, core's count on a tint badge) buttons, each 44 round, tinted
 * while core says they are active (View options also while details show, the host's own flag).
 */
@Composable
fun FocusHeaderButtons(model: InboxViewModel, controls: JSONObject) {
    val header = controls.getJSONObject("header")
    val viewOptions = header.getJSONObject("viewOptions")
    val filters = header.getJSONObject("filters")
    val enabled = model.writable && model.failedAction == null
    HeaderButton(Lucide.Settings2, viewOptions.getString("label"), viewOptions.getBoolean("active") || model.focusView.showDetails, null, enabled) {
        model.menu.focusControls.open("view")
    }
    HeaderButton(Lucide.SlidersHorizontal, filters.getString("label"), filters.getBoolean("active"), filters.menuText("badge"), enabled) {
        model.menu.focusControls.open("filters")
    }
}

@Composable
private fun HeaderButton(icon: ImageVector, label: String, tinted: Boolean, badge: String?, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.size(44.dp).clip(CircleShape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = if (tinted) c.tint else c.secondaryText, modifier = Modifier.size(20.dp))
        badge?.let {
            Box(Modifier.align(Alignment.TopEnd).padding(top = 5.dp, end = 5.dp).widthIn(min = 16.dp).height(16.dp).clip(CircleShape).background(c.tint)
                .padding(horizontal = 3.dp), contentAlignment = Alignment.Center) {
                Text(it, style = rnText(10, 700), color = c.onTint)
            }
        }
    }
}

/**
 * RN's rows under the header: core's saved Focus filters (All, then each filter with its delete button; a long-press deletes
 * too), and the active filters (each chip removes itself) with Clear. Deleting asks core's question first.
 */
@Composable
fun FocusFilterRows(model: InboxViewModel, controls: JSONObject) = with(model.menu.focusControls) {
    val c = LocalTheme.current.colors
    val idle = model.menu.idle
    val revision = model.focus?.revision ?: return
    Column {
        controls.optJSONObject("savedFilters")?.let { saved ->
            Row(Modifier.padding(top = 10.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                val all = saved.getJSONObject("all")
                SavedChip(all.getString("label"), all.getBoolean("selected"), null, idle, {}) { edit(all.getJSONObject("edit")) }
                val chips = saved.getJSONObject("chips")
                val shown = collection("savedFilters", chips, revision)
                for (chip in shown) {
                    SavedChip(chip.getString("label"), chip.getBoolean("selected"), chip.getString("deleteLabel"), idle,
                        { confirmDelete(chip.getString("id"), chip.getString("label")) }) { edit(chip.getJSONObject("edit")) }
                }
                if (shown.size < chips.getInt("total")) MoreChip(idle) { loadMore("savedFilters", chips, revision) }
            }
        }
        controls.optJSONObject("activeChips")?.let { active ->
            Row(Modifier.padding(top = 8.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                for (chip in active.menuObjects("chips")) {
                    SheetChip(chip.getString("label"), true, chip.getBoolean("excluded"), enabled = idle) { edit(chip.getJSONObject("edit")) }
                }
                val clear = active.getJSONObject("clear")
                val label = clear.getString("label")
                val clearEdit = clear.getJSONObject("edit")
                Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.heightIn(min = 44.dp)
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (idle) onClick { edit(clearEdit); true } else disabled() }
                    .clickable(enabled = idle) { edit(clearEdit) }.padding(horizontal = 8.dp, vertical = 14.dp))
            }
        }
    }
}

/** RN's saved filter chip, attached to its delete button (Trash2) when it has one; TalkBack has the delete as an action. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SavedChip(label: String, selected: Boolean, deleteLabel: String?, enabled: Boolean, onDelete: () -> Unit, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val fill = if (selected) c.tint else c.filterBg
    val edge = if (selected) c.tint else c.border
    Row(Modifier.height(IntrinsicSize.Min)) {
        val shape = if (deleteLabel != null) RoundedCornerShape(topStart = 22.dp, bottomStart = 22.dp) else RoundedCornerShape(22.dp)
        Box(Modifier.widthIn(min = 44.dp, max = 180.dp).heightIn(min = 44.dp).clip(shape).background(fill).border(1.dp, edge, shape)
            .clearAndSetSemantics {
                contentDescription = label; role = Role.Button; this.selected = selected
                if (enabled) {
                    onClick { action(); true }
                    deleteLabel?.let { customActions = listOf(CustomAccessibilityAction(it) { onDelete(); true }) }
                } else disabled()
            }
            .combinedClickable(enabled = enabled, onLongClick = if (deleteLabel != null) onDelete else null, onClick = action)
            .padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
            Text(label, style = rnText(12, 700), color = if (selected) c.onTint else c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        deleteLabel?.let { spoken ->
            val end = RoundedCornerShape(topEnd = 22.dp, bottomEnd = 22.dp)
            Box(Modifier.width(44.dp).fillMaxHeight().clip(end).background(fill).border(1.dp, edge, end)
                .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; if (enabled) onClick { onDelete(); true } else disabled() }
                .clickable(enabled = enabled, onClick = onDelete), contentAlignment = Alignment.Center) {
                Icon(Lucide.Trash2, null, tint = if (selected) c.onTint else c.secondaryText, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/** RN's Reorder beside Today's Focus: GripVertical and core's label; it opens the reorder screen. */
@Composable
fun ReorderToggle(model: InboxViewModel, label: String) {
    val c = LocalTheme.current.colors
    val enabled = model.menu.idle
    Row(Modifier.heightIn(min = 36.dp).clip(RoundedCornerShape(8.dp))
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { model.menu.focusControls.reorder(true); true } else disabled() }
        .clickable(enabled = enabled) { model.menu.focusControls.reorder(true) }.padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(Lucide.GripVertical, null, tint = c.secondaryText, modifier = Modifier.size(15.dp))
        Text(label, style = rnText(11, 700), color = c.secondaryText, maxLines = 1)
    }
}

/** RN's group heading in a grouped Next actions: core's dot (muted: the secondary text), title in capitals, and count. */
@Composable
fun FocusGroupHeading(heading: JSONObject) {
    val c = LocalTheme.current.colors
    val muted = heading.getBoolean("muted")
    val title = heading.getString("title")
    val count = heading.getInt("count")
    Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 6.dp, start = 4.dp, end = 4.dp).clearAndSetSemantics { contentDescription = "$title $count"; heading() },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(if (muted) c.secondaryText else coreColorOrNull(heading.menuText("dotColor")) ?: c.tint))
        Text(title.uppercase(), style = rnText(13, 700, letterSpacing = 0.6f), color = if (muted) c.secondaryText else c.text, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text("$count", style = rnText(12, 700), color = c.secondaryText)
    }
}

/** A row under a group heading: indented, with RN's 2-wide rule at its left (contextGroupTaskWrapper). */
@Composable
fun GroupedRow(grouped: Boolean, content: @Composable () -> Unit) {
    if (!grouped) return content()
    val c = LocalTheme.current.colors
    Box(Modifier.padding(start = 13.dp).drawBehind { drawLine(c.border, Offset(1.dp.toPx(), 0f), Offset(1.dp.toPx(), size.height), 2.dp.toPx()) }
        .padding(start = 10.dp)) { content() }
}

/**
 * RN's reorder screen for Today's Focus: core's title and Done, then core's rows (title and secondary line) in their order.
 * A long-press lifts a row and a drag moves it (its new place shows on the badge); the drop sends the new order to core's
 * reorderFocus, which writes only the moved tasks. TalkBack has core's Move up and Move down (core's whole orders) on each row.
 * Core's hint shows until the first move.
 */
@Composable
fun FocusReorder(model: InboxViewModel, screen: JSONObject, modifier: Modifier) = with(model.menu.focusControls) {
    val theme = LocalTheme.current
    val c = theme.colors
    val rows = screen.getJSONObject("rows").menuObjects("items")
    val ids = rows.map { it.getString("id") }
    // Each row's revision as core showed it: reorderFocus sends them all.
    val revisions = JSONObject().apply { rows.forEach { put(it.getString("id"), it.optString("taskRevision")) } }
    var hint by rememberSaveable { mutableStateOf(true) }
    val enabled = model.menu.idle
    Column(modifier.background(c.bg)) {
        Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(screen.getString("title").uppercase(), style = rnText(13, 700, letterSpacing = 1f), color = c.text, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).semantics { heading() })
            val done = screen.getString("doneLabel")
            Box(Modifier.heightIn(min = 40.dp).clip(RoundedCornerShape(20.dp)).background(theme.filledBg).border(1.dp, theme.filledBg, RoundedCornerShape(20.dp))
                .clearAndSetSemantics { contentDescription = done; role = Role.Button; onClick { reorder(false); true } }
                .clickable { reorder(false) }.padding(horizontal = 18.dp), contentAlignment = Alignment.Center) {
                Text(done, style = rnText(14, 700), color = theme.filledText)
            }
        }
        val density = LocalDensity.current
        val rowHeight = with(density) { 80.dp.toPx() }
        var dragged by remember { mutableStateOf<String?>(null) }
        var shift by remember { mutableFloatStateOf(0f) }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 24.dp)) {
            itemsIndexed(rows, key = { _, row -> row.getString("id") }) { index, row ->
                val id = row.getString("id")
                val active = dragged == id
                // The place a drop would take: the row's own, moved by whole rows under the finger.
                val target = if (active) (index + (shift / rowHeight).roundToInt()).coerceIn(0, rows.size - 1) else index
                val moves = listOfNotNull(
                    row.optJSONArray("moveUp")?.let { order -> CustomAccessibilityAction(screen.getString("moveUpLabel")) { if (enabled) { hint = false; reorderTo(order.ids(), revisions) }; enabled } },
                    row.optJSONArray("moveDown")?.let { order -> CustomAccessibilityAction(screen.getString("moveDownLabel")) { if (enabled) { hint = false; reorderTo(order.ids(), revisions) }; enabled } },
                )
                Box(Modifier.height(80.dp).padding(vertical = 4.dp).then(if (active) Modifier.offset { IntOffset(0, shift.roundToInt()) } else Modifier)) {
                    val shape = RoundedCornerShape(12.dp)
                    Row(Modifier.fillMaxSize().then(if (active) Modifier.shadow(4.dp, shape) else Modifier).clip(shape).background(if (active) c.filterBg else c.cardBg)
                        .border(if (active) 1.dp else 0.5.dp, if (active) c.tint else c.border, shape)
                        .clearAndSetSemantics {
                            contentDescription = row.getString("positionLabel"); role = Role.Button
                            if (enabled) customActions = moves else disabled()
                        }
                        .pointerInput(id, enabled) {
                            if (!enabled) return@pointerInput
                            detectDragGesturesAfterLongPress(
                                onDragStart = { dragged = id; shift = 0f; hint = false },
                                onDragEnd = {
                                    val to = (index + (shift / rowHeight).roundToInt()).coerceIn(0, ids.size - 1)
                                    dragged = null; shift = 0f
                                    // The drop's order: this row taken out and put back at the place it was dropped.
                                    if (to != index) reorderTo(ids.toMutableList().apply { add(to, removeAt(index)) }, revisions)
                                },
                                onDragCancel = { dragged = null; shift = 0f },
                            ) { change, amount -> change.consume(); shift += amount.y }
                        }.padding(start = 14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(row.getString("title"), style = rnText(15, 600, 20), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            row.getString("secondaryLabel").takeIf { it.isNotEmpty() }?.let {
                                Text(it, style = rnText(12, 400, 16), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        if (active) Box(Modifier.size(24.dp).clip(CircleShape).background(c.tint), contentAlignment = Alignment.Center) {
                            Text("${target + 1}", style = rnText(12, 700), color = c.onTint)
                        }
                        Box(Modifier.width(40.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
                            Icon(Lucide.GripVertical, null, tint = if (active) c.tint else c.secondaryText, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }
            if (hint) item(key = "hint") {
                Text(screen.getString("hint"), style = rnText(12, 400, 18), color = c.secondaryText, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(top = 16.dp, start = 24.dp, end = 24.dp))
            }
        }
    }
}

/** Focus's open sheet or dialog (FocusModel.dialog), over the tabs: View options, the filter sheet, Save filter, or a delete question. */
@Composable
fun FocusDialogs(model: InboxViewModel) = with(model.menu.focusControls) {
    val open = dialog ?: return
    val controls = model.focus?.controls ?: return
    BackHandler(enabled = model.failedAction == null) { back() }
    when (open.optString("kind")) {
        "view" -> ViewOptionsSheet(model, controls)
        "filters" -> FocusFilterSheet(model, controls, open)
        "save" -> SaveFilterDialog(model, controls, open)
        "deleteFilter", "removeCriterion" -> {
            val confirm = if (open.optString("kind") == "deleteFilter") controls.optJSONObject("savedFilters")?.optJSONObject("deleteConfirm")
            else controls.getJSONObject("filterSheet").getJSONObject("removeConfirm")
            if (confirm == null) return@with
            AlertDialog(
                onDismissRequest = { back() },
                title = { Text(confirm.getString("title")) },
                text = { Text(open.getString("name")) },
                confirmButton = { TextButton(onClick = { confirmed() }, enabled = model.menu.idle) { Text(confirm.getString("confirmLabel")) } },
                dismissButton = { TextButton(onClick = { back() }) { Text(confirm.getString("cancelLabel")) } },
            )
        }
    }
}

/** RN's bottom sheet (focus.tsx sheet): the 0.35 backdrop (a tap closes), a card from the bottom, radius 24, at most [tall] or 78% high. */
@Composable
private fun FocusSheet(model: InboxViewModel, tall: Boolean = false, content: @Composable ColumnScope.() -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    val close = t("common.close")
    Box(Modifier.fillMaxSize().background(theme.scrim).clickable(role = Role.Button) { model.menu.focusControls.keepDialog(null) }.semantics { contentDescription = close }) {
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        val height = (LocalConfiguration.current.screenHeightDp * (if (tall) 0.82f else 0.78f)).dp
        Column(Modifier.align(Alignment.BottomCenter).imePadding().fillMaxWidth().then(if (tall) Modifier.height(height) else Modifier.heightIn(max = height))
            .clip(shape).background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
            .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 20.dp), content = content)
    }
}

/** A sheet's text button (Done, Clear, Back): the tint, 13/600, 44 high. */
@Composable
private fun SheetText(label: String, enabled: Boolean = true, action: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(label, style = rnText(13, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).fade(if (enabled) 1f else 0.5f).padding(horizontal = 10.dp, vertical = 12.dp))
}

/** RN's View options: core's sort chips (a control edit), group chips (core's setFocusGroupBy) and the Show details chip. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ViewOptionsSheet(model: InboxViewModel, controls: JSONObject) = with(model.menu.focusControls) {
    val c = LocalTheme.current.colors
    val view = controls.getJSONObject("view")
    val idle = model.menu.idle
    FocusSheet(model) {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(view.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            SheetText(view.getString("doneLabel")) { keepDialog(null) }
        }
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            val sort = view.getJSONObject("sort")
            SheetLabel(sort.getString("label"))
            ChipFlow(sort.menuObjects("options"), idle) { edit(it) }
            val grouping = view.getJSONObject("group")
            SheetLabel(grouping.getString("label"))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (option in grouping.menuObjects("options")) SheetChip(option.getString("label"), option.getBoolean("selected"), false, enabled = idle) {
                    group(option.getString("value"))
                }
            }
            val details = view.getJSONObject("details")
            SheetLabel(details.getString("sectionLabel"))
            val on = model.focusView.showDetails
            SheetChip(details.getString(if (on) "hideLabel" else "showLabel"), on, false, enabled = true) { model.setFocusDetails(!on) }
        }
    }
}

/**
 * RN's filter sheet for Focus (TaskFilterSheet with no search box) on core's filterSheet: the title with Save (BookmarkPlus, while
 * core says there is something to save) and Clear, the active filters (core's chips, and an applied saved filter's criteria no
 * picker expresses, which ask core's question before they go), the contexts and tags and the projects pickers (core's options,
 * the match modes under the tokens), time estimate, energy level, and more filters (priority and location). Every chip and row
 * sends core's edit; the typed location sends core's setLocation once typing pauses.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FocusFilterSheet(model: InboxViewModel, controls: JSONObject, open: JSONObject) = with(model.menu.focusControls) {
    val c = LocalTheme.current.colors
    val sheet = controls.getJSONObject("filterSheet")
    val text = sheet.getJSONObject("text")
    val visibility = sheet.getJSONObject("visibility")
    val summaries = sheet.getJSONObject("summaries")
    val all = text.getString("all")
    val picker = open.menuText("page")
    val revision = model.focus?.revision ?: return
    val idle = model.menu.idle
    FocusSheet(model, tall = picker != null) {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            if (picker != null) SheetText(text.getString("back")) { page(null) }
            val title = if (picker == null) sheet.getString("title") else text.getString(if (picker == "tokens") "contexts" else "projects")
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            if (picker == null) sheet.optJSONObject("save")?.let { save ->
                val label = save.getString("label")
                val name = save.getJSONObject("dialog").getString("defaultName")
                Row(Modifier.heightIn(min = 44.dp).clearAndSetSemantics { contentDescription = label; role = Role.Button; if (idle) onClick { openSave(name); true } else disabled() }
                    .clickable(enabled = idle) { openSave(name) }.padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Lucide.BookmarkPlus, null, tint = c.tint, modifier = Modifier.size(16.dp))
                    Text(label, style = rnText(13, 600), color = c.tint)
                }
            }
            val clear = sheet.getJSONObject("clear")
            if (clear.getBoolean("visible")) SheetText(clear.getString("label"), idle) { edit(clear.getJSONObject("edit")) }
        }
        if (picker != null) {
            val window = sheet.getJSONObject(picker)
            // RN's picker search: core's matching options (the query from offset zero), read again whenever Focus changes, since a
            // tap changes the options' states.
            val query = open.optString("query")
            val found = pickerFound?.takeIf { it.getString("name") == picker && it.getString("query") == query && it.getString("revision") == revision }
            LaunchedEffect(revision, picker) { if (query.isNotBlank()) searchPicker(picker, query, pickerFound?.optJSONArray("items")?.length() ?: 0) }
            val title = text.getString(if (picker == "tokens") "contexts" else "projects")
            Box(Modifier.padding(bottom = 10.dp)) {
                SheetField(query, text.getString("search"), "${text.getString("search")} $title") { pickerQuery(picker, it) }
            }
            val options = if (query.isBlank()) collection(picker, window, revision) else found?.menuObjects("items").orEmpty()
            val excluded = text.getString("excluded")
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                if (options.isEmpty() && (query.isBlank() || found != null)) Text(text.getString("noResults"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp))
                for (option in options) {
                    val label = option.optString("title").ifEmpty { option.getString("value") }
                    val out = option.optString("state") == "excluded"
                    val on = option.optString("state") == "included" || option.optBoolean("selected")
                    val spoken = if (out) "$label ($excluded)" else label
                    val optionEdit = option.getJSONObject("edit")
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).hairline(c.border, top = false)
                        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; selected = on; if (idle) onClick { edit(optionEdit); true } else disabled() }
                        .clickable(enabled = idle) { edit(optionEdit) }.padding(horizontal = 4.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(label, style = rnText(14, 400, 19).copy(textDecoration = if (out) TextDecoration.LineThrough else null),
                            color = if (out) c.danger else c.text, maxLines = 2, modifier = Modifier.weight(1f))
                        if (on || out) Text(if (out) excluded else text.getString("selected"), style = rnText(12, 600), color = if (out) c.danger else c.tint)
                    }
                }
                if (query.isBlank() && options.size < window.getInt("total")) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { loadMore(picker, window, revision) } }
                if (found != null && options.size < found.getInt("total")) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { searchPicker(picker, query, options.size + 100) } }
                if (picker == "tokens") Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    val modes = sheet.getJSONObject("matchModes")
                    for (kind in listOf("context", "tag")) modes.getJSONObject(kind).takeIf { it.getBoolean("visible") }?.let { mode ->
                        MatchModeRow(mode.getString("label"), mode.menuObjects("options"), idle) { edit(it) }
                    }
                }
            }
        } else {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                val chips = sheet.menuObjects("chips")
                val advanced = sheet.menuObjects("advancedChips")
                if (chips.isNotEmpty() || advanced.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SheetLabel(text.getString("active"))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val remove = text.getString("removeFilter")
                        for (chip in chips) {
                            val label = chip.getString("label")
                            SheetChip(label, true, chip.getBoolean("excluded"), remove = "$remove: $label", enabled = idle) { edit(chip.getJSONObject("edit")) }
                        }
                        for (chip in advanced) {
                            val label = chip.getString("label")
                            SheetChip(label, true, false, remove = "$remove: $label", enabled = idle) { confirmRemove(chip.getString("criterionId"), label) }
                        }
                    }
                }
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    sheet.optJSONObject("taskDates")?.let { dates ->
                        Disclosure(dates.getString("label"), dates.menuObjects("options"), all, open.optBoolean("taskDates"), idle,
                            { toggle("taskDates") }) { edit(it) }
                    }
                    if (sheet.getJSONObject("tokens").getInt("total") > 0) OverviewRow(text.getString("contexts"), summaries.getString("tokens"), all, null) { page("tokens") }
                    if (sheet.getJSONObject("projects").getInt("total") > 0) OverviewRow(text.getString("projects"), summaries.getString("projects"), all, null) { page("projects") }
                    val estimates = sheet.menuObjects("timeEstimates")
                    if (visibility.optBoolean("timeEstimate") && estimates.isNotEmpty()) {
                        Disclosure(text.getString("timeEstimate"), estimates, all, open.optBoolean("time"), idle, { toggle("time") }, summaries.getString("timeEstimates")) { edit(it) }
                    }
                    if (visibility.optBoolean("energyLevel")) {
                        Disclosure(text.getString("energyLevel"), sheet.menuObjects("energyLevels"), all, open.optBoolean("energy"), idle, { toggle("energy") },
                            summaries.getString("energyLevels")) { edit(it) }
                    }
                    if (visibility.optBoolean("priority") || visibility.optBoolean("location")) {
                        OverviewRow(text.getString("more"), summaries.getString("more"), all, open.optBoolean("more")) { toggle("more") }
                        if (open.optBoolean("more")) Column(Modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            if (visibility.optBoolean("priority")) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                SheetLabel(text.getString("priority"))
                                ChipFlow(sheet.menuObjects("priorities"), idle) { edit(it) }
                            }
                            if (visibility.optBoolean("location")) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                SheetLabel(text.getString("location"))
                                SheetField(open.optString("typed:location", sheet.getString("location")), text.getString("locationPlaceholder"), text.getString("location")) {
                                    typeLocation(it)
                                }
                            }
                        }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
            SheetText(sheet.getString("doneLabel")) { keepDialog(null) }
        }
    }
}

/**
 * RN's Save filter dialog: core's title, the name (starting with core's name for the filter), Cancel and Save (off while the name
 * is blank). Save is core's saveFocusFilter with the dialog's request UUID, on disk first; while its retry is owed it re-sends it.
 */
@Composable
private fun SaveFilterDialog(model: InboxViewModel, controls: JSONObject, open: JSONObject) = with(model.menu.focusControls) {
    val theme = LocalTheme.current
    val c = theme.colors
    val text = controls.getJSONObject("filterSheet").optJSONObject("save")?.getJSONObject("dialog") ?: return
    val name = open.optString("text")
    val owed = model.failedAction != null && model.failedAction == saveAction()
    val canSave = name.isNotBlank() && model.writable && !model.busy && (model.failedAction == null || owed)
    Box(Modifier.fillMaxSize().background(theme.scrim).clickable(role = Role.Button) { if (!model.busy && !owed) back() }.imePadding().padding(horizontal = 24.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(14.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp)) {
            Text(text.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
            val field = RoundedCornerShape(8.dp)
            BasicTextField(name, { typeName(it) }, enabled = !owed && !model.busy, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text),
                cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { if (canSave) save() }),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = text.getString("placeholder") },
                decorationBox = { inner ->
                    Box(Modifier.heightIn(min = 44.dp).clip(field).background(c.bg).border(1.dp, c.border, field).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                        if (name.isEmpty()) Text(text.getString("placeholder"), style = rnText(15, 400), color = c.secondaryText)
                        inner()
                    }
                })
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                val cancel = text.getString("cancelLabel")
                Box(Modifier.heightIn(min = 44.dp).widthIn(min = 72.dp).clip(RoundedCornerShape(8.dp))
                    .clearAndSetSemantics { contentDescription = cancel; role = Role.Button; if (!owed && !model.busy) onClick { back(); true } else disabled() }
                    .clickable(enabled = !owed && !model.busy) { back() }.padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                    Text(cancel, style = rnText(14, 700), color = c.secondaryText)
                }
                val saveLabel = text.getString("saveLabel")
                Box(Modifier.heightIn(min = 44.dp).widthIn(min = 72.dp).clip(RoundedCornerShape(8.dp)).background(if (canSave) theme.filledBg else c.filterBg)
                    .clearAndSetSemantics { contentDescription = saveLabel; role = Role.Button; if (canSave) onClick { save(); true } else disabled() }
                    .clickable(enabled = canSave) { save() }.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                    Text(saveLabel, style = rnText(14, 700), color = if (canSave) theme.filledText else c.secondaryText)
                }
            }
        }
    }
}
