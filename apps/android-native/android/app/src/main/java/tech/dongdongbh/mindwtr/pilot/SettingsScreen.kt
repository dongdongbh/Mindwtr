package tech.dongdongbh.mindwtr.pilot

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import org.json.JSONObject


@Composable
fun SettingsList(model: InboxViewModel) = with(model.menu.settings) {
    val shown = page ?: return

    if (shown.screen != screen && !(shown.screen.startsWith("gtd") && screen.startsWith("gtd"))) return
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp).testTag("settings-$screen")) {
        if (Workspace.sandbox) SandboxSettings(model, shown.view) else when (screen) {
            "main" -> SettingsMenu(model, shown.view)
            "advanced" -> MenuCard(model, shown.view.getJSONObject("advanced").menuObjects("rows"))
            "general" -> GeneralSettings(model, shown.view)
            "manage" -> ManageSettings(model, shown)
            "data" -> DataSettings(model, shown.view)
            "notifications" -> NotificationsSettings(model, shown.view)
            "sync" -> SyncSettings(model, shown.view)
            "ai" -> AISettings(model, shown.view)
            "about" -> AboutSettings(model, shown.view)
            "calendar" -> CalendarSettings(model, shown.view)
            else -> GtdSettings(model, shown.view)
        }
        Spacer(Modifier.height(16.dp))
    }
    SettingsDialogs(model, shown)
}


@Composable
private fun SettingsMenu(model: InboxViewModel, view: JSONObject) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    val placeholder = view.getString("searchPlaceholder")
    Row(Modifier.padding(top = 16.dp).fillMaxWidth().height(44.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Icon(Lucide.Search, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        BasicTextField(query, { search(it) }, singleLine = true, textStyle = rnText(15, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            modifier = Modifier.weight(1f).padding(start = 8.dp).semantics { contentDescription = placeholder }.testTag("settings-search"),
            decorationBox = { inner -> Box { if (query.isEmpty()) Text(placeholder, style = rnText(15, 400), color = c.secondaryText); inner() } })
    }
    Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        val groups = view.getJSONArray("groups")
        for (index in 0 until groups.length()) {
            MenuCard(model, List(groups.getJSONArray(index).length()) { groups.getJSONArray(index).getJSONObject(it) })
        }
        view.menuText("noMatches")?.let { Text(it, style = rnText(14, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp)) }
    }
}


@Composable
private fun MenuCard(model: InboxViewModel, rows: List<JSONObject>) = with(model.menu) {
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.cardBg)) {
        rows.forEachIndexed { index, row ->
            val id = row.getString("id")
            val enabled = row.getBoolean("enabled") && idle
            val label = row.getString("accessibilityLabel")
            Row(Modifier.fillMaxWidth().heightIn(min = 72.dp)
                .then(if (index < rows.size - 1) Modifier.rnBorderBottom(c.border) else Modifier)
                .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (enabled) onClick { settings.push(id); true } else disabled() }
                .clickable(enabled = enabled) { settings.push(id) }.fade(if (row.getBoolean("enabled")) 1f else 0.5f)
                .padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
                    SettingsLucide.byName[row.getString("icon")]?.let { Icon(it, null, tint = c.secondaryText, modifier = Modifier.size(20.dp)) }
                }
                Column(Modifier.weight(1f).padding(start = 13.dp)) {
                    Text(row.getString("title"), style = rnText(17, 500, 22), color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    row.menuText("description")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 3.dp)) }
                }
                if (row.optBoolean("showIndicator")) {
                    val indicatorIcon = when (row.menuText("indicatorIcon")) {
                        "refresh" -> SettingsLucide.RefreshCw
                        "check" -> Lucide.Check
                        "warning" -> Lucide.TriangleAlert
                        else -> null
                    }
                    if (indicatorIcon != null) Icon(indicatorIcon, null, tint = c.text, modifier = Modifier.padding(start = 12.dp).size(16.dp))
                    else Box(Modifier.padding(start = 12.dp).size(8.dp).clip(CircleShape)
                        .background(coreColorOrNull(row.menuText("indicatorColor")) ?: theme.deleteAction))
                }
                Icon(Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.padding(start = 8.dp).size(20.dp))
            }
        }
    }
}


@Composable
internal fun SectionTitle(text: String, top: Int = 0, color: Color = LocalTheme.current.colors.secondaryText) =
    Text(text.uppercase(), style = rnText(13, 600), color = color,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp, top = top.dp).semantics { heading() })


@Composable
private fun Description(text: String, top: Int = 0) =
    Text(text, style = rnText(13, 400, 18), color = LocalTheme.current.colors.secondaryText, modifier = Modifier.padding(start = 4.dp, end = 4.dp, bottom = 12.dp, top = top.dp))


@Composable
internal fun Card(top: Int = 0, content: @Composable ColumnScope.() -> Unit) =
    Column(Modifier.padding(top = top.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(LocalTheme.current.colors.cardBg), content = content)


@Composable
internal fun SettingRow(label: String, description: String?, divider: Boolean = false, modifier: Modifier = Modifier, failure: String? = null,
                        dimmed: Boolean = false, trailing: (@Composable RowScope.() -> Unit)? = null) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (divider) Modifier.rnBorderTop(c.border) else Modifier).then(modifier).padding(16.dp),
        verticalAlignment = Alignment.Top) {

        Column(Modifier.weight(1f).padding(end = 16.dp).fade(if (dimmed) 0.5f else 1f)) {
            Text(label, style = rnText(16, 500, 21), color = c.text)
            description?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
            failure?.let { Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 6.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
        }

        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}


@Composable
private fun PressRow(label: String, value: String?, divider: Boolean, enabled: Boolean, icon: ImageVector = SettingsIonicons.ChevronDown,
                     expanded: Boolean? = null, onClick: () -> Unit) {
    val spoken = if (value == null) label else "$label: $value"
    SettingRow(label, value, divider, Modifier.clearAndSetSemantics {
        contentDescription = spoken; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled()

        if (expanded == true) collapse { onClick(); true } else if (expanded == false) expand { onClick(); true }
    }.clickable(enabled = enabled, onClick = onClick)) {
        Icon(icon, null, tint = LocalTheme.current.colors.secondaryText, modifier = Modifier.size(18.dp))
    }
}


@Composable
private fun ToggleRow(model: InboxViewModel, toggle: JSONObject, divider: Boolean, enabled: Boolean = true,
                      props: RnSwitchProps = LocalTheme.current.settingsSwitch, write: (JSONObject) -> Unit) {
    val label = toggle.getString("label")
    SettingRow(label, toggle.menuText("description"), divider) {
        RnSwitch(toggle.getBoolean("value"), enabled && model.failedAction == null, label, props) { write(toggle.getJSONObject("edit")) }
    }
}


@Composable
private fun NavRow(model: InboxViewModel, link: JSONObject, first: Boolean = false) {
    val c = LocalTheme.current.colors
    val title = link.getString("title")
    val enabled = model.menu.idle
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (first) Modifier else Modifier.rnBorderTop(c.border))
        .clearAndSetSemantics { contentDescription = title; role = Role.Button; if (enabled) onClick { model.menu.settings.push(link.getString("screen")); true } else disabled() }
        .clickable(enabled = enabled) { model.menu.settings.push(link.getString("screen")) }.padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(title, style = rnText(16, 500, 21), color = c.text)
            link.menuText("description")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
        }
        Icon(SettingsIonicons.ChevronForward, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
    }
}


@Composable
private fun Segmented(model: InboxViewModel, options: List<JSONObject>, text: (JSONObject) -> String, icons: Boolean = false, radio: Boolean = false,
                      write: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(14.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        for (option in options) {
            val on = option.getBoolean("selected")
            val label = text(option)
            val enabled = model.menu.idle
            Row(Modifier.weight(1f).heightIn(min = 38.dp).clip(RoundedCornerShape(10.dp)).background(if (on) c.filterBg else c.bg)
                .clearAndSetSemantics { contentDescription = label; role = if (radio) Role.RadioButton else Role.Button; selected = on
                    if (enabled) onClick { write(option.getJSONObject("edit")); true } else disabled() }
                .clickable(enabled = enabled) { write(option.getJSONObject("edit")) }.padding(horizontal = 10.dp),
                horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                if (icons) SettingsIonicons.byName[option.optString("icon")]?.let { Icon(it, null, tint = if (on) c.tint else c.secondaryText, modifier = Modifier.padding(end = 6.dp).size(16.dp)) }
                Text(label, style = rnText(14, 700, 18), color = if (on) c.tint else c.secondaryText, textAlign = TextAlign.Center, maxLines = 2)
            }
        }
    }
}


