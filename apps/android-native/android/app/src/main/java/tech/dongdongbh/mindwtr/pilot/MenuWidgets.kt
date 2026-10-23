package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.roundToInt

/*
 * The pieces RN's Menu screens share: the stack header (app/(drawer)/_layout.tsx DrawerHeader), the list overflow menu
 * (list-overflow-menu.tsx), the sort and group modals (task-list/TaskListSortModal and task-list.tsx), the filter sheet
 * (task-filter-sheet.tsx) on core's filter view, the header's active filters, the section headings, the empty states, the
 * stats, the parked projects (views/deferred-projects-section.tsx), and the Someday and Archive dialogs. Every word is core's.
 */

fun JSONObject.menuObjects(name: String): List<JSONObject> = optJSONArray(name)?.let { list -> List(list.length()) { list.getJSONObject(it) } }.orEmpty()
fun JSONObject.menuText(name: String): String? = if (!has(name) || isNull(name)) null else getString(name)

/**
 * RN's stack screen for a Menu destination, full screen over the tabs as RN pushes it: its header with Back, a failure
 * above the list (a read's Try again, or an owed command's exact retry), History's tabs, the list, RN's toast, and the
 * open sheet or dialog. The Weekly and Daily Review draw their own header and footer; RN's Projects screen shows the Projects
 * tab's list (an open project draws its own header, as on the tab). The capture popup opens over it (the Weekly Review's
 * Add task). The list is read again on every resume.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun MenuScreenHost(model: InboxViewModel, screen: MenuScreen) = with(model) {
    val c = LocalTheme.current.colors
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) { owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { menu.refresh() } }
    // Back closes an open dialog, then leaves selection mode, then the screen.
    BackHandler(enabled = failedAction == null) { if (menu.dialog != null) menu.backInDialog() else if (menu.page?.bulk != null) menu.list?.let(menu::endBulk) else menu.closeScreen() }
    Box(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("menu-screen")) {
        when (screen) {
            MenuScreen.Weekly -> WeeklyReview(model)
            MenuScreen.Daily -> DailyReview(model)
            // RN's Mind Sweep modal draws its own header.
            MenuScreen.MindSweep -> MindSweepScreen(model)
            else -> Column(Modifier.fillMaxSize()) {
                val list = menu.list
                // Settings titles RN's top bar with its open screen's title (core's words).
                val title = when (screen) {
                    MenuScreen.Settings -> menu.settings.title
                    // RN's widget list titles its stack screen with the list's title (core's), once read.
                    MenuScreen.WidgetList -> menu.page?.view?.menuText("title").orEmpty()
                    else -> t(screen.title)
                }
                if (screen != MenuScreen.Projects || openProjectId == null) MenuHeader(title, enabled = failedAction == null, onBack = menu::closeScreen) {
                    // Reference and Done put their list menu in the header (RN's overflowPlacement "navigation").
                    if (list == "reference" || list == "done") OverflowTrigger(plain = true) { menu.openDialog("overflow") }
                }
                error?.let { message ->
                    FailureBanner(message) {
                        if (failedAction == null) TextButton(onClick = { menu.retryRead() }, enabled = !busy, modifier = Modifier.testTag("read-retry")) { Text(t("common.retry")) }
                        else OwedRetry(model)
                    }
                }
                if (screen == MenuScreen.History) HistoryTabs(model)
                // RN's bulk bar over a selecting list (Waiting, Someday, Reference, Done).
                BulkBar(model)
                Box(Modifier.weight(1f).fillMaxWidth()) {
                    when (list) {
                        "waiting" -> WaitingList(model)
                        "someday" -> SomedayList(model)
                        "reference", "done" -> StatusList(model)
                        "archive" -> ArchiveList(model)
                        "contexts" -> ContextsList(model)
                        "trash" -> TrashList(model)
                        "review" -> ReviewList(model)
                        "calendar" -> CalendarList(model)
                        "board" -> BoardList(model)
                        "settings" -> SettingsList(model)
                        "savedSearch" -> SavedSearchList(model)
                        "widgetList" -> WidgetList(model)
                    }
                    if (screen == MenuScreen.Projects) ProjectsTab(model, Modifier.fillMaxSize())
                    ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 32.dp))
                }
            }
        }
        MenuDialogs(model)
        StatusMenu(model)
        capture?.let { CapturePopup(model, it) }
    }
}

/**
 * RN's quick-access tab when it holds Review, Contexts or the Calendar: that screen under the tab header, read on every resume,
 * with its dialogs (drawn over the tabs by MainActivity) and Back closing an open dialog.
 */
@Composable
fun QuickList(model: InboxViewModel, modifier: Modifier) = with(model) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) { owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { menu.refresh() } }
    BackHandler(enabled = failedAction == null && menu.dialog != null) { menu.backInDialog() }
    Box(modifier) {
        when (menu.list) {
            "contexts" -> ContextsList(model)
            "review" -> ReviewList(model)
            "calendar" -> CalendarList(model)
        }
    }
}

/** RN's DrawerHeader: the card background, a hairline below, Back (Ionicons chevron-back), the title at 17/700, and a right slot. */
@Composable
fun MenuHeader(title: String, enabled: Boolean, onBack: () -> Unit, right: @Composable () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.fillMaxWidth().height(52.dp).background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 8.dp)) {
        val back = t("common.back")
        Box(Modifier.align(Alignment.CenterStart).size(40.dp).clickable(enabled = enabled, role = Role.Button, onClick = onBack)
            .semantics { contentDescription = back }, contentAlignment = Alignment.Center) {
            Icon(Ionicons.ChevronBack, null, tint = c.text, modifier = Modifier.size(24.dp))
        }
        Text(title, style = rnText(17, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center).padding(horizontal = 56.dp).semantics { heading() })
        Box(Modifier.align(Alignment.CenterEnd).size(44.dp), contentAlignment = Alignment.Center) { right() }
    }
}

