package tech.dongdongbh.mindwtr.pilot

import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import org.json.JSONObject

data class ProjectRow(
    val id: String,
    val title: String,
    val status: String,
    /** Core's status line text (Completed or Cancelled for a closed project). */
    val statusLabel: String,
    val isFocused: Boolean,
    val focusDisabled: Boolean,
    val activeTaskCount: Int,
    val nextActionTitle: String?,
    val focusedWithoutNextAction: Boolean,
    /** Core's revision of the project as the view showed it; the star sends it. */
    val projectRevision: String,
)
data class ProjectGroup(val areaId: String?, val areaName: String?, val areaColor: String?, val areaIcon: String?, val projects: List<ProjectRow>)

/** Core's three buckets, in the order the handoff and mobile show them, with mobile's heading key for each. */
val PROJECT_BUCKETS = listOf("active" to "projects.activeSection", "deferred" to "projects.deferredSection", "archived" to "projects.closed")

/** Core's getProjects reply. Groups, areas, rows, and counts stay exactly as core sent them. */
data class ProjectsView(val buckets: Map<String, List<ProjectGroup>>) {
    fun title(id: String) = buckets.values.firstNotNullOfOrNull { groups ->
        groups.firstNotNullOfOrNull { group -> group.projects.firstOrNull { it.id == id }?.title }
    }

    companion object {
        private fun JSONObject.text(name: String) = if (isNull(name)) null else getString(name)

        fun parse(json: JSONObject): ProjectsView {
            check(json.getInt("version") == 1) { "Unsupported core contract" }
            return ProjectsView(PROJECT_BUCKETS.associate { (bucket, _) ->
                bucket to json.getJSONArray(bucket).let { groups ->
                    List(groups.length()) { index ->
                        groups.getJSONObject(index).let { group ->
                            val rows = group.getJSONArray("projects")
                            ProjectGroup(group.text("areaId"), group.text("areaName"), group.text("areaColor"), group.text("areaIcon"), List(rows.length()) { row ->
                                rows.getJSONObject(row).let {
                                    ProjectRow(it.getString("id"), it.getString("title"), it.getString("status"), it.getString("statusLabel"), it.getBoolean("isFocused"),
                                        it.getBoolean("focusDisabled"), it.getInt("activeTaskCount"), it.text("nextActionTitle"),
                                        it.getBoolean("focusedWithoutNextAction"), it.optString("projectRevision"))
                                }
                            })
                        }
                    }
                }
            })
        }
    }
}

sealed interface DetailItem
data class DetailSection(val id: String, val title: String, val count: Int, val muted: Boolean) : DetailItem
data class DetailTask(val row: TaskRow, val sequenceCue: String?) : DetailItem

/** Core's sequence cue values and mobile's label key for each. */
private val CUE_KEYS = mapOf("available" to "projects.availableNextAction", "later" to "projects.laterInSequence")

/**
 * Core's getProjectDetail windows at one revision: section markers and task rows exactly in core's order, and core's
 * [metadata] for the project's Details (getProjectDetailsPresentation: the summary and every value's label).
 */
data class ProjectDetail(val revision: String, val projectId: String, val readOnly: Boolean, val total: Int, val items: List<DetailItem>,
                         val metadata: JSONObject? = null, val gettingStarted: JSONObject? = null) {
    /** Adds one later window after the items already loaded. */
    fun append(window: JSONObject): ProjectDetail {
        val next = parse(window)
        check(next.revision == revision && next.projectId == projectId) { "Unexpected project window" }
        return next.copy(items = items + next.items)
    }

    companion object {
        fun parse(json: JSONObject): ProjectDetail {
            check(json.getInt("version") == 1) { "Unsupported core contract" }
            val items = json.getJSONArray("items")
            return ProjectDetail(json.getString("revision"), json.getString("projectId"), json.getBoolean("readOnly"),
                json.getInt("total"), metadata = json.optJSONObject("metadata"), gettingStarted = json.optJSONObject("gettingStarted"),
                items = List(items.length()) { index ->
                    items.getJSONObject(index).let { item ->
                        if (item.getString("type") == "section") {
                            DetailSection(item.getString("id"), item.getString("title"), item.getInt("count"), item.getBoolean("muted"))
                        } else {
                            DetailTask(item.getJSONObject("row").taskRow(), if (item.isNull("sequenceCue")) null else item.getString("sequenceCue"))
                        }
                    }
                })
        }
    }
}

