package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/*
 * RN's global search (app/global-search.tsx) on core's searchTasks: core finds, filters, highlights and
 * dates every result, and sends the filter sheet's words and choices. Kotlin holds only RN's screen
 * state: the query, the filter choices, and the save dialog.
 */

/** RN shows 50 results. */
private const val SEARCH_LIMIT = 50

/** The tabs this app has for core's list routes (getGlobalSearchTaskListTarget); the Menu lists' routes open through MenuModel.openRoute. */
private val SEARCH_ROUTES = mapOf("/inbox" to Screen.Inbox, "/focus" to Screen.Focus, "/projects-screen" to Screen.Projects)

/**
 * The search screen's state, as RN keeps it: the query, the filters, the open sheet, and the save dialog with its
 * request UUID. [filters] is null until the user changes one: the host then sends core's defaults, and the screen
 * shows core's `defaultFilters`.
 */
data class SearchState(
    val query: String = "",
    val filters: JSONObject? = null,
    val filtersOpen: Boolean = false,
    val saveName: String? = null,
    val saveRequestId: String = UUID.randomUUID().toString(),
    /** The name of a Save Search sent to core and not yet answered: the dialog is locked to it. */
    val submitted: String? = null,
) {
    fun request(): String = JSONObject().put("query", query).put("filters", filters ?: JSONObject.NULL).put("limit", SEARCH_LIMIT).toString()

    fun state(): JSONObject = JSONObject().put("query", query).put("filters", filters ?: JSONObject.NULL).put("filtersOpen", filtersOpen)
        .put("saveName", saveName ?: JSONObject.NULL).put("saveRequestId", saveRequestId).put("submitted", submitted ?: JSONObject.NULL)

    companion object {
        fun restore(text: String): SearchState? = runCatching {
            val saved = JSONObject(text)
            SearchState(saved.getString("query"), saved.optJSONObject("filters"), saved.getBoolean("filtersOpen"),
                if (saved.isNull("saveName")) null else saved.getString("saveName"), saved.getString("saveRequestId"),
                if (saved.isNull("submitted")) null else saved.getString("submitted"))
        }.getOrNull()
    }
}

/** A copy of [filters] with [name] set to [value]. */
private fun JSONObject.withValue(name: String, value: Any): JSONObject = JSONObject(toString()).put(name, value)

private fun JSONObject.texts(name: String): List<String> = getJSONArray(name).let { list -> List(list.length()) { list.getString(it) } }

/** RN's toggleStatus / toggleToken: [value] in or out of the list [name]. */
private fun JSONObject.toggled(name: String, value: String): JSONObject =
    withValue(name, JSONArray(texts(name).let { if (value in it) it - value else it + value }))

/** Core's title highlight segments: the text and whether it matched. */
private fun JSONArray.segments(): List<Pair<String, Boolean>> = List(length()) { getJSONObject(it).let { part -> part.getString("text") to part.getBoolean("highlighted") } }

/** One task result as core sent it: its highlight, its date line and tone, and where a tap goes. */
data class SearchTask(
    val id: String, val title: String, val segments: List<Pair<String, Boolean>>, val inProject: Boolean, val cancelled: Boolean,
    val canComplete: Boolean, val dateTone: String?, val dateLabel: String?, val editor: Boolean, val route: String?, val projectId: String?,
    /** Core's revision of the task as the result showed it; Done sends it. */
    val taskRevision: String,
)
data class SearchProject(val id: String, val title: String, val segments: List<Pair<String, Boolean>>)

