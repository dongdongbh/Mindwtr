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
import tech.dongdongbh.mindwtr.pilot.core.RnKeyValue
import tech.dongdongbh.mindwtr.pilot.core.routedDeviceStore
import java.io.File
import java.util.Locale
import java.util.UUID


private const val ARCHIVE_EDIT = "archiveRetentionDays"

val SETTINGS_KINDS = setOf("generalSetting", "gtdSetting", "manageEditor", "manageDelete", "somedayRename", "somedayReorder", "somedayDelete", "dataSetting", "syncPreference",
    "setAISetting", "notificationsSetting", "calendarSetting")


const val LANGUAGE_KEY = "mindwtr-language"
const val THEME_KEY = "@mindwtr_theme"
const val MANAGE_SECTIONS_KEY = "mindwtr:settings:manage:openSections"
const val TASK_OPEN_MODE_KEY = "mindwtr:view:taskOpenMode:v1"

const val UPDATE_AVAILABLE_KEY = "mindwtr-update-available"


const val DEVICE_PREFS = "mindwtr-view-state"


fun deviceStore(prefs: SharedPreferences) = DeviceWrites({ prefs.all }, { changes ->
    prefs.edit().apply { changes.forEach { (key, value) -> if (value == null) remove(key) else putString(key, value) } }.commit()
})


fun deviceStore(app: Context, keyValue: RnKeyValue, sandbox: Boolean = false): DeviceWrites {
    val prefs = Workspace.viewPrefs(app, sandbox)
    return routedDeviceStore({ prefs.all }, { changes ->
        prefs.edit().apply { changes.forEach { (key, value) -> if (value == null) remove(key) else putString(key, value) } }.commit()
    }, keyValue)
}


private const val WINDOW = 100


private val MANAGE_LISTS = listOf("areas", "people", "contexts", "tags")


fun applyDeviceChoices(runtime: CoreHost, prefs: SharedPreferences) {
    prefs.getString(LANGUAGE_KEY, null)?.let { stored ->
        runtime.language(stored, Locale.getDefault().toLanguageTag())
        loadLabels(runtime)
    }
    prefs.getString(THEME_KEY, null)?.let { stored -> runCatching { ThemeChoice.load(runtime.theme(stored)) } }
}


fun applySyncedChoices(runtime: CoreHost, prefs: SharedPreferences) {
    runCatching {
        val before = prefs.getString(LANGUAGE_KEY, null)
        val reply = runtime.languageSaved(before.orEmpty(), Locale.getDefault().toLanguageTag())
        reply.optJSONArray("deviceWrites")?.takeIf { it.length() > 0 }?.let { deviceStore(prefs).store(it, null, replay = false) }
        if (reply.optString("language") != Labels.language) loadLabels(runtime)
    }.onFailure { Log.w(CoreHost.TAG, "Native Android synced language not applied ${failureForLog(it)}") }
    runCatching { ThemeChoice.load(runtime.theme(prefs.getString(THEME_KEY, null).orEmpty())) }
        .onFailure { Log.w(CoreHost.TAG, "Native Android synced theme not applied ${failureForLog(it)}") }
}


class SettingsPage(val screen: String, val view: JSONObject, val lists: Map<String, List<JSONObject>>, val sections: JSONObject?,
                   val captureToken: String? = null) {

    fun list(name: String): List<JSONObject> = lists[name] ?: view.optJSONObject(name)?.optJSONObject("rows")?.menuObjects("items").orEmpty()
    fun total(name: String): Int = view.optJSONObject(name)?.optJSONObject("rows")?.optInt("total") ?: 0

    val depth: Map<String, Int> get() = MANAGE_LISTS.associateWith { list(it).size } + ("somedaySections" to (sections?.menuObjects("rows")?.size ?: 0))
}

class SettingsModel(private val menu: MenuModel, private val saved: SavedStateHandle) {
    private val shell get() = menu.shell
    private val prefs get() = menu.prefs
    private val main = Handler(Looper.getMainLooper())

