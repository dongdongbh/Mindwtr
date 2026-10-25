package tech.dongdongbh.mindwtr.pilot

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/*
 * RN's Settings › Calendar (components/settings/calendar-settings-screen.tsx) on core's contract
 * (native-host-contract-settings-calendar.ts). Kotlin keeps only what RN keeps in React state for one visit, in memory (a URL as
 * typed may hold a password, so never in saved state): which card is open, the open Area choice, the name and URL as typed, and
 * Delete's confirmation. Every word, option, value and write is core's; the system document picker is the host's.
 */

/**
 * Settings › Calendar's screen calls CalendarSettings.kt sends itself: a new subscription (host-entry.ts MENU_COMMANDS, never
 * journaled: WriteJournal.UNJOURNALED, its URL may carry a password). Every other write is `calendarSetting` through the Menu
 * tab's journaled send.
 */
val CALENDAR_COMMANDS = setOf("calendarFeedAdd")

/**
 * Settings › Calendar's visits: each Back ends one, so an open (or a device call) that ends after it counts for nothing, its toasts
 * are dropped, and the next visit opens afresh (RN unmounts the screen). Thread-safe: opens run off the main thread.
 */
class CalendarVisit {
    @Volatile var current = 0L; private set
    @Volatile var isOpen = false; private set

    /** The visit [visit]'s open answered: true when it is still the visit on screen (now open). */
    @Synchronized fun opened(visit: Long): Boolean = (visit == current).also { if (it) isOpen = true }
    fun isCurrent(visit: Long) = visit == current
    @Synchronized fun leave() { current += 1; isOpen = false }
}

class CalendarSettingsModel(private val menu: MenuModel) {
    private companion object {
        /** A visit's open and close, and each new subscription, in the order sent. */
        val visits: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-calendar-settings") }
    }
    private val shell get() = menu.shell
    private val settings get() = menu.settings

    /** This visit, and whether openCalendarSettings ran for it: RN reads the device once, when the screen mounts. */
    private val visit = CalendarVisit()
    var pushOpen by mutableStateOf(false); private set
    var deviceOpen by mutableStateOf(false); private set
    /** The open Area choice (core's `key`), one at a time. */
    var areas by mutableStateOf<String?>(null); private set
    var name by mutableStateOf(""); private set
    var url by mutableStateOf(""); private set
    /** Delete Mindwtr calendar's question (core's confirm and edit) while it shows. */
    var confirm by mutableStateOf<JSONObject?>(null); private set

    /** Settings' read of this screen: it opens once per visit (its toasts shown), then core's view for the fields as typed. */
    fun read(runtime: CoreHost): JSONObject {
        open(runtime)
        val input = { JSONObject().put("draft", JSONObject().put("name", name).put("url", url)).toString() }
        return try {
            runtime.menuRead("calendarSettings", input())
        } catch (failure: Exception) {
            // Core has no open screen (a close that raced this visit): open it again, once.
            if (failure.message?.contains("(openCalendarSettings)") != true) throw failure
            open(runtime, reopen = true)
            runtime.menuRead("calendarSettings", input())
        }
    }

    /**
     * One open per visit, after any close sent before it. An open that ends after Back counts for nothing: core's session it made
     * is closed again and its toasts dropped.
     */
    private fun open(runtime: CoreHost, reopen: Boolean = false) = visits.submit {
        val mine = visit.current
        if (visit.isOpen && !reopen) return@submit
        val reply = runtime.calendarRequest("openCalendarSettings", "{}")
        if (visit.opened(mine)) shell.ui { if (visit.isCurrent(mine)) toasts("openCalendarSettings", reply) }
        else runCatching { runtime.menuRead("calendarSettingsClose", "{}") }
    }.get()

    /** Leaving the screen (RN unmounts it): its state goes, and core forgets the visit. */
    fun leave() {
        visit.leave()
        pushOpen = false; deviceOpen = false; areas = null; name = ""; url = ""; confirm = null
        val runtime = shell.coreHost() ?: return
        visits.execute { runCatching { runtime.menuRead("calendarSettingsClose", "{}") }.onFailure { Log.w(CoreHost.TAG, "Calendar screen close failed ${failureForLog(it)}") } }
    }

    fun togglePush() { pushOpen = !pushOpen }
    fun toggleDevice() { deviceOpen = !deviceOpen }
    fun toggleAreas(key: String) { areas = if (areas == key) null else key }
    fun typeName(text: String) { name = text }
    fun typeUrl(text: String) { url = text }
    fun askDelete(delete: JSONObject) { confirm = delete }
    fun closeConfirm() { confirm = null }