/** RN's ListOverflowMenu trigger: MoreHorizontal in a 44 box, bordered on the list, plain in the header. */
@Composable
fun OverflowTrigger(plain: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    val label = t("taskEdit.moreOptions")
    Box(Modifier.size(44.dp).clip(shape).then(if (plain) Modifier else Modifier.background(c.filterBg).border(1.dp, c.border, shape))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Icon(Lucide.MoreHorizontal, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
    }
}

/** One overflow menu row: its icon, label, value, selected state, and either an action or a submenu page. */
class OverflowAction(val label: String, val icon: ImageVector, val description: String = label, val value: String? = null,
                     val selected: Boolean = false, val page: String? = null, val onClick: () -> Unit = {})

/**
 * RN's overflow menu sheet: a card from the bottom over a light scrim, its title (More options, or a submenu's), Back on a
 * submenu, Close, and the rows in one bordered section. A leaf closes the menu, then runs.
 */
@Composable
fun OverflowSheet(model: InboxViewModel, title: String, actions: List<OverflowAction>) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val close = t("common.close")
    Box(Modifier.fillMaxSize().background(theme.overflowScrim).clickable(role = Role.Button) { keepDialog(null) }
        .semantics { contentDescription = close }.padding(start = 12.dp, end = 12.dp, top = 24.dp)) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.align(Alignment.BottomCenter).widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.82f).dp)
            .clip(shape).background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
            .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp)) {
            Row(Modifier.heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically) {
                if (dialog?.has("page") == true) {
                    val back = t("common.back")
                    Box(Modifier.size(44.dp).clickable(role = Role.Button) { dialogPage(null) }.semantics { contentDescription = back },
                        contentAlignment = Alignment.Center) { Icon(Lucide.ChevronLeft, null, tint = c.secondaryText, modifier = Modifier.size(22.dp)) }
                }
                Text(title, style = rnText(17, 700), color = c.text, maxLines = 2, modifier = Modifier.weight(1f).padding(horizontal = 8.dp).semantics { heading() })
                Box(Modifier.size(44.dp).clickable(role = Role.Button) { keepDialog(null) }.semantics { contentDescription = close },
                    contentAlignment = Alignment.Center) { Icon(Lucide.X, null, tint = c.secondaryText, modifier = Modifier.size(20.dp)) }
            }
            val section = RoundedCornerShape(12.dp)
            Column(Modifier.verticalScroll(rememberScrollState()).clip(section).border(1.dp, c.border, section)) {
                for (action in actions) {
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).hairline(c.border, top = false)
                        .selectable(selected = action.selected, enabled = idle || action.page != null, role = Role.Button) {
                            if (action.page != null) dialogPage(action.page) else { keepDialog(null); action.onClick() }
                        }.semantics { contentDescription = action.description }.padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(34.dp).clip(RoundedCornerShape(10.dp)).background(if (action.selected) theme.tintWash else c.filterBg),
                            contentAlignment = Alignment.Center) {
                            Icon(action.icon, null, tint = if (action.selected) c.tint else c.secondaryText, modifier = Modifier.size(19.dp))
                        }
                        Text(action.label, style = rnText(15, 600), color = c.text, maxLines = 2, modifier = Modifier.weight(1f))
                        action.value?.let { Text(it, style = rnText(13, 400), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 160.dp)) }
                    }
                }
            }
        }
    }
}

/** One modal choice: core's label and value, and whether it is the current one. */
class Choice(val label: String, val selected: Boolean, val onClick: () -> Unit)

/** RN's sort and group modals: a centered card over a dimmed screen, the title, and the options; the current one is washed. */
@Composable
fun ChoiceModal(model: InboxViewModel, title: String, choices: List<Choice>) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button) { keepDialog(null) }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.cardBg)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = rnText(16, 700), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().semantics { heading() })
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (choice in choices) {
                    Text(choice.label, style = rnText(14, 400), color = c.text, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                        .then(if (choice.selected) Modifier.background(c.filterBg) else Modifier)
                        .selectable(selected = choice.selected, enabled = idle, role = Role.Button) { keepDialog(null); choice.onClick() }
                        .padding(horizontal = 10.dp, vertical = 8.dp))
                }
            }
        }
    }
}

/**
 * RN's list header chips under the header: each active filter with its removal (core's edit), struck through and red
 * when excluded, then Clear (core's clear edit), in a bordered strip. [clear] is core's clear action; null hides Clear.
 */
@Composable
fun ActiveChips(model: InboxViewModel, chips: List<JSONObject>, clear: (() -> Unit)?) = with(model.menu) {
    if (chips.isEmpty()) return
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).horizontalScroll(rememberScrollState())
        .padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        for (chip in chips) {
            val excluded = chip.optBoolean("excluded")
            val accent = if (excluded) c.danger else c.tint
            val label = chip.getString("label")
            val spoken = chip.menuText("accessibilityLabel")
                ?: if (excluded) "${t("filters.remove")}: $label (${t("filters.excluded")})" else "${t("filters.remove")}: $label"
            Row(Modifier.clip(CircleShape).background(c.filterBg).border(1.dp, accent, CircleShape)
                .clickable(enabled = idle, role = Role.Button) { removeChip(chip.getJSONObject("action")) }
                .semantics { contentDescription = spoken }.padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(label, style = rnText(12, 600).copy(textDecoration = if (excluded) TextDecoration.LineThrough else null), color = accent)
                Icon(Lucide.X, null, tint = accent, modifier = Modifier.size(14.dp))
            }
        }
        clear?.let { onClear ->
            val label = t("filters.clear")
            Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.clip(CircleShape).background(c.filterBg).border(1.dp, c.border, CircleShape)
                .clickable(enabled = idle, role = Role.Button, onClick = onClear).padding(horizontal = 12.dp, vertical = 6.dp))
        }
    }
}