    val sync = SyncSettingsModel(menu)

    val ai = AISettingsModel(menu)

    val about = AboutSettingsModel(menu)

    val transfer = DataTransferModel(menu, saved)

    val calendar = CalendarSettingsModel(menu)

    val gmail = GmailCaptureModel(menu)


    var stack by mutableStateOf(saved.get<String>("settingsStack")?.split(',') ?: listOf("main")); private set
    val screen: String get() = stack.last()

    var query by mutableStateOf(saved.get<String>("settingsQuery") ?: ""); private set

    var page by mutableStateOf<SettingsPage?>(null); private set


    var local by mutableStateOf(runCatching { JSONObject(saved.get<String>("settingsLocal") ?: "{}") }.getOrDefault(JSONObject())); private set

    private fun keepStack(value: List<String>) { stack = value; saved["settingsStack"] = value.joinToString(",") }
    private fun keepLocal(value: JSONObject) { local = value; saved["settingsLocal"] = value.toString() }
    internal fun editLocal(edit: JSONObject.() -> Unit) = keepLocal(JSONObject(local.toString()).apply(edit))


    val title: String get() {
        val view = page?.takeIf { it.screen == screen || (isGtd(it.screen) && isGtd(screen)) }?.view ?: return t("settings.title")
        return when (screen) {
            "main" -> view.getString("title")
            "advanced" -> view.getJSONObject("advanced").getString("title")
            "general", "manage", "data", "notifications", "sync", "ai", "about", "calendar" -> view.getString("title")
            "gtd" -> view.getJSONObject("hub").getString("title")
            else -> gtdScreen(view)?.getString("title") ?: t("settings.title")
        }
    }


    fun reset() {
        sync.leave()
        ai.leave()
        about.leave()
        calendar.leave()
        gmail.leave()
        keepStack(listOf("main"))
        logToShare = null
        query = ""
        saved["settingsQuery"] = ""
        keepLocal(JSONObject())
        page = null
    }


    fun push(next: String) {
        keepStack(stack + next)
        logToShare = null
        keepLocal(JSONObject())
        menu.keepDialog(null)
        if (!(isGtd(next) && page?.screen?.let(::isGtd) == true)) page = null
        reload()
    }


    fun back(): Boolean {
        if (stack.size < 2) return false
        if (screen == "sync") sync.leave()
        if (screen == "ai") ai.leave()
        if (screen == "about") about.leave()
        if (screen == "calendar") calendar.leave()
        if (screen == "gtd-capture") gmail.leave()
        keepStack(stack.dropLast(1))
        logToShare = null
        keepLocal(JSONObject())
        menu.keepDialog(null)
        if (!(isGtd(screen) && page?.screen?.let(::isGtd) == true)) page = null
        reload()
        return true
    }

    private var searchTyped = 0


    fun search(text: String) {
        query = text
        saved["settingsQuery"] = text
        val mine = ++searchTyped
        main.postDelayed({ if (mine == searchTyped) reload() }, 200)
    }


    private fun isGtd(screen: String) = screen == "gtd" || screen.startsWith("gtd-")


    fun gtdScreen(view: JSONObject): JSONObject? = when (screen) {
        "gtd-pomodoro" -> view.optJSONObject("pomodoro")
        "gtd-capture" -> view.optJSONObject("capture")
        "gtd-review" -> view.optJSONObject("review")
        "gtd-inbox" -> view.optJSONObject("inbox")
        "gtd-archive" -> view.optJSONObject("archive")
        "gtd-task-editor" -> view.optJSONObject("taskEditor")
        else -> null
    }