@Composable
private fun SettingInput(value: String, label: String, placeholder: String?, modifier: Modifier, enabled: Boolean = true, number: Boolean = false,
                         center: Boolean = false, onDone: (() -> Unit)? = null, change: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    val focus = LocalFocusManager.current
    BasicTextField(value, change, enabled = enabled, singleLine = true, cursorBrush = SolidColor(c.tint),
        textStyle = rnText(14, 400).copy(color = c.text, textAlign = if (center) TextAlign.Center else TextAlign.Start),
        keyboardOptions = KeyboardOptions(keyboardType = if (number) KeyboardType.Number else KeyboardType.Text, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke(); focus.clearFocus() }),
        modifier = modifier.clip(shape).background(c.bg).rnBorder(1.dp, c.border, shape).semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = if (center) Alignment.Center else Alignment.CenterStart) {
                if (value.isEmpty() && placeholder != null) Text(placeholder, style = rnText(14, 400), color = c.secondaryText); inner()
            }
        })
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PresetChips(presets: JSONObject, enabled: Boolean, modifier: Modifier = Modifier, rowLabel: String? = null, pick: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = if (rowLabel != null) RoundedCornerShape(9.dp) else CircleShape
    FlowRow(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = if (rowLabel != null) Int.MAX_VALUE else 3) {
        for (option in presets.menuObjects("options")) {
            val on = option.getBoolean("selected")
            val label = option.getString("label")
            val spoken = rowLabel?.let { "$it: $label" } ?: label
            val edit = option.getJSONObject("edit")
            Box(Modifier.then(if (rowLabel != null) Modifier.heightIn(min = 40.dp) else Modifier.weight(1f).heightIn(min = 38.dp)).clip(shape)
                .background(if (on) c.filterBg else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, shape)
                .clearAndSetSemantics { contentDescription = spoken; role = Role.RadioButton; selected = on; if (enabled) onClick { pick(edit); true } else disabled() }
                .clickable(enabled = enabled) { pick(edit) }.padding(horizontal = 12.dp, vertical = if (rowLabel != null) 0.dp else 8.dp), contentAlignment = Alignment.Center) {
                if (rowLabel != null) Text(label, style = rnText(14, 400), color = if (on) c.tint else c.text, maxLines = 1)
                else Text(label, style = rnText(13, 700), color = if (on) c.tint else c.secondaryText, maxLines = 1)
            }
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SandboxSettings(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val sandbox = model.sandbox
    LaunchedEffect(model.busy) { if (!model.busy) settings.readSandboxEditor() }
    val shape = RoundedCornerShape(14.dp)
    Column(Modifier.padding(top = 16.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(16.dp).testTag("sandbox-settings"),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(t("sandbox.title"), style = rnText(18, 700, 24), color = c.text, modifier = Modifier.semantics { heading() })
        Text(t("sandbox.description"), style = rnText(14, 400, 20), color = c.secondaryText)
        Text(t("sandbox.notice"), style = rnText(13, 400, 18), color = c.secondaryText,
            modifier = Modifier.fillMaxWidth().rnBorderTop(c.border).padding(top = 10.dp))
        if (sandbox.failed) Text(t("sandbox.switchFailed"), style = rnText(13, 400, 18), color = c.danger)
        if (sandbox.switching) Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)) {
            CircularProgressIndicator(Modifier.size(18.dp), color = c.tint, strokeWidth = 2.dp)
            Text(t("sandbox.switching"), style = rnText(14, 400, 20), color = c.secondaryText)
        } else FlowRow(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val buttonShape = RoundedCornerShape(10.dp)
            val reset = t("sandbox.reset")
            Row(Modifier.heightIn(min = 44.dp).clip(buttonShape).rnBorder(1.dp, c.border, buttonShape)
                .clearAndSetSemantics { contentDescription = reset; role = Role.Button; testTag = "sandbox-settings-reset"; onClick { sandbox.reset(); true } }
                .clickable(onClick = sandbox::reset).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(Lucide.RotateCcw, null, tint = c.tint, modifier = Modifier.size(17.dp))
                Text(reset, style = rnText(14, 700), color = c.tint)
            }
            val exit = t("sandbox.exit")
            Row(Modifier.heightIn(min = 44.dp).clip(buttonShape).background(c.tint)
                .clearAndSetSemantics { contentDescription = exit; role = Role.Button; testTag = "sandbox-settings-exit"; onClick { sandbox.exit(); true } }
                .clickable(onClick = sandbox::exit).padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Icon(Lucide.X, null, tint = c.onTint, modifier = Modifier.size(18.dp))
                Text(exit, style = rnText(14, 700), color = c.onTint)
            }
        }
    }
    settings.sandboxEditor?.optJSONObject("taskEditor")?.optJSONObject("presets")?.let { presets ->
        SectionTitle(t("settings.taskEditorLayout"), top = 16)
        Card {
            val label = presets.getString("label")
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(label, style = rnText(14, 600), color = c.text)
                PresetChips(presets, idle && !sandbox.switching, rowLabel = label) { settings.gtd(it) }
            }
        }
    }
    val age = view.optJSONObject("appearance")?.optJSONObject("showTaskAge") ?: return
    SectionTitle(t("settings.appearance"), top = 16)
    Card { ToggleRow(model, age, false, enabled = !sandbox.switching, props = theme.generalSwitch) { settings.general(it) } }
    val regional = view.optJSONObject("regional") ?: return
    SectionTitle(t("settings.regionalFormats"), top = 16)
    Card {
        listOf("weekStart", "dateFormat", "timeFormat").forEachIndexed { index, name ->
            regional.optJSONObject(name)?.let { picker ->
                PressRow(picker.getString("label"), picker.getString("value"), index > 0, idle && !sandbox.switching) {
                    keepDialog(JSONObject().put("kind", "settingsPicker").put("picker", name))
                }
            }
        }
    }
}


@Composable
private fun GeneralSettings(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val appearance = view.getJSONObject("appearance")
    val privacy = view.getJSONObject("privacy")
    val language = view.getJSONObject("language")
    val regional = view.getJSONObject("regional")
    val open = { picker: String -> keepDialog(JSONObject().put("kind", "settingsPicker").put("picker", picker)) }
    SectionTitle(appearance.getString("title"))
    Card {
        val themeRow = appearance.getJSONObject("theme")
        PressRow(themeRow.getString("label"), themeRow.getString("value"), false, idle) { open("theme") }
        ToggleRow(model, appearance.getJSONObject("showTaskAge"), true, props = theme.generalSwitch) { settings.general(it) }
        val quick = appearance.getJSONObject("quickAccess")
        PressRow(quick.getString("label"), quick.getString("value"), true, idle) { open("quickAccess") }
    }
    SectionTitle(privacy.getString("title"), top = 16)
    Card {

        val lock = privacy.getJSONObject("appLock")
        SettingRow(lock.getString("label"), lock.getString("description"), failure = model.lock.switchFailure(lock)) {
            RnSwitch(lock.getBoolean("value"), model.failedAction == null && !model.lock.authenticating, lock.getString("label"), theme.generalSwitch) { model.lock.toggle(lock) }
        }

        privacy.optJSONObject("appLockRelockDelay")?.let { PressRow(it.getString("label"), it.getString("value"), true, idle) { open("appLockRelockDelay") } }
        privacy.optJSONObject("appSearch")?.let { ToggleRow(model, it, true, props = theme.generalSwitch) { edit -> settings.general(edit) } }
    }
    SectionTitle(language.getString("title"), top = 16)
    Description(language.getString("description"))
    Card { PressRow(language.getString("label"), language.getString("value"), false, idle) { open("language") } }
    Card(top = 12) {
        val expanded = settings.local.optBoolean("regional")
        PressRow(regional.getString("label"), regional.getString("summary"), false, true, if (expanded) SettingsIonicons.ChevronUp else SettingsIonicons.ChevronDown, expanded) {
            settings.editLocal { put("regional", !expanded) }
        }
        if (expanded) for (name in listOf("weekStart", "dateFormat", "calendarSystem", "timeFormat")) {
            val picker = regional.optJSONObject(name) ?: continue
            PressRow(picker.getString("label"), picker.getString("value"), true, idle) { open(name) }
        }
    }
}


@Composable
private fun DataSettings(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    OnboardingHandoffCard(model)
    BackupCard(model, view.getJSONObject("backup"))
    ImportCard(model, view.getJSONObject("importData"))
    ArchiveRetentionCard(model, view.getJSONObject("archiveRetention"))
    val diagnostics = view.getJSONObject("diagnostics")
    SectionTitle(diagnostics.getString("title"), top = 24, color = c.text)
    Card {

        diagnostics.optJSONObject("analytics")?.let { analytics ->
            ToggleRow(model, analytics, false, props = theme.analyticsSwitch) { edit ->
                if (edit.getBoolean("value")) settings.editLocal { put("analyticsConfirm", true) } else settings.data(edit)
            }
        }


        ToggleRow(model, diagnostics.getJSONObject("debugLogging"), true) { settings.data(it) }
        val activity = LocalActivity.current
        LaunchedEffect(settings.logToShare) { if (settings.logToShare != null) activity?.let(settings::openShareSheet) }
        diagnostics.optJSONObject("shareLog")?.let { share ->
            ActionRow(share.getString("label"), share.getString("description"), c.tint, true, "settings-share-log") { settings.shareLog() }
        }
        diagnostics.optJSONObject("clearLog")?.let { clear ->
            ActionRow(clear.getString("label"), null, c.secondaryText, true, "settings-clear-log") { settings.clearLog() }
        }
    }
}


@Composable
private fun ArchiveRetentionCard(model: InboxViewModel, card: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val days = card.getInt("days")
    var draft by rememberSaveable(days) { mutableStateOf(if (days > 0) "$days" else "") }

    val typed = draft.takeIf { it.matches(Regex("[1-9][0-9]{0,4}")) }?.toInt()?.takeIf { it <= 36500 }
    val canSave = typed != null && idle && typed != days
    val canNever = days != 0 && idle
    val never = card.getJSONObject("never")
    val shape = RoundedCornerShape(8.dp)
    val focus = LocalFocusManager.current
    Card(top = 16) {
        Column(Modifier.padding(16.dp)) {
            Text(card.getString("title"), style = rnText(16, 500, 21), color = c.text)
            Text(card.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
            Text(card.getString("safety"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
            Text(card.getString("current"), style = rnText(16, 500, 21), color = c.text, modifier = Modifier.padding(top = 12.dp))
            val label = card.getString("daysLabel")
            Text(label, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 12.dp))
            BasicTextField(draft, { draft = it; settings.archiveSaveFailed(false) }, singleLine = true, cursorBrush = SolidColor(c.tint), textStyle = rnText(14, 400).copy(color = c.text),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.padding(top = 6.dp).fillMaxWidth().clip(shape).rnBorder(1.dp, c.border, shape).padding(10.dp)
                    .semantics { contentDescription = label }.testTag("archive-retention-days"))
            if (draft.isNotEmpty() && typed == null) Text(card.getString("invalid"), style = rnText(14, 400), color = c.text,
                modifier = Modifier.padding(top = 6.dp).semantics { liveRegion = LiveRegionMode.Polite })
            if (settings.local.optBoolean("archiveSaveFailed")) Text(card.getString("saveFailed"), style = rnText(14, 400), color = c.text,
                modifier = Modifier.padding(top = 6.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("archive-retention-save-failed"))
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(card.getString("save"), style = rnText(16, 400, 21), color = c.tint, modifier = Modifier.fade(if (canSave) 1f else 0.45f)
                    .clickable(enabled = canSave, role = Role.Button) { focus.clearFocus(); typed?.let(settings::archiveRetention) }.testTag("archive-retention-save"))
                Text(never.getString("label"), style = rnText(16, 400, 21), color = c.tint, modifier = Modifier.fade(if (canNever) 1f else 0.45f)
                    .clickable(enabled = canNever, role = Role.Button) { settings.archiveData(never.getJSONObject("edit")) }.testTag("archive-retention-never"))
            }
        }
    }
}


@Composable
private fun ArchiveRetentionReview(model: InboxViewModel, review: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val close = { settings.editLocal { remove("archiveReview") } }
    BackHandler { close() }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(Unit) { detectTapGestures { close() } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.7f).dp).clip(shape).background(c.cardBg)
            .rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("archive-retention-review")) {
            Text(review.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                Text(review.getString("description"), style = rnText(14, 400), color = c.text)
                for (line in listOf("counts", "legacy", "heading")) Text(review.getString(line), style = rnText(14, 400), color = c.text, modifier = Modifier.padding(top = 12.dp))
                val lines = review.getJSONArray("lines")
                for (index in 0 until lines.length()) Text(lines.getString(index), style = rnText(14, 400), color = c.text, modifier = Modifier.padding(top = 6.dp))
            }
            Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(24.dp, Alignment.End)) {
                Text(review.getString("cancel"), style = rnText(14, 400), color = c.tint, modifier = Modifier.clickable(role = Role.Button) { close() }.testTag("archive-retention-cancel"))
                Text(review.getString("confirm"), style = rnText(14, 400), color = c.tint, modifier = Modifier.clickable(role = Role.Button) {
                    close(); settings.archiveData(review.getJSONObject("edit"))
                }.testTag("archive-retention-apply"))
            }
        }
    }
}