/** Core's searchTasks reply. [options] is core's filter sheet: its sections, choices and labels. */
class SearchView(
    val query: String, val tasks: List<SearchTask>, val projects: List<SearchProject>, val chips: List<Pair<String, JSONObject>>,
    val hiddenCompleted: Int, val hasActiveFilters: Boolean, val truncated: Boolean, val totalLabel: String, val options: JSONObject,
    val defaultFilters: JSONObject,
) {
    companion object {
        fun parse(json: JSONObject): SearchView {
            check(json.getInt("version") == 1) { "Unsupported core contract" }
            val tasks = json.getJSONArray("tasks")
            val projects = json.getJSONArray("projects")
            val chips = json.getJSONArray("activeChips")
            return SearchView(
                json.getString("query"),
                List(tasks.length()) { index ->
                    val row = tasks.getJSONObject(index)
                    val tap = row.getJSONObject("tap")
                    val date = if (row.isNull("date")) null else row.getJSONObject("date")
                    SearchTask(row.getString("id"), row.getString("title"), row.getJSONArray("titleSegments").segments(), !row.isNull("projectTitle"),
                        row.getBoolean("cancelled"), row.getBoolean("canComplete"), date?.getString("tone"), date?.getString("label"), tap.getString("kind") == "editor",
                        tap.optString("route").ifEmpty { null }, if (tap.isNull("projectId")) null else tap.optString("projectId").ifEmpty { null },
                        row.optString("taskRevision"))
                },
                List(projects.length()) { index ->
                    projects.getJSONObject(index).let { SearchProject(it.getString("id"), it.getString("title"), it.getJSONArray("titleSegments").segments()) }
                },
                // Each chip carries core's exact filters once it is cleared.
                List(chips.length()) { index -> chips.getJSONObject(index).let { it.getString("label") to it.getJSONObject("clearedFilters") } },
                json.getInt("hiddenCompletedCount"), json.getBoolean("hasActiveFilters"), json.getBoolean("isTruncated"),
                json.getString("totalResultsLabel"), json.getJSONObject("filterOptions"), json.getJSONObject("defaultFilters"),
            )
        }
    }
}

