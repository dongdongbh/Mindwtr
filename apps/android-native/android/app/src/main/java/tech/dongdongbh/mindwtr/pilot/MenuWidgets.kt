package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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


fun JSONObject.menuObjects(name: String): List<JSONObject> = optJSONArray(name)?.let { list -> List(list.length()) { list.getJSONObject(it) } }.orEmpty()
fun JSONObject.menuText(name: String): String? = if (!has(name) || isNull(name)) null else getString(name)


@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun MenuScreenHost(model: InboxViewModel, screen: MenuScreen) = with(model) {
    val c = LocalTheme.current.colors
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) { owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { menu.refresh() } }

    ReadAgainAt(menu.page?.let { shown -> clockReadAt(shown.items.map { it.row }, shown.view) }) { menu.refresh() }

    BackHandler(enabled = failedAction == null) { if (menu.dialog != null) menu.backInDialog() else if (menu.page?.bulk != null) menu.list?.let(menu::endBulk) else menu.closeScreen() }
    Box(Modifier.fillMaxSize().background(c.bg).systemBarsPadding().semantics { testTagsAsResourceId = true }.testTag("menu-screen")) {
        when (screen) {
            MenuScreen.Weekly -> WeeklyReview(model)
            MenuScreen.Daily -> DailyReview(model)

            MenuScreen.MindSweep -> MindSweepScreen(model)
            else -> Column(Modifier.fillMaxSize()) {
                val list = menu.list

                val title = when (screen) {
                    MenuScreen.Settings -> menu.settings.title

                    MenuScreen.WidgetList -> menu.page?.view?.menuText("title").orEmpty()
                    else -> t(screen.title)
                }
                if (screen != MenuScreen.Projects || openProjectId == null) MenuHeader(title, enabled = failedAction == null, onBack = menu::closeScreen,
                    area = if (showsAreaFilter(screen)) model else null,

                    right = if (list == "reference" || list == "done") { { OverflowTrigger(plain = true) { menu.openDialog("overflow") } } } else null)
                error?.let { message ->
                    FailureBanner(message) {
                        if (failedAction == null) RetryButton({ menu.retryRead() }, !busy, "read-retry")
                        else OwedRetry(model)
                    }
                }
                if (screen == MenuScreen.History) HistoryTabs(model)

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
        if (areaSheet) AreaSheet(model)
    }
}


@Composable
fun QuickList(model: InboxViewModel, modifier: Modifier) = with(model) {
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner) { owner.repeatOnLifecycle(Lifecycle.State.RESUMED) { menu.refresh() } }
    ReadAgainAt(menu.page?.let { shown -> clockReadAt(shown.items.map { it.row }, shown.view) }) { menu.refresh() }
    BackHandler(enabled = failedAction == null && menu.dialog != null) { menu.backInDialog() }
    Box(modifier) {
        when (menu.list) {
            "contexts" -> ContextsList(model)
            "review" -> ReviewList(model)
            "calendar" -> CalendarList(model)
        }
    }
}


@Composable
fun MenuHeader(title: String, enabled: Boolean, onBack: () -> Unit, area: InboxViewModel? = null, right: (@Composable () -> Unit)? = null) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().height(52.dp).background(c.cardBg).hairline(c.border, top = false).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically) {
        val back = t("common.back")
        Box(Modifier.size(40.dp).clickable(enabled = enabled, role = Role.Button, onClick = onBack)
            .semantics { contentDescription = back }, contentAlignment = Alignment.Center) {
            Icon(Ionicons.ChevronBack, null, tint = c.text, modifier = Modifier.size(24.dp))
        }
        Text(title, style = rnText(17, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            modifier = Modifier.weight(1f).padding(horizontal = 4.dp).semantics { heading() })
        area?.let { AreaTrigger(it) }
        if (right != null || area == null) Box(Modifier.size(44.dp), contentAlignment = Alignment.Center) { right?.invoke() }
    }
}


@Composable
fun OverflowTrigger(plain: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    val label = t("taskEdit.moreOptions")
    Box(Modifier.size(44.dp).clip(shape).then(if (plain) Modifier else Modifier.background(c.filterBg).rnBorder(1.dp, c.border, shape))
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
        Icon(Lucide.MoreHorizontal, null, tint = c.secondaryText, modifier = Modifier.size(20.dp))
    }
}


class OverflowAction(val label: String, val icon: ImageVector, val description: String = label, val value: String? = null,
                     val selected: Boolean = false, val page: String? = null, val onClick: () -> Unit = {})