@Composable
private fun BackupCard(model: InboxViewModel, backup: JSONObject) = with(model.menu.settings) {
    val theme = LocalTheme.current
    val c = theme.colors
    val transfer = transfer
    val activity = LocalActivity.current
    val pickJson = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { transfer.backupPicked(it) }
    val pickTree = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { transfer.folderPicked(it) }
    LaunchedEffect(transfer.launch) {
        val wanted = transfer.launch ?: return@LaunchedEffect
        transfer.launched()


        if (wanted == "tree") runCatching { pickTree.launch(tech.dongdongbh.mindwtr.pilot.core.debugProperty("export_tree").ifEmpty { null }?.toUri()) }
            .onFailure { transfer.folderPicked(null) }
        else runCatching { pickJson.launch(transfer.pickTypes) }.onFailure { transfer.backupPicked(null) }
    }
    LaunchedEffect(transfer.share) { if (transfer.share != null) activity?.let(transfer::openShare) }
    val open = local.optBoolean("backupOpen")
    val toggle = { editLocal { put("backupOpen", !open) } }
    val title = backup.getString("title")
    val description = backup.getString("foldDescription")
    Card(top = 24) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .clearAndSetSemantics { contentDescription = "$title, $description"; role = Role.Button; testTag = "backup-disclosure"
                onClick { toggle(); true }; if (open) collapse { toggle(); true } else expand { toggle(); true } }
            .clickable(onClick = toggle).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {

            Column(Modifier.weight(1f).padding(end = 28.dp)) {
                Text(title, style = rnText(16, 500, 21), color = c.text)
                Text(description, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            }
            Icon(if (open) SettingsIonicons.ChevronUp else SettingsIonicons.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        }
        if (open) {
            val running = transfer.action
            val enabled = !transfer.busy
            BackupRow(backup.getString("exportLabel"), backup.getString("description"), theme.exportAction, enabled, running == "export", "data-transfer-export") { transfer.export("json") }
            BackupRow(backup.getString("csvLabel"), backup.getString("csvDescription"), theme.exportAction, enabled, running == "export:csv", "data-transfer-export-csv") { transfer.export("csv") }
            BackupRow(backup.getString("tasknotesLabel"), backup.getString("tasknotesDescription"), theme.exportAction, enabled, running == "export:tasknotes", "data-transfer-export-tasknotes") { transfer.export("tasknotes") }
            BackupRow(backup.getString("restoreFileLabel"), backup.getString("restoreFileDescription"), c.tint, enabled, running == "restore", "data-transfer-restore") { transfer.pickBackup("restore") }
            BackupRow(backup.getString("mergeLabel"), backup.getString("mergeDescription"), c.tint, enabled, running == "merge", "data-transfer-merge") { transfer.pickBackup("merge") }

            val starter = backup.getJSONObject("gettingStarted")
            BackupRow(starter.getString("label"), starter.getString("description"), c.tint, enabled, running == "gettingStarted", "add-getting-started-content") { transfer.gettingStarted() }
        }
    }
}


@Composable
private fun ImportCard(model: InboxViewModel, importData: JSONObject) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    val transfer = transfer
    val open = local.optBoolean("importOpen")
    val toggle = { editLocal { put("importOpen", !open) } }
    val title = importData.getString("title")
    val description = importData.getString("description")
    Card(top = 16) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .clearAndSetSemantics { contentDescription = "$title, $description"; role = Role.Button; testTag = "import-disclosure"
                onClick { toggle(); true }; if (open) collapse { toggle(); true } else expand { toggle(); true } }
            .clickable(onClick = toggle).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 28.dp)) {
                Text(title, style = rnText(16, 500, 21), color = c.text)
                Text(description, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            }
            Icon(if (open) SettingsIonicons.ChevronUp else SettingsIonicons.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        }
        if (open) {
            Row(Modifier.fillMaxWidth().rnBorderTop(c.border).padding(16.dp)) { GuideLink(importData.getJSONObject("guide"), "import-guide-link", bottom = 0) }
            val running = transfer.action
            val rows = importData.getJSONArray("rows")
            for (index in 0 until rows.length()) {
                val row = rows.getJSONObject(index)
                val key = row.getString("key")
                BackupRow(row.getString("label"), row.getString("description"), c.tint, !transfer.busy, running == "import:$key", "data-transfer-import-$key") { transfer.pickImport(key) }
            }
        }
    }
}


