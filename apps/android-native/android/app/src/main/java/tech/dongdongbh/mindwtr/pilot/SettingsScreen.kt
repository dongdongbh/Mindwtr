package tech.dongdongbh.mindwtr.pilot

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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

/*
 * RN's Settings screens (settings.tsx, settings.shell.tsx, setting-row.tsx, general-, manage- and gtd-settings-screen.tsx,
 * views/someday-section-manager.tsx) drawn from core's views in RN's settings.styles.ts. Every word, option, value, confirmation
 * and write is core's; Kotlin keeps which screen, picker and dialog are open.
 */

/** The open Settings screen under RN's settings top bar (MenuScreenHost draws the bar with [SettingsModel.title]). */
@Composable
fun SettingsList(model: InboxViewModel) = with(model.menu.settings) {
    val shown = page ?: return
    // A GTD sub-screen shares core's one GTD view with the hub.
    if (shown.screen != screen && !(shown.screen.startsWith("gtd") && screen.startsWith("gtd"))) return
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(16.dp).testTag("settings-$screen")) {
        when (screen) {
            "main" -> SettingsMenu(model, shown.view)
            "advanced" -> MenuCard(model, shown.view.getJSONObject("advanced").menuObjects("rows"))
            "general" -> GeneralSettings(model, shown.view)
            "manage" -> ManageSettings(model, shown)
            "data" -> DataSettings(model, shown.view)
            "sync" -> SyncSettings(model, shown.view)
            "ai" -> AISettings(model, shown.view)
            "about" -> AboutSettings(model, shown.view)
            else -> GtdSettings(model, shown.view)
        }
        Spacer(Modifier.height(16.dp))
    }
    SettingsDialogs(model, shown)
}

// ---- The menu ----

/** RN's settings menu: the search field, core's cards of rows, and core's no-matches line. */
@Composable
private fun SettingsMenu(model: InboxViewModel, view: JSONObject) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    val placeholder = view.getString("searchPlaceholder")
    Row(Modifier.padding(top = 16.dp).fillMaxWidth().height(44.dp).clip(shape).background(c.cardBg).border(1.dp, c.border, shape).padding(horizontal = 12.dp),
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

/** RN's menuCard of MenuItems: core's icon, title, description and badge dot; a screen this app does not build is drawn disabled. */
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
                .then(if (index < rows.size - 1) Modifier.hairline(c.border, top = false) else Modifier)
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
                if (row.optBoolean("showIndicator")) Box(Modifier.padding(start = 12.dp).size(8.dp).clip(CircleShape)
                    .background(coreColorOrNull(row.menuText("indicatorColor")) ?: theme.deleteAction))
                Icon(Lucide.ChevronRight, null, tint = c.secondaryText, modifier = Modifier.padding(start = 8.dp).size(20.dp))
            }
        }
    }
}

// ---- Shared pieces (setting-row.tsx, settings.styles.ts) ----

/** RN's sectionTitle: 13/600 capitals, in the secondary text color unless the screen sets another (Data's Diagnostics: the text color). */
@Composable
internal fun SectionTitle(text: String, top: Int = 0, color: Color = LocalTheme.current.colors.secondaryText) =
    Text(text.uppercase(), style = rnText(13, 600), color = color,
        modifier = Modifier.padding(start = 4.dp, bottom = 8.dp, top = top.dp).semantics { heading() })

/** RN's description line above a card. */
@Composable
private fun Description(text: String, top: Int = 0) =
    Text(text, style = rnText(13, 400, 18), color = LocalTheme.current.colors.secondaryText, modifier = Modifier.padding(start = 4.dp, end = 4.dp, bottom = 12.dp, top = top.dp))

/** RN's settingCard. */
@Composable
internal fun Card(top: Int = 0, content: @Composable ColumnScope.() -> Unit) =
    Column(Modifier.padding(top = top.dp).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(LocalTheme.current.colors.cardBg), content = content)

/**
 * RN's SettingRow: the label and description at the left, a trailing control at the top (RN's settingRow is flex-start); a
 * hairline above when [divider]. [failure] is App
 * lock's line in RN's danger color under the description (TalkBack hears it when it shows).
 */