/** RN's "Filters · N" button (task list header, Archive's search row): the tint border and SlidersHorizontal; it opens the sheet. */
@Composable
fun ActiveFiltersButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.heightIn(min = 44.dp).clip(shape).background(c.filterBg).border(1.dp, c.tint, shape)
        .selectable(selected = true, enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
        .padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Icon(Lucide.SlidersHorizontal, null, tint = c.tint, modifier = Modifier.size(16.dp))
        Text(label, style = rnText(13, 700), color = c.tint)
    }
}

/**
 * RN's grouping heading: a chevron when it folds, the title in capitals, and the count, in task-list.tsx's type, or
 * archived.tsx's ([archive]: a looser count, less letter spacing, more room above).
 */
@Composable
fun GroupHeading(model: InboxViewModel, item: JSONObject, archive: Boolean = false) {
    val c = LocalTheme.current.colors
    val collapsible = item.optBoolean("collapsible")
    val collapsed = item.optBoolean("collapsed")
    val title = item.getString("title")
    val count = item.getInt("count")
    val toggle = if (collapsible) t(if (collapsed) "markdown.expand" else "markdown.collapse") else null
    val muted = item.optBoolean("muted")
    Row(Modifier.fillMaxWidth().then(if (collapsible) Modifier.clickable(enabled = model.menu.idle, onClickLabel = toggle) { model.menu.toggleGroup(item.getString("id")) } else Modifier)
        .semantics { contentDescription = "$title · $count"; heading() }
        .padding(start = if (archive) 4.dp else 6.dp, end = if (archive) 4.dp else 6.dp, top = if (archive) 14.dp else 10.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (collapsible) Icon(if (collapsed) Lucide.ChevronRight else Lucide.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(15.dp))
        Text(title.uppercase(), style = rnText(13, 700, letterSpacing = if (archive) 0.4f else 0.6f), color = if (muted) c.secondaryText else c.text,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text("$count", style = if (archive) rnText(12, 400) else rnText(11, 600), color = c.secondaryText)
    }
}

/** RN's icon empty state (Waiting, Someday, Archive): a 48 glyph at stroke 1.5, the title, the hint, and an optional action. */
@Composable
fun IconEmptyState(icon: ImageVector, title: String, hint: String?, action: String? = null, onAction: () -> Unit = {}) {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, null, tint = c.secondaryText, modifier = Modifier.padding(bottom = 16.dp).size(48.dp))
        Text(title, style = rnText(18, 600), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.padding(bottom = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite })
        hint?.takeIf { it.isNotEmpty() }?.let { Text(it, style = rnText(14, 400, 20), color = c.secondaryText, textAlign = TextAlign.Center) }
        action?.let { label ->
            val shape = RoundedCornerShape(8.dp)
            Text(label, style = rnText(12, 600), color = c.text, modifier = Modifier.padding(top = 12.dp).clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
                .clickable(role = Role.Button, onClick = onAction).padding(horizontal = 12.dp, vertical = 6.dp))
        }
    }
}

/** RN's stats bar (Waiting, Someday): core's values in the screen's color at 24 bold, core's labels under them, then [trailing]. */
@Composable
fun StatBar(stats: JSONArray, color: Color, trailing: @Composable RowScope.() -> Unit = {}) {
    val theme = LocalTheme.current
    val c = theme.colors
    Row(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
        for (index in 0 until stats.length()) {
            val stat = stats.getJSONObject(index)
            val value = stat.getInt("value")
            Column(Modifier.clearAndSetSemantics { text = AnnotatedString("${stat.getInt("value")} ${stat.getString("label")}") },
                horizontalAlignment = Alignment.CenterHorizontally) {
                Text("$value", style = rnText(24, 700), color = color)
                Text(stat.getString("label"), style = rnText(12, 400), color = theme.gray, modifier = Modifier.padding(top = 4.dp))
            }
        }
        trailing()
    }
}

/** A pill that loads a collection's next window (core's `common.more`). */
@Composable
fun MoreChip(enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(t("common.more"), style = rnText(12, 600), color = c.tint, modifier = Modifier.clip(CircleShape).border(1.dp, c.border, CircleShape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp))
}

/**
 * RN's parked projects card (DeferredProjectsSection): a header with its chevron and core's "Projects (N)", then each
 * project with RN's folder in its color, its area, a tap that opens it, and RN's swipe right to core's Reactivate
 * (activateProject), also a TalkBack action. The card starts open; the fold is screen state, as in RN.
 */
@Composable
fun DeferredProjects(model: InboxViewModel, page: MenuPage) = with(model.menu) {
    val deferred = page.view.optJSONObject("deferred") ?: return
    val c = LocalTheme.current.colors
    var open by rememberSaveable { mutableStateOf(true) }
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.padding(bottom = 12.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
        .padding(horizontal = 12.dp, vertical = if (open) 12.dp else 0.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        val title = deferred.getString("title")
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).toggleable(open, role = Role.Button) { open = it }.semantics { contentDescription = title },
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(if (open) Lucide.ChevronDown else Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
            Text(title.uppercase(), style = rnText(12, 600, letterSpacing = 0.5f), color = c.secondaryText)
        }
        if (!open) return@Column
        val activate = deferred.getString("activateLabel")
        for (project in page.collection("deferredProjects")) {
            ParkedProject(model, project, activate)
        }
        if (page.collection("deferredProjects").size < page.collectionTotal("deferredProjects")) MoreChip(idle) { loadCollection("deferredProjects") }
    }
}

/**
 * One parked project row (RN's DeferredProjectRow): a tap opens it; a drag right past 72 opens RN's Reactivate action and runs it, as
 * RN's onSwipeableLeftOpen does. Someday's section groups draw it too (#1319).
 */