@Composable
internal fun BackupRow(label: String, description: String, color: Color, enabled: Boolean, busy: Boolean, tag: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).rnBorderTop(c.border)
        .clearAndSetSemantics { contentDescription = "$label, $description"; role = Role.Button; testTag = tag
            if (busy) stateDescription = "busy"
            if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(16.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(label, style = rnText(16, 500, 21), color = color)
            Text(description, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        }
        if (busy) androidx.compose.material3.CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
    }
}


@Composable
internal fun DataTransferQuestion(model: InboxViewModel) {
    val transfer = model.menu.settings.transfer
    val open = transfer.question ?: return
    val words = open.getJSONObject("model")
    val destructive = open.getString("kind") == "snapshot" || open.optString("mode") == "restore"
    ThemedAlert(words.getString("title"), words.optString("summary").ifEmpty { words.optString("message") },
        listOf(AlertButton(words.getString("cancelLabel"), "cancel", transfer::cancel),
            AlertButton(words.getString("confirmLabel"), if (destructive) "destructive" else "default", transfer::confirm)), transfer::cancel)
}


@Composable
private fun ActionRow(label: String, description: String?, color: Color, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val spoken = if (description == null) label else "$label, $description"
    Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).rnBorderTop(c.border)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = tag; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(16.dp)) {

        Column(Modifier.padding(end = 16.dp)) {
            Text(label, style = rnText(16, 500, 21), color = color)
            description?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
        }
    }
}


@Composable
private fun ManageSettings(model: InboxViewModel, page: SettingsPage) = with(model.menu) {
    val view = page.view
    val theme = LocalTheme.current
    val c = theme.colors
    for (section in view.menuObjects("sections")) {
        val key = section.getString("key")
        val open = section.getBoolean("open")
        val title = section.getString("title")
        Column(Modifier.padding(bottom = 16.dp)) {
            val spoken = "$title · ${section.getInt("count")}"
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.cardBg)
                .clearAndSetSemantics {
                    contentDescription = spoken; role = Role.Button; heading(); testTag = "manage-section-$key"
                    onClick { settings.toggleSection(section.getJSONObject("toggle")); true }

                    if (open) collapse { settings.toggleSection(section.getJSONObject("toggle")); true } else expand { settings.toggleSection(section.getJSONObject("toggle")); true }
                }
                .clickable { settings.toggleSection(section.getJSONObject("toggle")) }.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(if (open) SettingsIonicons.ChevronDown else SettingsIonicons.ChevronForward, null, tint = c.secondaryText, modifier = Modifier.size(16.dp))
                Text(title, style = rnText(16, 500, 21), color = c.text, modifier = Modifier.weight(1f).padding(start = 8.dp))
                Text("${section.getInt("count")}", style = rnText(13, 400), color = c.secondaryText)
            }
            if (open) Card(top = 1) {
                when (key) {
                    "areas" -> ManageAreas(model, page)
                    "somedaySections" -> SomedaySectionsManager(model, page)
                    "people" -> ManagePeople(model, page)
                    else -> ManageValues(model, page, key, view.getJSONObject(key).menuText("empty"))
                }
            }
        }
    }
}


@Composable
private fun RowButton(icon: ImageVector, label: String, tint: Color, enabled: Boolean, tag: String? = null, onClick: () -> Unit) {

    Box(Modifier.size(44.dp).clearAndSetSemantics {
        contentDescription = label; role = Role.Button; if (tag != null) testTag = tag
        if (enabled) onClick { onClick(); true } else disabled()
    }.clickable(enabled = enabled, onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
    }
}


@Composable
private fun Swatch(color: String) {
    val c = LocalTheme.current.colors
    Box(Modifier.padding(end = 12.dp).size(24.dp).clip(RoundedCornerShape(6.dp)).background(LocalTheme.current.identityColorOrNull(color) ?: c.tint))
}


@Composable
private fun AddButton(label: String, spoken: String, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val theme = LocalTheme.current
    Row(Modifier.fade(if (enabled) 1f else 0.5f).widthIn(min = 86.dp).heightIn(min = 42.dp).clip(RoundedCornerShape(10.dp)).background(theme.manageButton)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = tag; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(horizontal = 14.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Icon(SettingsIonicons.Add, null, tint = theme.onAction, modifier = Modifier.size(17.dp))
        Text(label, style = rnText(14, 600), color = theme.onAction, modifier = Modifier.padding(start = 6.dp))
    }
}


@Composable
private fun ListMore(model: InboxViewModel, list: String) =
    Box(Modifier.fillMaxWidth().padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        PillButton(t("common.more"), onClick = { model.menu.settings.more(list) }, enabled = model.menu.idle)
    }

@Composable
private fun ManageAreas(model: InboxViewModel, page: SettingsPage) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val areas = page.view.getJSONObject("areas")
    val unassigned = areas.getJSONObject("unassigned")
    Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Swatch(unassigned.getString("color"))
        Column(Modifier.weight(1f)) {
            Text(unassigned.getString("label"), style = rnText(16, 500, 21), color = c.text, maxLines = 1)
            Text(unassigned.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 2)
        }
        RowButton(SettingsIonicons.PencilOutline, "${t("common.edit")}: ${unassigned.getString("label")}", c.secondaryText, idle) {
            settings.openEditor(unassigned.getJSONObject("edit"))
        }
    }
    areas.menuText("empty")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(16.dp)) }
    for (row in page.list("areas")) {
        val name = row.getString("name")
        Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(horizontal = 16.dp, vertical = 6.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            Swatch(row.getString("color"))
            Text(name, style = rnText(16, 500, 21), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            RowButton(SettingsIonicons.PencilOutline, "${t("common.edit")}: $name", c.secondaryText, idle) { settings.openEditor(row.getJSONObject("edit")) }
            RowButton(SettingsIonicons.TrashOutline, "${t("common.delete")}: $name", theme.deleteAction, idle) {
                confirm(row.getJSONObject("deleteConfirm"), JSONObject().put("target", row.getJSONObject("delete")), "manageDelete")
            }
        }
    }
    if (page.list("areas").size < page.total("areas")) ListMore(model, "areas")
    val add = areas.getJSONObject("newArea")
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Swatch(add.getString("color"))
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(add.getString("label"), style = rnText(16, 500, 21), color = c.text, maxLines = 1)
            Text(add.getString("hint"), style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 2)
        }
        AddButton(add.getString("addLabel"), add.getString("label"), idle, "manage-area-add") { settings.openEditor(add.getJSONObject("edit")) }
    }
}

@Composable
private fun ManagePeople(model: InboxViewModel, page: SettingsPage) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val context = LocalContext.current
    val people = page.view.getJSONObject("people")
    val text = people.getJSONObject("text")
    people.menuText("empty")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(16.dp)) }
    for (row in page.list("people")) {
        val name = row.getString("name")
        Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).clip(CircleShape).background(c.bg).rnBorder(1.dp, c.border, CircleShape), contentAlignment = Alignment.Center) {
                Text(row.getString("initial"), style = rnText(14, 700), color = c.text)
            }
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(name, style = rnText(16, 500, 21), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                row.menuText("detail")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }

            val count = row.getString("countAccessibilityLabel")
            Text(row.getString("countLabel"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier
                .clearAndSetSemantics { contentDescription = count; role = Role.Button; onClick { model.openSearch(); model.editSearch(row.getString("searchQuery")); true } }
                .clickable { model.openSearch(); model.editSearch(row.getString("searchQuery")) }.padding(8.dp))
            row.menuText("referenceLink")?.let { link ->
                RowButton(SettingsIonicons.OpenOutline, text.getString("openReference"), c.secondaryText, true) {
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, link.toUri())) }
                        .onFailure { model.showToast(text.getString("openReference"), text.getString("openReferenceFailed"), "warning") }
                }
            }
            RowButton(SettingsIonicons.PencilOutline, text.getString("editLabel"), c.secondaryText, idle) { settings.openEditor(row.getJSONObject("edit")) }
            RowButton(SettingsIonicons.TrashOutline, text.getString("deleteLabel"), theme.deleteAction, idle) {
                confirm(row.getJSONObject("deleteConfirm"), JSONObject().put("target", row.getJSONObject("delete")), "manageDelete")
            }
        }
    }
    if (page.list("people").size < page.total("people")) ListMore(model, "people")
    val add = people.getJSONObject("newPerson")
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(add.getString("label"), style = rnText(16, 500, 21), color = c.text, maxLines = 1)
            Text(add.getString("hint"), style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 2)
        }
        AddButton(add.getString("addLabel"), add.getString("label"), idle, "manage-person-add") { settings.openEditor(add.getJSONObject("edit")) }
    }
}


