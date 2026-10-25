package tech.dongdongbh.mindwtr.pilot

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/**
 * RN's Review (app/(drawer)/review.tsx), as a stack screen or the quick-access tab, on core's getReviewOverview (with its
 * scope) and runReviewAction: the Due and All scope buttons with core's help, the expansion button and Start Review, the bulk
 * bar while rows are selected (core's actions and its Organize dialog), and core's areas, projects and task rows as far as they
 * are expanded, each row due for review with Mark reviewed and Review in 1 week. Back leaves selection first, as in RN.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReviewList(model: InboxViewModel) = with(model.menu) {
    val shown = page ?: return
    val view = shown.view
    val theme = LocalTheme.current
    val c = theme.colors
    val bulk = view.optJSONObject("bulk")
    val selected = bulk?.optJSONArray("selectedIds").ids()
    val scope = view.optJSONObject("scope")
    val due = scope?.optString("selected") == "due"
    BackHandler(enabled = bulk != null && dialog == null && model.failedAction == null) { endSelection(); reload() }
    LazyColumn(Modifier.fillMaxSize().testTag("review-list"), contentPadding = PaddingValues(bottom = 16.dp)) {
        scope?.let {
            item(key = "scope") {
                FlowRow(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (option in it.menuObjects("options")) {
                        val on = option.getString("id") == it.getString("selected")
                        Box(Modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(8.dp)).background(if (on) c.tint else c.filterBg)
                            .selectable(selected = on, enabled = idle, role = Role.Button) { if (!on) reviewScope(option.getString("id")) }
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                            contentAlignment = Alignment.Center) {
                            Text(option.getString("label"), style = rnText(14, 400), color = if (on) c.onTint else c.text)
                        }
                    }
                    // RN's All scope links to History's Done list.
                    if (!due) Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).clickable(enabled = idle, role = Role.Button) { openRoute("/done") }
                        .semantics { contentDescription = "${t("nav.done")} ${t("common.tasks")}" }, contentAlignment = Alignment.Center) {
                        Text(t("nav.done"), style = rnText(14, 400), color = c.tint)
                    }
                    Text(it.getString("help"), style = rnText(12, 400), color = c.secondaryText, modifier = Modifier.fillMaxWidth())
                }
            }
        }
        if (bulk == null) item(key = "actions") {
            Row(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                val expansion = view.getJSONObject("expansion")
                val off = expansion.getBoolean("disabled")
                val shape = RoundedCornerShape(10.dp)
                val label = expansion.getString("label")
                Box(Modifier.fade(if (off) 0.45f else 1f).size(42.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
                    .clickable(enabled = idle && !off, role = Role.Button) { reviewExpansion(JSONObject().put("type", "cycle")) }
                    .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
                    Icon(if (expansion.getBoolean("allExpanded")) Lucide.ChevronsUp else Lucide.ChevronsDown, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
                }
                val start = view.getJSONObject("startReview")
                Box(Modifier.widthIn(min = 152.dp).heightIn(min = 42.dp).clip(shape).background(theme.filledBg)
                    .clickable(enabled = idle, role = Role.Button) { openDialog("startReview") }.padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                    Text(start.getString("label"), style = rnText(15, 800), color = theme.filledText, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        bulk?.let { bar -> item(key = "bulk") { ReviewBulkBar(model, bar, selected) } }
        if (shown.items.isEmpty()) view.menuText("empty")?.let { empty ->
            item(key = "empty") {
                Text(empty, style = rnText(16, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(32.dp))
            }
        }
        items(shown.items, key = { it.key }) { item ->
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = if (item === shown.items.first()) 16.dp else 0.dp)) {
                when (item.type) {
                    "area" -> ReviewArea(model, item.json)
                    "project" -> ReviewProject(model, item.json)
                    else -> item.row?.let { row ->
                        Column(Modifier.padding(start = 30.dp, top = 8.dp)) {
                            TaskRowItem(model, row, status = RowStatus.Badge, actions = RowActions(
                                status = { status -> act("reviewAction", setTaskStatus(row.id, status, row.taskRevision)) },
                                delete = { act("reviewAction", trashTask(row.id, row.taskRevision)) },
                                selecting = bulk != null, selected = row.id in selected, select = { toggleRow("review", row.id) },
                            ))
                            // RN's Mark reviewed and Review in 1 week under every row due for review, in either scope: core's two actions.
                            item.json.optJSONObject("review")?.let { review ->
                                Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                                    for (name in listOf("markReviewed", "advance")) {
                                        val link = review.getJSONObject(name)
                                        ReviewLink(link.getString("label"), link.getString("accessibilityLabel"), idle, "review-$name") { act("reviewAction", link.getJSONObject("action")) }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if (shown.items.size < shown.total) item(key = "more") { MoreRow(model) }
    }
}

/** RN's Review text button (Mark reviewed, Review in 1 week): 44 high, the tint; a disabled one is dimmed and TalkBack hears it is unavailable. */
@Composable
private fun ReviewLink(label: String, description: String, enabled: Boolean, tag: String, action: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp)
        .clearAndSetSemantics { contentDescription = description; role = Role.Button; testTag = tag; if (enabled) onClick { action(); true } else disabled() }
        .clickable(enabled = enabled, onClick = action).fade(if (enabled) 1f else 0.45f), contentAlignment = Alignment.CenterStart) {
        Text(label, style = rnText(14, 400), color = c.tint)
    }
}