    private fun request(screen: String): Pair<String, JSONObject> = when {


        screen == "main" || screen == "advanced" -> "settingsMenu" to JSONObject().put("query", query).put("syncBadge", shell.syncBadge.state)
            .put("updateAvailable", runCatching { shell.coreHost()?.rnValue(UPDATE_AVAILABLE_KEY) == "true" }.getOrDefault(false))
        screen == "general" -> "generalSettings" to JSONObject().put("deviceTheme", prefs.getString(THEME_KEY, null) ?: JSONObject.NULL)
        screen == "manage" -> "manageSettings" to JSONObject().put("openSections", prefs.getString(MANAGE_SECTIONS_KEY, null) ?: JSONObject.NULL)
        screen == "data" -> "dataSettings" to JSONObject()
        screen == "notifications" -> "notificationsSettings" to JSONObject()
        else -> "gtdSettings" to JSONObject().put("taskOpenMode", prefs.getString(TASK_OPEN_MODE_KEY, null) ?: JSONObject.NULL)
    }


    private fun read(runtime: CoreHost, screen: String, depth: Map<String, Int>): SettingsPage {
        if (screen == "sync") return SettingsPage(screen, sync.read(runtime), emptyMap(), null)
        if (screen == "ai") return SettingsPage(screen, ai.read(runtime), emptyMap(), null)
        if (screen == "about") return SettingsPage(screen, about.read(runtime), emptyMap(), null)
        if (screen == "calendar") return SettingsPage(screen, calendar.read(runtime), emptyMap(), null)
        val (name, input) = request(screen)

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
                    if (next.isEmpty()) break
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


    private fun show(next: SettingsPage) {
        if (menu.list != "settings" || next.screen != screen) return
        if (screen == "sync") sync.follow(next.view)
        if (screen == "ai") ai.follow(next.view)
        if (screen == "about") about.follow(next.view)
        page = next
        next.view.optJSONObject("openSectionsRestore")?.takeIf { prefs.getString(it.getString("key"), null) != it.getString("value") }?.let { store(JSONArray().put(it)) }
    }


    fun reload(depth: Map<String, Int> = page?.takeIf { it.screen == screen }?.depth.orEmpty()) = menu.whenIdle {
        val open = screen
        val mine = shell.issue()
        shell.perform { runtime ->
            val next = read(runtime, open, depth)
            shell.ui { if (shell.fresh(mine, Part.Menu)) show(next) }
        }
    }


    fun refresh() {
        val open = screen
        val depth = page?.takeIf { it.screen == open }?.depth.orEmpty()
        shell.background(listOf(Part.Menu), { runtime -> read(runtime, open, depth) }) { next, mine -> if (shell.fresh(mine, Part.Menu)) show(next) }
    }


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


    fun more(list: String) {
        val shown = page ?: return
        reload(shown.depth + (list to (shown.depth[list] ?: 0) + WINDOW))
    }


    private fun store(writes: JSONArray) = deviceStore(prefs).store(writes, null, replay = false)


    fun toggleSection(toggle: JSONObject) {
        store(JSONArray().put(toggle))
        reload()
    }


    fun general(edit: JSONObject) = menu.command("generalSetting", JSONObject().put("edit", edit))


    fun gtd(edit: JSONObject) = menu.command("gtdSetting", JSONObject().put("edit", edit))


    fun commitText(edit: JSONObject, names: List<String>, shown: List<String>) {
        val typed = names.map { local.optString("typed:$it", shown[names.indexOf(it)]) }
        editLocal { names.forEach { remove("typed:$it") } }
        if (typed != shown) gtd(edit)
    }


    fun type(name: String, text: String) = editLocal { put("typed:$name", text) }


    val uncommitted: Boolean get() = local.has("renaming") || local.keys().asSequence().any { it.startsWith("typed:") }


    fun openEditor(edit: JSONObject) {
        val draft = edit.getJSONObject("draft")
        menu.keepDialog(JSONObject().put("kind", "manageEditor").put("target", edit.getJSONObject("target")).put("name", draft.getString("name"))
            .put("color", draft.getString("color")).put("note", draft.getString("note")).put("referenceLink", draft.getString("referenceLink"))
            .put("requestId", UUID.randomUUID().toString()))
    }


    var editorCheck by mutableStateOf<JSONObject?>(null); private set


    fun checkEditor(target: JSONObject, name: String) {
        shell.background(listOf(Part.MenuDialog), { runtime ->
            runtime.menuRead("manageCheck", JSONObject().put("target", target).put("name", name).toString()).put("name", name).put("target", target.toString())
        }) { check, mine ->
            val open = menu.dialog?.takeIf { it.optString("kind") == "manageEditor" } ?: return@background
            if (shell.fresh(mine, Part.MenuDialog) && open.getString("name") == name && open.getJSONObject("target").toString() == target.toString()) editorCheck = check
        }
    }


    fun editField(name: String, value: String) { menu.dialog?.takeIf { it.optString("kind") == "manageEditor" }?.let { menu.keepDialog(JSONObject(it.toString()).put(name, value)) } }


    fun editorAction(open: JSONObject, text: JSONObject): FailedAction {
        val input = JSONObject().put("target", open.getJSONObject("target"))
        if (!text.isNull("namePlaceholder")) input.put("name", open.getString("name"))
        if (!text.isNull("changeColor")) input.put("color", open.getString("color"))
        if (!text.isNull("personFields")) input.put("note", open.getString("note")).put("referenceLink", open.getString("referenceLink"))
        return FailedAction("manageEditor", open.getString("requestId"), input.toString())
    }


    fun saveEditor(action: FailedAction) = menu.create(action)


    fun createArea(target: JSONObject, name: String, color: String) = saveEditor(FailedAction("manageEditor", UUID.randomUUID().toString(),
        JSONObject().put("target", target).put("name", name).put("color", color).toString()))


    fun notifications(edit: JSONObject) = menu.command("notificationsSetting", JSONObject().put("edit", edit))


    fun data(edit: JSONObject) = menu.command("dataSetting", JSONObject().put("edit", edit))


    fun archiveData(edit: JSONObject) {
        archiveSaveFailed(false)
        data(edit)
    }


    fun archiveRetention(days: Int) {
        archiveSaveFailed(false)
        shell.background(listOf(Part.MenuDialog), { runtime -> runtime.menuRead("archiveRetentionReview", JSONObject().put("days", days).toString()) }) { reply, _ ->
            val review = reply.optJSONObject("review")
            if (review == null) archiveData(reply.getJSONObject("edit")) else editLocal { put("archiveReview", review) }
        }
    }


    fun archiveSaveFailed(failed: Boolean, action: FailedAction? = null) {
        if (action != null && JSONObject(action.title).optJSONObject("edit")?.optString("type") != ARCHIVE_EDIT) return
        if (failed != local.optBoolean("archiveSaveFailed")) editLocal { if (failed) put("archiveSaveFailed", true) else remove("archiveSaveFailed") }
    }


    var logToShare by mutableStateOf<String?>(null); private set


    fun shareLog() {
        val words = page?.view?.optJSONObject("diagnostics") ?: return
        val missing = { shell.showToast(words.getString("toastTitle"), words.getString("logMissing"), "warning") }
        shell.anyTime({ runtime ->
            val reply = runtime.logShare()
            val path = if (reply.isNull("path")) null else reply.getString("path")
            shell.ui {
                when {
                    path == null -> missing()

                    screen == "data" && menu.list == "settings" -> logToShare = path
                }
            }
        }) { missing() }
    }


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


    fun clearLog() {
        val words = page?.view?.optJSONObject("diagnostics") ?: return
        shell.anyTime({ runtime ->
            runtime.logClear()
            shell.ui { shell.showToast(words.getString("toastTitle"), words.getString("logCleared"), "success") }
        }) {}
    }


    fun renameSection(id: String, title: String) = menu.command("somedayRename", JSONObject().put("id", id).put("title", title))
    fun reorderSections(ids: JSONArray) = menu.command("somedayReorder", JSONObject().put("ids", ids))


    internal fun applied(runtime: CoreHost, reply: JSONObject) {


        reply.optJSONObject("persistentCapture")?.let { PersistentCapture.switched(shell.getApplication<Application>(), it, runtime::logLine) }
        val writes = reply.optJSONArray("deviceWrites") ?: return
        val keys = List(writes.length()) { writes.getJSONObject(it).getString("key") }
        if (LANGUAGE_KEY in keys) {
            runtime.language(prefs.getString(LANGUAGE_KEY, null).orEmpty(), Locale.getDefault().toLanguageTag())
            loadLabels(runtime)
        }
        if (THEME_KEY in keys) runCatching { ThemeChoice.load(runtime.theme(prefs.getString(THEME_KEY, null).orEmpty())) }

        if ("mindwtr:appSearchIndexingEnabled" in keys) runCatching { runtime.appSearchApply() }
            .onFailure { Log.w(CoreHost.TAG, "Native Android system search apply failed ${failureForLog(it)}") }
    }


    internal fun unsettled(runtime: CoreHost, action: FailedAction) {
        when (JSONObject(action.title).getJSONObject("edit").getString("type")) {
            "appLock" -> runCatching { runtime.appLock().getBoolean("value") }.onSuccess { on -> shell.ui { shell.lock.stored(on) } }
            "appLockRelockDelay" -> runCatching { runtime.appLock().optInt("relockDelayMinutes") }.onSuccess { minutes -> shell.ui { shell.lock.relock.delayMinutes = minutes } }
        }
    }


    fun done(action: FailedAction, reply: JSONObject) {
        val input = JSONObject(action.title)
        when (action.kind) {
            "manageEditor" -> menu.closeDialog("manageEditor")
            "setAISetting" -> ai.done(action, reply)
            "calendarSetting" -> calendar.done(reply)
            "somedayRename" -> editLocal { remove("renaming") }
            "generalSetting" -> when (input.getJSONObject("edit").getString("type")) {
                "quickAccessView" -> menu.readMore()

                "appLock" -> shell.lock.stored(input.getJSONObject("edit").getBoolean("value"))
                "appLockRelockDelay" -> shell.lock.relock.delayMinutes = input.getJSONObject("edit").getInt("value")
            }
            "gtdSetting" -> {
                val edit = input.getJSONObject("edit")
                val type = edit.getString("type")


                if (type.startsWith("pomodoro")) shell.pomodoro.refresh(planAlarms = true)
                val notice = page?.view?.optJSONObject("pomodoro")?.optString("autoStartNotice").orEmpty()
                if ((type == "pomodoroAutoStartBreaks" || type == "pomodoroAutoStartFocus") && edit.optBoolean("value") && reply.optBoolean("changed")
                    && !local.optBoolean("noticeShown") && notice.isNotEmpty()) {
                    editLocal { put("noticeShown", true) }
                    shell.showToast(null, notice, "info")
                }
            }
        }
    }


    fun refused(action: FailedAction, failure: Exception) {
        val message = failure.message.orEmpty()
        when (action.kind) {
            "gtdSetting" -> {
                val edit = JSONObject(action.title).getJSONObject("edit")
                val invalid = page?.view?.optJSONObject("hub")?.optJSONObject("defaultScheduleTime")?.optString("invalidMessage")
                shell.showToast(null, if (edit.getString("type") == "defaultScheduleTime" && invalid != null) invalid else message.substringAfter(": "), "warning")
            }
            "calendarSetting" -> calendar.refused(failure)
            "manageEditor" -> menu.dialog?.takeIf { it.optString("kind") == "manageEditor" && it.optString("requestId") == action.id }
                ?.let { menu.keepDialog(JSONObject(it.toString()).put("requestId", UUID.randomUUID().toString())) }
        }
    }
}