@Composable
private fun ManageValues(model: InboxViewModel, page: SettingsPage, list: String, empty: String?) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    empty?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(16.dp)) }
    for (row in page.list(list)) {
        val value = row.getString("value")
        Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(horizontal = 16.dp, vertical = 6.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(value, style = rnText(16, 500, 21), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            RowButton(SettingsIonicons.PencilOutline, "${t("common.edit")}: $value", c.secondaryText, idle) { settings.openEditor(row.getJSONObject("edit")) }
            RowButton(SettingsIonicons.TrashOutline, "${t("common.delete")}: $value", theme.deleteAction, idle) {
                confirm(row.getJSONObject("deleteConfirm"), JSONObject().put("target", row.getJSONObject("delete")), "manageDelete")
            }
        }
    }
    if (page.list(list).size < page.total(list)) ListMore(model, list)
    val create = page.view.getJSONObject(list).getJSONObject("create")
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(create.getString("label"), style = rnText(16, 500, 21), color = c.text, modifier = Modifier.weight(1f))
        RowButton(SettingsIonicons.Add, create.getString("label"), c.tint, idle) { settings.openEditor(create.getJSONObject("edit")) }
    }
}


@Composable
private fun SomedaySectionsManager(model: InboxViewModel, page: SettingsPage) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    page.view.getJSONObject("somedaySections").menuText("emptyHint")?.let { hint ->
        Text(hint, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(16.dp))
        return@with
    }
    val sections = page.sections ?: return@with
    val text = sections.getJSONObject("text")
    val renaming = settings.local.optJSONObject("renaming")
    for (row in sections.menuObjects("rows")) {
        val id = row.getString("id")
        val editing = renaming?.optString("id") == id
        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).rnBorderBottom(c.border).padding(horizontal = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            if (editing) {
                val typed = renaming!!.optString("title")
                SettingInput(typed, text.getString("nameLabel"), null, Modifier.weight(1f), onDone = { if (typed.isNotBlank()) settings.renameSection(id, typed) }) { next ->
                    settings.editLocal { put("renaming", JSONObject().put("id", id).put("title", next)) }
                }
            } else {
                Text(row.getString("title"), style = rnText(14, 500), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            for ((move, icon) in listOf("moveUp" to SettingsIonicons.ChevronUp, "moveDown" to SettingsIonicons.ChevronDown)) {
                val step = row.getJSONObject(move)
                val ids = step.optJSONArray("ids")
                val can = !step.getBoolean("disabled") && ids != null && idle
                Box(Modifier.heightIn(min = 44.dp).widthIn(min = 36.dp)
                    .clearAndSetSemantics { contentDescription = step.getString("label"); role = Role.Button; if (can) onClick { settings.reorderSections(ids!!); true } else disabled() }
                    .clickable(enabled = can) { settings.reorderSections(ids!!) }.fade(if (!step.getBoolean("disabled")) 1f else 0.35f), contentAlignment = Alignment.Center) {
                    Icon(icon, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
                }
            }
            if (editing) {
                val typed = renaming!!.optString("title")
                RowButton(SettingsIonicons.Checkmark, text.getString("saveLabel"), c.tint, idle && typed.isNotBlank()) { settings.renameSection(id, typed) }
            } else {
                RowButton(SettingsIonicons.PencilOutline, row.getString("renameLabel"), c.secondaryText, idle) {
                    settings.editLocal { put("renaming", JSONObject().put("id", id).put("title", row.getString("title"))) }
                }
            }
            RowButton(SettingsIonicons.TrashOutline, row.getString("deleteLabel"), c.danger, idle) {
                confirm(row.getJSONObject("deleteConfirm"), JSONObject().put("id", id), "somedayDelete")
            }
        }
    }
    if (sections.menuObjects("rows").size < sections.getInt("total")) ListMore(model, "somedaySections")
}


@Composable
private fun GtdSettings(model: InboxViewModel, view: JSONObject) = with(model.menu.settings) {
    when (screen) {
        "gtd" -> GtdHub(model, view.getJSONObject("hub"))
        "gtd-pomodoro" -> GtdPomodoro(model, view.getJSONObject("pomodoro"))
        "gtd-capture" -> GtdCapture(model, view.getJSONObject("capture"))
        "gtd-review" -> {
            val review = view.getJSONObject("review")
            Description(review.getString("description"))
            Card {
                val daily = review.getJSONObject("daily")
                SettingRow(daily.getString("label"), daily.getString("description"))
                ToggleRow(model, review.getJSONObject("dailyFocusStep"), true, write = { gtd(it) })
                val weekly = review.getJSONObject("weekly")
                SettingRow(weekly.getString("label"), weekly.getString("description"), true)
                ToggleRow(model, review.getJSONObject("weeklyContextStep"), true, write = { gtd(it) })
            }
        }
        "gtd-inbox" -> {
            val inbox = view.getJSONObject("inbox")
            Description(inbox.getString("description"))
            Card {
                listOf("twoMinute", "projectFirst", "contextStep", "schedule").forEachIndexed { index, name ->
                    ToggleRow(model, inbox.getJSONObject(name), index > 0, write = { gtd(it) })
                }
            }
        }
        "gtd-archive" -> {
            val archive = view.getJSONObject("archive")
            val c = LocalTheme.current.colors
            Description(archive.getString("description"))
            Card {
                archive.menuObjects("options").forEachIndexed { index, option ->
                    val on = option.getBoolean("selected")
                    val label = option.getString("label")
                    val enabled = model.menu.idle
                    SettingRow(label, null, index > 0, Modifier.clearAndSetSemantics { contentDescription = label; role = Role.RadioButton; selected = on
                        if (enabled) onClick { gtd(option.getJSONObject("edit")); true } else disabled() }.clickable(enabled = enabled) { gtd(option.getJSONObject("edit")) }) {
                        if (on) Icon(Lucide.Check, null, tint = LocalTheme.current.settingsCheck, modifier = Modifier.size(20.dp))
                    }
                }
            }
        }
        else -> GtdTaskEditor(model, view.getJSONObject("taskEditor"))
    }
}

@Composable
private fun GtdHub(model: InboxViewModel, hub: JSONObject) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    Description(hub.getString("description"))
    Card {
        val features = hub.getJSONObject("features")
        SettingRow(features.getString("label"), features.getString("description"))
        ToggleRow(model, hub.getJSONObject("pomodoro"), true, write = { gtd(it) })
        hub.optJSONObject("pomodoroSettings")?.let { NavRow(model, it) }
    }
    Card(top = 12) {
        val time = hub.getJSONObject("defaultScheduleTime")
        val shown = time.getString("value")
        SettingRow(time.getString("label"), time.getString("description")) {
            TimeField(model, "time", shown, time.getString("label"), time.getString("placeholder"), Modifier.width(104.dp).heightIn(min = 44.dp)) { typed ->
                JSONObject().put("type", "defaultScheduleTime").put("value", typed)
            }
        }
        for (name in listOf("focusTaskLimit", "focusIncludeStartDates", "defaultProjectFlowMode")) {
            val control = hub.getJSONObject(name)

            if (name == "focusIncludeStartDates") { ToggleRow(model, control, true, write = { gtd(it) }); continue }
            Column(Modifier.fillMaxWidth().rnBorderTop(c.border).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column {
                    Text(control.getString("label"), style = rnText(16, 500, 21), color = c.text)
                    Text(control.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                }
                Segmented(model, control.menuObjects("options"), { if (name == "focusTaskLimit") "${it.get("value")}" else it.getString("label") }, write = { gtd(it) })
            }
        }
        NavRow(model, hub.getJSONObject("autoArchive"))
    }
    Card(top = 12) {
        NavRow(model, hub.getJSONObject("taskEditor"), first = true)
        NavRow(model, hub.getJSONObject("capture"))
    }
    Card(top = 12) {
        NavRow(model, hub.getJSONObject("review"), first = true)
        NavRow(model, hub.getJSONObject("inbox"))
    }
}


@Composable
private fun TimeField(model: InboxViewModel, name: String, shown: String, label: String, placeholder: String?, modifier: Modifier,
                      number: Boolean = false, edit: (String) -> JSONObject) = with(model.menu.settings) {
    val typed = local.optString("typed:$name", shown)
    val commit = { if (local.has("typed:$name")) commitText(edit(typed), listOf(name), listOf(shown)) }
    SettingInput(typed, label, placeholder, modifier.onFocusChanged { if (!it.isFocused) commit() }, enabled = model.failedAction == null, number = number,
        center = !number, onDone = commit) { type(name, it) }
}

@Composable
private fun GtdPomodoro(model: InboxViewModel, pomodoro: JSONObject) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    Description(pomodoro.getString("description"))
    val controls = pomodoro.optJSONObject("controls")
    if (controls == null) {
        val enable = pomodoro.getJSONObject("enable")
        val label = enable.getString("label")
        Card {
            SettingRow(label, null, modifier = Modifier.clearAndSetSemantics { contentDescription = label; role = Role.Button; onClick { gtd(enable.getJSONObject("edit")); true } }
                .clickable(enabled = model.menu.idle) { gtd(enable.getJSONObject("edit")) })
        }
        return@with
    }
    Card {
        val preset = controls.getJSONObject("customPreset")
        val minutes = pomodoro.getJSONObject("minutes")
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column {
                Text(preset.getString("label"), style = rnText(16, 500, 21), color = c.text)
                Text(preset.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            }

            val focusShown = minutes.getString("focus")
            val breakShown = minutes.getString("break")
            val both = { JSONObject().put("type", "pomodoroDurations").put("focusMinutes", local.optString("typed:focus", focusShown))
                .put("breakMinutes", local.optString("typed:break", breakShown)) }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for ((name, key, shown) in listOf(Triple("focus", "focusLabel", focusShown), Triple("break", "breakLabel", breakShown))) {
                    Column(Modifier.weight(1f)) {
                        val label = preset.getString(key)
                        Text(label, style = rnText(12, 600), color = c.secondaryText)
                        val typed = local.optString("typed:$name", shown)
                        val commit = {
                            if (local.has("typed:focus") || local.has("typed:break")) commitText(both(), listOf("focus", "break"), listOf(focusShown, breakShown))
                        }
                        SettingInput(typed, label, null, Modifier.padding(top = 6.dp).fillMaxWidth().onFocusChanged { if (!it.isFocused) commit() },
                            enabled = model.failedAction == null, number = true, onDone = commit) { type(name, it) }
                    }
                }
            }
        }
        for (name in listOf("linkTask", "autoStartBreaks", "autoStartFocus", "completionAlert")) ToggleRow(model, controls.getJSONObject(name), true, write = { gtd(it) })


        controls.optJSONObject("alarmNotice")?.let { notice ->
            val context = LocalContext.current
            val denied = remember(model.resumes) { ReminderAlarms.exactAlarmsDenied(context) }
            if (denied) Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp).testTag("exact-alarm-notice"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(notice.getString("label"), style = rnText(13, 600), color = c.text)
                Text(notice.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText)
                val action = notice.getString("actionLabel")
                Box(Modifier.heightIn(min = 44.dp).clearAndSetSemantics { contentDescription = action; role = Role.Button; onClick { ReminderAlarms.openExactAlarmSettings(context); true } }
                    .clickable { ReminderAlarms.openExactAlarmSettings(context) }.padding(vertical = 10.dp).testTag("exact-alarm-allow"), contentAlignment = Alignment.CenterStart) {
                    Text(action, style = rnText(14, 600), color = c.tint)
                }
            }
        }
    }
}

