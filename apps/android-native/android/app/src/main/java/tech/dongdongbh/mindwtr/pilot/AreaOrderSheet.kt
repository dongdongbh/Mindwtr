package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
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
import org.json.JSONObject

/**
 * RN's Manage areas sheet (ProjectAreaModals.tsx, #1263): the title with Sort A–Z and Sort by color, then each area in core's order with
 * its dot and ↑ (off on the first). Each control sends RN's intent on the order shown; the sheet reads core's order again after it.
 */
@Composable
fun AreaOrderSheet(model: InboxViewModel, sheet: JSONObject) = with(model) {
    val c = LocalTheme.current.colors
    LaunchedEffect(projects, busy) { if (!busy) readAreaManager() }
    BackHandler(onBack = ::closeAreaManager)
    val enabled = writable && !busy && failedAction == null
    Box(Modifier.fillMaxSize().background(LocalTheme.current.pickerScrim).pointerInput(Unit) { detectTapGestures { closeAreaManager() } }
        .padding(20.dp).semantics { testTagsAsResourceId = true }, contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(min = 280.dp, max = 360.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("project-area-manager")) {
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(t("projects.areaLabel"), style = rnText(16, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                for ((kind, key) in listOf("sortName" to "projects.sortByName", "sortColor" to "projects.sortByColor")) {
                    val buttonShape = RoundedCornerShape(8.dp)
                    Text(t(key), style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.clip(buttonShape).rnBorder(1.dp, c.border, buttonShape)
                        .clickable(enabled = enabled, role = Role.Button) { orderAreas(JSONObject().put("kind", kind)) }
                        .testTag("project-area-$kind").padding(horizontal = 8.dp, vertical = 4.dp))
                }
            }
            val areas = sheet.menuObjects("areas")
            if (areas.isEmpty()) Text(t("projects.noArea"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(bottom = 8.dp)) {
                areas.forEachIndexed { index, area ->
                    val id = area.getString("id")
                    val name = area.getString("name")
                    Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(vertical = 8.dp).testTag("project-area-row-$id"), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(coreColorOrNull(area.menuText("color")) ?: c.tint))
                        Text(name, style = rnText(14, 600), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f).padding(start = 8.dp, end = 8.dp))
                        val up = index > 0
                        val label = "${t("projects.moveUp")}: $name"
                        Box(Modifier.size(44.dp).fade(if (up) 1f else 0.5f).clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = up && enabled, role = Role.Button) { orderAreas(JSONObject().put("kind", "moveUp").put("areaId", id)) }
                            .semantics { contentDescription = label; if (!up) disabled() }.testTag("project-area-move-up-$id"), contentAlignment = Alignment.Center) {
                            Text("↑", style = rnText(12, 700), color = c.text)
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.End) {
                Text(t("common.cancel"), style = rnText(14, 700), color = c.secondaryText, modifier = Modifier.clip(RoundedCornerShape(10.dp))
                    .clickable(role = Role.Button, onClick = ::closeAreaManager).padding(horizontal = 10.dp, vertical = 8.dp))
            }
        }
    }
}
