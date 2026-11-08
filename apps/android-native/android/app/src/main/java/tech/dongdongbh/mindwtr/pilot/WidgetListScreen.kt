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


@Composable
fun WidgetList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val c = LocalTheme.current.colors

    PullToRead(Modifier.fillMaxSize(), { done -> refresh(done) }) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
            shown.view.optJSONObject("empty")?.takeIf { shown.items.isEmpty() }?.let { empty ->
                item(key = "empty") {
                    Text(empty.getString("message"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite })
                }
            }
            items(shown.items, key = { it.key }) { item -> item.row?.let { TaskRowItem(model, it, status = RowStatus.Badge, details = true) } }
            if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
        }
    }
}