@Composable
internal fun ParkedProject(model: InboxViewModel, project: JSONObject, activate: String) = with(model) {
    val c = LocalTheme.current.colors
    val density = LocalDensity.current
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val shape = RoundedCornerShape(10.dp)
    val id = project.getString("id")
    val revision = project.optString("projectRevision")
    val enabled = menu.idle
    Box {
        if (offset.value > 0f) {
            Box(Modifier.matchParentSize().clip(shape).background(c.tint).border(1.dp, c.border, shape).padding(horizontal = 16.dp),
                contentAlignment = Alignment.CenterStart) { Text(activate, style = rnText(14, 600), color = c.onTint) }
        }
        val title = project.getString("title")
        Row(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
            .draggable(rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceAtLeast(0f)) } }, Orientation.Horizontal,
                enabled = enabled, onDragStopped = {
                    val opened = with(density) { offset.value.toDp() } > 72.dp
                    scope.launch { offset.animateTo(0f) }
                    if (opened) menu.activate(id, revision)
                })
            .clickable(enabled = failedAction == null && !busy, role = Role.Button) { menu.openProjects(id) }
            .semantics {
                contentDescription = title
                customActions = listOf(CustomAccessibilityAction(activate) { if (enabled) menu.activate(id, revision); enabled })
            }.padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Lucide.Folder, null, tint = coreColorOrNull(project.menuText("color")) ?: c.secondaryText, modifier = Modifier.size(18.dp))
            Column(Modifier.weight(1f)) {
                Text(title, style = rnText(14, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                project.menuText("areaName")?.let { Text(it, style = rnText(12, 400), color = c.secondaryText, maxLines = 1, modifier = Modifier.padding(top = 2.dp)) }
            }
        }
    }
}

/** The open sheet or dialog over the Menu screen (or the quick-access tab), by its kind. */
@Composable
fun MenuDialogs(model: InboxViewModel) = with(model.menu) {
    val open = dialog ?: return
    val view = page?.view
    // The Inbox's sort and group modals come from its toolbar; each option carries core's edit.
    val controls = if (list == "inbox") view?.optJSONObject("toolbar") else view
    when (open.optString("kind")) {
        "overflow" -> view?.let { OverflowFor(model, it, open) }
        "filters" -> view?.let { FilterSheet(model, it, open) }
        "sort" -> controls?.getJSONObject("sort")?.let { modal ->
            ChoiceModal(model, modal.getString("title"), modal.menuObjects("options").map { option ->
                Choice(option.getString("label"), option.getBoolean("selected")) { sort(option.optJSONObject("edit")?.getString("sortBy") ?: option.getString("value")) }
            })
        }
        "group" -> controls?.getJSONObject("group")?.let { modal ->
            ChoiceModal(model, modal.getString("title"), modal.menuObjects("options").map { option ->
                Choice(option.getString("label"), option.getBoolean("selected")) { group(option.optJSONObject("edit")?.getString("groupBy") ?: option.getString("value")) }
            })
        }
        "completedAt" -> CompletedAtPicker(model, open)
        "bulkTag" -> AddTagDialog(model, open)
        "organize" -> OrganizeDialog(model, open)
        "move" -> MoveDialog(model, open)
        "newSection", "addTask" -> CreateDialog(model, open)
        "tokens" -> TokenPicker(model, open)
        "startReview", "reviewMove", "reviewTag" -> ReviewDialog(model, open)
        "projectTask" -> ProjectTaskPrompt(model, open)
        "confirm" -> AlertDialog(
            onDismissRequest = { keepDialog(null) },
            title = { Text(open.getString("title")) },
            text = { Text(open.getString("message")) },
            confirmButton = { TextButton(onClick = { keepDialog(null); act(open.optString("command", "archiveAction"), open.getJSONObject("action")) }, enabled = idle) { Text(open.getString("confirmLabel")) } },
            dismissButton = { TextButton(onClick = { keepDialog(null) }) { Text(open.getString("cancelLabel")) } },
        )
    }
}