@Composable
fun OverflowSheet(model: InboxViewModel, title: String, actions: List<OverflowAction>) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val close = t("common.close")
    Box(Modifier.fillMaxSize().background(theme.overflowScrim).clickable(role = Role.Button) { keepDialog(null) }
        .semantics { contentDescription = close }.padding(start = 12.dp, end = 12.dp, top = 24.dp)) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.align(Alignment.BottomCenter).widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.82f).dp)
            .clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
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
            Column(Modifier.verticalScroll(rememberScrollState()).clip(section).rnBorder(1.dp, c.border, section)) {
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


class Choice(val label: String, val selected: Boolean, val onClick: () -> Unit)


@Composable
fun ChoiceModal(model: InboxViewModel, title: String, choices: List<Choice>, dismiss: () -> Unit = { model.menu.keepDialog(null) }) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).clickable(role = Role.Button, onClick = dismiss).padding(20.dp),
        contentAlignment = Alignment.Center) {
        Column(Modifier.widthIn(max = 360.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.cardBg)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = rnText(16, 700), color = c.text, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().semantics { heading() })
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (choice in choices) {
                    Text(choice.label, style = rnText(14, 400), color = c.text, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp))
                        .then(if (choice.selected) Modifier.background(c.filterBg) else Modifier)
                        .selectable(selected = choice.selected, enabled = idle, role = Role.Button) { dismiss(); choice.onClick() }
                        .padding(horizontal = 10.dp, vertical = 8.dp))
                }
            }
        }
    }
}


@Composable
fun ActiveChips(model: InboxViewModel, chips: List<JSONObject>, clear: (() -> Unit)?) = with(model.menu) {
    if (chips.isEmpty()) return
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).horizontalScroll(rememberScrollState())
        .padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        for (chip in chips) {
            val excluded = chip.optBoolean("excluded")
            val accent = if (excluded) c.danger else c.tint
            val label = chip.getString("label")
            val spoken = chip.menuText("accessibilityLabel")
                ?: if (excluded) "${t("filters.remove")}: $label (${t("filters.excluded")})" else "${t("filters.remove")}: $label"
            Row(Modifier.clip(CircleShape).background(c.filterBg).rnBorder(1.dp, accent, CircleShape)
                .clickable(enabled = idle, role = Role.Button) { removeChip(chip.getJSONObject("action")) }
                .semantics { contentDescription = spoken }.padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(label, style = rnText(12, 600).copy(textDecoration = if (excluded) TextDecoration.LineThrough else null), color = accent)
                Icon(Lucide.X, null, tint = accent, modifier = Modifier.size(14.dp))
            }
        }
        clear?.let { onClear ->
            val label = t("filters.clear")
            Text(label, style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.clip(CircleShape).background(c.filterBg).rnBorder(1.dp, c.border, CircleShape)
                .clickable(enabled = idle, role = Role.Button, onClick = onClear).padding(horizontal = 12.dp, vertical = 6.dp))
        }
    }
}


@Composable
fun ActiveFiltersButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.heightIn(min = 44.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.tint, shape)
        .selectable(selected = true, enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label }
        .padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Icon(Lucide.SlidersHorizontal, null, tint = c.tint, modifier = Modifier.size(16.dp))
        Text(label, style = rnText(13, 700), color = c.tint)
    }
}


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
            Text(label, style = rnText(12, 600), color = c.text, modifier = Modifier.padding(top = 12.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
                .clickable(role = Role.Button, onClick = onAction).padding(horizontal = 12.dp, vertical = 6.dp))
        }
    }
}


