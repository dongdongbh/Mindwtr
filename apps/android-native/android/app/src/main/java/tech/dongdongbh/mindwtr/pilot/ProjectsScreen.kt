package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.CustomAccessibilityAction
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.stateDescription
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
import org.json.JSONArray
import org.json.JSONObject

data class ProjectRow(
    val id: String,
    val title: String,
    val status: String,

    val statusLabel: String,
    val isFocused: Boolean,
    val focusDisabled: Boolean,
    val activeTaskCount: Int,
    val nextActionTitle: String?,
    val focusedWithoutNextAction: Boolean,

    val projectRevision: String,
)
data class ProjectGroup(val areaId: String?, val areaName: String?, val areaColor: String?, val areaIcon: String?, val projects: List<ProjectRow>)


val PROJECT_BUCKETS = listOf("active" to "projects.activeSection", "deferred" to "projects.deferredSection", "archived" to "projects.closed")


data class ProjectsView(val buckets: Map<String, List<ProjectGroup>>, val moves: Map<String, Pair<Boolean, Boolean>> = emptyMap()) {
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
            }, json.optJSONObject("moves")?.let { moves -> moves.keys().asSequence().associateWith { id ->
                moves.getJSONObject(id).let { it.getBoolean("up") to it.getBoolean("down") } } }.orEmpty())
        }
    }
}

sealed interface DetailItem

data class DetailSection(val id: String, val title: String, val count: Int, val muted: Boolean, val collapsible: Boolean = false,
                         val collapsed: Boolean = false, val flowLabel: String? = null) : DetailItem
data class DetailTask(val row: TaskRow, val sequenceCue: String?) : DetailItem


private val CUE_KEYS = mapOf("available" to "projects.availableNextAction", "later" to "projects.laterInSequence")


data class ProjectDetail(val revision: String, val projectId: String, val readOnly: Boolean, val total: Int, val items: List<DetailItem>,
                         val metadata: JSONObject? = null, val gettingStarted: JSONObject? = null, val controls: JSONObject? = null,

                         val listFilters: JSONObject? = null) {

    fun append(window: JSONObject): ProjectDetail {
        val next = parse(window)
        check(next.revision == revision && next.projectId == projectId) { "Unexpected project window" }
        return next.copy(items = items + next.items, listFilters = listFilters ?: next.listFilters)
    }

    companion object {
        fun parse(json: JSONObject): ProjectDetail {
            check(json.getInt("version") == 1) { "Unsupported core contract" }
            val items = json.getJSONArray("items")
            return ProjectDetail(json.getString("revision"), json.getString("projectId"), json.getBoolean("readOnly"),
                json.getInt("total"), metadata = json.optJSONObject("metadata"), gettingStarted = json.optJSONObject("gettingStarted"),
                controls = json.optJSONObject("controls"),
                listFilters = json.optJSONObject("filters")?.let { filters -> JSONObject().put("filters", filters).put("chips", json.optJSONArray("chips") ?: JSONArray())
                    .put("filterButtonLabel", json.optString("filterButtonLabel")).put("empty", json.opt("empty") ?: JSONObject.NULL) },
                items = List(items.length()) { index ->
                    items.getJSONObject(index).let { item ->
                        if (item.getString("type") == "section") {
                            DetailSection(item.getString("id"), item.getString("title"), item.getInt("count"), item.getBoolean("muted"),
                                item.optBoolean("collapsible"), item.optBoolean("collapsed"), item.menuText("flowLabel"))
                        } else {
                            DetailTask(item.getJSONObject("row").taskRow(), if (item.isNull("sequenceCue")) null else item.getString("sequenceCue"))
                        }
                    }
                })
        }
    }
}


@Composable
fun ProjectsTab(model: InboxViewModel, modifier: Modifier) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) {
        owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { model.refreshProjects() }
    }

    ReadAgainAt(model.project?.takeIf { model.openProjectId != null }?.let { open -> clockReadAt(open.items.map { (it as? DetailTask)?.row }) }) {
        model.refreshProjects()
    }
    if (model.openProjectId == null) ProjectList(model, modifier) else ProjectDetailList(model, modifier)
}