/** RN's area header: core's color dot (the tint without one), title, summary, and the chevron; a tap folds it (core's toggle). */
@Composable
private fun ReviewArea(model: InboxViewModel, area: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val expanded = area.getBoolean("expanded")
    Row(Modifier.fillMaxWidth().padding(bottom = 6.dp).hairline(c.border, top = false)
        .clickable(enabled = idle, role = Role.Button) { reviewExpansion(JSONObject().put("type", "toggleArea").put("id", area.getString("id"))) }
        .semantics { contentDescription = area.getString("accessibilityLabel"); stateDescription = t(if (expanded) "markdown.collapse" else "markdown.expand") }
        .padding(horizontal = 4.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.padding(end = 10.dp).size(8.dp).clip(CircleShape).background(coreColorOrNull(area.menuText("color")) ?: c.tint))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(area.getString("title"), style = rnText(16, 700), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(area.getString("summary"), style = rnText(12, 500, 17), color = c.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Icon(if (expanded) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
    }
}

/** RN's project group header: title, chevron, core's status dot and summary (amber when core says it needs action). */
@Composable
private fun ReviewProject(model: InboxViewModel, project: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val expanded = project.getBoolean("expanded")
    Column(Modifier.padding(start = 26.dp).fillMaxWidth().hairline(c.border, top = false)
        .clickable(enabled = idle, role = Role.Button) { reviewExpansion(JSONObject().put("type", "toggleProject").put("id", project.getString("id"))) }
        .semantics { contentDescription = project.getString("accessibilityLabel"); stateDescription = t(if (expanded) "markdown.collapse" else "markdown.expand") }
        .padding(horizontal = 4.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(project.getString("title"), style = rnText(15, 700), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Icon(if (expanded) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(17.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            theme.tone(project.menuText("statusTone"))?.let { Box(Modifier.size(7.dp).clip(CircleShape).background(it)) }
            val tone = if (project.getString("summaryTone") == "warning") c.warning else c.secondaryText
            Text(project.getString("summary"), style = rnText(12, 500, 17), color = tone,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
    }
}

/**
 * RN's Review bulk bar: core's count and Cancel, then core's actions in core's order. Organize opens the lists' Bulk organize
 * dialog on Review's own bar (core's `bulk.organize`); Mark reviewed sends the revisions the bar showed.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReviewBulkBar(model: InboxViewModel, bulk: JSONObject, selected: List<String>) = with(model.menu) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
            Text(bulk.getString("countLabel"), style = rnText(12, 600), color = c.secondaryText)
            Text(bulk.getString("cancelLabel"), style = rnText(12, 700), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                .clickable(role = Role.Button) { endSelection(); reload() }.padding(horizontal = 6.dp, vertical = 12.dp))
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            for (action in bulk.menuObjects("actions")) {
                val id = action.getString("id")
                val filled = id == "organize" || id == "markReviewed"
                val on = idle && action.getBoolean("enabled") && selected.isNotEmpty()
                Text(action.getString("label"), style = rnText(12, 600), color = if (filled) c.onTint else c.text,
                    modifier = Modifier.fade(if (on) 1f else 0.5f).clip(RoundedCornerShape(6.dp)).background(if (filled) c.tint else c.filterBg)
                        .clickable(enabled = on, role = Role.Button) {
                            when (id) {
                                "organize" -> openOrganize()
                                "moveTo" -> openDialog("reviewMove")
                                "markReviewed" -> act("reviewAction", markReviewedTasks(selected, bulk.getJSONObject("taskRevisions")))
                                "addTag" -> keepDialog(JSONObject().put("kind", "reviewTag").put("text", ""))
                                "removeTag" -> keepDialog(JSONObject().put("kind", "tokens").put("list", "review").put("picked", org.json.JSONArray()))
                                "share" -> {
                                    // RN's Share.share with core's text, then it leaves selection mode.
                                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, bulk.getString("shareText"))
                                    runCatching { context.startActivity(Intent.createChooser(send, null)) }.onSuccess { endSelection(); reload() }
                                }
                                "delete" -> confirm(bulk.getJSONObject("deleteConfirmation"), trashTasks(selected, bulk.getJSONObject("taskRevisions")), "reviewAction")
                            }
                        }.semantics { if (!on) disabled() }.padding(horizontal = 10.dp, vertical = 6.dp))
            }
        }
    }
}

/**
 * Review's modals, RN's centered cards over a dimmed screen: Start Review (core's Daily and Weekly choices and Cancel), Move to
 * (core's statuses), and Add tag (the typed tag, Cancel and Save).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ReviewDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val view = page?.view ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    val kind = open.getString("kind")
    val bulk = view.optJSONObject("bulk")
    val selected = bulk?.optJSONArray("selectedIds").ids()
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button) { keepDialog(null) }.imePadding().padding(20.dp),
        contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.cardBg).pointerInput(Unit) { detectTapGestures { } }
            .padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            val cancel: String
            when (kind) {
                "startReview" -> {
                    val start = view.getJSONObject("startReview")
                    cancel = start.getString("cancelLabel")
                    ModalTitle(start.getString("label"))
                    for (option in start.menuObjects("options")) {
                        val shape = RoundedCornerShape(10.dp)
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
                            .clickable(role = Role.Button) { keepDialog(null); openReview(option.getString("id")) }.padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(option.getString("label"), style = rnText(15, 700), color = c.text, modifier = Modifier.weight(1f))
                            Icon(Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
                        }
                    }
                }
                "reviewMove" -> {
                    val move = bulk ?: return@Column
                    cancel = move.getString("cancelLabel")
                    ModalTitle(move.menuObjects("actions").firstOrNull { it.getString("id") == "moveTo" }?.getString("label").orEmpty())
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (status in move.menuObjects("statuses")) {
                            val shape = RoundedCornerShape(10.dp)
                            Text(status.getString("label"), style = rnText(12, 600), color = c.text, modifier = Modifier.clip(shape).background(c.filterBg)
                                .rnBorder(1.dp, c.border, shape).clickable(enabled = idle && selected.isNotEmpty(), role = Role.Button) {
                                    keepDialog(null)
                                    act("reviewAction", moveTasks(selected, status.getString("status"), move.getJSONObject("taskRevisions")))
                                }.padding(horizontal = 10.dp, vertical = 8.dp))
                        }
                    }
                }
                else -> {
                    val tag = bulk?.getJSONObject("addTag") ?: return@Column
                    cancel = tag.getString("cancelLabel")
                    ModalTitle(tag.getString("title"))
                    val text = open.optString("text")
                    val shape = RoundedCornerShape(8.dp)
                    BasicTextField(text, { keepDialog(JSONObject(open.toString()).put("text", it)) }, singleLine = true,
                        textStyle = rnText(14, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = tag.getString("placeholder") }.testTag("menu-dialog-field"),
                        decorationBox = { inner ->
                            Box(Modifier.heightIn(min = 40.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 8.dp),
                                contentAlignment = Alignment.CenterStart) {
                                if (text.isEmpty()) Text(tag.getString("placeholder"), style = rnText(14, 400), color = c.secondaryText)
                                inner()
                            }
                        })
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                Text(cancel, style = rnText(14, 600), color = c.secondaryText, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { keepDialog(null) }.padding(horizontal = 12.dp, vertical = 12.dp))
                if (kind == "reviewTag") {
                    val tag = bulk?.getJSONObject("addTag")
                    val value = open.optString("text").trim()
                    val can = idle && value.isNotEmpty() && selected.isNotEmpty()
                    Text(tag?.getString("saveLabel").orEmpty(), style = rnText(14, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                        .clickable(enabled = can, role = Role.Button) { keepDialog(null); act("reviewAction", addTag(selected, value, bulk?.optJSONObject("taskRevisions") ?: JSONObject())) }
                        .fade(if (can) 1f else 0.5f).padding(horizontal = 12.dp, vertical = 12.dp))
                }
            }
        }
    }
}

@Composable
private fun ModalTitle(text: String) = Text(text, style = rnText(16, 700), color = LocalTheme.current.colors.text, textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth().semantics { heading() })

/** Review's scope (core's option id): RN leaves selection mode first. */
private fun MenuModel.reviewScope(id: String) {
    editOwn("review") { put("scope", id).put("selected", org.json.JSONArray()) }
    reload()
}

/** An expansion control's edit (RN's cycle, and an area's or project's fold): core applies it and answers the new expansion. */
private fun MenuModel.reviewExpansion(edit: JSONObject) = reload(edit)
