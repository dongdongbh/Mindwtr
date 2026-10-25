package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * RN's Trash (app/(drawer)/trash.tsx) on core's getTrashView and runTrashAction: core's counts with Select and Clear Trash,
 * core's retention hint, the bulk bar (Select all, Restore, Delete permanently), core's task and project items with core's
 * type and deleted labels, and core's empty state. A row swipes right to Restore and left to Delete permanently, which asks
 * core's question first, as Clear Trash does (it sends the revision its question showed). Rows open nothing, as in RN.
 */
@Composable
fun TrashList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val c = LocalTheme.current.colors
    val labels = view.getJSONObject("labels")
    val own = own("trash")
    val selecting = own.optBoolean("selecting")
    val selected = view.getJSONObject("selected")
    val tasks = selected.optJSONArray("taskIds").ids()
    val projects = selected.optJSONArray("projectIds").ids()
    // Back leaves selection mode before the screen (RN's trash.tsx); an open dialog takes Back first.
    BackHandler(enabled = selecting && dialog == null && model.failedAction == null) { endSelection(); reload() }
    LazyColumn(Modifier.fillMaxSize().testTag("trash-list"), contentPadding = PaddingValues(bottom = 16.dp)) {
        view.menuText("summary")?.let { summary ->
            item(key = "summary") {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(summary, style = rnText(13, 500), color = c.secondaryText, modifier = Modifier.weight(1f))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SmallButton(labels.getString(if (selecting) "done" else "select"), c.text, idle) {
                            editOwn("trash") { put("selecting", !selecting) }
                            if (selecting) { endSelection(); reload() }
                        }
                        view.optJSONObject("emptyTrash")?.let { clear ->
                            SmallButton(labels.getString("clearAll"), c.secondaryText, idle) {
                                confirm(clear.getJSONObject("confirmation"), emptyTrash(clear.getString("revision")), "trashAction")
                            }
                        }
                    }
                }
            }
        }
        view.menuText("retentionHint")?.let { hint ->
            item(key = "hint") { Text(hint, style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp)) }
        }
        if (selecting) item(key = "bulk") { TrashBulkBar(model, view, tasks, projects) }
        if (shown.items.isEmpty()) view.optJSONObject("empty")?.let { empty ->
            item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Lucide.Trash2, null, tint = c.secondaryText, modifier = Modifier.padding(bottom = 12.dp).size(40.dp))
                    Text(empty.getString("title"), style = rnText(18, 600), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(bottom = 6.dp))
                    Text(empty.getString("message"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center)
                }
            }
        }
        items(shown.items, key = { it.key }) { item ->
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = if (item === shown.items.first()) 16.dp else 0.dp)) {
                TrashItem(model, item, labels, selecting, if (item.row != null) item.row.id in tasks else item.json.getString("id") in projects)
            }
        }
        if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
    }
}

/**
 * RN's trashed task or project: the struck title, core's note preview (a task's), core's type and deleted lines, and the
 * gray bar (a task) or the project's accent bar. While selecting, a tap toggles it and RN's circle shows it.
 */
@Composable
private fun TrashItem(model: InboxViewModel, item: MenuItem, labels: JSONObject, selecting: Boolean, isSelected: Boolean) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val json = item.json
    val row = item.row
    val kind = if (row != null) "task" else "project"
    val id = row?.id ?: json.getString("id")
    val revision = row?.taskRevision ?: json.optString("projectRevision")
    val title = row?.title ?: json.getString("title")
    val confirmation = page?.view?.getJSONObject("confirmations")?.getJSONObject("purgeItem")
    ArchiveSwipe(model, enabled = !selecting && idle, restore = labels.getString("restore"), delete = labels.getString("delete"),
        onRestore = { act("trashAction", restoreItem(kind, id, revision)) },
        onDelete = { confirmation?.let { confirm(it, purgeItem(kind, id, revision), "trashAction") } },
        width = 120.dp, restoreColor = theme.trashRestore) { actions ->
        val shape = RoundedCornerShape(12.dp)
        Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(shape).background(c.taskItemBg)
            .rnBorder(if (selecting && isSelected) 2.dp else 1.dp, if (selecting && isSelected) c.tint else c.border, shape)
            .clickable(enabled = selecting && idle) { toggleTrash(kind, id) }
            .semantics {
                contentDescription = if (selecting) "${labels.getString("select")} $title" else title
                if (selecting) selected = isSelected else customActions = actions
            }.testTag("task-row").padding(16.dp)) {
            if (selecting) {
                Box(Modifier.padding(end = 12.dp).size(22.dp).clip(CircleShape).rnBorder(2.dp, c.tint, CircleShape).background(if (isSelected) c.tint else c.taskItemBg),
                    contentAlignment = Alignment.Center) { if (isSelected) Icon(Lucide.CheckBold, null, tint = c.onTint, modifier = Modifier.size(14.dp)) }
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = rnText(16, 600).copy(textDecoration = TextDecoration.LineThrough), color = c.secondaryText, maxLines = 2,
                    overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 4.dp))
                json.menuText("descriptionMarkdown")?.let {
                    Text(it, style = rnText(14, 400), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 4.dp))
                }
                Text(json.getString("typeLabel"), style = rnText(12, 400).copy(fontStyle = FontStyle.Italic), color = c.secondaryText)
                Text(json.getString("deletedLabel"), style = rnText(12, 400).copy(fontStyle = FontStyle.Italic), color = c.secondaryText)
            }
            val bar: Color? = if (row != null) theme.gray else coreColorOrNull(json.menuText("indicatorColor"))
            bar?.let { Box(Modifier.padding(start = 12.dp).width(4.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(it)) }
        }
    }
}

/** RN's Trash bulk bar: core's count, then Select all, Restore, and Delete permanently (core's question first). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TrashBulkBar(model: InboxViewModel, view: JSONObject, tasks: List<String>, projects: List<String>) = with(model.menu) {
    val c = LocalTheme.current.colors
    val labels = view.getJSONObject("labels")
    val shape = RoundedCornerShape(10.dp)
    val count = tasks.size + projects.size
    Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 4.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(labels.getString("selected"), style = rnText(12, 600), color = c.secondaryText)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val total = view.getInt("total")
            BulkButton(labels.getString("selectAll"), c.text, idle && total > 0 && count != total) { selectAll() }
            BulkButton(labels.getString("restoreSelected"), c.text, idle && count > 0) { act("trashAction", restoreItems(view.getJSONObject("selected"))) }
            BulkButton(labels.getString("deleteSelected"), c.danger, idle && count > 0) {
                confirm(view.getJSONObject("confirmations").getJSONObject("purgeSelection"), purgeItems(view.getJSONObject("selected")), "trashAction")
            }
        }
    }
}

/** One trashed task or project in or out of the selection; core prunes it to the items on screen and counts it. */
private fun MenuModel.toggleTrash(kind: String, id: String) {
    val name = if (kind == "task") "selectedTasks" else "selectedProjects"
    val picked = own("trash").optJSONArray(name).ids()
    editOwn("trash") { put(name, org.json.JSONArray(if (id in picked) picked - id else picked + id)) }
    reload()
}
