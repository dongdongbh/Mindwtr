package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * RN's widget list screen (app/(drawer)/widget-list/[id].tsx) on core's getWidgetListView, under RN's stack header with the list's
 * title: every task of the widget's own core list (already filtered and ordered; no in-app filter applies again) as the lists draw
 * them (RN's task row with its status badge; their swipes, status menu and editor are the lists' own commands), read in windows of
 * 50 with More, and RN's empty line ("No results", also for a list that is gone).
 */
@Composable
fun WidgetList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val c = LocalTheme.current.colors
    // RN's pull here reads the list again (a RefreshControl over fetchData), no sync.
    PullToRead(Modifier.fillMaxSize(), { done -> refresh(done) }) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
            shown.view.optJSONObject("empty")?.takeIf { shown.items.isEmpty() }?.let { empty ->
                item(key = "empty") {
                    Text(empty.getString("message"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
            items(shown.items, key = { it.key }) { item -> item.row?.let { TaskRowItem(model, it, status = RowStatus.Badge) } }
            if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
        }
    }
}