@Composable
private fun GtdCapture(model: InboxViewModel, capture: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    Description(capture.getString("description"))
    Card {
        val method = capture.getJSONObject("method")
        SettingRow(method.getString("label"), method.getString("description"))
        Box(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
            Segmented(model, method.menuObjects("options"), { it.getString("label") }, icons = true, write = settings::gtd)
        }
        val area = capture.getJSONObject("defaultArea")
        val spoken = area.getString("accessibilityLabel")
        val pick = { keepDialog(JSONObject().put("kind", "settingsPicker").put("picker", "defaultArea")) }
        SettingRow(area.getString("label"), area.getString("description"), true, Modifier
            .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; if (idle) onClick { pick(); true } else disabled() }
            .clickable(enabled = idle) { pick() }) {
            Text(area.getString("value"), style = rnText(16, 400, 21), color = c.secondaryText, textAlign = TextAlign.End, maxLines = 2,
                modifier = Modifier.widthIn(max = 150.dp))
            Icon(SettingsIonicons.ChevronForward, null, tint = c.secondaryText, modifier = Modifier.padding(start = 8.dp).size(18.dp))
        }
        capture.optJSONObject("saveAudio")?.let { ToggleRow(model, it, true, write = settings::gtd) }
        for (name in listOf("quickAddAutoClean", "naturalLanguageDates", "markdownEditorAssist")) ToggleRow(model, capture.getJSONObject(name), true, write = settings::gtd)
    }
    capture.optJSONObject("captureIntent")?.let { CaptureIntentCard(model, it) }
    GmailCaptureSection(model)
}


@Composable
private fun CaptureIntentCard(model: InboxViewModel, card: JSONObject) = with(model.menu) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    val messages = card.getJSONObject("messages")
    val label = card.getString("label")
    LaunchedEffect(card.getBoolean("disabled")) {
        if (card.getBoolean("disabled") && !settings.local.optBoolean("captureLoadFailed")) {
            settings.editLocal { put("captureLoadFailed", true) }
            model.showToast(null, messages.getString("loadFailed"), "error")
        }
    }
    Card(top = 12) {
        SettingRow(label, card.menuText("description")) {
            Box(Modifier.testTag("android-capture-intent-switch")) {
                RnSwitch(card.getBoolean("value"), !card.getBoolean("disabled") && idle, label, LocalTheme.current.settingsSwitch) {
                    settings.setCaptureIntent(!card.getBoolean("value"), messages.getString("updateFailed"))
                }
            }
        }
        val token = card.optJSONObject("token")
        val stored = settings.page?.captureToken
        if (token != null && stored != null) {
            Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(token.getString("label"), style = rnText(15, 600), color = c.text)
                SelectionContainer {
                    Text(stored, style = rnText(13, 400, 19).copy(fontFamily = FontFamily.Monospace), color = c.secondaryText,
                        modifier = Modifier.fillMaxWidth().testTag("android-capture-intent-token").clip(RoundedCornerShape(8.dp)).background(c.bg)
                            .rnBorder(Dp.Hairline, c.border, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 9.dp))
                }
                val copyLabel = token.getString("copyLabel")
                Box(Modifier.testTag("android-capture-intent-copy").clip(RoundedCornerShape(8.dp)).rnBorder(1.dp, c.tint, RoundedCornerShape(8.dp))
                    .clearAndSetSemantics { contentDescription = copyLabel; role = Role.Button; onClick { copy(context, stored, messages, model); true } }
                    .clickable { copy(context, stored, messages, model) }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(copyLabel, style = rnText(14, 600), color = c.tint)
                }
            }
        }
    }
}


private fun copy(context: Context, token: String, messages: JSONObject, model: InboxViewModel) {
    val copied = runCatching {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(null, token))
    }.isSuccess
    if (copied) model.showToast(null, messages.getString("copied"), "info") else model.showToast(null, messages.getString("copyFailed"), "error")
}


