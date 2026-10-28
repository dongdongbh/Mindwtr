package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

/**
 * RN's task list for Reference (app/(drawer)/reference.tsx) and History's Done (done.tsx), on core's getReferenceView and
 * getDoneView: the "Filters · N" button and the active chips with Clear under the header (whose list menu holds Filters,
 * Sort and Group), core's headings (folding ones fold, kept on the device as RN keeps them), core's rows with RN's status
 * glyph, read-only rows (an archived project's) without a swipe or selection, a long-press that starts selection mode
 * (core's bulk bar), and core's empty state with its Clear.
 */
@Composable
fun StatusList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val clear = view.getJSONObject("filters").getJSONObject("clearEdit")
    // RN's pull down to sync (TaskList, 5bb0ea8f).
    PullToSync(model, Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
            if (view.getBoolean("hasActiveFilters")) item(key = "filters") {
                Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 6.dp)) {
                    ActiveFiltersButton("${t("filters.label")} · ${view.getInt("filterActiveCount")}", idle) { openDialog("filters") }
                }
            }
            item(key = "chips") { ActiveChips(model, view.menuObjects("chips")) { filterEdit(clear) } }
            if (shown.items.isEmpty()) item(key = "empty") {
                val empty = view.getJSONObject("empty")
                Box(Modifier.padding(12.dp)) {
                    EmptyState(empty.getString("message"), empty.getString("hint").ifEmpty { null }, empty.menuText("actionLabel")) { filterEdit(clear) }
                }
            }
            items(shown.items, key = { it.key }) { item ->
                Box(Modifier.padding(horizontal = 12.dp)) {
                    val row = item.row
                    if (row == null) GroupHeading(model, item.json)
                    else {
                        val readOnly = item.json.getJSONObject("row").optBoolean("readOnly")
                        TaskRowItem(model, row, status = RowStatus.Icon, completable = !readOnly, actions = bulkRow(row, readOnly))
                    }
                }
            }
            if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
        }
    }
}

/** RN's History tab bar: core's two tabs, the selected one in the tint over a 2 underline. */
@Composable
fun HistoryTabs(model: InboxViewModel) = with(model.menu) {
    val tabs = history?.menuObjects("tabs") ?: return
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 12.dp)) {
        for (tab in tabs) {
            val id = tab.getString("id")
            val selected = id == historyTab
            Box(Modifier.weight(1f).heightIn(min = 44.dp).selectable(selected = selected, enabled = model.failedAction == null && !model.busy, role = Role.Tab) { showTab(id) }
                .drawBehind { if (selected) drawLine(c.tint, Offset(0f, size.height - 1.dp.toPx()), Offset(size.width, size.height - 1.dp.toPx()), 2.dp.toPx()) }
                .padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
                Text(tab.getString("label"), style = rnText(14, 700), color = if (selected) c.tint else c.secondaryText)
            }
        }
    }
}