    // ---- Writes ----

    /** An edit core's view gave (setCalendarSetting), through the Menu tab's journaled send. */
    fun edit(edit: JSONObject) = menu.command("calendarSetting", JSONObject().put("edit", edit))

    fun delete() {
        val question = confirm ?: return
        confirm = null
        edit(question.getJSONObject("edit"))
    }

    /** Add: the URL and name as typed, at the list's revision the view showed. Never journaled (its URL may hold a password). */
    fun add(revision: String) = addFeed(JSONObject().put("name", name).put("url", url).put("revision", revision))

    /**
     * Choose local .ics file's pick: kept readable after a restart (a persisted read grant; RN's picker keeps none), then sent
     * with the name as typed, the file's name and its URI.
     */
    fun addFile(uri: Uri, revision: String) {
        val resolver = shell.getApplication<android.app.Application>().contentResolver
        keepPickedFileReadable { flags -> resolver.takePersistableUriPermission(uri, flags) }
            ?.let { Log.w(CoreHost.TAG, "Calendar file grant not kept ${failureForLog(it)}") }
        val fileName = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }
        }.getOrNull()
        addFeed(JSONObject().put("name", name).put("fileName", fileName ?: JSONObject.NULL).put("uri", uri.toString()).put("revision", revision))
    }

    private fun addFeed(input: JSONObject) {
        val runtime = shell.coreHost() ?: return
        visits.execute {
            val result = runCatching { runtime.menuCommand("calendarFeedAdd", input.put("requestId", UUID.randomUUID().toString()).toString()) }
            shell.ui {
                result.onSuccess { reply -> done(reply) }
                // Core's message names no URL.
                result.exceptionOrNull()?.let { failed("calendarFeedAdd", it) }
                menu.whenIdle { settings.refresh() }
            }
        }
    }

    /** Grant access, Test and Refresh calendars: core's device calls, which wait on a prompt, the provider or every feed. */
    fun request(name: String) {
        val runtime = shell.coreHost() ?: return
        val mine = visit.current
        Thread({
            val result = runCatching { runtime.calendarRequest(name, "{}") }
            shell.ui {
                // An answer after Back belongs to a screen no longer shown.
                if (!visit.isCurrent(mine)) return@ui
                result.onSuccess { toasts(name, it) }
                result.exceptionOrNull()?.let { failed(name, it) }
                menu.whenIdle { settings.refresh() }
            }
        }, "mindwtr-calendar-$name").start()
    }

    // ---- Answers ----

    /** Core's answer to a write: its toasts, the card it opens, the fields emptied, and Grant access when core asks for it. */
    fun done(reply: JSONObject) {
        toasts("calendarSetting", reply)
        when (reply.menuText("open")) { "push" -> pushOpen = true; "device" -> deviceOpen = true }
        if (reply.optBoolean("clearDraft")) { name = ""; url = "" }
        if (reply.optBoolean("requestAccess")) request("grantDeviceCalendarAccess")
    }

    /** A write core refused before writing: a stale view is read again; any other refusal shows core's words. */
    fun refused(failure: Exception) {
        if (failure.message?.startsWith("STALE_REVISION") != true) shell.showToast(null, failure.message.orEmpty().substringAfter(": "), "error")
        menu.whenIdle { settings.refresh() }
    }

    private fun failed(name: String, error: Throwable) {
        Log.w(CoreHost.TAG, "Calendar screen command failed command=$name code=${error.message?.substringBefore(':')}")
        shell.showToast(null, error.message.orEmpty().substringAfter(": "), "error")
    }

    /**
     * Core's toasts, RN's in order: the newest stays on screen. The log names each toast's tone, title and message for the device
     * check: Settings › Calendar's toasts are core's fixed words and counts, never a URL or a calendar's name.
     */
    private fun toasts(name: String, reply: JSONObject) {
        val all = reply.menuObjects("toasts")
        if (all.isNotEmpty()) Log.i(CoreHost.TAG, "Native Android calendar screen command=$name toasts=${all.joinToString("|") { "${it.optString("tone")}:${it.optString("title")}:${it.optString("message")}" }}")
        val toast = all.lastOrNull() ?: return
        shell.showToast(toast)
    }
}

// ---- The screen ----