@Composable
private fun GtdTaskEditor(model: InboxViewModel, editor: JSONObject) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    val resetKey = editor.getString("expandedResetKey")
    LaunchedEffect(resetKey) {
        if (local.optString("expandedKey") != resetKey) editLocal {
            put("expandedKey", resetKey).put("expanded", editor.getJSONObject("initiallyExpanded")).remove("sheetField")
        }
    }
    val expanded = local.optJSONObject("expanded") ?: editor.getJSONObject("initiallyExpanded")
    Description(editor.getString("description"))
    Description(editor.getString("helper"))
    Card {
        val open = editor.getJSONObject("openMode")
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column {
                Text(open.getString("label"), style = rnText(16, 500, 21), color = c.text)
                Text(open.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            }
            Segmented(model, open.menuObjects("options"), { it.getString("label") }, radio = true, write = { gtd(it) })
        }
    }
    Card(top = 12) {
        val presets = editor.getJSONObject("presets")
        Text(presets.getString("label").uppercase(), style = rnText(12, 600, letterSpacing = 0.6f), color = c.secondaryText,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp))
        PresetChips(presets, model.menu.idle, Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp, top = 4.dp)) { gtd(it) }
        presets.menuText("custom")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp)) }
    }
    for (group in editor.menuObjects("groups")) {
        val id = group.getString("id")
        val open = expanded.optBoolean(id)
        Card(top = 12) {
            val title = group.getString("title")
            val spoken = "$title · ${group.getInt("count")}"
            Row(Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = spoken; role = Role.Button; heading()
                onClick { editLocal { put("expanded", JSONObject(expanded.toString()).put(id, !open)) }; true } }
                .clickable { editLocal { put("expanded", JSONObject(expanded.toString()).put(id, !open)) } }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = rnText(16, 500, 21), color = c.text, maxLines = 2)
                Box(Modifier.padding(start = 10.dp).heightIn(min = 26.dp).widthIn(min = 26.dp).clip(CircleShape).background(c.filterBg).padding(horizontal = 8.dp),
                    contentAlignment = Alignment.Center) { Text("${group.getInt("count")}", style = rnText(12, 700), color = c.tint) }
                Spacer(Modifier.weight(1f))
                Icon(if (open) SettingsIonicons.ChevronUp else SettingsIonicons.ChevronDown, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
            }
            if (open) {
                group.optJSONObject("defaultOpen")?.let { ToggleRow(model, it, true, write = { gtd(it) }) }
                group.menuObjects("fields").forEachIndexed { index, field -> FieldRow(model, field, index > 0 || id != "basic") }
            }
        }
    }
    Card(top = 12) {
        val reset = editor.getJSONObject("reset")
        val label = reset.getString("label")
        SettingRow(label, null, modifier = Modifier.clearAndSetSemantics { contentDescription = label; role = Role.Button
            if (model.menu.idle) onClick { gtd(reset.getJSONObject("edit")); true } else disabled() }.clickable(enabled = model.menu.idle) { gtd(reset.getJSONObject("edit")) })
    }
}


@Composable
private fun FieldRow(model: InboxViewModel, field: JSONObject, divider: Boolean) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    val visible = field.getBoolean("visible")
    val visibility = field.getJSONObject("visibility")
    val enabled = model.menu.idle
    Row(Modifier.fillMaxWidth().then(if (divider) Modifier.rnBorderTop(c.border) else Modifier).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        val label = visibility.getString("accessibilityLabel")
        Box(Modifier.padding(end = 12.dp).size(34.dp).clip(CircleShape).background(if (visible) c.filterBg else c.cardBg).rnBorder(1.dp, if (visible) c.tint else c.border, CircleShape)
            .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = visible; if (enabled) onClick { gtd(visibility.getJSONObject("edit")); true } else disabled() }
            .clickable(enabled = enabled) { gtd(visibility.getJSONObject("edit")) }, contentAlignment = Alignment.Center) {
            Icon(if (visible) SettingsIonicons.EyeOutline else SettingsIonicons.EyeOffOutline, null, tint = if (visible) c.tint else c.secondaryText, modifier = Modifier.size(16.dp))
        }
        val title = field.getString("label")
        val status = field.getString("status")
        val open = { editLocal { put("sheetField", field.getString("id")) } }
        Row(Modifier.weight(1f).clearAndSetSemantics { contentDescription = "$title, $status"; role = Role.Button; onClick { open(); true } }
            .clickable { open() }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = rnText(16, 500, 21), color = c.text)
                Text(status, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            }
            Icon(SettingsIonicons.ChevronForward, null, tint = c.secondaryText, modifier = Modifier.size(18.dp))
        }
    }
}


@Composable
private fun SettingsDialogs(model: InboxViewModel, page: SettingsPage) = with(model.menu) {
    val open = dialog
    when (open?.optString("kind")) {
        "settingsPicker" -> Picker(model, page.view, open.getString("picker"))
        "manageEditor" -> ManageEditor(model, page.view, open)
    }
    if (settings.screen == "ai") AISettingsDialogs(model, page.view)
    if (settings.screen == "data" || settings.screen == "sync") DataTransferQuestion(model)
    if (settings.screen == "data") settings.local.optJSONObject("archiveReview")?.let { ArchiveRetentionReview(model, it) }
    if (settings.screen == "about") AboutOverlays(model, page.view)

    if (settings.screen == "data" && settings.local.optBoolean("analyticsConfirm")) page.view.getJSONObject("diagnostics").optJSONObject("analytics")?.let { analytics ->
        val confirm = analytics.getJSONObject("confirm")
        val close = { settings.editLocal { remove("analyticsConfirm") } }
        androidx.compose.material3.AlertDialog(
            onDismissRequest = close,
            title = { Text(confirm.getString("title")) },
            text = { Text(confirm.getString("message")) },
            confirmButton = { androidx.compose.material3.TextButton({ close(); settings.data(analytics.getJSONObject("edit")) }, Modifier.testTag("analytics-disable")) {
                Text(confirm.getString("disableLabel").uppercase()) } },
            dismissButton = { androidx.compose.material3.TextButton(close, Modifier.testTag("analytics-keep")) { Text(confirm.getString("keepLabel").uppercase()) } },
        )
    }
    if (settings.screen == "calendar") CalendarSettingsDialogs(model)
    if (settings.screen == "gtd-capture") GmailLabelPicker(model)
    if (settings.screen == "gtd-task-editor") settings.local.optString("sheetField").ifEmpty { null }?.let { id ->
        val field = page.view.getJSONObject("taskEditor").menuObjects("groups").flatMap { it.menuObjects("fields") }.firstOrNull { it.getString("id") == id }
        if (field != null) FieldSheet(model, field)
    }
}


