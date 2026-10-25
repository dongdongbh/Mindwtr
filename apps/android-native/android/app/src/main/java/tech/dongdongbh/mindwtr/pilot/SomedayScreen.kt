package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * RN's Someday/Maybe (components/views/someday-view.tsx) on core's getSomedayView: core's stats with the filter summary
 * chip (its X clears the filters) and RN's list menu (Filters, Sort, Group, Details, New section…, all core's), the
 * parked projects, core's headings with their Add task, core's rows (their detail parts when Details is on) whose status
 * menu offers Move to section… (a long-press starts selection mode, core's bulk bar with its own Move to section…), the
 * parked projects inside their section groups when core groups by section (#1319), and core's empty state.
 */
@Composable
fun SomedayList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val theme = LocalTheme.current
    val details = view.getBoolean("showDetails")
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 16.dp)) {
        item(key = "stats") {
            StatBar(view.getJSONArray("stats"), theme.somedayStat) {
                view.optJSONObject("filterChip")?.let { chip -> SummaryChip(chip, idle) { filterEdit(view.getJSONObject("filters").getJSONObject("clearEdit")) } }
                Spacer(Modifier.weight(1f))
                OverflowTrigger(enabled = idle) { openDialog("overflow") }
            }
        }
        item(key = "deferred") { Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp)) { DeferredProjects(model, shown) } }
        val empty = view.optJSONObject("empty")
        if (shown.items.isEmpty() && empty != null) item(key = "empty") {
            if (empty.getBoolean("clear")) {
                Box(Modifier.padding(16.dp)) {
                    EmptyState(empty.getString("title"), empty.getString("hint").ifEmpty { null }, t("filters.clear")) {
                        filterEdit(view.getJSONObject("filters").getJSONObject("clearEdit"))
                    }
                }
            } else {
                IconEmptyState(Lucide.LightbulbThin, empty.getString("title"), empty.getString("hint"))
            }
        }
        items(shown.items, key = { it.key }) { item ->
            Box(Modifier.padding(horizontal = 16.dp)) {
                val row = item.row
                when {
                    row != null -> TaskRowItem(model, row, status = RowStatus.Icon, details = details, actions = bulkRow(row))
                    // A parked project in its section, before the section's tasks (#1319); RN's sectionProjectRow adds 8 below.
                    item.type == "project" -> Box(Modifier.padding(bottom = 8.dp)) {
                        ParkedProject(model, item.json.getJSONObject("project"), item.json.getString("activateLabel"))
                    }
                    else -> Heading(model, item.json)
                }
            }
        }
        if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
    }
}

/** RN's group heading (TaskListView): the title at 13/700, muted for "No section", and core's Add task for a section. */
@Composable
private fun Heading(model: InboxViewModel, heading: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val muted = heading.optBoolean("muted")
    Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(heading.getString("title"), style = rnText(13, 700, letterSpacing = 0.4f), color = if (muted) c.secondaryText else c.text,
            modifier = Modifier.weight(1f).semantics { heading() })
        heading.optJSONObject("addTask")?.let { addTask ->
            val label = addTask.getString("accessibilityLabel")
            Box(Modifier.heightIn(min = 44.dp).clickable(enabled = idle, role = Role.Button) { openAddTask(heading) }
                .semantics { contentDescription = label }.padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                Text(addTask.getString("label"), style = rnText(14, 400), color = c.tint)
            }
        }
    }
}

/** RN's removable FilterChip beside the stats: core's "Filters · N" on the tint; its X (core's remove label) clears the filters. */
@Composable
private fun SummaryChip(chip: JSONObject, enabled: Boolean, onClear: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(22.dp)
    Row(Modifier.heightIn(min = 44.dp).clip(shape).background(c.tint).rnBorder(1.dp, c.tint, shape).padding(start = 10.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(chip.getString("label"), style = rnText(12, 600), color = c.onTint)
        val remove = chip.getString("removeLabel")
        Box(Modifier.size(28.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClear).semantics { contentDescription = remove },
            contentAlignment = Alignment.Center) { Icon(Lucide.X, null, tint = c.onTint, modifier = Modifier.size(16.dp)) }
    }
}