/**
 * RN's search screen: the search field with Clear, the filter button, Save search, the operators hint, the active
 * chips, core's truncation and hidden-matches lines, then the project and task results with core's highlights.
 * A task opens the editor; a result core cannot open there goes to its list when this app has that list.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun SearchScreen(model: InboxViewModel, state: SearchState) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val view = searchView
    val trimmed = state.query.trim()
    val idle = writable && !busy && failedAction == null
    BackHandler(enabled = failedAction == null) { if (!busy) closeSearch() }
    Column(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("global-search")) {
        Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(16.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Lucide.Search, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { if (state.query.isEmpty()) focus.requestFocus() }
            val placeholder = t("search.placeholder")
            PlainField(state.query, ::editSearch, placeholder, placeholder, rnText(16, 400), Modifier.weight(1f).heightIn(min = 40.dp).focusRequester(focus))
            if (state.query.isNotEmpty()) {
                val clear = t("common.clear")
                Box(Modifier.size(32.dp).clickable(role = Role.Button) { editSearch("") }.semantics { contentDescription = clear }, contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
                }
            }
            val active = state.filtersOpen || view?.hasActiveFilters == true
            val filters = t("filters.label")
            val focusManager = LocalFocusManager.current
            val shape = RoundedCornerShape(8.dp)
            Box(Modifier.clip(shape).then(if (active) Modifier.background(c.filterBg) else Modifier).rnBorder(1.dp, if (active) c.tint else c.border, shape)
                // RN's openFilters blurs the search field first, so the keyboard leaves and the sheet gets the screen.
                .clickable(enabled = view != null, role = Role.Button) { focusManager.clearFocus(); showSearchFilters(true) }.semantics { contentDescription = filters }.padding(6.dp)) {
                Icon(Lucide.SlidersHorizontal, null, tint = if (active) c.tint else c.secondaryText, modifier = Modifier.size(18.dp))
            }
            if (trimmed.isNotEmpty()) {
                Text(t("search.saveSearch"), style = rnText(14, 600), color = c.tint,
                    modifier = Modifier.clickable(enabled = idle, role = Role.Button) { showSaveSearch(trimmed) }.padding(start = 4.dp))
            }
        }
        error?.let { message -> FailureBanner(message) { OwedRetry(model) } }
        if (trimmed.isNotEmpty()) HelpLine(t("search.helpOperators"))
        if (view != null && view.chips.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for ((label, cleared) in view.chips) FilterChip(label, label, true, true) { setSearchFilters(cleared) }
            }
        }
        val searching = trimmed.isNotEmpty() || view?.hasActiveFilters == true
        val shown = (view?.projects?.size ?: 0) + (view?.tasks?.size ?: 0)
        if (view != null && searching && view.truncated) {
            HelpLine(t("search.showingFirst").replace("{shown}", "$shown").replace("{total}", view.totalLabel))
        }
        if (view != null && searching && view.hiddenCompleted > 0) {
            val shape = RoundedCornerShape(8.dp)
            val hidden = t("search.hiddenCompletedMatches").replace("{{count}}", "${view.hiddenCompleted}")
            Text(hidden, style = rnText(13, 600), color = c.tint,
                textAlign = TextAlign.Center, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp).fillMaxWidth().clip(shape)
                    .background(c.cardBg).rnBorder(1.dp, c.border, shape)
                    .clickable(role = Role.Button) { setSearchFilters((state.filters ?: view.defaultFilters).withValue("includeCompleted", true)) }
                    .padding(horizontal = 12.dp, vertical = 8.dp))
        }
        LazyColumn(Modifier.weight(1f).imePadding(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (view != null && searching && shown == 0) item(key = "empty") {
                Text(if (trimmed.isEmpty()) t("search.noResults") else "${t("search.noResults")} \"$trimmed\"", style = rnText(16, 400),
                    color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(32.dp))
            }
            items(view?.projects.orEmpty(), key = { "project-${it.id}" }) { project ->
                ResultRow(project.segments, project.title, t("search.resultProject"), null, null, idle, true, {
                    Icon(Lucide.Folder, null, tint = c.tint, modifier = Modifier.size(24.dp))
                }) { openFromSearch(Screen.Projects, project.id) }
            }
            items(view?.tasks.orEmpty(), key = { "task-${it.id}" }) { task ->
                val route = task.route?.let(SEARCH_ROUTES::get)
                // Waiting, Someday, Reference, Done and Archived hits open their Menu list.
                val listed = task.route?.takeIf(::isMenuRoute)
                val subtitle = if (task.inProject) "${t("search.resultTask")} • ${t("search.inProjectSuffix")}" else t("search.resultTask")
                val dateColor = when (task.dateTone) { "danger" -> c.danger; "warning" -> c.warning; else -> c.secondaryText }
                // A hit core routes to a list this app has not built keeps RN's row look but has no tap and no chevron.
                val opens = task.editor || route != null || listed != null
                ResultRow(task.segments, task.title, subtitle, task.dateLabel, dateColor, idle && opens, opens, {
                    when {
                        task.canComplete -> {
                            val markDone = t("review.markDone")
                            val canDone = writable && !busy && (failedAction == null || failedAction == completeAction(task.id, task.taskRevision))
                            Box(Modifier.size(32.dp).clickable(enabled = canDone, role = Role.Button) { complete(task.id, task.taskRevision) }
                                .semantics { contentDescription = markDone }, contentAlignment = Alignment.Center) {
                                Icon(Lucide.CheckCircle, null, tint = c.secondaryText, modifier = Modifier.size(24.dp))
                            }
                        }
                        task.cancelled -> Icon(Lucide.XCircle, null, tint = c.secondaryText, modifier = Modifier.size(24.dp))
                        else -> Icon(Lucide.CheckCircle, null, tint = c.tint, modifier = Modifier.size(24.dp))
                    }
                }) {
                    // RN's setHighlightTask: the hit is outlined on the list it opens on (the one under the search for the editor).
                    when {
                        task.editor -> { highlight(task.id); openEditor(task.id) }
                        route != null -> { openFromSearch(route, task.projectId); highlight(task.id, task.projectId) }
                        listed != null -> { closeSearch(); menu.openRoute(listed); highlight(task.id) }
                    }
                }
            }
        }
    }
    if (state.filtersOpen && view != null) FilterSheet(model, state, view)
    state.saveName?.let { SaveSearchDialog(model, state, it) }
}

@Composable
private fun HelpLine(text: String) =
    Text(text, style = rnText(12, 400), color = LocalTheme.current.colors.secondaryText, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp))

/** A plain text field in RN's style: no box of its own, the placeholder in the secondary text color. */
@Composable
private fun PlainField(value: String, onChange: (String) -> Unit, placeholder: String, description: String, style: TextStyle, modifier: Modifier,
                       enabled: Boolean = true) {
    val c = LocalTheme.current.colors
    BasicTextField(value, onChange, enabled = enabled, singleLine = true, textStyle = style.copy(color = c.text), cursorBrush = SolidColor(c.tint),
        modifier = modifier.semantics { contentDescription = description },
        decorationBox = { inner ->
            Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = style, color = c.secondaryText)
                inner()
            }
        })
}