@Composable
private fun SettingRow(label: String, description: String?, divider: Boolean = false, modifier: Modifier = Modifier, failure: String? = null,
                       trailing: @Composable RowScope.() -> Unit = {}) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (divider) Modifier.hairline(c.border, top = true) else Modifier).then(modifier).padding(16.dp),
        verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(label, style = rnText(16, 500, 21), color = c.text)
            description?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
            failure?.let { Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 6.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
        }
        trailing()
    }
}

/** A SettingRow that opens a picker or a screen: one node with its label, value and role. */
@Composable
private fun PressRow(label: String, value: String?, divider: Boolean, enabled: Boolean, icon: ImageVector = SettingsIonicons.ChevronDown,
                     expanded: Boolean? = null, onClick: () -> Unit) {
    val spoken = if (value == null) label else "$label: $value"
    SettingRow(label, value, divider, Modifier.clearAndSetSemantics {
        contentDescription = spoken; role = Role.Button; if (enabled) onClick { onClick(); true } else disabled()
        // A row that folds (Regional formats) reports expanded or collapsed, as RN's accessibilityState does.
        if (expanded == true) collapse { onClick(); true } else if (expanded == false) expand { onClick(); true }
    }.clickable(enabled = enabled, onClick = onClick)) {
        Icon(icon, null, tint = LocalTheme.current.colors.secondaryText, modifier = Modifier.size(18.dp))
    }
}

/** RN's SettingToggleRow: core's label and description, and RN's Android switch sending core's edit. */
@Composable
private fun ToggleRow(model: InboxViewModel, toggle: JSONObject, divider: Boolean, enabled: Boolean = true,
                      props: RnSwitchProps = LocalTheme.current.settingsSwitch, write: (JSONObject) -> Unit) {
    val label = toggle.getString("label")
    SettingRow(label, toggle.menuText("description"), divider) {
        RnSwitch(toggle.getBoolean("value"), enabled && model.failedAction == null, label, props) { write(toggle.getJSONObject("edit")) }
    }
}

/** RN's GTD navigation row: the label, the description, and chevron-forward; it pushes core's screen. */
@Composable
private fun NavRow(model: InboxViewModel, link: JSONObject, first: Boolean = false) {
    val c = LocalTheme.current.colors
    val title = link.getString("title")
    val enabled = model.menu.idle
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (first) Modifier else Modifier.hairline(c.border, top = true))
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

/** RN's gtdSegmentedControl: core's options side by side; the chosen one washed and in the tint. */
@Composable
private fun Segmented(model: InboxViewModel, options: List<JSONObject>, text: (JSONObject) -> String, icons: Boolean = false, radio: Boolean = false,
                      write: (JSONObject) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(14.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(c.bg).border(1.dp, c.border, shape).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
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

/** RN's settings text input (textInput): a bordered field on the screen color. */
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
        modifier = modifier.clip(shape).background(c.bg).border(1.dp, c.border, shape).semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = if (center) Alignment.Center else Alignment.CenterStart) {
                if (value.isEmpty() && placeholder != null) Text(placeholder, style = rnText(14, 400), color = c.secondaryText); inner()
            }
        })
}

// ---- General ----

/** RN's GeneralSettingsScreen on core's getGeneralSettings; every choice sends core's edit through setGeneralSetting. */
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
        // RN's app lock (AppLock.kt): turning it on asks the device lock first; a no shows core's line for why under the row.
        val lock = privacy.getJSONObject("appLock")
        SettingRow(lock.getString("label"), lock.getString("description"), failure = model.lock.switchFailure(lock)) {
            RnSwitch(lock.getBoolean("value"), model.failedAction == null && !model.lock.authenticating, lock.getString("label"), theme.generalSwitch) { model.lock.toggle(lock) }
        }
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

// ---- Data ----

/**
 * RN's Data screen's Diagnostics card (sync-settings-sections.tsx SyncDiagnosticsCard) on core's getDataSettings: the Debug
 * logging switch sends core's edit; while logging is on, Share log and Clear log. The Data screen's other cards, RN's analytics
 * row (builds with the heartbeat only) and its Encryption block (sync) come with their passes.
 */
