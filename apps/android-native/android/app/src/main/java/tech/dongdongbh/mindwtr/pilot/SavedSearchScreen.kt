package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject


@Composable
fun SavedSearchList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().background(c.bg).rnBorderBottom(c.border).padding(16.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(view.getString("title"), style = rnText(20, 700), color = c.text, modifier = Modifier.semantics { heading() })
                view.menuText("query")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }

            view.optJSONObject("sort")?.let { sort ->
                DirectControl(Lucide.ArrowUpDown, sort.getString("accessibilityLabel"), null, null, idle) { openDialog("savedSearchSort") }
            }
            view.optJSONObject("delete")?.let { delete ->
                val label = delete.getString("label")
                val ask = { confirm(delete.getJSONObject("confirm"), JSONObject().put("id", view.getString("id")), "savedSearchDelete") }
                Box(Modifier.padding(start = 8.dp).size(44.dp)
                    .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = "saved-search-delete"; if (idle) onClick { ask(); true } else disabled() }
                    .clickable(enabled = idle) { ask() }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.Trash2, null, tint = c.danger, modifier = Modifier.size(20.dp))
                }
            }
        }

        PullToRead(Modifier.weight(1f).fillMaxWidth(), { done -> refresh(done) }) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp)) {
                view.optJSONObject("empty")?.takeIf { shown.items.isEmpty() }?.let { empty ->
                    item(key = "empty") { EmptyLine(model, empty) }
                }
                items(shown.items, key = { it.key }) { item -> item.row?.let { TaskRowItem(model, it, status = RowStatus.Badge) } }
                if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
            }
        }
    }
}


@Composable
private fun EmptyLine(model: InboxViewModel, empty: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(empty.getString("message"), style = rnText(16, 400), color = c.secondaryText, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        empty.optJSONObject("actions")?.let { actions ->
            Row(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                EmptyAction(actions.getString("inboxLabel"), model.failedAction == null) { closeScreen(); model.show(Screen.Inbox) }
                EmptyAction(actions.getString("backLabel"), model.failedAction == null) { closeScreen() }
            }
        }
    }
}

@Composable
private fun EmptyAction(label: String, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.heightIn(min = 44.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 14.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(label, style = rnText(14, 600), color = c.text)
    }
}