/** RN's result row: the leading glyph, core's highlighted title, the kind line, core's date line, and the chevron. */
@Composable
private fun ResultRow(segments: List<Pair<String, Boolean>>, title: String, subtitle: String, date: String?, dateColor: Color?, enabled: Boolean,
                      opens: Boolean, leading: @Composable () -> Unit, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .then(if (opens) Modifier.clickable(enabled = enabled, onClick = onClick) else Modifier)
        .padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        leading()
        Column(Modifier.weight(1f)) {
            val highlighted = buildAnnotatedString {
                for ((text, hit) in segments) if (hit) withStyle(SpanStyle(color = c.tint, fontWeight = FontWeight(600))) { append(text) } else append(text)
            }
            Text(highlighted, style = rnText(16, 500), color = c.text, modifier = Modifier.padding(bottom = 2.dp).testTag("search-result")
                .semantics { contentDescription = title })
            Text(subtitle, style = rnText(12, 400), color = c.secondaryText)
            if (date != null && dateColor != null) Text(date, style = rnText(12, 400), color = dateColor, modifier = Modifier.padding(top = 2.dp))
        }
        if (opens) Icon(Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
    }
}

/** RN's filter chip: the tint when selected, else the filter background. [description] names it for TalkBack and the checks. */
@Composable
private fun FilterChip(label: String, description: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(16.dp)
    Box(Modifier.clip(shape).background(if (selected) c.tint else c.filterBg).rnBorder(1.dp, c.border, shape)
        .semantics { contentDescription = description }.selectable(selected = selected, enabled = enabled, role = Role.Tab, onClick = onClick)
        .padding(horizontal = 10.dp, vertical = 6.dp)) {
        Text(label, style = rnText(12, 600), color = if (selected) c.onTint else c.text)
    }
}

