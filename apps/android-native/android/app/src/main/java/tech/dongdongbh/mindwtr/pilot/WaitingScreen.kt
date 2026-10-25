package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/**
 * RN's Waiting For (components/views/waiting-view.tsx) on core's getWaitingView: core's two stats, the person filter
 * (core's All, each person core offers, and Clear while one is chosen), the parked projects, core's rows with their detail
 * parts (Waiting shows them) and RN's status glyph (a long-press starts selection mode, core's bulk bar), and core's empty
 * state. The stats and the filter scroll with the rows, as every list here does, so landscape shows rows.
 */
@Composable
fun WaitingList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val theme = LocalTheme.current
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        item(key = "stats") { StatBar(view.getJSONArray("stats"), theme.waitingStat) }
        item(key = "people") { PersonFilter(model, shown) }
        item(key = "deferred") { Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) { DeferredProjects(model, shown) } }
        val empty = view.optJSONObject("empty")
        if (shown.items.isEmpty() && empty != null) item(key = "empty") {
            IconEmptyState(Lucide.CirclePauseThin, empty.getString("title"), empty.getString("hint"))
        }
        items(shown.items, key = { it.key }) { item ->
            Box(Modifier.padding(horizontal = 16.dp)) { item.row?.let { TaskRowItem(model, it, status = RowStatus.Icon, details = true, actions = bulkRow(it)) } }
        }
        if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
    }
}

/** RN's person filter: core's label, then All and each person as RN's pills (the tint when chosen), then core's Clear. */
@Composable
private fun PersonFilter(model: InboxViewModel, shown: MenuPage) = with(model.menu) {
    val c = LocalTheme.current.colors
    val view = shown.view
    Column(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(view.getString("filterLabel"), style = rnText(12, 600), color = c.secondaryText)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            val all = view.getJSONObject("all")
            PersonChip(all.getString("label"), all.getBoolean("selected"), idle) { person("") }
            for (entry in shown.collection("people")) {
                PersonChip(entry.getString("label"), entry.getBoolean("selected"), idle) { person(entry.getString("person")) }
            }
            if (shown.collection("people").size < shown.collectionTotal("people")) MoreChip(idle) { loadCollection("people") }
        }
        view.menuText("clearLabel")?.let { clear ->
            val shape = RoundedCornerShape(8.dp)
            Text(clear, style = rnText(12, 600), color = c.text, modifier = Modifier.clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
                .clickable(enabled = idle, role = Role.Button) { person("") }.padding(horizontal = 8.dp, vertical = 4.dp))
        }
    }
}

@Composable
private fun PersonChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(label, style = rnText(12, 600), color = if (selected) c.onTint else c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.widthIn(max = 180.dp).clip(CircleShape).background(if (selected) c.tint else c.filterBg).rnBorder(1.dp, c.border, CircleShape)
            .semantics { contentDescription = label }.selectable(selected = selected, enabled = enabled, role = Role.Tab, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp))
}