@Composable
fun StatBar(stats: JSONArray, color: Color, trailing: @Composable RowScope.() -> Unit = {}) {
    val theme = LocalTheme.current
    val c = theme.colors
    Row(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).padding(16.dp),
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


@Composable
fun MoreChip(enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Text(t("common.more"), style = rnText(12, 600), color = c.tint, modifier = Modifier.clip(CircleShape).rnBorder(1.dp, c.border, CircleShape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp))
}


@Composable
fun DeferredProjects(model: InboxViewModel, page: MenuPage) = with(model.menu) {
    val deferred = page.view.optJSONObject("deferred") ?: return
    val c = LocalTheme.current.colors
    var open by rememberSaveable { mutableStateOf(true) }
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.padding(bottom = 12.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
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


@Composable
internal fun ParkedProject(model: InboxViewModel, project: JSONObject, activate: String, moveLabel: String? = null) = with(model) {
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
            Box(Modifier.matchParentSize().clip(shape).background(c.tint).rnBorder(1.dp, c.border, shape).padding(horizontal = 16.dp),
                contentAlignment = Alignment.CenterStart) { Text(activate, style = rnText(14, 600), color = c.onTint) }
        }
        val title = project.getString("title")
        Row(Modifier.offset { IntOffset(offset.value.roundToInt(), 0) }.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .draggable(rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceAtLeast(0f)) } }, Orientation.Horizontal,
                enabled = enabled, onDragStopped = {
                    val opened = with(density) { offset.value.toDp() } > 72.dp
                    scope.launch { offset.animateTo(0f) }
                    if (opened) menu.activate(id, revision)
                })

            .combinedClickable(enabled = failedAction == null && !busy, role = Role.Button,
                onLongClick = moveLabel?.let { { if (enabled) menu.openProjectMove(id, revision) } }) { menu.openProjects(id) }
            .semantics {
                contentDescription = title
                customActions = listOf(CustomAccessibilityAction(activate) { if (enabled) menu.activate(id, revision); enabled }) +
                    listOfNotNull(moveLabel?.let { CustomAccessibilityAction(it) { if (enabled) menu.openProjectMove(id, revision); enabled } })
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


@Composable
fun MenuDialogs(model: InboxViewModel) = with(model.menu) {
    val open = dialog ?: return
    val view = page?.view

    val controls = if (list == "inbox") view?.optJSONObject("toolbar") else view
    when (open.optString("kind")) {
        "overflow" -> view?.let { OverflowFor(model, it, open) }
        "filters" -> view?.let { FilterSheet(model.menu, if (list == "contexts") JSONObject(it.toString()).put("chips", it.optJSONArray("filterChips") ?: JSONArray()) else it, open) }
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

        "savedSearchSort" -> view?.optJSONObject("sort")?.let { modal ->
            ChoiceModal(model, modal.getString("title"), modal.menuObjects("options").map { option ->
                Choice(option.getString("label"), option.getBoolean("selected")) { savedSearchSort(option.getJSONObject("edit")) }
            })
        }
        "completedAt" -> CompletedAtPicker(model, open)
        "bulkTag" -> AddTagDialog(model, open)
        "organize" -> OrganizeDialog(model, open)
        "move" -> MoveDialog(model, open)
        "newSection", "addTask", "contextsSave" -> CreateDialog(model, open)
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


interface FilterSheetHost {
    val idle: Boolean

    val filterRevision: String?

    val pickerFound: JSONObject?
    fun collection(name: String): List<JSONObject>
    fun collectionTotal(name: String): Int
    fun filterEdit(edit: JSONObject)
    fun removeChip(action: JSONObject)
    fun typeFilter(type: String, text: String)
    fun toggleDisclosure(id: String)
    fun dialogPage(page: String?)
    fun closeFilters()
    fun pickerQuery(name: String, text: String)

    fun searchPicker(name: String, query: String, depth: Int = 100)
    fun loadCollection(name: String)

    fun archivedProjects(on: Boolean) {}
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun FilterSheet(host: FilterSheetHost, view: JSONObject, open: JSONObject) = with(host) {
    val theme = LocalTheme.current
    val c = theme.colors
    val filters = view.getJSONObject("filters")
    val state = filters.getJSONObject("state")
    val visibility = filters.getJSONObject("visibility")
    val revision = filterRevision ?: return
    val picker = open.menuText("page")
    val all = t("common.all")
    val excluded = t("filters.excluded")
    val close = t("common.close")
    Box(Modifier.fillMaxSize().background(theme.scrim).clickable(role = Role.Button) { closeFilters() }.semantics { contentDescription = close }) {
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        val tall = (LocalConfiguration.current.screenHeightDp * 0.82f).dp
        Column(Modifier.align(Alignment.BottomCenter).imePadding().fillMaxWidth().then(if (picker != null) Modifier.height(tall) else Modifier.heightIn(max = tall))
            .clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
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


                val query = open.optString("query")
                val found = pickerFound?.takeIf { it.getString("name") == name && it.getString("query") == query && it.getString("revision") == revision }
                LaunchedEffect(revision, name) { if (query.isNotBlank()) searchPicker(name, query, pickerFound?.optJSONArray("items")?.length() ?: 0) }
                Box(Modifier.padding(bottom = 10.dp)) {
                    SheetField(query, t("common.search"), "${t("common.search")} ${t(if (name == "tokens") "filters.contexts" else "filters.projects")}") { pickerQuery(name, it) }
                }
                val options = if (query.isBlank()) collection(name) else found?.menuObjects("items").orEmpty()
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                    if (options.isEmpty() && (query.isBlank() || found != null)) Text(t("search.noResults"), style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 28.dp))
                    for (option in options) {
                        val label = option.optString("title").ifEmpty { option.getString("value") }
                        val out = option.optString("state") == "excluded" || option.optBoolean("excluded")
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
                    if (query.isBlank() && options.size < collectionTotal(name)) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { loadCollection(name) } }
                    if (found != null && options.size < found.getInt("total")) Box(Modifier.padding(vertical = 8.dp)) { MoreChip(idle) { searchPicker(name, query, options.size + 100) } }

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
                        val statuses = filters.menuObjects("statuses")
                        if (statuses.isNotEmpty()) {
                            SheetLabel(t("taskEdit.statusLabel"))
                            ChipFlow(statuses, idle) { filterEdit(it) }
                        }
                        filters.optJSONObject("taskDates")?.let { dates ->
                            Disclosure(dates.getString("label"), dates.menuObjects("options"), all, open.optBoolean("taskDates"), idle,
                                { toggleDisclosure("taskDates") }) { filterEdit(it) }
                        }
                        val tokens = collection("tokens")
                        if (tokens.isNotEmpty() || collectionTotal("tokens") > 0) {
                            val picked = state.optJSONArray("tokens").strings() + state.optJSONArray("excludedTokens").strings().map { "$excluded: $it" }
                            OverviewRow(t("filters.contexts"), picked.joinToString(", ").ifEmpty { all }, all, null) { dialogPage("tokens") }
                        }
                        val projects = collection("projects")
                        if (projects.isNotEmpty()) {
                            val chosen = projects.chosenLabels(excluded).joinToString(", ")
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
                    .clickable(role = Role.Button) { closeFilters() }.padding(horizontal = 10.dp, vertical = 12.dp))
            }
        }
    }
}

private fun JSONArray?.strings(): List<String> = this?.let { list -> List(list.length()) { list.getString(it) } }.orEmpty()

private fun List<JSONObject>.chosenLabels(excludedLabel: String? = null): List<String> = mapNotNull { option ->
    val label = option.optString("title").ifEmpty { option.optString("label") }
    when {
        excludedLabel != null && option.optBoolean("excluded") -> "$excludedLabel: $label"
        option.optBoolean("selected") -> label
        else -> null
    }
}

@Composable
internal fun SheetLabel(text: String) = Text(text.uppercase(), style = rnText(12, 600, letterSpacing = 0.4f), color = LocalTheme.current.colors.secondaryText)


@Composable
internal fun OverviewRow(label: String, summary: String, all: String, expanded: Boolean?, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().heightIn(min = 60.dp).clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape).clickable(role = Role.Button, onClick = onClick)
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


@Composable
internal fun Disclosure(label: String, options: List<JSONObject>, all: String, open: Boolean, enabled: Boolean, onToggle: () -> Unit,
                        summary: String? = null, onEdit: (JSONObject) -> Unit) {
    OverviewRow(label, summary ?: options.chosenLabels().joinToString(", ").ifEmpty { all }, all, open, onToggle)
    if (open) Box(Modifier.padding(start = 4.dp, end = 4.dp, top = 10.dp)) { ChipFlow(options, enabled, onEdit) }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ChipFlow(options: List<JSONObject>, enabled: Boolean, onEdit: (JSONObject) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (option in options) SheetChip(option.getString("label"), option.getBoolean("selected"), false, enabled = enabled) {
            onEdit(option.getJSONObject("edit"))
        }
    }
}


@Composable
internal fun MatchModeRow(label: String, options: List<JSONObject>, enabled: Boolean, onEdit: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = rnText(12, 600), color = c.secondaryText)
        val shape = RoundedCornerShape(18.dp)
        Row(Modifier.heightIn(min = 36.dp).clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape).padding(2.dp)) {
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


@Composable
internal fun SheetChip(label: String, selected: Boolean, excluded: Boolean, remove: String? = null, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(22.dp)
    val color = if (excluded) c.danger else if (selected) c.onTint else c.text
    Row(Modifier.widthIn(min = 104.dp).heightIn(min = 44.dp).clip(shape).background(if (selected && !excluded) c.tint else c.filterBg)
        .rnBorder(1.dp, if (excluded) c.danger else if (selected) c.tint else c.border, shape)
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


@Composable
internal fun SheetField(value: String, placeholder: String, description: String, onChange: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(value, onChange, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = description },
        decorationBox = { inner ->
            Box(Modifier.heightIn(min = 44.dp).clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Text(placeholder, style = rnText(15, 400), color = c.secondaryText)
                inner()
            }
        })
}


@Composable
private fun MoveDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val taskIds = open.optJSONArray("taskIds")?.strings().orEmpty()
    val taskRevisions = open.optJSONObject("taskRevisions") ?: JSONObject()

    val project = open.optString("projectId").ifEmpty { null }?.let { it to open.getString("projectRevision") }
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
                    .clip(RoundedCornerShape(8.dp)).background(if (selected) c.tint else c.filterBg).rnBorder(1.dp, if (selected) c.tint else c.border, RoundedCornerShape(8.dp))
                    .selectable(selected = selected, enabled = idle, role = Role.Button) {
                        if (project != null) moveProject(project.first, choice.menuText("sectionId"), project.second) else move(taskIds, choice.menuText("sectionId"), taskRevisions)
                    }
                    .semantics { contentDescription = title }.padding(horizontal = 12.dp, vertical = 12.dp))
            }
            if (choices != null && choices.menuObjects("items").size < choices.getInt("total")) MoreChip(idle) { moreMoveChoices() }
            reply?.getString("newSectionLabel")?.let { label ->
                Text(label, style = rnText(15, 400), color = c.tint, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(RoundedCornerShape(8.dp))
                    .background(c.filterBg).rnBorder(1.dp, c.border, RoundedCornerShape(8.dp)).clickable(enabled = idle, role = Role.Button) { if (project != null) openNewSection(project = project) else openNewSection(taskIds, taskRevisions) }
                    .semantics { contentDescription = label }.padding(horizontal = 12.dp, vertical = 12.dp))
            }
        }
        Text(reply?.getString("cancelLabel") ?: t("common.cancel"), style = rnText(15, 400), color = c.secondaryText, modifier = Modifier.heightIn(min = 44.dp)
            .clickable(enabled = !model.busy, role = Role.Button) { keepDialog(null) }.padding(horizontal = 12.dp, vertical = 12.dp))
    }
}