@Composable
private fun DataSettings(model: InboxViewModel, view: JSONObject) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val diagnostics = view.getJSONObject("diagnostics")
    SectionTitle(diagnostics.getString("title"), top = 24, color = c.text)
    Card {
        // RN's analytics switch, in a build with the heartbeat: on while opted out; turning it on asks core's question first.
        diagnostics.optJSONObject("analytics")?.let { analytics ->
            ToggleRow(model, analytics, false, props = theme.analyticsSwitch) { edit ->
                if (edit.getBoolean("value")) settings.editLocal { put("analyticsConfirm", true) } else settings.data(edit)
            }
        }
        // RN always draws this row's top border (it follows the Encryption block). Share and Clear touch no app data, so they work
        // in every state, as RN's do (a retry owed included).
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

/** RN's pressable settingRow with a colored label and no trailing control: one button node that reads its texts, as RN's does. */
@Composable
private fun ActionRow(label: String, description: String?, color: Color, enabled: Boolean, tag: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val spoken = if (description == null) label else "$label, $description"
    Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(c.border, top = true)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = tag; if (enabled) onClick { onClick(); true } else disabled() }
        .clickable(enabled = enabled, onClick = onClick).padding(16.dp)) {
        // RN's settingInfo: 16dp to its right.
        Column(Modifier.padding(end = 16.dp)) {
            Text(label, style = rnText(16, 500, 21), color = color)
            description?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
        }
    }
}

// ---- Manage ----

/** RN's ManageSettingsScreen on core's getManageSettings: its five folding sections, each read open or closed from RN's key. */
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
                    // RN's accessibilityState expanded: TalkBack hears "expanded" or "collapsed" from the action it offers.
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

/** RN's row buttons on Manage: pencil (edit) and trash (delete, in RN's red), each a 44 target with core's words. */
@Composable
private fun RowButton(icon: ImageVector, label: String, tint: Color, enabled: Boolean, tag: String? = null, onClick: () -> Unit) {
    // The tag goes inside the one semantics block: clearAndSetSemantics drops a testTag set after it (S23 run 50).
    Box(Modifier.size(44.dp).clearAndSetSemantics {
        contentDescription = label; role = Role.Button; if (tag != null) testTag = tag
        if (enabled) onClick { onClick(); true } else disabled()
    }.clickable(enabled = enabled, onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
    }
}

/** RN's 24 color swatch beside an area. */
@Composable
private fun Swatch(color: String) {
    val c = LocalTheme.current.colors
    Box(Modifier.padding(end = 12.dp).size(24.dp).clip(RoundedCornerShape(6.dp)).background(coreColorOrNull(color) ?: c.tint))
}

/** RN's primary Add button (manageEditorButtonPrimary): core's label with RN's plus, in RN's fixed blue. */
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

/** A list's More: the next window of core's rows. */
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
    Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
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
        Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 6.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
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
        Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).clip(CircleShape).background(c.bg).border(1.dp, c.border, CircleShape), contentAlignment = Alignment.Center) {
                Text(row.getString("initial"), style = rnText(14, 700), color = c.text)
            }
            Column(Modifier.weight(1f).padding(start = 12.dp)) {
                Text(name, style = rnText(16, 500, 21), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                row.menuText("detail")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            // The task count opens global search for the person's tasks (core's query), as RN's does.
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

/** Contexts and tags: each value with Rename (core's editor) and Delete (after core's question). */
@Composable
private fun ManageValues(model: InboxViewModel, page: SettingsPage, list: String, empty: String?) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    empty?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(16.dp)) }
    for (row in page.list(list)) {
        val value = row.getString("value")
        Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(horizontal = 16.dp, vertical = 6.dp).heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(value, style = rnText(16, 500, 21), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            RowButton(SettingsIonicons.PencilOutline, "${t("common.edit")}: $value", c.secondaryText, idle) { settings.openEditor(row.getJSONObject("edit")) }
            RowButton(SettingsIonicons.TrashOutline, "${t("common.delete")}: $value", theme.deleteAction, idle) {
                confirm(row.getJSONObject("deleteConfirm"), JSONObject().put("target", row.getJSONObject("delete")), "manageDelete")
            }
        }
    }
    if (page.list(list).size < page.total(list)) ListMore(model, list)
}

/**
 * RN's SomedaySectionManager on core's getSomedaySections: each section with Move up and Move down (core's order after the move),
 * Rename (an inline field; Save sends core's rename), and Delete after core's question. Core's hint shows when there is none.
 */
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
        Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).hairline(c.border, top = false).padding(horizontal = 12.dp),
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