@Composable
private fun CompletedHeading(entry: DetailSection, enabled: Boolean, toggle: () -> Unit) {
    val c = LocalTheme.current.colors
    val open = !entry.collapsed
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = toggle)
        .semantics { stateDescription = t(if (open) "markdown.collapse" else "markdown.expand") }
        .padding(start = 6.dp, end = 6.dp, top = 10.dp, bottom = 6.dp).testTag("project-completed-heading"),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (open) Lucide.ChevronDownPlain else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(15.dp))
        Text(entry.title.uppercase(), style = rnText(13, 700, letterSpacing = 0.6f), color = if (entry.muted) c.secondaryText else c.text,
            modifier = Modifier.weight(1f))
        Text("${entry.count}", style = rnText(11, 600), color = c.secondaryText)
    }
}


@Composable
private fun ProjectList(model: InboxViewModel, modifier: Modifier) = with(model) {
    val c = LocalTheme.current.colors
    LazyColumn(modifier, contentPadding = PaddingValues(12.dp)) {
        item(key = "add") { AddProjectField(model) }

        item(key = "controls") {
            val manage = t("areas.manage")
            val shape = RoundedCornerShape(8.dp)
            Row(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 4.dp), horizontalArrangement = Arrangement.End) {
                Box(Modifier.heightIn(min = 44.dp).clip(shape).rnBorder(1.dp, c.border, shape)
                    .clickable(enabled = writable && !busy, role = Role.Button) { openAreaManager() }
                    .semantics { contentDescription = manage }.testTag("projects-manage-areas").padding(horizontal = 8.dp), contentAlignment = Alignment.Center) {
                    Text(manage, style = rnText(12, 600), color = c.text)
                }
            }
        }
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

                Row(
                    Modifier.fillMaxWidth().then(if (ruled) Modifier.rnBorderTop(c.border) else Modifier)
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

                val areaKey = group.areaId ?: "no-area"
                val folded = areaKey in projectsView.collapsedAreas
                item(key = "area:$bucket:${group.areaId}") { AreaHeader(model, group, areaKey, folded) }
                if (!folded) for (row in group.projects) item(key = "project:${row.id}") {
                    val (up, down) = projects?.moves?.get(row.id) ?: (false to false)
                    ProjectRowItem(model, row, group.projects.map { it.id }, up, down)
                }
            }
        }
    }
}


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
        else if (dot != null) Box(Modifier.padding(end = 8.dp).size(8.dp).clip(CircleShape).background(dot).rnBorder(1.dp, c.border, CircleShape))
        Text(area.uppercase(), style = rnText(12, 700, letterSpacing = 0.4f), color = c.secondaryText, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(end = 8.dp))
        Icon(if (folded) Lucide.ChevronRight else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
    }
}


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
                    Box(Modifier.clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 12.dp)) {
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


@Composable
private fun AreaChip(label: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(label, style = rnText(12, 600), color = if (selected) c.onTint else c.text,
        modifier = Modifier.clip(CircleShape).background(if (selected) c.tint else c.cardBg).rnBorder(1.dp, if (selected) c.tint else c.border, CircleShape)
            .selectable(selected = selected, enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 10.dp, vertical = 6.dp))
}


@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ProjectRowItem(model: InboxViewModel, row: ProjectRow, order: List<String>, canMoveUp: Boolean, canMoveDown: Boolean) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val count = "${row.activeTaskCount} ${t("common.tasks")}"
    val view = LocalView.current

    val moves = listOfNotNull("up".takeIf { canMoveUp }?.let { it to t("projects.moveUp") }, "down".takeIf { canMoveDown }?.let { it to t("projects.moveDown") })
    val canAct = writable && !busy && failedAction == null
    var moveMenu by remember { mutableStateOf(false) }
    val move = { direction: String -> moveMenu = false; projectDetails.move(row.id, direction, order) }
    if (moveMenu) ThemedAlert(row.title, null, moves.map { (direction, label) -> AlertButton(label, "default") { move(direction) } } +
        AlertButton(t("common.cancel"), "cancel") { moveMenu = false }) { moveMenu = false }
    Row(
        Modifier.fillMaxWidth().padding(bottom = 6.dp).clip(RoundedCornerShape(8.dp)).background(c.cardBg)
            .heightIn(min = 52.dp).padding(start = 12.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)
            .combinedClickable(enabled = canAct, role = Role.Button, onLongClick = if (moves.isEmpty()) null else ({
                view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK); moveMenu = true
            })) { openProject(row.id) }
            .semantics { customActions = moves.map { (direction, label) -> CustomAccessibilityAction(label) { if (canAct) move(direction); canAct } } }
            .testTag("project-row-open-${row.id}")) {
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


@Composable
private fun ProjectDetailList(model: InboxViewModel, modifier: Modifier) = with(model) {

    BackHandler(enabled = failedAction == null) { closeProject() }
    val c = LocalTheme.current.colors
    val detail = project
    val completable = detail?.readOnly == false
    LaunchedEffect(openProjectId) { projectDetails.follow(openProjectId) }
    DisposableEffect(Unit) { onDispose { projectDetails.closeOverlays() } }
    Column(modifier) {


        Row(Modifier.fillMaxWidth().heightIn(min = 64.3.dp).background(c.cardBg).bottomBorder(c.border).padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically) {
            val back = t("common.back")
            IconButton(onClick = model::closeProject, enabled = failedAction == null, modifier = Modifier.semantics { contentDescription = back }) {
                Icon(Lucide.ChevronLeft, null, tint = c.tint, modifier = Modifier.size(24.dp))
            }
            ProjectTitleField(model, projects?.title(openProjectId.orEmpty()).orEmpty(), detail?.readOnly != false, Modifier.weight(1f).padding(start = 8.dp))

            val actionsLabel = t("projects.actionsLabel")
            val actionsShape = RoundedCornerShape(10.dp)
            Box(Modifier.padding(start = 8.dp).size(38.dp).clip(actionsShape).background(c.filterBg).rnBorder(1.dp, c.border, actionsShape)
                .clickable(enabled = writable && detail != null && failedAction == null, role = Role.Button) { projectDetails.openActions() }
                .semantics { contentDescription = actionsLabel }.testTag("project-actions-menu-button"), contentAlignment = Alignment.Center) {
                Icon(Ionicons.EllipsisHorizontal, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
            }
        }


        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).background(c.cardBg).rnBorderBottom(c.border).padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {

            detail?.listFilters?.let { view ->
                if (view.getJSONObject("filters").optInt("activeCount") > 0) {
                    val label = view.getString("filterButtonLabel")
                    val chipShape = RoundedCornerShape(12.dp)
                    Row(Modifier.heightIn(min = 44.dp).clip(chipShape).background(c.tint.copy(alpha = 0x20 / 255f)).rnBorder(1.dp, c.tint, chipShape)
                        .clickable(enabled = writable && failedAction == null, role = Role.Button) { projectDetails.openFilters() }
                        .semantics { contentDescription = label; selected = true }.testTag("project-task-filter-button").padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Ionicons.FilterOutline, null, tint = c.tint, modifier = Modifier.size(18.dp))
                        Text(label, style = rnText(13, 700), color = c.tint)
                    }
                }
            }

            LaunchedEffect(openProjectId) { projectDetails.readSort() }
            val optionsLabel = t("taskEdit.moreOptions")
            val active = projectShowCompleted || projectDetails.customSort || projectDetails.reorderMode
            val optionsShape = RoundedCornerShape(12.dp)
            Box(Modifier.size(44.dp).clip(optionsShape).background(if (active) c.tint.copy(alpha = 0x20 / 255f) else c.filterBg)
                .rnBorder(1.dp, if (active) c.tint else c.border, optionsShape)
                .clickable(enabled = writable && detail != null && failedAction == null, role = Role.Button) { projectDetails.openViewOptions() }
                .semantics { contentDescription = optionsLabel; selected = active }.testTag("project-task-view-options-button"), contentAlignment = Alignment.Center) {
                Icon(Ionicons.EllipsisHorizontal, null, tint = if (active) c.tint else c.secondaryText, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.weight(1f))
            if (detail?.readOnly == false) {
                val theme = LocalTheme.current
                val addLabel = t("nav.addTask")
                val addShape = RoundedCornerShape(14.dp)
                Box(Modifier.size(width = 56.dp, height = 44.dp).clip(addShape).background(theme.filledBg).rnBorder(1.dp, theme.filledBg, addShape)
                    .clickable(enabled = writable && failedAction == null, role = Role.Button) { openProjectId?.let(::openProjectCapture) }
                    .semantics { contentDescription = addLabel }.testTag("project-add-task-button"), contentAlignment = Alignment.Center) {
                    Icon(SettingsIonicons.Add, null, tint = theme.filledText, modifier = Modifier.size(24.dp))
                }
            }
        }


        val listState = remember(openProjectId) { LazyListState() }
        val gettingStarted = detail?.gettingStarted != null
        LaunchedEffect(openProjectId, gettingStarted) { if (gettingStarted && listState.firstVisibleItemIndex <= 1) listState.scrollToItem(0) }

        var scrolledTo by remember(openProjectId) { mutableStateOf<String?>(null) }
        LaunchedEffect(highlightTaskId, detail) {
            val id = highlightTaskId ?: return@LaunchedEffect
            val items = detail?.items ?: return@LaunchedEffect
            val entry = items.indexOfFirst { it is DetailTask && it.row.id == id }
            if (entry < 0 || scrolledTo == id || !isHighlighted(id)) return@LaunchedEffect
            scrolledTo = id

            val after = items.size - entry + (if (items.size < detail.total) 1 else 0)
            listState.animateScrollToItem(maxOf(0, listState.layoutInfo.totalItemsCount - after))
        }

        LaunchedEffect(listState) {
            snapshotFlow { listState.layoutInfo.let { info -> firstViewedTask(info.visibleItemsInfo.map { Triple(it.key, it.offset, it.size) },
                info.viewportStartOffset, info.viewportEndOffset) } }.collect { if (!projectDetails.reorderMode) projectDetails.viewedTaskId = it }
        }

        if (projectDetails.reorderMode) {


            LaunchedEffect(detail) { projectDetails.readOrder() }
            LazyColumn(Modifier.fillMaxWidth().background(c.bg), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 12.dp), userScrollEnabled = false) {
                openProjectId?.let { id -> projectDetailsItems(model, id, detail) }
            }
            ProjectReorderList(model, Modifier.weight(1f))
            return@Column
        }

        PullToSync(model, Modifier.weight(1f).background(c.bg).imePadding()) {
            LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(12.dp)) {

                openProjectId?.let { id -> projectDetailsItems(model, id, detail) }
                for (entry in detail?.items.orEmpty()) when (entry) {
                    is DetailSection -> item(key = "section:${entry.id}") {
                        if (entry.collapsible) CompletedHeading(entry, enabled = !busy && failedAction == null, toggle = model::toggleProjectCompleted)
                        else SectionTitle(entry.title, entry.count,
                            Modifier.fillMaxWidth().fade(if (entry.muted) 0.6f else 1f).padding(top = 12.dp, bottom = 8.dp, start = 4.dp), note = entry.flowLabel)
                    }
                    is DetailTask -> item(key = "task:${entry.row.id}") {
                        TaskRowItem(model, entry.row, status = RowStatus.Badge, completable = completable,
                            note = entry.sequenceCue?.let(CUE_KEYS::get)?.let(::t), available = entry.sequenceCue == "available")
                    }
                }

                detail?.listFilters?.optJSONObject("empty")?.takeIf { detail.items.none { it is DetailTask } }?.let { empty ->
                    item(key = "empty") {
                        val clear = empty.optJSONObject("action")?.optJSONObject("filterEdit")
                        EmptyState(empty.getString("message"), empty.optString("hint").ifEmpty { null }, empty.menuText("actionLabel")) {
                            clear?.let(projectDetails::filterEdit)
                        }
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
}


internal fun firstViewedTask(items: List<Triple<Any, Int, Int>>, viewportStart: Int, viewportEnd: Int): String? =
    items.firstOrNull { (key, offset, size) ->
        (key as? String)?.startsWith("task:") == true && size > 0
            && (minOf(offset + size, viewportEnd) - maxOf(offset, viewportStart)) * 10 >= size
    }?.let { (key) -> (key as String).removePrefix("task:") }