/**
 * The Projects tab: core's project list, or the open project's detail. Both are
 * read again on every resume and after every command.
 */
@Composable
fun ProjectsTab(model: InboxViewModel, modifier: Modifier) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) {
        owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { model.refreshProjects() }
    }
    if (model.openProjectId == null) ProjectList(model, modifier) else ProjectDetailList(model, modifier)
}

/**
 * Core's groups as they come, drawn as RN's project list: RN's "Add new project…" field first,
 * then Active, then Someday / Waiting and Closed, which open on a tap and start closed. Each
 * area header has RN's dot and chevron and folds its projects. What is open is kept on the
 * device as RN keeps it.
 */
@Composable
private fun ProjectList(model: InboxViewModel, modifier: Modifier) = with(model) {
    val c = LocalTheme.current.colors
    LazyColumn(modifier, contentPadding = PaddingValues(12.dp)) {
        item(key = "add") { AddProjectField(model) }
        if (projects != null && PROJECT_BUCKETS.all { (bucket, _) -> projects?.buckets?.get(bucket).isNullOrEmpty() }) item(key = "empty") {
            Text(t("projects.empty"), style = rnText(16, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(48.dp))
        }
        var first = true
        for ((bucket, heading) in PROJECT_BUCKETS) {
            val groups = projects?.buckets?.get(bucket).orEmpty()
            if (groups.isEmpty()) continue
            val collapsible = bucket != "active"
            val open = !collapsible || (if (bucket == "deferred") projectsView.showDeferred else projectsView.showArchived)
            val ruled = !first
            first = false
            item(key = "bucket:$bucket") {
                val toggleLabel = t(if (open) "markdown.collapse" else "markdown.expand")
                val title = t(heading)
                // RN's section toggle: 12/700 capitals and a chevron, a rule above all but the first.
                Row(
                    Modifier.fillMaxWidth().then(if (ruled) Modifier.hairline(c.border, top = true) else Modifier)
                        .clearAndSetSemantics {
                            text = AnnotatedString(title)
                            heading()
                            if (collapsible) onClick(label = toggleLabel) { toggle(bucket); true }
                        }
                        .then(if (collapsible) Modifier.clickable(onClickLabel = toggleLabel) { toggle(bucket) } else Modifier)
                        .padding(top = 14.dp, bottom = 10.dp, start = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 0.4f), color = c.secondaryText, modifier = Modifier.weight(1f))
                    if (collapsible) Icon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                }
            }
            if (!open) continue
            for (group in groups) {
                // RN keys a collapsed area by its id, "no-area" without one, the same in every group.
                val areaKey = group.areaId ?: "no-area"
                val folded = areaKey in projectsView.collapsedAreas
                item(key = "area:$bucket:${group.areaId}") { AreaHeader(model, group, areaKey, folded) }
                if (!folded) for (row in group.projects) item(key = "project:${row.id}") { ProjectRowItem(model, row) }
            }
        }
    }
}

/** RN's area header: the area's icon or colored dot, its name in capitals, and a chevron; a tap folds its projects. */
@Composable
private fun AreaHeader(model: InboxViewModel, group: ProjectGroup, areaKey: String, folded: Boolean) {
    val c = LocalTheme.current.colors
    val area = group.areaName ?: t("projects.noArea")
    val toggleLabel = t(if (folded) "markdown.expand" else "markdown.collapse")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp)
            .clearAndSetSemantics {
                text = AnnotatedString(area)
                heading()
                onClick(label = toggleLabel) { model.toggleArea(areaKey); true }
            }
            .clickable { model.toggleArea(areaKey) }.padding(top = 4.dp, bottom = 8.dp, start = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val icon = group.areaIcon
        val dot = coreColorOrNull(group.areaColor)
        if (icon != null) Text(icon, style = rnText(14, 400, 18), color = c.secondaryText, modifier = Modifier.padding(end = 8.dp))
        else if (dot != null) Box(Modifier.padding(end = 8.dp).size(8.dp).clip(CircleShape).background(dot).border(1.dp, c.border, CircleShape))
        Text(area.uppercase(), style = rnText(12, 700, letterSpacing = 0.4f), color = c.secondaryText, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(end = 8.dp))
        Icon(if (folded) Lucide.ChevronRight else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
    }
}