@Composable
private fun Picker(model: InboxViewModel, view: JSONObject, picker: String) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val source = when (picker) {
        "theme" -> view.getJSONObject("appearance").getJSONObject("theme")
        "quickAccess" -> view.getJSONObject("appearance").getJSONObject("quickAccess")
        "appLockRelockDelay" -> view.getJSONObject("privacy").optJSONObject("appLockRelockDelay")
        "language" -> view.getJSONObject("language")
        "defaultArea" -> view.getJSONObject("capture").getJSONObject("defaultArea")
        "weeklyReviewDay" -> view.getJSONObject("weeklyReview").getJSONObject("day")
        "taskReminderDefault" -> view.getJSONObject("reminders").getJSONObject("taskDefault")
        else -> view.getJSONObject("regional").optJSONObject(picker)
    } ?: return@with
    val groups = if (picker == "theme") source.getJSONArray("groups").let { all -> List(all.length()) { all.getJSONArray(it).let { g -> List(g.length()) { g.getJSONObject(it) } } } }
        else listOf(source.menuObjects("options"))
    val write = { edit: JSONObject -> keepDialog(null); when (picker) { "defaultArea" -> settings.gtd(edit); "weeklyReviewDay", "taskReminderDefault" -> settings.notifications(edit); else -> settings.general(edit) } }
    BackHandler { keepDialog(null) }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(Unit) { detectTapGestures { keepDialog(null) } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.7f).dp).clip(shape).background(c.cardBg)
            .rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("settings-picker")) {
            Text(source.getString("pickerTitle"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                groups.forEachIndexed { index, options ->
                    if (index > 0) Box(Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(c.border))
                    for (option in options) {
                        val on = option.getBoolean("selected")
                        val label = option.getString("label")
                        val row = RoundedCornerShape(10.dp)
                        Row(Modifier.fillMaxWidth().clip(row).background(if (on) c.filterBg else c.cardBg).rnBorder(1.dp, if (on && picker == "defaultArea") c.tint else c.border, row)
                            .clearAndSetSemantics { contentDescription = label; role = Role.RadioButton; selected = on; if (idle) onClick { write(option.getJSONObject("edit")); true } else disabled() }
                            .clickable(enabled = idle) { write(option.getJSONObject("edit")) }.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            SettingsIonicons.byName[option.optString("icon")]?.let { icon ->
                                Box(Modifier.padding(end = 12.dp).size(32.dp).clip(CircleShape).background(c.filterBg).rnBorder(1.dp, if (on) c.tint else c.border, CircleShape),
                                    contentAlignment = Alignment.Center) { Icon(icon, null, tint = if (on) c.tint else c.secondaryText, modifier = Modifier.size(17.dp)) }
                            }
                            Text(label, style = rnText(13, 600), color = if (on) c.tint else c.text, maxLines = 2, modifier = Modifier.weight(1f))

                            if (on) Icon(if (picker == "weeklyReviewDay") Lucide.CheckPicked else SettingsIonicons.Checkmark, null, tint = c.tint, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ManageEditor(model: InboxViewModel, view: JSONObject, open: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val type = open.getJSONObject("target").getString("type")
    val text = view.getJSONObject("editor").getJSONObject("text").getJSONObject(type)
    val name = open.getString("name")
    val action = settings.editorAction(open, text)
    val owed = model.failedAction == action
    val editable = model.failedAction == null


    val target = open.getJSONObject("target")
    LaunchedEffect(target.toString(), name, model.busy, model.failedAction) { settings.checkEditor(target, name) }
    val checked = settings.editorCheck?.takeIf { it.getString("name") == name && it.getString("target") == target.toString() }
    val canSave = owed || (idle && checked != null && !checked.getBoolean("saveDisabled"))

    BackHandler(enabled = !owed) { keepDialog(null) }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(owed) { detectTapGestures { if (!owed) keepDialog(null) } }.imePadding().padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("manage-editor")) {
            Text(text.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            text.menuText("namePlaceholder")?.let { placeholder ->
                SettingInput(name, placeholder, placeholder, Modifier.fillMaxWidth().testTag("manage-editor-name"), enabled = editable) { settings.editField("name", it) }
            }
            checked?.menuText("message")?.let { Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
            text.optJSONObject("personFields")?.let { fields ->
                SettingInput(open.getString("note"), fields.getString("notePlaceholder"), fields.getString("notePlaceholder"), Modifier.padding(top = 8.dp).fillMaxWidth(),
                    enabled = editable) { settings.editField("note", it) }
                SettingInput(open.getString("referenceLink"), fields.getString("referencePlaceholder"), fields.getString("referencePlaceholder"),
                    Modifier.padding(top = 8.dp).fillMaxWidth(), enabled = editable) { settings.editField("referenceLink", it) }
            }
            if (!text.isNull("changeColor")) FlowRow(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                for (swatch in view.getJSONObject("editor").menuObjects("colors")) {
                    val color = swatch.getString("color")
                    val on = open.getString("color") == color
                    val label = swatch.getString("label")
                    val choose = { settings.editField("color", color) }
                    Box(Modifier.size(32.dp).clip(CircleShape).background(coreColorOrNull(color) ?: c.tint)
                        .rnBorder(if (on) 2.dp else 1.dp, if (on) theme.swatchSelected else theme.swatchBorder, CircleShape)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; if (editable) onClick { choose(); true } else disabled() }
                        .clickable(enabled = editable) { choose() }, contentAlignment = Alignment.Center) {
                        if (on) Icon(SettingsIonicons.Checkmark, null, tint = theme.onAction, modifier = Modifier.size(16.dp))
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                val button = RoundedCornerShape(10.dp)
                val cancel = text.getString("cancelLabel")
                Box(Modifier.widthIn(min = 92.dp).heightIn(min = 42.dp).clip(button).rnBorder(1.dp, c.border, button)
                    .clearAndSetSemantics { contentDescription = cancel; role = Role.Button; if (!owed) onClick { keepDialog(null); true } else disabled() }
                    .clickable(enabled = !owed) { keepDialog(null) }.padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                    Text(cancel, style = rnText(14, 600), color = c.secondaryText)
                }
                val save = text.getString("saveLabel")
                Box(Modifier.fade(if (canSave) 1f else 0.5f).widthIn(min = 92.dp).heightIn(min = 42.dp).clip(button).background(theme.manageButton)
                    .clearAndSetSemantics { contentDescription = save; role = Role.Button; testTag = "manage-editor-save"; if (canSave) onClick { settings.saveEditor(action); true } else disabled() }
                    .clickable(enabled = canSave) { settings.saveEditor(action) }.padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center) {
                    Text(save, style = rnText(14, 600), color = theme.onAction)
                }
            }
        }
    }
}


@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FieldSheet(model: InboxViewModel, field: JSONObject) = with(model.menu.settings) {
    val theme = LocalTheme.current
    val c = theme.colors
    val sheet = field.getJSONObject("sheet")
    val close = { editLocal { remove("sheetField") } }
    BackHandler { close() }
    Box(Modifier.fillMaxSize().background(theme.scrim).pointerInput(Unit) { detectTapGestures { close() } }) {
        val shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(bottom = 24.dp).testTag("settings-field-sheet")) {
            Box(Modifier.padding(top = 10.dp, bottom = 2.dp).align(Alignment.CenterHorizontally).size(42.dp, 5.dp).clip(CircleShape).background(c.border))
            Column(Modifier.padding(16.dp)) {
                Text(sheet.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 4.dp).semantics { heading() })
                sheet.menuText("section")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText) }
            }
            ToggleRow(model, sheet.getJSONObject("visible"), true, write = { gtd(it) })
            sheet.optJSONObject("sections")?.let { sections ->
                Column(Modifier.fillMaxWidth().rnBorderTop(c.border).padding(16.dp)) {
                    Text(sections.getString("label"), style = rnText(16, 500, 21), color = c.text)
                    FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (option in sections.menuObjects("options")) {
                            val on = option.getBoolean("selected")
                            val label = option.getString("label")
                            val enabled = model.menu.idle
                            Text(label, style = rnText(12, 600), color = if (on) c.tint else c.secondaryText, modifier = Modifier.clip(CircleShape)
                                .background(if (on) c.filterBg else c.cardBg).rnBorder(1.dp, if (on) c.tint else c.border, CircleShape)
                                .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; if (enabled) onClick { gtd(option.getJSONObject("edit")); true } else disabled() }
                                .clickable(enabled = enabled) { gtd(option.getJSONObject("edit")) }.padding(horizontal = 10.dp, vertical = 6.dp))
                        }
                    }
                }
            }
            val order = sheet.getJSONObject("order")
            Column(Modifier.fillMaxWidth().rnBorderTop(c.border).padding(16.dp)) {
                Text(order.getString("label"), style = rnText(16, 500, 21), color = c.text)
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((name, icon) in listOf("moveUp" to SettingsIonicons.ArrowUp, "moveDown" to SettingsIonicons.ArrowDown)) {
                        val move = order.getJSONObject(name)
                        val edit = move.optJSONObject("edit")
                        val can = !move.getBoolean("disabled") && edit != null && model.menu.idle
                        val label = move.getString("label")
                        val button = RoundedCornerShape(12.dp)
                        Row(Modifier.fade(if (!move.getBoolean("disabled")) 1f else 0.45f).weight(1f).heightIn(min = 44.dp).clip(button).background(c.filterBg).rnBorder(1.dp, c.border, button)
                            .clearAndSetSemantics { contentDescription = label; role = Role.Button; if (can) onClick { gtd(edit!!); true } else disabled() }
                            .clickable(enabled = can) { gtd(edit!!) }.padding(horizontal = 12.dp),
                            horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                            val tint = if (move.getBoolean("disabled")) c.secondaryText else c.text
                            Icon(icon, null, tint = tint, modifier = Modifier.size(16.dp))
                            Text(label, style = rnText(14, 600), color = tint, modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
            }
            val done = sheet.getString("doneLabel")
            Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp).fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(theme.filledBg)
                .clearAndSetSemantics { contentDescription = done; role = Role.Button; onClick { close(); true } }.clickable { close() }, contentAlignment = Alignment.Center) {
                Text(done, style = rnText(15, 700), color = theme.filledText)
            }
        }
    }
}


@Composable
internal fun OnboardingHandoffCard(model: InboxViewModel) {
    val settings = model.menu.settings
    if (!settings.local.optBoolean("onboardingHandoff")) return
    val c = LocalTheme.current.colors
    val transfer = settings.transfer
    val seeding = transfer.action == "gettingStarted"
    Column(Modifier.padding(bottom = 12.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(c.cardBg).padding(16.dp)) {
        Text(t("settings.gettingStartedContentContinueTitle"), style = rnText(16, 500, 21), color = c.text)
        Text(t("settings.gettingStartedContentContinueDesc"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        val busy = transfer.busy
        val shape = RoundedCornerShape(16.dp)
        Box(Modifier.padding(top = 12.dp).clip(shape).background(if (busy) c.filterBg else c.tint).rnBorder(1.dp, if (busy) c.border else c.tint, shape)
            .clickable(enabled = !busy, role = Role.Button) { transfer.gettingStarted(openProject = true) }.semantics { if (busy) disabled() }
            .testTag("mobile-onboarding-start-fresh-handoff")

            .padding(horizontal = 11.dp, vertical = 7.dp)) {
            Text(t(if (seeding) "common.loading" else "onboarding.startFreshTitle"), style = rnText(13, 700, 17), color = if (busy) c.secondaryText else c.onTint)
        }
    }
}