@Composable
private fun CreateDialog(model: InboxViewModel, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val section = open.getString("kind") == "newSection"
    val contextsSave = open.getString("kind") == "contextsSave"
    val action = createAction()
    val owed = model.failedAction != null && model.failedAction == action
    val canSave = action != null && model.writable && !model.busy && (model.failedAction == null || owed)
    val addText = page?.view?.optJSONObject("text")?.optJSONObject("addTask")
    DialogCard(model, dismissible = false) {
        Text(if (section) t("viewSections.add") else if (contextsSave) t("savedFilters.saveTitle") else open.getString("title"), style = rnText(17, 700), color = c.text, modifier = Modifier.semantics { heading() })
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
        val label = if (section) t("viewSections.nameHint") else if (contextsSave) t("savedFilters.namePlaceholder") else addText?.getString("inputLabel").orEmpty()
        val placeholder = if (section) t("viewSections.namePlaceholder") else if (contextsSave) t("savedFilters.namePlaceholder") else addText?.getString("placeholder").orEmpty()
        val shape = RoundedCornerShape(8.dp)
        val text = open.optString("text")
        BasicTextField(text, { typeDialog(it) }, enabled = !owed && !model.busy, singleLine = true, textStyle = rnText(16, 400).copy(color = c.text),
            cursorBrush = SolidColor(c.tint), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (canSave) saveCreate() }),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = label }.testTag("menu-dialog-field"),
            decorationBox = { inner ->
                Box(Modifier.heightIn(min = 44.dp).clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
                    if (text.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                    inner()
                }
            })
        open.menuText("error")?.let { Text(it, style = rnText(14, 400), color = c.danger, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive }) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
            val cancel = t("common.cancel")
            Box(Modifier.heightIn(min = 44.dp).widthIn(min = 88.dp).clip(shape).then(if (section) Modifier.rnBorder(1.dp, c.border, shape) else Modifier)
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


@Composable
internal fun DialogCard(model: InboxViewModel, dismissible: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    Box(Modifier.fillMaxSize().background(theme.pickerScrim)
        .then(if (dismissible) Modifier.clickable(role = Role.Button) { if (!model.busy) model.menu.backInDialog() } else Modifier.pointerInput(Unit) { detectTapGestures { } })
        .imePadding(), contentAlignment = Alignment.Center) {
        Column(Modifier.fillMaxWidth(0.88f).heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.8f).dp).clip(RoundedCornerShape(14.dp))
            .background(c.cardBg).rnBorder(1.dp, c.border, RoundedCornerShape(14.dp)).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    }
}


@Composable
fun MoreRow(model: InboxViewModel) {
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        PillButton(t("common.more"), onClick = model.menu::loadMore, enabled = model.menu.idle)
    }
}
