package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.app.Application
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.FileProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.androidwidget.CaptureIntentConfigStore
import tech.dongdongbh.mindwtr.pilot.InboxViewModel.Part
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.DeviceWrites
import java.io.File
import java.util.Locale
import java.util.UUID

/*
 * RN's Settings (app/(drawer)/settings.tsx, components/settings/general-, manage- and gtd-settings-screen.tsx, and the Data
 * screen's Diagnostics card in sync-settings-sections.tsx) on core's
 * settings contract (native-host-contract-settings.ts), with Manage's Someday sections on core's Someday methods. Kotlin keeps
 * only RN's screen state: the open screen (RN's settings stack), the menu search, the screen state RN resets on every visit,
 * and the device choices RN keeps under its keys. Every row, label, option, confirmation and write is core's.
 */

/** Settings' commands (host-entry.ts MENU_COMMANDS). */
val SETTINGS_KINDS = setOf("generalSetting", "gtdSetting", "manageEditor", "manageDelete", "somedayRename", "somedayReorder", "somedayDelete", "dataSetting", "syncPreference",
    "setAISetting")

/** RN's device keys (core's LANGUAGE_STORAGE_KEY, MOBILE_THEME_STORAGE_KEY, MANAGE_OPEN_SECTIONS_STORAGE_KEY, MOBILE_TASK_OPEN_MODE_STORAGE_KEY). */
const val LANGUAGE_KEY = "mindwtr-language"
const val THEME_KEY = "@mindwtr_theme"
const val MANAGE_SECTIONS_KEY = "mindwtr:settings:manage:openSections"
const val TASK_OPEN_MODE_KEY = "mindwtr:view:taskOpenMode:v1"
/** RN's update dot (core's UPDATE_BADGE_AVAILABLE_KEY), in RN's AsyncStorage. */
const val UPDATE_AVAILABLE_KEY = "mindwtr-update-available"

/** The preferences file that holds RN's device keys (InboxViewModel's `prefs`). */
const val DEVICE_PREFS = "mindwtr-view-state"

/** RN's device keys in [prefs], each kept with the journal sequence of the write that set it (DeviceWrites); one commit each. */
fun deviceStore(prefs: SharedPreferences) = DeviceWrites({ prefs.all }, { changes ->
    prefs.edit().apply { changes.forEach { (key, value) -> if (value == null) remove(key) else putString(key, value) } }.commit()
})

/**
 * CoreHost's store for a reply's deviceWrites (a General or GTD setting's device-local part): the first send and the journal's
 * replay both store them before the write's journal entry goes, so a process death after core's reply loses none.
 */
fun deviceStore(app: Context) = deviceStore(app.getSharedPreferences(DEVICE_PREFS, Context.MODE_PRIVATE))

/** Core windows Manage's lists and the Someday sections by NATIVE_HOST_MAX_WINDOW. */
private const val WINDOW = 100

/** Manage's windowed lists (core's ManageListName), each under the section of the same key. */
private val MANAGE_LISTS = listOf("areas", "people", "contexts", "tags")

/**
 * At boot: the language and theme chosen in this app's Settings (RN's device keys) replace the ones found at boot, so every
 * screen draws in them from its first frame. A debug build's language property still wins (CoreHost.language).
 */
fun applyDeviceChoices(runtime: CoreHost, prefs: SharedPreferences) {
    prefs.getString(LANGUAGE_KEY, null)?.let { stored ->
        runtime.language(stored, Locale.getDefault().toLanguageTag())
        Labels.load(runtime.strings(LABEL_KEYS))
    }
    prefs.getString(THEME_KEY, null)?.let { stored -> runCatching { ThemeChoice.load(runtime.theme(stored)) } }
}

/**
 * A Settings screen at one revision: core's view, on Manage its lists as paged and core's Someday sections, and on GTD the
 * capture intent's token (RN's CaptureIntentConfigStore; it never goes to core), null while it is off or unreadable.
 */
class SettingsPage(val screen: String, val view: JSONObject, val lists: Map<String, List<JSONObject>>, val sections: JSONObject?,
                   val captureToken: String? = null) {
    /** A Manage list as shown: its first window, or as many as More loaded. */
    fun list(name: String): List<JSONObject> = lists[name] ?: view.optJSONObject(name)?.optJSONObject("rows")?.menuObjects("items").orEmpty()
    fun total(name: String): Int = view.optJSONObject(name)?.optJSONObject("rows")?.optInt("total") ?: 0
    /** How deep each list is shown, so a refresh reads it as deep. */
    val depth: Map<String, Int> get() = MANAGE_LISTS.associateWith { list(it).size } + ("somedaySections" to (sections?.menuObjects("rows")?.size ?: 0))
}

class SettingsModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val prefs get() = menu.prefs
    private val main = Handler(Looper.getMainLooper())
    /** Settings › Sync's screen state and commands (SyncSettings.kt). */
    val sync = SyncSettingsModel(menu)
    /** Settings › AI's screen state and commands (AISettings.kt). */
    val ai = AISettingsModel(menu)
    /** Settings › About's screen state and requests (AboutSettings.kt). */
    val about = AboutSettingsModel(menu)

    /** RN's settings stack: "main", then "general", "manage", "data", "advanced", or a GTD screen ("gtd", "gtd-pomodoro", ...). */
    var stack by mutableStateOf(saved.get<String>("settingsStack")?.split(',') ?: listOf("main")); private set
    val screen: String get() = stack.last()
    /** The menu's search as typed. */
    var query by mutableStateOf(saved.get<String>("settingsQuery") ?: ""); private set
    /** The open screen's view. */
    var page by mutableStateOf<SettingsPage?>(null); private set
    /**
     * Screen state RN keeps in React state and resets on every visit (Regional formats open, the GTD text fields as typed, the task
     * editor layout's open groups and field sheet, the auto-start notice shown, a Someday section being renamed). Small, so it rides
     * the Bundle: rotation and process death keep it.
     */
    var local by mutableStateOf(runCatching { JSONObject(saved.get<String>("settingsLocal") ?: "{}") }.getOrDefault(JSONObject())); private set

    private fun keepStack(value: List<String>) { stack = value; saved["settingsStack"] = value.joinToString(",") }
    private fun keepLocal(value: JSONObject) { local = value; saved["settingsLocal"] = value.toString() }
    internal fun editLocal(edit: JSONObject.() -> Unit) = keepLocal(JSONObject(local.toString()).apply(edit))

    /** The title of RN's settings top bar for the open screen, core's words. */
    val title: String get() {
        val view = page?.takeIf { it.screen == screen || (isGtd(it.screen) && isGtd(screen)) }?.view ?: return t("settings.title")
        return when (screen) {
            "main" -> view.getString("title")
            "advanced" -> view.getJSONObject("advanced").getString("title")
            "general", "manage", "data", "sync", "ai", "about" -> view.getString("title")
            "gtd" -> view.getJSONObject("hub").getString("title")
            else -> gtdScreen(view)?.getString("title") ?: t("settings.title")
        }
    }

    /** RN pushes a new Settings: its menu, no search. */
    fun reset() {
        sync.leave()
        ai.leave()
        about.leave()
        keepStack(listOf("main"))
        logToShare = null
        query = ""
        saved["settingsQuery"] = ""
        keepLocal(JSONObject())
        page = null
    }

    /** A menu row or a GTD link opens its screen, as RN pushes it; its screen state starts afresh (RN resets it on every visit). */
    fun push(next: String) {
        keepStack(stack + next)
        logToShare = null
        keepLocal(JSONObject())
        menu.keepDialog(null)
        if (!(isGtd(next) && page?.screen?.let(::isGtd) == true)) page = null
        reload()
    }

    /** RN's Back inside Settings: the screen it opened from; false on the menu itself. */
    fun back(): Boolean {
        if (stack.size < 2) return false
        if (screen == "sync") sync.leave()
        if (screen == "ai") ai.leave()
        if (screen == "about") about.leave()
        keepStack(stack.dropLast(1))
        logToShare = null
        keepLocal(JSONObject())
        menu.keepDialog(null)
        if (!(isGtd(screen) && page?.screen?.let(::isGtd) == true)) page = null
        reload()
        return true
    }

    private var searchTyped = 0

    /** The menu's search: kept as typed, then core's menu for it once typing pauses. */
    fun search(text: String) {
        query = text
        saved["settingsQuery"] = text
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload() }, 200)
    }

    // ---- Reads ----

    private fun isGtd(screen: String) = screen == "gtd" || screen.startsWith("gtd-")

    /** A GTD sub-screen's part of core's one GTD view (a link's `screen` names it). */
    fun gtdScreen(view: JSONObject): JSONObject? = when (screen) {
        "gtd-pomodoro" -> view.optJSONObject("pomodoro")
        "gtd-capture" -> view.optJSONObject("capture")
        "gtd-review" -> view.optJSONObject("review")
        "gtd-inbox" -> view.optJSONObject("inbox")
        "gtd-archive" -> view.optJSONObject("archive")
        "gtd-task-editor" -> view.optJSONObject("taskEditor")
        else -> null
    }

    /** The open screen's core read and its input: the device values core's doc names (RN's keys), sent as stored. */
    private fun request(screen: String): Pair<String, JSONObject> = when {
        // The Sync row's badge as RN's useMobileSyncBadge resolves it (core's state from the JS host's sync events).
        // The About row's update dot: RN's stored `mindwtr-update-available` (settings.tsx reads it on mount).
        screen == "main" || screen == "advanced" -> "settingsMenu" to JSONObject().put("query", query).put("syncBadge", shell.syncBadge.state)
            .put("updateAvailable", runCatching { shell.coreHost()?.rnValue(UPDATE_AVAILABLE_KEY) == "true" }.getOrDefault(false))
        screen == "general" -> "generalSettings" to JSONObject().put("deviceTheme", prefs.getString(THEME_KEY, null) ?: JSONObject.NULL)
        screen == "manage" -> "manageSettings" to JSONObject().put("openSections", prefs.getString(MANAGE_SECTIONS_KEY, null) ?: JSONObject.NULL)
        screen == "data" -> "dataSettings" to JSONObject()
        else -> "gtdSettings" to JSONObject().put("taskOpenMode", prefs.getString(TASK_OPEN_MODE_KEY, null) ?: JSONObject.NULL)
    }

    /**
     * The open screen from core; on Manage, each open list read to its [depth] under Manage's revision (getManageSettingsList), and
     * the Someday sections (getSomedaySections) under theirs. A list that changed between windows keeps what it read; the next
     * refresh reads it again from its first window.
     */
    private fun read(runtime: CoreHost, screen: String, depth: Map<String, Int>): SettingsPage {
        if (screen == "sync") return SettingsPage(screen, sync.read(runtime), emptyMap(), null)
        if (screen == "ai") return SettingsPage(screen, ai.read(runtime), emptyMap(), null)
        if (screen == "about") return SettingsPage(screen, about.read(runtime), emptyMap(), null)
        val (name, input) = request(screen)
        // GTD › Capture's automation capture card: core gets whether the stored config is on (null: it cannot be read).
        val capture = if (name == "gtdSettings") runCatching { CaptureIntentConfigStore.read(shell.getApplication<Application>()) } else null
        capture?.let { input.put("captureIntent", JSONObject().put("enabled", it.getOrNull()?.enabled ?: JSONObject.NULL)) }
        val view = runtime.menuRead(name, input.toString())
        check(view.optInt("version", 1) == 1) { "Unsupported core contract" }
        if (screen != "manage") return SettingsPage(screen, view, emptyMap(), null, capture?.getOrNull()?.token)
        val open = view.menuObjects("sections").associate { it.getString("key") to it.getBoolean("open") }
        val lists = HashMap<String, List<JSONObject>>()
        var sections: JSONObject? = null
        try {
            for (list in MANAGE_LISTS) {
                if (open[list] != true) continue
                val rows = view.getJSONObject(list).getJSONObject("rows")
                var loaded = rows.menuObjects("items")
                while (loaded.size < minOf(depth[list] ?: 0, rows.getInt("total"))) {
                    val next = runtime.menuRead("manageList", JSONObject().put("list", list).put("offset", loaded.size).put("limit", WINDOW)
                        .put("revision", view.getString("revision")).toString()).menuObjects("items")
                    if (next.isEmpty()) break // core sent no items: stop, never spin
                    loaded = loaded + next
                }
                lists[list] = loaded
            }
            if (open["somedaySections"] == true) {
                val first = runtime.menuRead("somedaySections", JSONObject().put("offset", 0).put("limit", WINDOW).toString())
                val rows = first.getJSONArray("rows")
                while (rows.length() < minOf(maxOf(WINDOW, depth["somedaySections"] ?: 0), first.getInt("total"))) {
                    val next = runtime.menuRead("somedaySections", JSONObject().put("offset", rows.length()).put("limit", WINDOW)
                        .put("revision", first.getString("revision")).toString()).getJSONArray("rows")
                    if (next.length() == 0) break
                    for (index in 0 until next.length()) rows.put(next.get(index))
                }
                sections = first
            }
        } catch (failure: Exception) {
            if (failure.message?.startsWith("STALE_REVISION") != true) throw failure
        }
        return SettingsPage(screen, view, lists, sections)
    }

    /** Core's answer on screen, when it is still for the open screen; Manage writes RN's normalized open sections back, as RN does. */
    private fun show(next: SettingsPage) {
        if (menu.list != "settings" || next.screen != screen) return
        if (screen == "sync") sync.follow(next.view)
        if (screen == "ai") ai.follow(next.view)
        if (screen == "about") about.follow(next.view)
        page = next
        next.view.optJSONObject("openSectionsRestore")?.takeIf { prefs.getString(it.getString("key"), null) != it.getString("value") }?.let { store(JSONArray().put(it)) }
    }

    /** A read the user asked for (a screen opening, the search, a section folding, More), through perform once no action runs. */
    fun reload(depth: Map<String, Int> = page?.takeIf { it.screen == screen }?.depth.orEmpty()) = menu.whenIdle {
        val open = screen
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, open, depth)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(next) }
        }
    }

    /** On resume and after every command: the open screen again, as deep as shown, in the background. */
    fun refresh() {
        val open = screen
        val depth = page?.takeIf { it.screen == open }?.depth.orEmpty()
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, open, depth) }) { next, mine -> if (shell.fresh(mine, Part.Menu)) show(next) }
    }

    /**
     * GTD › Capture's automation capture switch: RN's CaptureIntentConfigStore.setEnabled, a target state (on keeps a token already
     * stored, off deletes it, so off then on makes a new token), then the screen again. A write that fails shows core's [failed]
     * toast. The switch is off while it runs (perform).
     */
    fun setCaptureIntent(enabled: Boolean, failed: String) = menu.whenIdle {
        val open = screen
        val mine = shell.issue()
        shell.perform { runtime ->
            val written = runCatching { CaptureIntentConfigStore.setEnabled(shell.getApplication<Application>(), enabled) }.isSuccess
            val next = read(runtime, open, emptyMap())
            shell.ui {
                if (!written) shell.showToast(null, failed, "error")
                if (shell.fresh(mine, Part.Menu)) show(next)
            }
        }
    }

    /** A Manage list's next window (by core's ManageListName), or the Someday sections'. */
    fun more(list: String) {
        val shown = page ?: return
        reload(shown.depth + (list to (shown.depth[list] ?: 0) + WINDOW))
    }

    // ---- Device state ----

    /** Core's device writes, under RN's keys (a null value removes the key), committed before anything reads them. */
    /** A device write of the screen's own (a Manage section opened or closed): no command, so no journal sequence. */
    private fun store(writes: JSONArray) = deviceStore(prefs).store(writes, null, replay = false)

    /** A Manage section heading: core's `toggle` is the device write that opens or closes it; the screen is read again. */
    fun toggleSection(toggle: JSONObject) {
        store(JSONArray().put(toggle))
        reload()
    }

    // ---- Writes: every control sends the edit core put on it ----

    /** A General control's edit (core's `edit`), with a new request UUID. */
    fun general(edit: JSONObject) = menu.command("generalSetting", JSONObject().put("edit", edit))

    /** A GTD control's edit (core's `edit`, or a text field's typed text in core's edit), with a new request UUID. */
    fun gtd(edit: JSONObject) = menu.command("gtdSetting", JSONObject().put("edit", edit))

    /**
     * A GTD text field's commit on blur (RN's onBlur): the Default schedule time, or both Pomodoro minute fields, as typed. Text
     * the field already shows sends nothing. The typed text goes; the field shows core's value again after the write.
     */
    fun commitText(edit: JSONObject, names: List<String>, shown: List<String>) {
        val typed = names.map { local.optString("typed:$it", shown[names.indexOf(it)]) }
        editLocal { names.forEach { remove("typed:$it") } }
        if (typed != shown) gtd(edit)
    }

    /** A GTD text field as typed, kept with the screen until it commits. */
    fun type(name: String, text: String) = editLocal { put("typed:$name", text) }

    /** Text typed here and not yet sent: a GTD field before its commit, or a Someday section's inline rename (EntryPoints.kt waits). */
    val uncommitted: Boolean get() = local.has("renaming") || local.keys().asSequence().any { it.startsWith("typed:") }

    /**
     * Manage's editor (RN's modal): core's `edit` target and its starting fields, with a request UUID that stays with the dialog,
     * so a failed Save is retried exactly.
     */
    fun openEditor(edit: JSONObject) {
        val draft = edit.getJSONObject("draft")
        menu.keepDialog(JSONObject().put("kind", "manageEditor").put("target", edit.getJSONObject("target")).put("name", draft.getString("name"))
            .put("color", draft.getString("color")).put("note", draft.getString("note")).put("referenceLink", draft.getString("referenceLink"))
            .put("requestId", UUID.randomUUID().toString()))
    }

    /** Core's checkManageEditor for the open editor's name as typed: the taken-name line and whether Save is off. */
    var editorCheck by mutableStateOf<JSONObject?>(null); private set

    /**
     * Core's check of the editor's [name] for its [target] (checkManageEditor), read off the main thread as the name changes; an
     * answer counts only while the dialog still shows that target and name.
     */
    fun checkEditor(target: JSONObject, name: String) {
        shell.background(listOf(Part.MenuDialog), { runtime ->
            runtime.menuRead("manageCheck", JSONObject().put("target", target).put("name", name).toString()).put("name", name).put("target", target.toString())
        }) { check, mine ->
            val open = menu.dialog?.takeIf { it.optString("kind") == "manageEditor" } ?: return@background
            if (shell.fresh(mine, Part.MenuDialog) && open.getString("name") == name && open.getJSONObject("target").toString() == target.toString()) editorCheck = check
        }
    }

    /** A field of the open Manage editor, as typed or picked. */
    fun editField(name: String, value: String) { menu.dialog?.takeIf { it.optString("kind") == "manageEditor" }?.let { menu.keepDialog(JSONObject(it.toString()).put(name, value)) } }

    /** The open editor's exact request: the target, and the fields its type has (core's editor text says which). */
    fun editorAction(open: JSONObject, text: JSONObject): FailedAction {
        val input = JSONObject().put("target", open.getJSONObject("target"))
        if (!text.isNull("namePlaceholder")) input.put("name", open.getString("name"))
        if (!text.isNull("changeColor")) input.put("color", open.getString("color"))
        if (!text.isNull("personFields")) input.put("note", open.getString("note")).put("referenceLink", open.getString("referenceLink"))
        return FailedAction("manageEditor", open.getString("requestId"), input.toString())
    }

    /** The editor's Save: its exact request, on disk (synced) before the call (a new area or person is a create). */
    fun saveEditor(action: FailedAction) = menu.create(action)

    /** Data's Debug logging switch: core's edit, with a new request UUID. */
    fun data(edit: JSONObject) = menu.command("dataSetting", JSONObject().put("edit", edit))

    /** Data's made log file, waiting for the Data screen to open the share sheet from its activity (a rotation keeps it). */
    var logToShare by mutableStateOf<String?>(null); private set

    /**
     * Data's Share log (RN's handleShareLog): core makes the log file, then the Data screen opens the share sheet with it
     * (openShareSheet). No file shows RN's toast.
     */
    fun shareLog() {
        val words = page?.view?.optJSONObject("diagnostics") ?: return
        val missing = { shell.showToast(words.getString("toastTitle"), words.getString("logMissing"), "warning") }
        shell.anyTime({ runtime ->
            val reply = runtime.logShare()
            val path = if (reply.isNull("path")) null else reply.getString("path")
            shell.ui {
                when {
                    path == null -> missing()
                    // An answer after the Data screen closed opens nothing, now or on a later visit.
                    screen == "data" && menu.list == "settings" -> logToShare = path
                }
            }
        }) { missing() }
    }

    /**
     * The share sheet for the made log file, from [activity], as RN's expo-sharing opens it: a chooser over ACTION_SEND
     * text/plain with the FileProvider link and its read grant. Nothing leaves the phone until the user picks a target. No share
     * sheet shows RN's toast.
     */
    fun openShareSheet(activity: Activity) {
        val path = logToShare ?: return
        logToShare = null
        val words = page?.view?.optJSONObject("diagnostics") ?: return
        try {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.diagnostics", File(path))
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(null, uri)
            activity.startActivity(Intent.createChooser(send, null))
        } catch (failure: Exception) {
            Log.w(CoreHost.TAG, "Share log failed ${failureForLog(failure)}")
            shell.showToast(words.getString("toastTitle"), words.getString("shareUnavailable"), "warning")
        }
    }

    /** Data's Clear log (RN's handleClearLog): core deletes the log file; RN's success toast. */
    fun clearLog() {
        val words = page?.view?.optJSONObject("diagnostics") ?: return
        shell.anyTime({ runtime ->
            runtime.logClear()
            shell.ui { shell.showToast(words.getString("toastTitle"), words.getString("logCleared"), "success") }
        }) {}
    }

    /** A Someday section's rename (RN's inline field), core's reorder (a row's move ids) and delete (after core's question). */
    fun renameSection(id: String, title: String) = menu.command("somedayRename", JSONObject().put("id", id).put("title", title))
    fun reorderSections(ids: JSONArray) = menu.command("somedayReorder", JSONObject().put("ids", ids))

    // ---- Answers ----

    /**
     * A General or GTD write's device-local part (core's deviceWrites under RN's keys), which CoreHost stored before the reply
     * came back (deviceStore): on the command's own thread, a new language reloads core's words (setLanguage, then the labels),
     * a new theme core's colors.
     */
    internal fun applied(runtime: CoreHost, reply: JSONObject) {
        val writes = reply.optJSONArray("deviceWrites") ?: return
        val keys = List(writes.length()) { writes.getJSONObject(it).getString("key") }
        if (LANGUAGE_KEY in keys) {
            runtime.language(prefs.getString(LANGUAGE_KEY, null).orEmpty(), Locale.getDefault().toLanguageTag())
            Labels.load(runtime.strings(LABEL_KEYS))
        }
        if (THEME_KEY in keys) runCatching { ThemeChoice.load(runtime.theme(prefs.getString(THEME_KEY, null).orEmpty())) }
    }

    /**
     * A General write that failed without a refusal (SAVE_FAILED: core applied it in memory and the save is owed): App lock's gate
     * follows core's value at once, as RN's gate follows its store; the exact retry stays owed. On the command's thread.
     */
    internal fun unsettled(runtime: CoreHost, action: FailedAction) {
        if (JSONObject(action.title).getJSONObject("edit").getString("type") != "appLock") return
        runCatching { runtime.appLock().getBoolean("value") }.onSuccess { on -> shell.ui { shell.lock.stored(on) } }
    }

    /** Core's answer on screen: the editor closes; an auto-start turned on shows RN's notice once per visit; the tab bar follows. */
    fun done(action: FailedAction, reply: JSONObject) {
        val input = JSONObject(action.title)
        when (action.kind) {
            "manageEditor" -> menu.closeDialog("manageEditor")
            "setAISetting" -> ai.done(action, reply)
            "somedayRename" -> editLocal { remove("renaming") }
            "generalSetting" -> when (input.getJSONObject("edit").getString("type")) {
                "quickAccessView" -> menu.readMore()
                // RN's gate follows the stored value (AppLock.kt).
                "appLock" -> shell.lock.stored(input.getJSONObject("edit").getBoolean("value"))
            }
            "gtdSetting" -> {
                val edit = input.getJSONObject("edit")
                val type = edit.getString("type")
                val notice = page?.view?.optJSONObject("pomodoro")?.optString("autoStartNotice").orEmpty()
                if ((type == "pomodoroAutoStartBreaks" || type == "pomodoroAutoStartFocus") && edit.optBoolean("value") && reply.optBoolean("changed")
                    && !local.optBoolean("noticeShown") && notice.isNotEmpty()) {
                    editLocal { put("noticeShown", true) }
                    shell.showToast(null, notice, "info")
                }
            }
        }
    }

    /**
     * Core refused a Settings write before writing: a GTD time it cannot read shows RN's warning toast with core's words and the
     * field shows core's value again; a refused editor Save gets a fresh request UUID for its next Save.
     */
    fun refused(action: FailedAction, failure: Exception) {
        val message = failure.message.orEmpty()
        when (action.kind) {
            "gtdSetting" -> {
                val edit = JSONObject(action.title).getJSONObject("edit")
                val invalid = page?.view?.optJSONObject("hub")?.optJSONObject("defaultScheduleTime")?.optString("invalidMessage")
                shell.showToast(null, if (edit.getString("type") == "defaultScheduleTime" && invalid != null) invalid else message.substringAfter(": "), "warning")
            }
            "manageEditor" -> menu.dialog?.takeIf { it.optString("kind") == "manageEditor" && it.optString("requestId") == action.id }
                ?.let { menu.keepDialog(JSONObject(it.toString()).put("requestId", UUID.randomUUID().toString())) }
        }
    }
}