/** RN's calendar screen from core's view: the push card (none until calendar push, C4), the device calendars card, the subscription form and the list. */
@Composable
internal fun CalendarSettings(model: InboxViewModel, view: JSONObject) {
    view.optJSONObject("push")?.let { PushCard(model, it) }
    DeviceCard(model, view.getJSONObject("device"))
    FeedsSection(model, view.getJSONObject("feeds"))
}

/** Over the screen: Delete Mindwtr calendar's question, as RN's Alert asks it. */
@Composable
internal fun CalendarSettingsDialogs(model: InboxViewModel) {
    val screen = model.menu.settings.calendar
    val question = screen.confirm?.getJSONObject("confirm") ?: return
    AlertDialog(
        onDismissRequest = { screen.closeConfirm() },
        title = { Text(question.getString("title")) },
        text = { Text(question.getString("message")) },
        confirmButton = { TextButton(onClick = { screen.delete() }, modifier = Modifier.testTag("calendar-delete-confirm")) { Text(question.getString("confirm"), color = LocalTheme.current.deleteAction) } },
        dismissButton = { TextButton(onClick = { screen.closeConfirm() }) { Text(question.getString("cancel")) } },
    )
}

/** RN's settingRow: the content at the left (settingInfo), a hairline above when [divider], the trailing control at the top. */
@Composable
private fun CalendarRow(divider: Boolean, modifier: Modifier = Modifier, info: @Composable ColumnScope.() -> Unit, trailing: @Composable () -> Unit = {}) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().then(if (divider) Modifier.hairline(c.border, top = true) else Modifier).then(modifier).padding(16.dp),
        verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 16.dp), content = info)
        trailing()
    }
}

@Composable
private fun Label(text: String, color: Color = LocalTheme.current.colors.text, lines: Int = Int.MAX_VALUE) =
    Text(text, style = rnText(16, 500, 21), color = color, maxLines = lines)

@Composable
private fun Detail(text: String, top: Int = 2, color: Color = LocalTheme.current.colors.secondaryText, lines: Int = Int.MAX_VALUE) =
    Text(text, style = rnText(13, 400, 18), color = color, maxLines = lines, modifier = Modifier.padding(top = top.dp))

/** RN's CollapsibleSettingHeader: the title and description with ▸ or ▾ fold the card; RN's switch sends core's edit. */
@Composable
private fun FoldHeader(model: InboxViewModel, card: JSONObject, open: Boolean, tag: String, fold: () -> Unit) {
    val c = LocalTheme.current.colors
    val title = card.getString("title")
    val description = card.getString("description")
    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.Top) {
        Row(Modifier.weight(1f).padding(end = 12.dp).clearAndSetSemantics {
            contentDescription = "$title, $description"; role = Role.Button; testTag = tag
            onClick { fold(); true }; if (open) collapse { fold(); true } else expand { fold(); true }
        }.clickable(onClick = fold), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 12.dp)) {
                Label(title)
                Detail(description)
            }
            Text(if (open) "▾" else "▸", style = rnText(24, 300), color = c.secondaryText)
        }
        Box(Modifier.testTag("$tag-switch")) {
            RnSwitch(card.getBoolean("enabled"), model.menu.idle, title, LocalTheme.current.settingsSwitch) { model.menu.settings.calendar.edit(card.getJSONObject("toggle")) }
        }
    }
}

/** RN's backendOption: a bordered pill with a CompactText label; [filled] is Add's filled look once the URL has text. */
@Composable
private fun Pill(label: String, tag: String, enabled: Boolean = true, filled: Boolean = false, top: Int = 0, press: () -> Unit) {
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(16.dp)
    Box(Modifier.padding(top = top.dp).clip(shape).background(if (filled) theme.filledBg else c.filterBg).border(1.dp, c.border, shape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = tag; if (enabled) onClick { press(); true } else disabled() }
        .clickable(enabled = enabled, onClick = press).padding(horizontal = 10.dp, vertical = 6.dp)) {
        Text(label, style = rnText(13, 700, 17).compact(), color = when { filled -> theme.filledText; enabled || tag != "calendar-add" -> c.text; else -> c.secondaryText },
            maxLines = 2, textAlign = TextAlign.Center)
    }
}

