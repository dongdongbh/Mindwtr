package tech.dongdongbh.mindwtr.pilot

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.triStateToggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

/** One option of core's getAreaFilter: its state (included, excluded, none) and the selection a tap sends ([next], JSON). */
data class AreaOption(val id: String, val label: String, val color: String?, val state: String, val next: String)

/**
 * Core's getAreaFilter reply. Its options come in core's order: "All areas" first, then
 * each area, then "No area" last; [areas] are the middle ones, the choices for a new project.
 */
data class AreaFilter(val label: String, val summary: String, val options: List<AreaOption>) {
    /** Core marks "All areas" included exactly when no area is selected (RN's default scope). */
    val isDefault get() = options.firstOrNull()?.state == "included"
    val areas get() = if (options.size > 2) options.subList(1, options.size - 1) else emptyList()
    /** RN's new-project default: the one area the filter includes alone, else no area. */
    val soleArea: String? get() = options.filter { it.state != "none" }.singleOrNull()?.takeIf { it.state == "included" && it in areas }?.id

    companion object {
        fun parse(json: JSONObject): AreaFilter {
            val items = json.getJSONArray("options")
            return AreaFilter(json.getString("label"), json.getString("summary"), List(items.length()) { index ->
                items.getJSONObject(index).let {
                    AreaOption(it.getString("id"), it.getString("label"), if (it.isNull("color")) null else it.getString("color"),
                        it.getString("state"), it.getJSONObject("next").toString())
                }
            })
        }
    }
}

/** RN's header trigger (MobileAreaSwitcher): core's label and a chevron, tinted when an area is selected. */
@Composable
fun AreaTrigger(model: InboxViewModel, modifier: Modifier = Modifier) {
    val filter = model.areaFilter ?: return
    val c = LocalTheme.current.colors
    val color = if (filter.isDefault) c.secondaryText else c.tint
    val spoken = "${t("projects.areaFilter")}: ${filter.summary}"
    Row(
        modifier.widthIn(max = 160.dp).heightIn(min = 48.dp).clickable(role = Role.Button) { model.showAreaSheet(true) }
            .semantics { contentDescription = spoken }.padding(horizontal = 6.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(filter.label, style = rnText(13, 600, 18), color = color, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false))
        Icon(Lucide.ChevronDown, null, tint = color, modifier = Modifier.padding(start = 4.dp).size(13.dp))
    }
}

/**
 * RN's area sheet: the title, core's summary when an area is selected, then "All areas",
 * each area, and "No area". A tap sends that option's `next` selection to core, and the
 * sheet stays open as in RN; the lists are read again after core saves it. While a failed
 * change's retry is owed, only that exact option works.
 */
@Composable
fun AreaSheet(model: InboxViewModel) = with(model) {
    val filter = areaFilter ?: return
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler { showAreaSheet(false) }
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(theme.scrim).pointerInput(Unit) { detectTapGestures { showAreaSheet(false) } })
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.7f).dp).clip(shape).background(c.cardBg)
                .rnBorder(1.dp, c.border, shape).padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 20.dp),
        ) {
            Text(t("projects.areaFilter"), style = rnText(16, 700), color = c.text,
                modifier = Modifier.padding(bottom = if (filter.isDefault) 12.dp else 4.dp).semantics { heading() })
            if (!filter.isDefault) Text(filter.summary, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 2,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(bottom = 12.dp))
            Column(Modifier.verticalScroll(rememberScrollState())) {
                filter.options.forEachIndexed { index, option ->
                    val enabled = writable && !busy && (failedAction == null || failedAction == areaFilterAction(option))
                    val excluded = option.state == "excluded"
                    val included = option.state == "included"
                    val tone = if (excluded) c.danger else if (included) c.tint else null
                    val rowShape = RoundedCornerShape(14.dp)
                    val control = if (index == 0) {
                        Modifier.selectable(selected = included, enabled = enabled, role = Role.Button) { setAreaFilter(option) }
                    } else {
                        Modifier.triStateToggleable(
                            state = if (excluded) ToggleableState.Indeterminate else if (included) ToggleableState.On else ToggleableState.Off,
                            enabled = enabled, role = Role.Checkbox,
                        ) { setAreaFilter(option) }
                    }
                    Row(
                        Modifier.padding(bottom = 10.dp).fillMaxWidth().heightIn(min = 48.dp).clip(rowShape)
                            .background(tone?.copy(alpha = 0x18 / 255f) ?: c.cardBg).rnBorder(1.dp, tone ?: c.border, rowShape)
                            .then(control).padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(option.label, style = rnText(15, 600).copy(textDecoration = if (excluded) TextDecoration.LineThrough else null),
                            color = tone ?: c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (excluded) Icon(Lucide.X, null, tint = c.danger, modifier = Modifier.size(16.dp))
                        else if (included) Icon(Lucide.Check, null, tint = c.tint, modifier = Modifier.size(16.dp))
                    }
                }
            }
        }
    }
}
