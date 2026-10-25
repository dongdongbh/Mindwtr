package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * RN's Menu tab (the last tab): the lucide Menu glyph and core's `tab.menu`, in the tint while the More sheet is open.
 * A tap opens the sheet or closes it, as RN's tab does.
 */
@Composable
fun RowScope.MenuTab(model: InboxViewModel) {
    val c = LocalTheme.current.colors
    val open = model.menu.sheet
    val color = if (open) c.tabIconSelected else c.tabIconDefault
    Column(
        Modifier.weight(1f).fillMaxHeight().selectable(selected = open, role = Role.Tab, onClick = { model.menu.toggleSheet() }),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box {
            Icon(Lucide.Menu, null, tint = color, modifier = Modifier.size(if (open) 26.dp else 24.dp).fade(if (open) 1f else 0.8f))
            // RN's menuSyncDot: the sync badge's color, top right of the glyph; hidden from TalkBack, as RN's is. Its opacity goes
            // after the offset: a layer placed before it drew nothing on the phone.
            coreColorOrNull(model.syncBadge.color)?.let { dot ->
                Box(Modifier.align(Alignment.TopEnd).offset(x = 7.dp, y = (-2).dp).size(7.dp).fade(0.85f).clip(CircleShape).background(dot)
                    .rnBorder(1.5.dp, c.cardBg, CircleShape).clearAndSetSemantics { }.testTag("menu-sync-dot"))
            }
        }
        Text(t("tab.menu"), style = rnText(10, if (open) 700 else 600, 12), color = color, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
    }
}

/** A sheet destination this app opens (core's `route` names a screen built here), or RN's look drawn disabled. */
private fun JSONObject.icon(): ImageVector? = Ionicons.bySymbol[getString("icon")]

/**
 * RN's More sheet (MoreNavigationSheet), over the list and above the tab bar: a dimmed backdrop that closes it, and a
 * card from the bottom with RN's handle, core's utilities row (Trash, Board, History, Settings), core's saved searches,
 * a divider, and core's tiles, three to a row. A destination this app builds opens it; the others keep RN's look but are
 * drawn dimmed and disabled (TalkBack hears "disabled"), never a dead tap. It slides up; a drag down past 72 closes it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun MoreSheet(model: InboxViewModel) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val density = LocalDensity.current
    val height = LocalConfiguration.current.screenHeightDp
    val hidden = with(density) { height.dp.toPx() }
    val offset = remember { Animatable(hidden) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { offset.animateTo(0f, tween(220)) }
    val dismiss = { scope.launch { offset.animateTo(hidden, tween(180)); closeSheet() }; Unit }
    BackHandler { dismiss() }
    Box(Modifier.fillMaxSize().testTag("more-sheet")) {
        val close = t("common.close")
        Box(Modifier.fillMaxSize().background(theme.sheetScrim).clickable(role = Role.Button) { dismiss() }.semantics { contentDescription = close })
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = (height * 0.82f).dp)
                .offset { IntOffset(0, offset.value.roundToInt()) }
                .draggable(
                    state = rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceAtLeast(0f)) } },
                    orientation = Orientation.Vertical,
                    onDragStopped = { velocity ->
                        val dragged = with(density) { offset.value.toDp() }
                        if (dragged > 72.dp || (dragged > 24.dp && velocity > with(density) { 750.dp.toPx() })) dismiss()
                        else scope.launch { offset.animateTo(0f, tween(140)) }
                    },
                )
                .clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }
                .padding(start = 18.dp, end = 18.dp, top = 10.dp, bottom = 16.dp),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).padding(bottom = 18.dp).size(44.dp, 5.dp).clip(RoundedCornerShape(3.dp)).background(c.border))
            val sheet = more
            Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
                if (sheet != null) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (item in sheet.view.list("utilities")) CompactItem(model, item, Modifier.weight(1f))
                    }
                    val searches = sheet.collection("savedSearches")
                    if (searches.isNotEmpty()) {
                        Column(Modifier.padding(top = 18.dp)) {
                            Text(sheet.view.getString("savedSearchesTitle").uppercase(), style = rnText(12, 800), color = c.secondaryText,
                                modifier = Modifier.padding(bottom = 8.dp))
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                for (item in searches) CompactItem(model, item, Modifier.width(76.dp))
                                if (searches.size < sheet.collectionTotal("savedSearches")) {
                                    MoreChip(idle) { loadCollection("savedSearches") }
                                }
                            }
                        }
                    }
                    Box(Modifier.padding(vertical = 12.dp).fillMaxWidth().height(1.dp).background(c.border))
                    FlowRow(Modifier.fillMaxWidth(), maxItemsInEachRow = 3, horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        for (item in sheet.view.list("primary")) Tile(model, item, Modifier.weight(1f))
                    }
                }
            }
        }
    }
}

/** RN's MoreSheetTile: a bordered card, core's icon in its color on a 44 square, and core's display label. */
@Composable
private fun Tile(model: InboxViewModel, item: JSONObject, modifier: Modifier) {
    val c = LocalTheme.current.colors
    val id = item.getString("id")
    val opens = model.menu.opens(id)
    val enabled = opens && model.menu.idle
    val shape = RoundedCornerShape(8.dp)
    val label = item.getString("label")
    Column(
        modifier.fade(if (enabled) 1f else 0.45f).heightIn(min = 104.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            // One accessibility node holds the label, the role and the state (a separate semantics node kept
            // "enabled" on the labelled node, so TalkBack read a missing screen as a working button).
            .clearAndSetSemantics {
                contentDescription = label; role = Role.Button
                if (enabled) onClick { model.menu.openTile(id); true } else disabled()
            }
            .clickable(enabled = enabled) { model.menu.openTile(id) }
            .padding(horizontal = 8.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box(Modifier.padding(bottom = 8.dp).size(44.dp).clip(shape).background(c.filterBg), contentAlignment = Alignment.Center) {
            item.icon()?.let { Icon(it, null, tint = coreColorOrNull(item.getString("iconColor")) ?: c.tint, modifier = Modifier.size(24.dp)) }
        }
        Text(item.getString("displayLabel"), style = rnText(12, 700, 15), color = c.text, textAlign = TextAlign.Center, maxLines = 2,
            overflow = TextOverflow.Ellipsis)
    }
}

/** RN's MoreSheetCompactItem: core's icon (18, at 64%) over its display label, 10/700 in the secondary text color. */
@Composable
private fun CompactItem(model: InboxViewModel, item: JSONObject, modifier: Modifier) {
    val c = LocalTheme.current.colors
    val id = item.getString("id")
    val opens = model.menu.opens(id)
    val enabled = opens && model.menu.idle
    val label = item.getString("label")
    Column(
        modifier.heightIn(min = 58.dp).clip(RoundedCornerShape(8.dp))
            // One accessibility node holds the label, the role and the state (a separate semantics node kept
            // "enabled" on the labelled node, so TalkBack read a missing screen as a working button).
            .clearAndSetSemantics {
                contentDescription = label; role = Role.Button
                if (enabled) onClick { model.menu.openTile(id); true } else disabled()
            }
            .clickable(enabled = enabled) { model.menu.openTile(id) }.fade(if (enabled) 1f else 0.45f)
            .padding(horizontal = 2.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        item.icon()?.let { Icon(it, null, tint = coreColorOrNull(item.getString("iconColor")) ?: c.tint, modifier = Modifier.size(18.dp).fade(0.64f)) }
        Text(item.getString("displayLabel"), style = rnText(10, 700, 12), color = c.secondaryText, textAlign = TextAlign.Center, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp).heightIn(min = 16.dp))
    }
}

private fun JSONObject.list(name: String): List<JSONObject> = optJSONArray(name)?.let { items -> List(items.length()) { items.getJSONObject(it) } }.orEmpty()