/** RN's renderAreaSelector: core's label in the tint opens the choice; each Area is a checkbox sending core's edit. */
@Composable
private fun AreaChoice(model: InboxViewModel, choice: JSONObject?) {
    choice ?: return
    val screen = model.menu.settings.calendar
    val c = LocalTheme.current.colors
    val key = choice.getString("key")
    val label = choice.getString("label")
    Column(Modifier.padding(top = 8.dp)) {
        Text(label, style = rnText(13, 400, 18), color = c.tint, modifier = Modifier.clearAndSetSemantics {
            contentDescription = label; role = Role.Button; testTag = "calendar-areas-$key"; onClick { screen.toggleAreas(key); true }
        }.clickable { screen.toggleAreas(key) })
        if (screen.areas == key) for (option in choice.menuObjects("options")) {
            val text = option.getString("label")
            val checked = option.getBoolean("checked")
            val enabled = model.menu.idle
            Text(text, style = rnText(13, 400, 18), color = c.text, modifier = Modifier.fillMaxWidth().clearAndSetSemantics {
                contentDescription = text; role = Role.Checkbox; toggleableState = ToggleableState(checked)
                if (enabled) onClick { screen.edit(option.getJSONObject("edit")); true } else disabled()
            }.clickable(enabled = enabled) { screen.edit(option.getJSONObject("edit")) }.padding(vertical = 7.dp))
        }
    }
}

/** RN's spinner in the tint (ActivityIndicator). */
@Composable
private fun Spinner(color: Color = LocalTheme.current.colors.tint) = CircularProgressIndicator(Modifier.size(20.dp), color = color, strokeWidth = 2.dp)