/** Each list's overflow menu, with core's labels and values (Reference and Done in the header, Someday and Archive on the list). */
@Composable
private fun OverflowFor(model: InboxViewModel, view: JSONObject, open: JSONObject) = with(model.menu) {
    val list = list ?: return
    val pageId = open.menuText("page")
    when (list) {
        "someday" -> {
            val listMenu = view.getJSONObject("menu")
            val sortMenu = listMenu.getJSONObject("sort")
            val groupMenu = listMenu.getJSONObject("group")
            val sub = when (pageId) { "sort" -> sortMenu; "group" -> groupMenu; else -> null }
            if (sub != null) {
                OverflowSheet(model, sub.getString("label"), sub.menuObjects("options").map { option ->
                    OverflowAction(option.getString("label"), if (pageId == "sort") Lucide.ArrowUpDown else Lucide.Folder, option.getString("accessibilityLabel"),
                        selected = option.getBoolean("selected")) { if (pageId == "sort") sort(option.getString("value")) else group(option.getString("value")) }
                })
            } else {
                val detailsMenu = listMenu.getJSONObject("details")
                OverflowSheet(model, listMenu.getString("moreLabel"), listOf(
                    OverflowAction(listMenu.getJSONObject("filters").getString("label"), Lucide.SlidersHorizontal, selected = listMenu.getJSONObject("filters").getBoolean("selected")) { openDialog("filters") },
                    OverflowAction(sortMenu.getString("label"), Lucide.ArrowUpDown, sortMenu.getString("accessibilityLabel"), sortMenu.getString("value"), page = "sort"),
                    OverflowAction(groupMenu.getString("label"), Lucide.Folder, groupMenu.getString("accessibilityLabel"), groupMenu.getString("value"), page = "group"),
                    OverflowAction(detailsMenu.getString("label"), Lucide.Eye, selected = detailsMenu.getBoolean("selected")) { details(!detailsMenu.getBoolean("selected")) },
                    OverflowAction(listMenu.getJSONObject("newSection").getString("label"), Lucide.PlusPlain) { openNewSection() },
                ))
            }
        }
        "archive" -> {
            val listMenu = view.getJSONObject("menu")
            val sortMenu = listMenu.getJSONObject("sort")
            val groupMenu = listMenu.getJSONObject("group")
            val sub = when (pageId) { "sort" -> sortMenu; "group" -> groupMenu; else -> null }
            if (sub != null) {
                OverflowSheet(model, sub.getString("label"), sub.menuObjects("options").map { option ->
                    OverflowAction(option.getString("label"), if (pageId == "sort") Lucide.ArrowUpDown else Lucide.Folder, "${sub.getString("label")}: ${option.getString("label")}",
                        selected = option.getBoolean("selected")) { if (pageId == "sort") sort(option.getString("id")) else group(option.getString("id")) }
                })
            } else {
                OverflowSheet(model, t("taskEdit.moreOptions"), listOf(
                    OverflowAction(listMenu.getString("filtersLabel"), Lucide.SlidersHorizontal, selected = view.getJSONObject("filters").getBoolean("hasActive")) { openDialog("filters") },
                    OverflowAction(sortMenu.getString("label"), Lucide.ArrowUpDown, "${sortMenu.getString("label")}: ${sortMenu.getString("value")}", sortMenu.getString("value"), page = "sort"),
                    OverflowAction(groupMenu.getString("label"), Lucide.Folder, "${groupMenu.getString("label")}: ${groupMenu.getString("value")}", groupMenu.getString("value"), page = "group"),
                ))
            }
        }
        else -> {
            // Reference and Done (TaskListHeader in its navigation slot): Filters, then Sort and Group, which open their modals.
            val sortMenu = view.getJSONObject("sort")
            val groupMenu = view.getJSONObject("group")
            val filters = view.getJSONObject("filters")
            OverflowSheet(model, t("taskEdit.moreOptions"), listOf(
                OverflowAction(t("filters.label"), Lucide.SlidersHorizontal, selected = filters.getBoolean("hasActive") || view.optBoolean("includeArchivedProjects")) { openDialog("filters") },
                OverflowAction(sortMenu.getString("title"), Lucide.ArrowUpDown, "${sortMenu.getString("title")}: ${sortMenu.getString("label")}", sortMenu.getString("label")) { openDialog("sort") },
                OverflowAction(groupMenu.getString("title"), Lucide.Folder, "${groupMenu.getString("title")}: ${groupMenu.getString("label")}", groupMenu.getString("label")) { openDialog("group") },
            ))
        }
    }
}