// ---- GTD ----

/** RN's GtdSettingsScreen: the hub or one of its six screens, from core's one GTD view; every control sends core's edit. */
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
        for (name in listOf("focusTaskLimit", "defaultProjectFlowMode")) {
            val control = hub.getJSONObject(name)
            Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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

/**
 * A GTD text field (the Default schedule time, a Pomodoro minute field): the typed text is kept with the screen, and it commits
 * on blur or Done, as RN's onBlur does, sending the typed text in core's edit ([edit] builds it from the typed text).
 */
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
            // RN commits both minute fields together on either field's blur (core's pomodoroDurations reads both as typed).
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
        // RN's exact-alarm notice under the Completion alert (exact-alarm-notice.tsx, inline), core's words: only while Android 12+
        // withholds exact alarms from this app, read again on each resume. Allow opens Android's Alarms & reminders page.
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
}

/**
 * RN's AndroidCaptureIntentSection under the Capture card, from core's card: the switch (off while the stored config is unread or
 * its write runs), and while on the token row with the token RN's CaptureIntentConfigStore holds (never core's), selectable, and
 * Copy. A config that cannot be read shows core's loadFailed toast once per visit, as RN shows it on opening.
 */
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
                            .border(Dp.Hairline, c.border, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 9.dp))
                }
                val copyLabel = token.getString("copyLabel")
                Box(Modifier.testTag("android-capture-intent-copy").clip(RoundedCornerShape(8.dp)).border(1.dp, c.tint, RoundedCornerShape(8.dp))
                    .clearAndSetSemantics { contentDescription = copyLabel; role = Role.Button; onClick { copy(context, stored, messages, model); true } }
                    .clickable { copy(context, stored, messages, model) }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                    Text(copyLabel, style = rnText(14, 600), color = c.tint)
                }
            }
        }
    }
}

/** RN's copyToken: the token on the clipboard, then core's copied (info) or copyFailed (error) toast. */
private fun copy(context: Context, token: String, messages: JSONObject, model: InboxViewModel) {
    val copied = runCatching {
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText(null, token))
    }.isSuccess
    if (copied) model.showToast(null, messages.getString("copied"), "info") else model.showToast(null, messages.getString("copyFailed"), "error")
}

/**
 * RN's Task editor layout: Open tasks in (device-local, core's deviceWrites), the presets, core's groups (open as core says on
 * each visit and whenever core's expandedResetKey changes) with each field's visibility badge and its sheet, and Reset.
 */
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
        FlowRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 16.dp, top = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp), maxItemsInEachRow = 3) {
            for (option in presets.menuObjects("options")) {
                val on = option.getBoolean("selected")
                val label = option.getString("label")
                val enabled = model.menu.idle
                Box(Modifier.weight(1f).heightIn(min = 38.dp).clip(CircleShape).background(if (on) c.filterBg else c.cardBg).border(1.dp, if (on) c.tint else c.border, CircleShape)
                    .clearAndSetSemantics { contentDescription = label; role = Role.RadioButton; selected = on; if (enabled) onClick { gtd(option.getJSONObject("edit")); true } else disabled() }
                    .clickable(enabled = enabled) { gtd(option.getJSONObject("edit")) }.padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.Center) {
                    Text(label, style = rnText(13, 700), color = if (on) c.tint else c.secondaryText, maxLines = 1)
                }
            }
        }
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

