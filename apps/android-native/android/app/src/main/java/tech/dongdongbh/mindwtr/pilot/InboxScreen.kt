package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.activity.compose.ReportDrawnWhen
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import org.json.JSONObject

/**
 * RN's Inbox tab (app/(drawer)/(tabs)/inbox.tsx on components/task-list.tsx) on core's getInboxView: RN's inline Sort, Group and
 * Filters controls with the Mind Sweep pill beside them, the active filters with Clear, Process Inbox (Mind Sweep takes its slot
 * while the Inbox is empty), core's "All areas" line, core's headings (a folding one folds, kept on the device under RN's key)
 * and rows, core's empty state, and RN's bulk bar while selecting. The controls scroll with the rows, so landscape shows rows.
 * Mind Sweep opens RN's Mind Sweep (MindSweep.kt). The list is read on every resume and after every command.
 */
@Composable
fun InboxList(model: InboxViewModel, modifier: Modifier) = with(model.menu) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) { owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { refresh() } }
    // Time to first content (scripts/measure-startup-device.mjs): the frame that first draws core's Inbox rows.
    ReportDrawnWhen { page != null }
    // Back closes an open dialog first, then leaves selection mode.
    BackHandler(enabled = model.failedAction == null && (dialog != null || page?.bulk != null)) { if (dialog != null) backInDialog() else endBulk("inbox") }
    val shown = page
    val c = LocalTheme.current.colors
    Column(modifier) {
        BulkBar(model)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(bottom = 12.dp)) {
            val view = shown?.view ?: return@LazyColumn
            item(key = "toolbar") { InboxToolbar(model, view) }
            item(key = "chips") { ActiveChips(model, view.menuObjects("chips")) { filterEdit(view.getJSONObject("filters").getJSONObject("clearEdit")) } }
            item(key = "header") {
                // RN's action row (16 from the edges, 6 under the controls), then the scope line where the rows start.
                Column(Modifier.padding(top = 6.dp)) {
                    Box(Modifier.padding(horizontal = 16.dp)) {
                        view.optJSONObject("process")?.let { ProcessButton(model, it) }
                            ?: view.getJSONObject("mindSweep").let { sweep ->
                                ActionButton(Lucide.Brain, sweep.getString("label"), idle, sweep.getString("accessibilityLabel")) { openMindSweep() }
                            }
                    }
                    Text(view.getString("scopeLabel"), style = rnText(13, 600), color = c.secondaryText, modifier = Modifier.padding(start = 16.dp, bottom = 8.dp))
                }
            }
            if (shown.items.isEmpty()) item(key = "empty") {
                val empty = view.getJSONObject("empty")
                Box(Modifier.padding(horizontal = 12.dp)) {
                    // Core's action: its filter edit (Clear) with filters on, else quick capture.
                    EmptyState(empty.getString("message"), empty.getString("hint").ifEmpty { null }, empty.menuText("actionLabel")) {
                        empty.getJSONObject("action").optJSONObject("filterEdit")?.let(::filterEdit) ?: model.openCapture()
                    }
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

/**
 * RN's TaskListHeader with direct controls (the Inbox's): Sort, Group and Filters as 32 circles in 44 targets, the Filters one
 * in the tint with core's count while filters are on, then the Mind Sweep pill at the right while the Inbox has tasks.
 */
@Composable
private fun InboxToolbar(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val toolbar = view.getJSONObject("toolbar")
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            DirectControl(Lucide.ArrowUpDown, toolbar.getJSONObject("sort").getString("accessibilityLabel"), null, null, idle) { openDialog("sort") }
            DirectControl(Lucide.Folder, toolbar.getJSONObject("group").getString("accessibilityLabel"), null, null, idle) { openDialog("group") }
            val filters = toolbar.getJSONObject("filters")
            DirectControl(Lucide.SlidersHorizontal, filters.getString("accessibilityLabel"), filters.getBoolean("selected"), filters.menuText("countLabel"), idle) {
                openDialog("filters")
            }
        }
        view.getJSONObject("mindSweep").takeIf { it.getString("placement") == "accessory" }?.let { MindSweepPill(it, idle) { openMindSweep() } }
    }
}

/** One direct control: the glyph in a bordered 32 circle (a pill with [count]), the tint while [selected]; one node with label, role and state. */
@Composable
internal fun DirectControl(icon: ImageVector, label: String, selected: Boolean?, count: String?, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val on = selected == true
    Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp)
        .clearAndSetSemantics {
            contentDescription = label; role = Role.Button
            selected?.let { this.selected = it }
            if (enabled) onClick { action(); true } else disabled()
        }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = if (count != null) 6.dp else 0.dp), contentAlignment = Alignment.Center) {
        Row(Modifier.heightIn(min = 32.dp).widthIn(min = 32.dp).clip(CircleShape).background(c.filterBg).border(1.dp, if (on) c.tint else c.border, CircleShape)
            .padding(horizontal = if (count != null) 9.dp else 0.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterHorizontally)) {
            Icon(icon, null, tint = if (on) c.tint else c.secondaryText, modifier = Modifier.size(16.dp))
            count?.let { Text(it, style = rnText(13, 700), color = c.tint) }
        }
    }
}

/** RN's Mind Sweep pill beside the controls (core's label): it opens RN's Mind Sweep. */
@Composable
private fun MindSweepPill(mindSweep: JSONObject, enabled: Boolean, action: () -> Unit) {
    val c = LocalTheme.current.colors
    val label = mindSweep.getString("accessibilityLabel")
    Row(Modifier.fade(if (enabled) 1f else 0.45f).heightIn(min = 36.dp).clip(RoundedCornerShape(18.dp)).background(c.filterBg).border(1.dp, c.border, RoundedCornerShape(18.dp))
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Icon(Lucide.Brain, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        Text(mindSweep.getString("label"), style = rnText(14, 600), color = c.secondaryText, maxLines = 2)
    }
}

/**
 * RN's "Process Inbox (N)": core's label (99+ above 99) and spoken label (the exact count). It opens core's Process Inbox.
 */
@Composable
private fun ProcessButton(model: InboxViewModel, process: JSONObject) = with(model) {
    ActionButton(Lucide.ListChecks, process.getString("label"), writable && !busy && failedAction == null, process.getString("accessibilityLabel")) { openProcessing() }
}

/**
 * RN's primary action row: a tint wash with a tint border (Material 3: the filled container), the glyph, and the label: Process
 * Inbox, or Mind Sweep in this slot (an empty Inbox).
 */
@Composable
private fun ActionButton(icon: ImageVector, label: String, enabled: Boolean, description: String = label, dimmed: Boolean = false, action: () -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shape = RoundedCornerShape(12.dp)
    val material = theme.isMaterial
    Row(Modifier.fade(if (dimmed) 0.45f else 1f).padding(bottom = 12.dp).fillMaxWidth().heightIn(min = 44.dp).clip(shape).background(if (material) theme.filledBg else theme.processWash)
        .then(if (material) Modifier else Modifier.border(1.dp, c.tint, shape))
        .clearAndSetSemantics { contentDescription = description; role = Role.Button; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = if (material) theme.filledText else c.tint, modifier = Modifier.size(18.dp))
        Text(label, style = rnText(15, 600), color = if (material) theme.filledText else c.text, textAlign = TextAlign.Center,
            maxLines = 2, modifier = Modifier.padding(start = 8.dp))
    }
}