/**
 * RN's filter sheet (task-filter-sheet.tsx) on core's filter view: the title (Filters, or a picker's) with Back and Clear,
 * then the active filters, Search, the list's own switch (Reference's archived projects), and core's sections: contexts
 * and tags and projects (each a picker page), time estimate, energy level, and more filters (priority and location), each
 * disclosure folded as RN starts it. Every chip and row sends the exact edit core put on it; typed text sends core's
 * setSearch or setLocation once typing pauses. Done closes it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FilterSheet(model: InboxViewModel, view: JSONObject, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val filters = view.getJSONObject("filters")
    val state = filters.getJSONObject("state")
    val visibility = filters.getJSONObject("visibility")
    val shown = page ?: return
    val picker = open.menuText("page")
    val all = t("common.all")
    val excluded = t("filters.excluded")
    val close = t("common.close")
    Box(Modifier.fillMaxSize().background(theme.scrim).clickable(role = Role.Button) { keepDialog(null) }.semantics { contentDescription = close }) {
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        val tall = (LocalConfiguration.current.screenHeightDp * 0.82f).dp
        Column(Modifier.align(Alignment.BottomCenter).imePadding().fillMaxWidth().then(if (picker != null) Modifier.height(tall) else Modifier.heightIn(max = tall))
            .clip(shape).background(c.cardBg).border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
            .semantics { contentDescription = t("filters.label") }.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 12.dp)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                if (picker != null) Text(t("common.back"), style = rnText(13, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { dialogPage(null) }.padding(end = 8.dp, top = 12.dp, bottom = 12.dp))
                val title = t(when (picker) { "tokens" -> "filters.contexts"; "projects" -> "filters.projects"; else -> "filters.label" })
                Text(title, style = rnText(16, 700),
                    color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                if (filters.getBoolean("hasActive") || view.optBoolean("includeArchivedProjects")) {
                    Text(t("filters.clear"), style = rnText(13, 600), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                        .clickable(enabled = idle, role = Role.Button) { filterEdit(filters.getJSONObject("clearEdit")) }.padding(horizontal = 10.dp, vertical = 12.dp))
                }
            }
            if (picker != null) {
                val name = if (picker == "tokens") "tokens" else "projects"
                // RN's picker search: core's matching options (the query from offset zero), read again whenever the list changes,
                // since a tap changes the options' states.
                val query = open.optString("query")
                val found = pickerFound?.takeIf { it.getString("name") == name && it.getString("query") == query && it.getString("revision") == shown.revision }
                LaunchedEffect(shown.revision, name) { if (query.isNotBlank()) searchPicker(name, query, pickerFound?.optJSONArray("items")?.length() ?: 0) }
                Box(Modifier.padding(bottom = 10.dp)) {
                    SheetField(query, t("common.search"), "${t("common.search")} ${t(if (name == "tokens") "filters.contexts" else "filters.projects")}") { pickerQuery(name, it) }
                }
                val options = if (query.isBlank()) shown.collection(name) else found?.menuObjects("items").orEmpty()
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    if (options.isEmpty() && (query.isBlank() || found != null)) Text(t("search.noResults"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp))
                    for (option in options) {
                        val label = option.optString("title").ifEmpty { option.getString("value") }
                        val out = option.optString("state") == "excluded"
                        val on = option.optString("state") == "included" || option.optBoolean("selected")
                        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).hairline(c.border, top = false)
                            .selectable(selected = on, enabled = idle, role = Role.Button) { filterEdit(option.getJSONObject("edit")) }
                            .semantics { contentDescription = if (out) "$label ($excluded)" else label }.padding(horizontal = 4.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(label, style = rnText(14, 400, 19).copy(textDecoration = if (out) TextDecoration.LineThrough else null),
                                color = if (out) c.danger else c.text, maxLines = 2, modifier = Modifier.weight(1f))
                            if (on || out) Text(if (out) excluded else t("bulk.selected"), style = rnText(12, 600), color = if (out) c.danger else c.tint)
                        }
                    }
                    if (query.isBlank() && options.size < shown.collectionTotal(name)) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { loadCollection(name) } }
                    if (found != null && options.size < found.getInt("total")) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { searchPicker(name, query, options.size + 100) } }
                    // RN's footer: Any or All for two or more chosen contexts (or tags), core's edits.
                    if (name == "tokens") Column(Modifier.padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        for (mode in filters.menuObjects("matchModes")) MatchModeRow(mode.getString("label"), mode.menuObjects("options"), idle) { filterEdit(it) }
                    }
                }
            } else {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    val chips = view.menuObjects("chips").takeIf { it.isNotEmpty() }
                    chips?.let {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            SheetLabel(t("filters.active"))
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                for (chip in it) {
                                    val label = chip.getString("label")
                                    SheetChip(label, true, chip.optBoolean("excluded"), remove = "${t("filters.remove")}: $label", enabled = idle) {
                                        removeChip(chip.getJSONObject("action"))
                                    }
                                }
                            }
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        SheetLabel(t("common.search"))
                        SheetField(open.optString("typed:setSearch", state.optString("searchQuery")), t("search.placeholder"), t("common.search")) {
                            typeFilter("setSearch", it)
                        }
                    }
                    view.optJSONObject("archivedProjectsToggle")?.let { toggle ->
                        val label = toggle.getString("label")
                        val on = toggle.getBoolean("value")
                        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).toggleable(on, enabled = idle, role = Role.Switch) { archivedProjects(it) }
                            .semantics { contentDescription = label }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text(label, style = rnText(15, 500), color = c.text, modifier = Modifier.weight(1f))
                            RnSwitchGraphic(on, true, LocalTheme.current.referenceSwitch)
                        }
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        filters.optJSONObject("taskDates")?.let { dates ->
                            Disclosure(dates.getString("label"), dates.menuObjects("options"), all, open.optBoolean("taskDates"), idle,
                                { toggleDisclosure("taskDates") }) { filterEdit(it) }
                        }
                        val tokens = shown.collection("tokens")
                        if (tokens.isNotEmpty() || shown.collectionTotal("tokens") > 0) {
                            val picked = state.optJSONArray("tokens").strings() + state.optJSONArray("excludedTokens").strings().map { "$excluded: $it" }
                            OverviewRow(t("filters.contexts"), picked.joinToString(", ").ifEmpty { all }, all, null) { dialogPage("tokens") }
                        }
                        val projects = shown.collection("projects")
                        if (projects.isNotEmpty()) {
                            val chosen = projects.chosenLabels().joinToString(", ")
                            OverviewRow(t("filters.projects"), chosen.ifEmpty { all }, all, null) { dialogPage("projects") }
                        }
                        val estimates = filters.menuObjects("timeEstimates")
                        if (visibility.optBoolean("timeEstimate") && estimates.isNotEmpty()) {
                            Disclosure(t("filters.timeEstimate"), estimates, all, open.optBoolean("time"), idle, { toggleDisclosure("time") }) { filterEdit(it) }
                        }
                        if (visibility.optBoolean("energyLevel")) {
                            Disclosure(t("taskEdit.energyLevel"), filters.menuObjects("energyLevels"), all, open.optBoolean("energy"), idle, { toggleDisclosure("energy") }) { filterEdit(it) }
                        }
                        if (visibility.optBoolean("priority") || visibility.optBoolean("location")) {
                            val priorities = filters.menuObjects("priorities")
                            val location = state.optString("location").trim()
                            val summary = (priorities.chosenLabels() + listOfNotNull(location.takeIf { it.isNotEmpty() }?.let { "${t("taskEdit.locationLabel")}: $it" }))
                                .joinToString(", ").ifEmpty { all }
                            OverviewRow(t("filters.more"), summary, all, open.optBoolean("more")) { toggleDisclosure("more") }
                            if (open.optBoolean("more")) Column(Modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                if (visibility.optBoolean("priority")) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    SheetLabel(t("filters.priority"))
                                    ChipFlow(priorities, idle) { filterEdit(it) }
                                }
                                if (visibility.optBoolean("location")) Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    SheetLabel(t("taskEdit.locationLabel"))
                                    SheetField(open.optString("typed:setLocation", state.optString("location")), t("taskEdit.locationPlaceholder"),
                                        t("taskEdit.locationLabel")) { typeFilter("setLocation", it) }
                                }
                            }
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.End) {
                Text(t("common.done"), style = rnText(14, 700), color = c.tint, modifier = Modifier.heightIn(min = 44.dp)
                    .clickable(role = Role.Button) { keepDialog(null) }.padding(horizontal = 10.dp, vertical = 12.dp))
            }
        }
    }
}

private fun JSONArray?.strings(): List<String> = this?.let { list -> List(list.length()) { list.getString(it) } }.orEmpty()
/** The labels of the options core marks selected, in core's order. */
private fun List<JSONObject>.chosenLabels(): List<String> = mapNotNull { option -> option.optString("title").ifEmpty { option.optString("label") }.takeIf { option.optBoolean("selected") } }