/**
 * RN's "Add new project…" field and its + button; once a title is typed, RN's area chips
 * (No area, then core's areas) choose the new project's area. + runs core's createProject
 * with the draft's request UUID; while its retry is owed the field is locked, and only +
 * (the exact retry) works.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AddProjectField(model: InboxViewModel) = with(model) {
    val c = LocalTheme.current.colors
    val areas = areaFilter?.areas.orEmpty()
    val chosen = projectAreaId ?: areaFilter?.soleArea ?: ""
    val retrying = failedAction?.kind == "createProject"
    val canAdd = writable && !busy && projectDraft.isNotBlank() &&
        (failedAction == null || failedAction == createProjectAction(chosen))
    val placeholder = t("projects.addPlaceholder")
    Column(Modifier.padding(start = 4.dp, end = 4.dp, bottom = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val shape = RoundedCornerShape(8.dp)
            BasicTextField(
                value = projectDraft, onValueChange = model::editProjectDraft, singleLine = true,
                enabled = writable && !busy && !retrying, textStyle = rnText(16, 400).copy(color = c.text),
                cursorBrush = SolidColor(c.tint),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (canAdd) createProject(chosen) }),
                modifier = Modifier.weight(1f).semantics { contentDescription = placeholder },
                decorationBox = { field ->
                    Box(Modifier.clip(shape).background(c.inputBg).border(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 12.dp)) {
                        if (projectDraft.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText, maxLines = 1)
                        field()
                    }
                },
            )
            val add = t("projects.add")
            Box(
                Modifier.fade(if (canAdd) 1f else 0.5f).padding(start = 8.dp).size(46.dp).clip(RoundedCornerShape(8.dp)).background(c.tint)
                    .clickable(enabled = canAdd, role = Role.Button) { createProject(chosen) }
                    .semantics { contentDescription = add },
                contentAlignment = Alignment.Center,
            ) { Icon(Lucide.PlusMedium, null, tint = c.onTint, modifier = Modifier.size(22.dp)) }
        }
        if (projectDraft.isNotBlank() && areas.isNotEmpty()) {
            FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AreaChip(t("projects.noArea"), chosen == "", !retrying) { chooseProjectArea("") }
                for (area in areas) AreaChip(area.label, chosen == area.id, !retrying) { chooseProjectArea(area.id) }
            }
        }
    }
}

/** RN's chip: a pill, filled with the tint when selected. */
@Composable
private fun AreaChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(label, style = rnText(12, 600), color = if (selected) c.onTint else c.text,
        modifier = Modifier.clip(CircleShape).background(if (selected) c.tint else c.cardBg).border(1.dp, if (selected) c.tint else c.border, CircleShape)
            .selectable(selected = selected, enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp))
}

/**
 * RN's project row: the title; core's next action, its "No next action" warning, or the
 * project's status in RN's status color; then core's active task count and RN's star. The
 * star asks core for the other state, dimmed and disabled when core says five are starred.
 */
@Composable
private fun ProjectRowItem(model: InboxViewModel, row: ProjectRow) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val count = "${row.activeTaskCount} ${t("common.tasks")}"
    val view = LocalView.current
    Row(
        Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(8.dp)).background(c.cardBg)
            .heightIn(min = 52.dp).padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).clickable(enabled = writable && !busy && failedAction == null, role = Role.Button) { openProject(row.id) }) {
            Text(row.title, style = rnText(16, 500), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(bottom = 4.dp))
            if (row.nextActionTitle != null) {
                Text("↳ ${row.nextActionTitle}", style = rnText(12, 400), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis)
            } else if (row.focusedWithoutNextAction) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Lucide.TriangleAlert, null, tint = theme.attention, modifier = Modifier.size(12.dp))
                    Text(t("projects.noNextAction"), style = rnText(12, 400), color = theme.attention, modifier = Modifier.padding(start = 4.dp))
                }
            } else {
                val color = when (row.status) {
                    "active" -> c.tint
                    "waiting" -> theme.projectWaiting
                    "someday" -> theme.projectSomeday
                    else -> c.secondaryText
                }
                Text(row.statusLabel, style = rnText(12, 400), color = color)
            }
        }
        Text("${row.activeTaskCount}", style = rnText(12, 600, 16), color = c.secondaryText, textAlign = TextAlign.End,
            modifier = Modifier.padding(start = 8.dp).widthIn(min = 20.dp).semantics { contentDescription = count })
        val disabled = row.focusDisabled && !row.isFocused
        val enabled = !disabled && writable && !busy && (failedAction == null || failedAction == projectFocusAction(row.id, !row.isFocused, row.projectRevision))
        val label = t(if (row.isFocused) "projects.removeFromFocus" else "projects.addToFocus")
        FocusStar(row.isFocused, disabled, 18, Modifier.padding(end = 4.dp).size(44.dp)
            .clickable(enabled = enabled, role = Role.Button) {
                view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                setProjectFocus(row.id, !row.isFocused, row.projectRevision)
            }
            .semantics { contentDescription = label; selected = row.isFocused; if (disabled) disabled() })
    }
}