/** RN's push card: the header; while open and on, access denied, or the calendar choice, the colors, Refresh and Delete. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PushCard(model: InboxViewModel, push: JSONObject) {
    val screen = model.menu.settings.calendar
    val theme = LocalTheme.current
    val c = theme.colors
    Card {
        FoldHeader(model, push, screen.pushOpen, "calendar-push") { screen.togglePush() }
        if (!screen.pushOpen) return@Card
        push.menuText("denied")?.let { denied ->
            Column(Modifier.padding(top = 12.dp).fillMaxWidth().hairline(c.border, top = true).padding(top = 12.dp)) { Detail(denied, top = 0) }
        }
        val target = push.optJSONObject("target") ?: return@Card
        Column(Modifier.fillMaxWidth().hairline(c.border, top = true)) {
            Column(Modifier.padding(16.dp)) {
                Label(target.getString("title"))
                Detail(target.getString("description"))
                target.menuText("localHint")?.let { Detail(it, top = 8) }
                target.menuText("sharedAccountHint")?.let { Detail(it, top = 8) }
            }
            if (target.getBoolean("loading")) Box(Modifier.fillMaxWidth().padding(bottom = 16.dp), contentAlignment = Alignment.Center) { Spinner() }
            else target.menuObjects("options").forEachIndexed { index, option ->
                val on = option.getBoolean("selected")
                val enabled = model.menu.idle
                CalendarRow(index > 0, Modifier.clearAndSetSemantics {
                    contentDescription = option.getString("accessibilityLabel"); role = Role.Button; selected = on
                    if (enabled) onClick { screen.edit(option.getJSONObject("edit")); true } else disabled()
                }.clickable(enabled = enabled) { screen.edit(option.getJSONObject("edit")) }, info = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        coreColorOrNull(option.menuText("color"))?.let { Box(Modifier.padding(end = 8.dp).size(10.dp).clip(CircleShape).background(it)) }
                        Text(option.getString("name"), style = rnText(16, 500, 21), color = c.text, maxLines = 1, modifier = Modifier.weight(1f))
                    }
                    Detail(option.getString("description"), lines = 1)
                }) { if (on) Icon(SettingsIonicons.Checkmark, null, tint = c.tint, modifier = Modifier.size(20.dp)) }
            }
            target.optJSONObject("colors")?.let { colors ->
                Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(16.dp)) {
                    Label(colors.getString("title"))
                    Detail(colors.getString("description"))
                    FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        for (option in colors.menuObjects("options")) {
                            val on = option.getBoolean("selected")
                            val enabled = model.menu.idle
                            Box(Modifier.size(34.dp).clip(CircleShape).background(coreColorOrNull(option.getString("color")) ?: c.tint)
                                .border(if (on) 3.dp else 1.dp, if (on) c.text else c.border, CircleShape)
                                .clearAndSetSemantics { contentDescription = option.getString("accessibilityLabel"); role = Role.Button; selected = on
                                    if (enabled) onClick { screen.edit(option.getJSONObject("edit")); true } else disabled() }
                                .clickable(enabled = enabled) { screen.edit(option.getJSONObject("edit")) })
                        }
                    }
                }
            }
            val refresh = target.getJSONObject("refresh")
            CalendarRow(true, Modifier.clearAndSetSemantics { contentDescription = refresh.getString("label"); role = Role.Button; onClick { screen.request("refreshCalendarPushTargets"); true } }
                .clickable { screen.request("refreshCalendarPushTargets") }, info = {
                Label(refresh.getString("label"))
                Detail(refresh.getString("description"))
            }) { Icon(SettingsIonicons.RefreshOutline, null, tint = c.tint, modifier = Modifier.size(20.dp)) }
            val delete = target.getJSONObject("delete")
            val busy = delete.getBoolean("busy")
            CalendarRow(true, Modifier.fade(if (busy) 0.6f else 1f).clearAndSetSemantics { contentDescription = delete.getString("label"); role = Role.Button
                if (!busy) onClick { screen.askDelete(delete); true } else disabled() }.clickable(enabled = !busy) { screen.askDelete(delete) }, info = {
                Label(delete.getString("label"), theme.deleteAction)
                Detail(delete.getString("description"))
            }) { if (busy) Spinner(theme.deleteAction) else Icon(SettingsIonicons.TrashOutline, null, tint = theme.deleteAction, modifier = Modifier.size(20.dp)) }
        }
    }
}

/** RN's device calendars card: the header; while open and on, Grant access, a spinner, "none found", or each calendar's row. */
@Composable
private fun DeviceCard(model: InboxViewModel, device: JSONObject) {
    val screen = model.menu.settings.calendar
    val c = LocalTheme.current.colors
    Card(top = 16) {
        FoldHeader(model, device, screen.deviceOpen, "calendar-device") { screen.toggleDevice() }
        if (!screen.deviceOpen || !device.getBoolean("enabled")) return@Card
        Column(Modifier.padding(top = 12.dp).fillMaxWidth().hairline(c.border, top = true).padding(top = 12.dp).testTag("calendar-device-body")) {
            val access = device.optJSONObject("access")
            val calendars = device.menuObjects("calendars")
            when {
                access != null -> {
                    Detail(access.getString("text"), top = 0)
                    Pill(access.getString("grantLabel"), "calendar-grant", enabled = model.menu.idle, top = 12) { screen.request("grantDeviceCalendarAccess") }
                }
                device.getBoolean("loading") -> Box(Modifier.padding(vertical = 8.dp).fillMaxWidth(), contentAlignment = Alignment.Center) { Spinner() }
                device.menuText("empty") != null -> Detail(device.getString("empty"), top = 0)
                else -> calendars.forEachIndexed { index, calendar ->
                    val name = calendar.getString("name")
                    CalendarRow(index > 0, Modifier.testTag("calendar-device-${calendar.getString("id")}"), info = {
                        Label(name, lines = 2)
                        Detail(calendar.getString("subtitle"), lines = 2)
                        AreaChoice(model, calendar.optJSONObject("areas"))
                    }) {
                        val edit = calendar.optJSONObject("edit")
                        RnSwitch(calendar.getBoolean("selected"), model.menu.idle && edit != null, name, LocalTheme.current.settingsSwitch) { edit?.let(screen::edit) }
                    }
                }
            }
        }
    }
}