@Composable
internal fun SheetLabel(text: String) = Text(text.uppercase(), style = rnText(12, 600, letterSpacing = 0.4f), color = LocalTheme.current.colors.secondaryText)

/** RN's overview row: the section's label, its summary (the tint once anything is chosen), and a chevron (or the fold's). */
@Composable
internal fun OverviewRow(label: String, summary: String, all: String, expanded: Boolean?, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).clip(shape).background(c.bg).border(1.dp, c.border, shape).clickable(role = Role.Button, onClick = onClick)
        .semantics { contentDescription = "$label: $summary" }.padding(horizontal = 12.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f)) {
            Text(label, style = rnText(14, 600), color = c.text)
            Text(summary, style = rnText(12, 400, 17), color = if (summary == all) c.secondaryText else c.tint, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp))
        }
        Icon(when (expanded) { null -> Lucide.ChevronRight; true -> Lucide.ChevronUp; false -> Lucide.ChevronDown }, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
    }
}

/** A folding overview row whose chips (core's options with their edits, sent to [onEdit]) show while it is open; [summary] is core's when it sends one. */
@Composable
internal fun Disclosure(label: String, options: List<JSONObject>, all: String, open: Boolean, enabled: Boolean, onToggle: () -> Unit,
                        summary: String? = null, onEdit: (JSONObject) -> Unit) {
    OverviewRow(label, summary ?: options.chosenLabels().joinToString(", ").ifEmpty { all }, all, open, onToggle)
    if (open) Box(Modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp)) { ChipFlow(options, enabled, onEdit) }
}

/** Core's options as RN's filter chips; a tap sends the option's own edit to [onEdit]. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChipFlow(options: List<JSONObject>, enabled: Boolean, onEdit: (JSONObject) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in options) SheetChip(option.getString("label"), option.getBoolean("selected"), false, enabled = enabled) {
            onEdit(option.getJSONObject("edit"))
        }
    }
}

/**
 * RN's match mode control (the token picker's footer): core's label, then Any and All in a pill, the chosen one in the tint.
 * A tap sends that option's edit to [onEdit]. One node per option holds its label, role and state.
 */
@Composable
internal fun MatchModeRow(label: String, options: List<JSONObject>, enabled: Boolean, onEdit: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = rnText(12, 600), color = c.secondaryText)
        val shape = RoundedCornerShape(18.dp)
        Row(Modifier.heightIn(min = 36.dp).clip(shape).background(c.filterBg).border(1.dp, c.border, shape).padding(2.dp)) {
            for (option in options) {
                val on = option.getBoolean("selected")
                val text = option.getString("label")
                val choose = { onEdit(option.getJSONObject("edit")) }
                Box(Modifier.widthIn(min = 52.dp).heightIn(min = 30.dp).clip(RoundedCornerShape(15.dp)).then(if (on) Modifier.background(c.tint) else Modifier)
                    .clearAndSetSemantics {
                        contentDescription = "$label: $text"; role = Role.Button; selected = on
                        if (enabled) onClick { choose(); true } else disabled()
                    }
                    .clickable(enabled = enabled) { choose() }.padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(text, style = rnText(12, 700), color = if (on) c.onTint else c.secondaryText)
                }
            }
        }
    }
}

/**
 * RN's FilterChip in the sheet: a 44-high pill, the tint when selected, struck and red when excluded. A removable chip
 * (an active filter) is not pressable itself: its X, labelled [remove], runs [onClick], as in RN.
 */
@Composable
internal fun SheetChip(label: String, selected: Boolean, excluded: Boolean, remove: String? = null, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(22.dp)
    val color = if (excluded) c.danger else if (selected) c.onTint else c.text
    Row(Modifier.widthIn(min = 104.dp).heightIn(min = 44.dp).clip(shape).background(if (selected && !excluded) c.tint else c.filterBg)
        .border(1.dp, if (excluded) c.danger else if (selected) c.tint else c.border, shape)
        .then(if (remove == null) Modifier.selectable(selected = selected, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = if (excluded) "$label (${t("filters.excluded")})" else label } else Modifier)
        .padding(horizontal = 10.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = rnText(12, 600).copy(textDecoration = if (excluded) TextDecoration.LineThrough else null), color = color,
            textAlign = TextAlign.Center, maxLines = 2)
        remove?.let { spoken ->
            Box(Modifier.size(28.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = spoken },
                contentAlignment = Alignment.Center) { Icon(Lucide.X, null, tint = color, modifier = Modifier.size(16.dp)) }
        }
    }
}

/**
 * RN's sheet input: 44 high, bordered, the list background. [value] is the text as typed (the menu model keeps it with the
 * sheet until core has read it), else core's.
 */
@Composable
internal fun SheetField(value: String, placeholder: String, description: String, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(value, onChange, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = description },
        decorationBox = { inner ->
            Box(Modifier.heightIn(min = 44.dp).clip(shape).background(c.bg).border(1.dp, c.border, shape).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = rnText(15, 400), color = c.secondaryText)
                inner()
            }
        })
}

/**
 * RN's Move to section dialog (someday-view.tsx): a centered card, core's title, core's choices ("No section" first, the
 * current one filled), "+ New section…", and Cancel. A choice runs core's moveSomedayTasksToSection.
 */