/** One field of the task editor layout: RN's eye badge (core's visibility edit) and the row that opens the field's sheet. */
@Composable
private fun FieldRow(model: InboxViewModel, field: JSONObject, divider: Boolean) = with(model.menu.settings) {
    val c = LocalTheme.current.colors
    val visible = field.getBoolean("visible")
    val visibility = field.getJSONObject("visibility")
    val enabled = model.menu.idle
    Row(Modifier.fillMaxWidth().then(if (divider) Modifier.hairline(c.border, top = true) else Modifier).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        val label = visibility.getString("accessibilityLabel")
        Box(Modifier.padding(end = 12.dp).size(34.dp).clip(CircleShape).background(if (visible) c.filterBg else c.cardBg).border(1.dp, if (visible) c.tint else c.border, CircleShape)
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

// ---- Dialogs ----

/** The open picker, Manage editor, or task editor field sheet over the Settings screen. */
@Composable
private fun SettingsDialogs(model: InboxViewModel, page: SettingsPage) = with(model.menu) {
    val open = dialog
    when (open?.optString("kind")) {
        "settingsPicker" -> Picker(model, page.view, open.getString("picker"))
        "manageEditor" -> ManageEditor(model, page.view, open)
    }
    if (settings.screen == "ai") AISettingsDialogs(model, page.view)
    if (settings.screen == "about") AboutOverlays(model, page.view)
    // Data's analytics question (RN's Alert): Keep enabled closes it; Disable sends the switch's edit.
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
    if (settings.screen == "gtd-task-editor") settings.local.optString("sheetField").ifEmpty { null }?.let { id ->
        val field = page.view.getJSONObject("taskEditor").menuObjects("groups").flatMap { it.menuObjects("fields") }.firstOrNull { it.getString("id") == id }
        if (field != null) FieldSheet(model, field)
    }
}

/**
 * RN's settings picker (pickerOverlay, pickerCard): core's title and options, the current one washed with RN's checkmark; the
 * theme picker adds core's icons and a rule between its two groups. A choice sends core's edit and closes it.
 */
@Composable
private fun Picker(model: InboxViewModel, view: JSONObject, picker: String) = with(model.menu) {
    val theme = LocalTheme.current
    val c = theme.colors
    val source = when (picker) {
        "theme" -> view.getJSONObject("appearance").getJSONObject("theme")
        "quickAccess" -> view.getJSONObject("appearance").getJSONObject("quickAccess")
        "language" -> view.getJSONObject("language")
        "defaultArea" -> view.getJSONObject("capture").getJSONObject("defaultArea")
        else -> view.getJSONObject("regional").optJSONObject(picker)
    } ?: return@with
    val groups = if (picker == "theme") source.getJSONArray("groups").let { all -> List(all.length()) { all.getJSONArray(it).let { g -> List(g.length()) { g.getJSONObject(it) } } } }
        else listOf(source.menuObjects("options"))
    val write = { edit: JSONObject -> keepDialog(null); if (picker == "defaultArea") settings.gtd(edit) else settings.general(edit) }
    BackHandler { keepDialog(null) }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(Unit) { detectTapGestures { keepDialog(null) } }.padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().heightIn(max = (LocalConfiguration.current.screenHeightDp * 0.7f).dp).clip(shape).background(c.cardBg)
            .border(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(16.dp).testTag("settings-picker")) {
            Text(source.getString("pickerTitle"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                groups.forEachIndexed { index, options ->
                    if (index > 0) Box(Modifier.padding(vertical = 8.dp).fillMaxWidth().height(1.dp).background(c.border))
                    for (option in options) {
                        val on = option.getBoolean("selected")
                        val label = option.getString("label")
                        val row = RoundedCornerShape(10.dp)
                        Row(Modifier.fillMaxWidth().clip(row).background(if (on) c.filterBg else c.cardBg).border(1.dp, if (on && picker == "defaultArea") c.tint else c.border, row)
                            .clearAndSetSemantics { contentDescription = label; role = Role.RadioButton; selected = on; if (idle) onClick { write(option.getJSONObject("edit")); true } else disabled() }
                            .clickable(enabled = idle) { write(option.getJSONObject("edit")) }.padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            SettingsIonicons.byName[option.optString("icon")]?.let { icon ->
                                Box(Modifier.padding(end = 12.dp).size(32.dp).clip(CircleShape).background(c.filterBg).border(1.dp, if (on) c.tint else c.border, CircleShape),
                                    contentAlignment = Alignment.Center) { Icon(icon, null, tint = if (on) c.tint else c.secondaryText, modifier = Modifier.size(17.dp)) }
                            }
                            Text(label, style = rnText(13, 600), color = if (on) c.tint else c.text, maxLines = 2, modifier = Modifier.weight(1f))
                            if (on) Icon(SettingsIonicons.Checkmark, null, tint = c.tint, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
        }
    }
}

/**
 * RN's Manage editor modal on core's editor text for the target's type: the name (with core's checkManageEditor line and Save state),
 * a person's note and link, the color swatches, Cancel and Save. Save sends the dialog's exact
 * request (its request UUID stays with the dialog); while a retry is owed the fields stay as sent.
 */
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
    // Core's checkManageEditor for the name as typed (a blank name, or a new area named like a live one): its taken-name line and
    // Save's state. Save stays off until core has answered for this name; an owed retry is the dialog's exact request as sent.
    val target = open.getJSONObject("target")
    LaunchedEffect(target.toString(), name, model.busy, model.failedAction) { settings.checkEditor(target, name) }
    val checked = settings.editorCheck?.takeIf { it.getString("name") == name && it.getString("target") == target.toString() }
    val canSave = owed || (idle && checked != null && !checked.getBoolean("saveDisabled"))
    // While its Save's retry is owed, Back is left to the system, as on the lists.
    BackHandler(enabled = !owed) { keepDialog(null) }
    Box(Modifier.fillMaxSize().background(theme.settingsScrim).pointerInput(owed) { detectTapGestures { if (!owed) keepDialog(null) } }.imePadding().padding(20.dp),
        contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.widthIn(max = 440.dp).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
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
                        .border(if (on) 2.dp else 1.dp, if (on) theme.swatchSelected else theme.swatchBorder, CircleShape)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; if (editable) onClick { choose(); true } else disabled() }
                        .clickable(enabled = editable) { choose() }, contentAlignment = Alignment.Center) {
                        if (on) Icon(SettingsIonicons.Checkmark, null, tint = theme.onAction, modifier = Modifier.size(16.dp))
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.End)) {
                val button = RoundedCornerShape(10.dp)
                val cancel = text.getString("cancelLabel")
                Box(Modifier.widthIn(min = 92.dp).heightIn(min = 42.dp).clip(button).border(1.dp, c.border, button)
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

/**
 * RN's field sheet on the task editor layout: the field and its group, Show in editor (core's edit), Move to section (core's
 * chips), Order within section (core's moves, off where core says), and Done.
 */
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
        Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(bottom = 24.dp).testTag("settings-field-sheet")) {
            Box(Modifier.padding(top = 10.dp, bottom = 2.dp).align(Alignment.CenterHorizontally).size(42.dp, 5.dp).clip(CircleShape).background(c.border))
            Column(Modifier.padding(16.dp)) {
                Text(sheet.getString("title"), style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 4.dp).semantics { heading() })
                sheet.menuText("section")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText) }
            }
            ToggleRow(model, sheet.getJSONObject("visible"), true, write = { gtd(it) })
            sheet.optJSONObject("sections")?.let { sections ->
                Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(16.dp)) {
                    Text(sections.getString("label"), style = rnText(16, 500, 21), color = c.text)
                    FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (option in sections.menuObjects("options")) {
                            val on = option.getBoolean("selected")
                            val label = option.getString("label")
                            val enabled = model.menu.idle
                            Text(label, style = rnText(12, 600), color = if (on) c.tint else c.secondaryText, modifier = Modifier.clip(CircleShape)
                                .background(if (on) c.filterBg else c.cardBg).border(1.dp, if (on) c.tint else c.border, CircleShape)
                                .clearAndSetSemantics { contentDescription = label; role = Role.Button; selected = on; if (enabled) onClick { gtd(option.getJSONObject("edit")); true } else disabled() }
                                .clickable(enabled = enabled) { gtd(option.getJSONObject("edit")) }.padding(horizontal = 10.dp, vertical = 6.dp))
                        }
                    }
                }
            }
            val order = sheet.getJSONObject("order")
            Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(16.dp)) {
                Text(order.getString("label"), style = rnText(16, 500, 21), color = c.text)
                Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for ((name, icon) in listOf("moveUp" to SettingsIonicons.ArrowUp, "moveDown" to SettingsIonicons.ArrowDown)) {
                        val move = order.getJSONObject(name)
                        val edit = move.optJSONObject("edit")
                        val can = !move.getBoolean("disabled") && edit != null && model.menu.idle
                        val label = move.getString("label")
                        val button = RoundedCornerShape(12.dp)
                        Row(Modifier.fade(if (!move.getBoolean("disabled")) 1f else 0.45f).weight(1f).heightIn(min = 44.dp).clip(button).background(c.filterBg).border(1.dp, c.border, button)
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