/** RN's ICS subscriptions: the heading, the guide, the name and URL form with Add, Test and Choose local .ics file, then the list. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FeedsSection(model: InboxViewModel, feeds: JSONObject) {
    val screen = model.menu.settings.calendar
    val theme = LocalTheme.current
    val c = theme.colors
    val revision = feeds.getString("revision")
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { screen.addFile(it, revision) } }
    SectionTitle(feeds.getString("title"), top = 16)
    Text(feeds.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(start = 4.dp, end = 4.dp, bottom = 12.dp))
    GuideLink(feeds.getJSONObject("guide"), "calendar-guide-link")
    Card {
        Column(Modifier.padding(16.dp)) {
            val nameField = feeds.getJSONObject("name")
            Label(nameField.getString("label"))
            FeedInput(screen.name, nameField, "calendar-name", KeyboardOptions.Default) { screen.typeName(it) }
            val urlField = feeds.getJSONObject("url")
            Box(Modifier.padding(top = 12.dp)) { Label(urlField.getString("label")) }
            FeedInput(screen.url, urlField, "calendar-url", KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri)) { screen.typeUrl(it) }
            val add = feeds.getJSONObject("add")
            // The URL as typed decides Add at once, as RN's button follows its field (core's `add.enabled` follows a read later).
            val canAdd = screen.url.isNotBlank()
            FlowRow(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Pill(add.getString("label"), "calendar-add", enabled = canAdd && model.menu.idle, filled = canAdd) { screen.add(revision) }
                Pill(feeds.getJSONObject("test").getString("label"), "calendar-test") { screen.request("testCalendarFeeds") }
            }
            Pill(feeds.getJSONObject("chooseFile").getString("label"), "calendar-choose-file", enabled = model.menu.idle, top = 12) {
                pick.launch(arrayOf("text/calendar", "application/ics", "application/octet-stream", "*/*"))
            }
        }
    }
    val items = feeds.menuObjects("items")
    feeds.menuText("listTitle")?.takeIf { items.isNotEmpty() }?.let { title ->
        SectionTitle(title, top = 16)
        Card {
            items.forEachIndexed { index, feed ->
                val name = feed.getString("name")
                CalendarRow(index > 0, Modifier.testTag("calendar-feed-$index"), info = {
                    Label(name, lines = 2)
                    Detail(feed.getString("url"), lines = 2)
                    AreaChoice(model, feed.optJSONObject("areas"))
                    FlowRow(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (option in feed.menuObjects("colors")) Swatch(model, option)
                    }
                }) {
                    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        RnSwitch(feed.getBoolean("enabled"), model.menu.idle, name, theme.settingsSwitch) { screen.edit(feed.getJSONObject("toggle")) }
                        val remove = feed.getJSONObject("remove")
                        val enabled = model.menu.idle
                        Text(remove.getString("label"), style = rnText(13, 600), color = theme.deleteAction, modifier = Modifier.clearAndSetSemantics {
                            contentDescription = remove.getString("label"); role = Role.Button; testTag = "calendar-feed-$index-remove"
                            if (enabled) onClick { screen.edit(remove.getJSONObject("edit")); true } else disabled()
                        }.clickable(enabled = enabled) { screen.edit(remove.getJSONObject("edit")) })
                    }
                }
            }
        }
    }
}

/** A feed's color swatch (22 px): Auto (ban-outline on the card) or a color; the chosen one ringed in the tint. */
@Composable
private fun Swatch(model: InboxViewModel, option: JSONObject) {
    val screen = model.menu.settings.calendar
    val c = LocalTheme.current.colors
    val on = option.getBoolean("selected")
    val edit = option.optJSONObject("edit")
    val enabled = model.menu.idle
    val color = coreColorOrNull(option.menuText("color"))
    val fill = coreColorOrNull(option.menuText("fill")) ?: color
    Box(Modifier.size(22.dp).clip(CircleShape).background(fill ?: c.cardBg).border(if (on) 3.dp else 1.dp, if (on) c.tint else c.border, CircleShape)
        .clearAndSetSemantics { contentDescription = option.getString("accessibilityLabel"); role = Role.Button; selected = on
            // Picking the color it has writes nothing (core sends no edit).
            if (enabled) onClick { edit?.let(screen::edit); true } else disabled() }
        .clickable(enabled = enabled) { edit?.let(screen::edit) }, contentAlignment = Alignment.Center) {
        if (color == null) Icon(SettingsIonicons.BanOutline, null, tint = c.secondaryText, modifier = Modifier.size(12.dp))
    }
}

/** RN's textInput: a bordered field under its label, with core's placeholder. */
@Composable
private fun FeedInput(value: String, field: JSONObject, tag: String, keyboard: KeyboardOptions, change: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    val style = rnText(14, 400).copy(color = c.text)
    val placeholder = field.getString("placeholder")
    BasicTextField(value, change, singleLine = true, cursorBrush = SolidColor(c.tint), textStyle = style, keyboardOptions = keyboard,
        modifier = Modifier.padding(top = 8.dp).fillMaxWidth().heightIn(min = 40.dp).clip(shape).border(1.dp, c.border, shape)
            .semantics { contentDescription = field.getString("label") }.testTag(tag),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = c.secondaryText))
                inner()
            }
        })
}

/**
 * RN's 5bfa6bf6b: a picked document stays readable after a reboot only through a persisted read grant, which an
 * ACTION_OPEN_DOCUMENT result (OpenDocument) allows. [take] persists it for reading only; its failure is answered, not thrown.
 */
internal fun keepPickedFileReadable(take: (flags: Int) -> Unit): Throwable? =
    runCatching { take(Intent.FLAG_GRANT_READ_URI_PERMISSION) }.exceptionOrNull()
