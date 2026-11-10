package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.min
import org.json.JSONObject


@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AreaOrderSheet(model: InboxViewModel, sheet: JSONObject) = with(model) {
    val c = LocalTheme.current.colors
    LaunchedEffect(projects, busy) { if (!busy) readAreaManager() }
    BackHandler(onBack = ::closeAreaManager)

    val loaded = sheet.has("areas")
    val enabled = loaded && writable && !busy && failedAction == null
    val draft = areaManagerDraft
    val colors = sheet.optJSONArray("colors")?.let { list -> List(list.length()) { list.getString(it) } }.orEmpty()
    val danger = Color(0xFFEF4444)
    val height = LocalConfiguration.current.screenHeightDp.dp
    @Composable
    fun Swatch(color: String, selected: Boolean, label: String, tag: String, onPick: () -> Unit) =
        Box(Modifier.size(32.dp).clip(CircleShape).background(coreColorOrNull(color) ?: c.tint)
            .rnBorder(2.dp, if (selected) Color.Black else Color.Transparent, CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onPick).semantics { contentDescription = label; this.selected = selected }.testTag(tag))
    Box(Modifier.fillMaxSize().background(LocalTheme.current.pickerScrim).pointerInput(Unit) { detectTapGestures { closeAreaManager() } }
        .imePadding().padding(20.dp).semantics { testTagsAsResourceId = true }, contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(min = 280.dp, max = 360.dp).heightIn(max = min(height * 0.8f, 560.dp)).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).verticalScroll(rememberScrollState()).testTag("project-area-manager")) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(t("projects.manageAreas"), style = rnText(16, 700), color = c.text, modifier = Modifier.weight(1f).padding(bottom = 12.dp).semantics { heading() })
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((kind, key) in listOf("sortName" to "projects.sortByName", "sortColor" to "projects.sortByColor")) {
                        val buttonShape = RoundedCornerShape(8.dp)
                        Box(Modifier.heightIn(min = 44.dp).clip(buttonShape).rnBorder(1.dp, c.border, buttonShape)
                            .clickable(enabled = enabled, role = Role.Button) { orderAreas(JSONObject().put("kind", kind)) }
                            .testTag("project-area-$kind").padding(horizontal = 8.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
                            Text(t(key), style = rnText(12, 600), color = c.secondaryText)
                        }
                    }
                }
            }
            val areas = sheet.menuObjects("areas")
            val focus = draft.focus
            if (loaded && areas.isEmpty()) Text(t("projects.noArea"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
            else if (loaded) Column(Modifier.heightIn(min = if (focus == null) 120.dp else 0.dp, max = min(height * 0.45f, 320.dp)).verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
                areas.forEachIndexed { index, area ->
                    val id = area.getString("id")
                    if (focus != null && id != focus) return@forEachIndexed
                    val name = area.getString("name")
                    val shown = area.menuText("color")
                    val inUse = area.getBoolean("inUse")
                    @Composable
                    fun Name(modifier: Modifier) {
                        val renameLabel = "${t("projects.renameArea")}: $name"
                        Row(modifier.heightIn(min = 44.dp).clickable(enabled = enabled, role = Role.Button) { startAreaRename(id, name) }
                            .semantics { contentDescription = renameLabel }.testTag("project-area-name-$id"), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(10.dp).clip(CircleShape).background(LocalTheme.current.identityColorOrNull(shown) ?: c.tint))
                            Text(name, style = rnText(14, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp, end = 8.dp))
                        }
                    }
                    @Composable
                    fun Order(label: String, arrow: String, on: Boolean, tag: String, run: () -> Unit) =
                        Box(Modifier.size(44.dp).fade(if (on) 1f else 0.5f).clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = on && enabled, role = Role.Button, onClick = run)
                            .semantics { contentDescription = label; if (!on) disabled() }.testTag(tag), contentAlignment = Alignment.Center) {
                            Text(arrow, style = rnText(12, 700), color = c.text)
                        }
                    @Composable
                    fun Actions() {
                        Order("${t("projects.moveUp")}: $name", "↑", index > 0, "project-area-move-up-$id") { orderAreas(JSONObject().put("kind", "moveUp").put("areaId", id)) }
                        if (focus != null) Order("${t("projects.moveDown")}: $name", "↓", index < areas.size - 1, "project-area-move-down-$id") {
                            orderAreas(JSONObject().put("kind", "moveUp").put("areaId", areas[index + 1].getString("id")))
                        }
                        val toggleShape = RoundedCornerShape(8.dp)
                        val colorLabel = "${t("projects.changeColor")}: $name"
                        Box(Modifier.padding(start = 8.dp).clip(toggleShape).rnBorder(1.dp, c.border, toggleShape)
                            .clickable(enabled = enabled, role = Role.Button) { expandAreaColor(if (draft.expanded == id) null else id) }
                            .semantics { contentDescription = colorLabel }.testTag("project-area-color-$id").padding(6.dp)) {
                            Box(Modifier.size(32.dp).clip(CircleShape).background(coreColorOrNull(shown) ?: c.tint))
                        }
                        val deleteLabel = "${t("common.delete")}: $name"
                        Box(Modifier.padding(start = 8.dp).heightIn(min = 44.dp).fade(if (inUse) 0.6f else 1f)
                            .clickable(enabled = !inUse && enabled, role = Role.Button) { deleteArea(area) }
                            .semantics { contentDescription = deleteLabel; if (inUse) disabled() }.testTag("project-area-delete-$id").padding(horizontal = 6.dp, vertical = 4.dp),
                            contentAlignment = Alignment.Center) {
                            Text(t("common.delete"), style = rnText(12, 700), color = if (inUse) c.secondaryText else danger)
                        }
                    }
                    if (focus == null) Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(vertical = 8.dp).testTag("project-area-row-$id"), verticalAlignment = Alignment.CenterVertically) {
                        Name(Modifier.weight(1f))
                        Actions()
                    } else Column(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(vertical = 8.dp).testTag("project-area-row-$id")) {
                        Name(Modifier.fillMaxWidth())
                        FlowRow(verticalArrangement = Arrangement.Center) { Actions() }
                    }
                    if (draft.renaming == id) Column(Modifier.padding(top = 8.dp, bottom = 8.dp)) {
                        val renameShape = RoundedCornerShape(10.dp)
                        val renameLabel = t("projects.renameArea")
                        BasicTextField(draft.renameName, ::editAreaRename, singleLine = true, enabled = enabled, textStyle = rnText(16, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                            modifier = Modifier.fillMaxWidth().semantics { contentDescription = renameLabel }.testTag("project-area-rename-input"),
                            decorationBox = { field ->
                                Box(Modifier.clip(renameShape).background(c.inputBg).rnBorder(1.dp, c.border, renameShape).padding(horizontal = 12.dp, vertical = 10.dp)) { field() }
                            })
                        if (draft.renameCheck?.optBoolean("nameTaken") == true) Text(t("areas.nameExists"), style = rnText(12, 400), color = danger,
                            modifier = Modifier.padding(top = 8.dp).testTag("project-area-rename-taken"))
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                            SheetButton(t("common.cancel"), c.secondaryText, true, "project-area-rename-cancel", onClick = ::cancelAreaRename)
                            SheetButton(t("common.save"), c.tint, enabled && draft.canRename, "area-rename-save", t("common.rename"), ::saveAreaRename)
                        }
                    }
                    if (draft.expanded == id) FlowRow(Modifier.padding(start = 28.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        val none = t("projects.colorNone")
                        Box(Modifier.size(32.dp).clip(CircleShape).rnBorder(2.dp, if (shown == null) c.tint else c.border, CircleShape)
                            .clickable(enabled = enabled, role = Role.Button) { setAreaColor(id, null) }
                            .semantics { contentDescription = none; selected = shown == null }.testTag("project-area-color-none-$id"), contentAlignment = Alignment.Center) {
                            Icon(Lucide.Ban, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                        }
                        for (color in colors) Swatch(color, (shown ?: "") == color, "${t("projects.color")}: $color", "project-area-swatch-$id-$color") { setAreaColor(id, color) }
                    }
                }
            }
            if (draft.focus != null) {
                SheetButton(t("areas.new"), c.tint, enabled, "project-area-new") { openAreaManager() }
                return@Column
            }
            Text(t("areas.new"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(bottom = 6.dp))
            val inputShape = RoundedCornerShape(10.dp)
            val placeholder = t("projects.areaLabel")
            BasicTextField(draft.name, ::editNewAreaName, singleLine = true, enabled = enabled, textStyle = rnText(16, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = placeholder }.testTag("project-area-new-name"),
                decorationBox = { field ->
                    Box(Modifier.clip(inputShape).background(c.inputBg).rnBorder(1.dp, c.border, inputShape).padding(horizontal = 12.dp, vertical = 10.dp)) {
                        if (draft.name.isEmpty()) Text(placeholder, style = rnText(16, 400), color = c.secondaryText)
                        field()
                    }
                })
            draft.check?.takeIf { it.optBoolean("nameTaken") }?.menuText("message")?.let {
                Text(it, style = rnText(12, 400), color = danger, modifier = Modifier.padding(top = 8.dp))
            }
            val chosen = draft.color ?: colors.firstOrNull()
            FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (color in colors) Swatch(color, chosen == color, "${t("projects.color")}: $color", "project-area-new-color-$color") { pickNewAreaColor(color) }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End)) {
                SheetButton(t("common.cancel"), c.secondaryText, true, "project-area-cancel", onClick = ::closeAreaManager)
                SheetButton(t("common.save"), c.tint, enabled && draft.canSave, "project-area-save", onClick = ::addArea)
            }
        }
    }
}


@Composable
private fun SheetButton(text: String, color: Color, on: Boolean, tag: String, label: String = text, onClick: () -> Unit) =
    Box(Modifier.heightIn(min = 44.dp).widthIn(min = 44.dp).fade(if (on) 1f else 0.5f).clip(RoundedCornerShape(10.dp))
        .clickable(enabled = on, role = Role.Button, onClick = onClick).semantics { contentDescription = label }.testTag(tag).padding(horizontal = 10.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center) {
        Text(text, style = rnText(14, 700), color = color)
    }