/**
 * One project as core lists it, under RN's project header (Back and the title):
 * section markers and task rows in core's order, with core's titles and counts.
 * A read-only (archived) project shows no Complete.
 */
@Composable
private fun ProjectDetailList(model: InboxViewModel, modifier: Modifier) = with(model) {
    // While a failed command's retry is owed, Back is left to the system, as on the lists and in the editor.
    BackHandler(enabled = failedAction == null) { closeProject() }
    val c = LocalTheme.current.colors
    val detail = project
    val completable = detail?.readOnly == false
    LaunchedEffect(openProjectId) { projectDetails.follow(openProjectId) }
    DisposableEffect(Unit) { onDispose { projectDetails.closeOverlays() } }
    Column(modifier) {
        Row(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically) {
            val back = t("common.back")
            IconButton(onClick = model::closeProject, enabled = failedAction == null, modifier = Modifier.semantics { contentDescription = back }) {
                Icon(Lucide.ChevronLeft, null, tint = c.tint, modifier = Modifier.size(24.dp))
            }
            ProjectTitleField(model, projects?.title(openProjectId.orEmpty()).orEmpty(), detail?.readOnly != false, Modifier.weight(1f).padding(start = 8.dp))
            // RN's project actions button (projectHeaderActionButton): the "..." that opens Duplicate, Complete, Cancel and Delete.
            val actionsLabel = t("projects.actionsLabel")
            val actionsShape = RoundedCornerShape(10.dp)
            Box(Modifier.padding(start = 8.dp).size(38.dp).clip(actionsShape).background(c.filterBg).border(1.dp, c.border, actionsShape)
                .clickable(enabled = writable && detail != null && failedAction == null, role = Role.Button) { projectDetails.openActions() }
                .semantics { contentDescription = actionsLabel }.testTag("project-actions-menu-button"), contentAlignment = Alignment.Center) {
                Icon(Ionicons.EllipsisHorizontal, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
            }
        }
        // RN's KeyboardAvoidingView: the open keyboard shortens the list, so a focused Details field scrolls into view.
        LazyColumn(Modifier.weight(1f).background(c.bg).imePadding(), contentPadding = PaddingValues(12.dp)) {
            // RN's Details toggle and panel (its Attachments card inside), scrolling away with the rows as RN's list header.
            openProjectId?.let { id -> projectDetailsItems(model, id, detail) }
            for (entry in detail?.items.orEmpty()) when (entry) {
                is DetailSection -> item(key = "section:${entry.id}") {
                    SectionTitle(entry.title, entry.count,
                        Modifier.fillMaxWidth().fade(if (entry.muted) 0.6f else 1f).padding(top = 12.dp, bottom = 8.dp, start = 4.dp))
                }
                is DetailTask -> item(key = "task:${entry.row.id}") {
                    TaskRowItem(model, entry.row, status = RowStatus.Badge, completable = completable,
                        note = entry.sequenceCue?.let(CUE_KEYS::get)?.let(::t), available = entry.sequenceCue == "available")
                }
            }
            if (detail != null && detail.items.size < detail.total) item(key = "more") {
                Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                    PillButton(t("common.more"), onClick = model::loadMoreProject, enabled = writable && !busy && failedAction == null)
                }
            }
        }
    }
}