@Composable
private fun MoveDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val taskIds = open.getJSONArray("taskIds").strings()
    val taskRevisions = open.optJSONObject("taskRevisions") ?: JSONObject()
    val reply = moveChoices
    DialogCard(model, dismissible = true) {
        val title = reply?.getString("title") ?: page?.view?.getJSONObject("text")?.getString("moveToSection").orEmpty()
        Text(title, style = rnText(17, 700), color = c.text,
            modifier = Modifier.semantics { heading() })
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val choices = reply?.getJSONObject("choices")
            for (choice in choices?.menuObjects("items").orEmpty()) {
                val selected = choice.getBoolean("selected")
                val title = choice.getString("title")
                Text(title, style = rnText(15, 400), color = if (selected) c.onTint else c.text, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp)
                    .clip(RoundedCornerShape(8.dp)).background(if (selected) c.tint else c.filterBg).border(1.dp, if (selected) c.tint else c.border, RoundedCornerShape(8.dp))
                    .selectable(selected = selected, enabled = idle, role = Role.Button) { move(taskIds, choice.menuText("sectionId"), taskRevisions) }
                    .semantics { contentDescription = title }.padding(horizontal = 12.dp, vertical = 12.dp))
            }
            if (choices != null && choices.menuObjects("items").size < choices.getInt("total")) MoreChip(idle) { moreMoveChoices() }
            reply?.getString("newSectionLabel")?.let { label ->
                Text(label, style = rnText(15, 400), color = c.tint, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(RoundedCornerShape(8.dp))
                    .background(c.filterBg).border(1.dp, c.border, RoundedCornerShape(8.dp)).clickable(enabled = idle, role = Role.Button) { openNewSection(taskIds, taskRevisions) }
                    .semantics { contentDescription = label }.padding(horizontal = 12.dp, vertical = 12.dp))
            }
        }
        Text(reply?.getString("cancelLabel") ?: t("common.cancel"), style = rnText(15, 400), color = c.secondaryText, modifier = Modifier.heightIn(min = 44.dp)
            .clickable(enabled = !model.busy, role = Role.Button) { keepDialog(null) }.padding(horizontal = 12.dp, vertical = 12.dp))
    }
}

/**
 * RN's name prompts: New section… (someday-section-picker.tsx) and a heading's Add task (someday-view.tsx), each a card with
 * its title, the field, core's failure line, Cancel and Save. Save sends the dialog's exact request (a capture UUID for a
 * task), written to disk first; while its retry is owed, the field is locked and Save re-sends it (RN's Retry).
 */
@Composable
private fun CreateDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val section = open.getString("kind") == "newSection"
    val action = createAction()
    val owed = model.failedAction != null && model.failedAction == action
    val canSave = action != null && model.writable && !model.busy && (model.failedAction == null || owed)
    val addText = page?.view?.optJSONObject("text")?.optJSONObject("addTask")
    DialogCard(model, dismissible = false) {
        Text(if (section) t("viewSections.add") else open.getString("title"), style = rnText(17, 700), color = c.text, modifier = Modifier.semantics { heading() })
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
        val label = if (section) t("viewSections.nameHint") else addText?.getString("inputLabel").orEmpty()
        val placeholder = if (section) t("viewSections.namePlaceholder") else addText?.getString("placeholder").orEmpty()
        val shape = RoundedCornerShape(8.dp)
        val text = open.optString("text")
        BasicTextField(text, { typeDialog(it) }, enabled = !owed && !model.busy, singleLine = true, textStyle = rnText(16, 400).copy(color = c.text),
            cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (canSave) saveCreate() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = label }.testTag("menu-dialog-field"),
            decorationBox = { inner ->
                Box(Modifier.heightIn(min = 44.dp).clip(shape).background(c.bg).border(1.dp, c.border, shape).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                    inner()
                }
            })
        open.menuText("error")?.let { Text(it, style = rnText(14, 400), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            val cancel = t("common.cancel")
            Box(Modifier.heightIn(min = 44.dp).widthIn(min = 88.dp).clip(shape).then(if (section) Modifier.border(1.dp, c.border, shape) else Modifier)
                .clickable(enabled = !owed && !model.busy, role = Role.Button) { backInDialog() }.semantics { contentDescription = cancel }
                .padding(horizontal = 14.dp), contentAlignment = Alignment.Center) { Text(cancel, style = rnText(15, 400), color = c.secondaryText) }
            val save = if (owed && !section) addText?.getString("retryLabel") ?: t("common.retry") else t("common.save")
            Box(Modifier.fade(if (canSave) 1f else 0.5f).heightIn(min = 44.dp).widthIn(min = 88.dp).clip(shape).background(if (section) theme.restoreAction else c.tint)
                .clickable(enabled = canSave, role = Role.Button) { saveCreate() }.semantics { contentDescription = save }
                .padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(save, style = rnText(15, if (section) 600 else 400), color = if (section) theme.onAction else c.onTint)
            }
        }
    }
}

/**
 * RN's picker card: a dimmed screen (0.45) and a centered card, 88% wide, radius 14, over the keyboard. Only the move
 * dialog's backdrop closes it ([dismissible]); RN's name prompts sit on a plain overlay.
 */
@Composable
internal fun DialogCard(model: InboxViewModel, dismissible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    Box(Modifier.fillMaxSize().background(theme.pickerScrim)
        .then(if (dismissible) Modifier.clickable(role = Role.Button) { if (!model.busy) model.menu.backInDialog() } else Modifier.pointerInput(Unit) { detectTapGestures { } })
        .imePadding(), contentAlignment = Alignment.Center) {
        Column(Modifier.fillMaxWidth(0.88f).heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.8f).dp).clip(RoundedCornerShape(14.dp))
            .background(c.cardBg).border(1.dp, c.border, RoundedCornerShape(14.dp)).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}

/** A list's More at its end: core's next window (core's `common.more`), as on the other lists. */
@Composable
fun MoreRow(model: InboxViewModel) {
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        PillButton(t("common.more"), onClick = model.menu::loadMore, enabled = model.menu.idle)
    }
}