/**
 * RN's filter sheet: a card from the bottom over a dimmed screen, Filters with Clear and Close, then core's sections in
 * RN's order: due date, location, contexts and tags, Include, status, scope, area. Each choice is searched at once.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterSheet(model: InboxViewModel, state: SearchState, view: SearchView) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    val options = view.options
    val presentation = options.getJSONObject("presentation")
    val sections = presentation.getJSONObject("sections")
    val filters = state.filters ?: view.defaultFilters
    val set = { next: JSONObject -> setSearchFilters(next) }
    BackHandler { showSearchFilters(false) }
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { showSearchFilters(false) } }) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.align(Alignment.BottomCenter).imePadding().padding(12.dp).fillMaxWidth()
            .heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.82f).dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(12.dp)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(t("filters.label"), style = rnText(14, 600), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                if (view.hasActiveFilters) Text(presentation.getString("clear"), style = rnText(12, 600), color = c.tint,
                    modifier = Modifier.heightIn(min = 36.dp).clickable(role = Role.Button) { set(view.defaultFilters) }
                        .padding(horizontal = 8.dp, vertical = 10.dp))
                val close = t("common.close")
                Box(Modifier.size(36.dp).clickable(role = Role.Button) { showSearchFilters(false) }.semantics { contentDescription = close },
                    contentAlignment = Alignment.Center) {
                    Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
                }
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                val chips = @Composable { section: String, content: @Composable () -> Unit ->
                    Text(section.uppercase(), style = rnText(12, 600, letterSpacing = 0.4f), color = c.secondaryText)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
                }
                val choice = { list: String -> options.getJSONArray(list).let { items -> List(items.length()) { items.getJSONObject(it) } } }
                val due = sections.getString("due")
                chips(due) {
                    for (option in choice("due")) {
                        val value = option.getString("value")
                        FilterChip(option.getString("label"), "$due: ${option.getString("label")}", filters.getString("duePreset") == value, true) { set(filters.withValue("duePreset", value)) }
                    }
                }
                val location = options.getJSONObject("location")
                Text(location.getString("label").uppercase(), style = rnText(12, 600, letterSpacing = 0.4f), color = c.secondaryText)
                val inputShape = RoundedCornerShape(8.dp)
                PlainField(filters.getString("locationQuery"), { set(filters.withValue("locationQuery", it)) }, location.getString("placeholder"),
                    location.getString("label"), rnText(13, 400), Modifier.fillMaxWidth().clip(inputShape).background(c.filterBg)
                        .rnBorder(1.dp, c.border, inputShape).padding(horizontal = 10.dp, vertical = 8.dp))
                val tokens = sections.getString("tokens")
                chips(tokens) {
                    for (token in options.texts("tokens")) {
                        FilterChip(token, "$tokens: $token", token in filters.texts("selectedTokens"), true) { set(filters.toggled("selectedTokens", token)) }
                    }
                }
                val include = options.getJSONObject("include")
                chips(include.getString("label")) {
                    for ((name, field) in listOf("completed" to "includeCompleted", "reference" to "includeReference", "hideFutureTasks" to "hideFutureTasks")) {
                        val on = filters.getBoolean(field)
                        FilterChip(include.getString(name), "${include.getString("label")}: ${include.getString(name)}", on, true) { set(filters.withValue(field, !on)) }
                    }
                }
                val status = sections.getString("status")
                chips(status) {
                    for (option in choice("statuses")) {
                        val value = option.getString("value")
                        FilterChip(option.getString("label"), "$status: ${option.getString("label")}", value in filters.texts("selectedStatuses"), true) {
                            set(filters.toggled("selectedStatuses", value))
                        }
                    }
                }
                for ((section, list, field) in listOf(Triple(sections.getString("scope"), "scope", "scope"), Triple(sections.getString("area"), "areas", "selectedArea"))) {
                    chips(section) {
                        for (option in choice(list)) {
                            val value = option.getString("value")
                            FilterChip(option.getString("label"), "$section: ${option.getString("label")}", filters.getString(field) == value, true) { set(filters.withValue(field, value)) }
                        }
                    }
                }
            }
        }
    }
}

/** RN's save dialog: the name (the query to start), Cancel and Save. While a failed save's retry is owed only that save runs. */
@Composable
private fun SaveSearchDialog(model: InboxViewModel, state: SearchState, name: String) = with(model) {
    val theme = LocalTheme.current
    val c = theme.colors
    // A submitted save is locked to its request until core answers (after process death too).
    val owed = failedAction != null || state.submitted != null
    BackHandler(enabled = !owed) { if (!busy) showSaveSearch(null) }
    Box(Modifier.fillMaxSize().background(theme.menuScrim).pointerInput(Unit) { detectTapGestures { } }.padding(24.dp), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(t("search.saveSearch"), style = rnText(16, 600), color = c.text, modifier = Modifier.semantics { heading() })
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            val prompt = t("search.saveSearchPrompt")
            val inputShape = RoundedCornerShape(8.dp)
            PlainField(state.submitted ?: name, { showSaveSearch(it) }, prompt, prompt, rnText(16, 400), Modifier.fillMaxWidth().clip(inputShape).rnBorder(1.dp, c.border, inputShape)
                .padding(horizontal = 12.dp, vertical = 8.dp).focusRequester(focus), enabled = !owed && !busy)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                val sent = state.submitted ?: name
                val canSave = sent.isNotBlank() && writable && !busy && (failedAction == null || failedAction == saveSearchAction(state, sent))
                DialogButton(t("common.cancel"), c.secondaryText, !owed && !busy) { showSaveSearch(null) }
                DialogButton(t("common.save"), c.text, canSave) { saveSearch(sent) }
            }
        }
    }
}

@Composable
private fun DialogButton(label: String, color: Color, enabled: Boolean, onClick: () -> Unit) =
    Box(Modifier.heightIn(min = 44.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center) {
        Text(label, style = rnText(14, 600), color = color, modifier = Modifier.fade(if (enabled) 1f else 0.5f))
    }
