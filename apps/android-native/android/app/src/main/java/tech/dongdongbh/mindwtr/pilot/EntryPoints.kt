package tech.dongdongbh.mindwtr.pilot

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.IntentCompat
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.contextautomation.queueTrigger
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.io.File
import java.io.InputStream


private const val CREATE_NOTE = "com.google.android.gms.actions.CREATE_NOTE"
private const val NOTE_NAME = "com.google.android.gms.actions.extra.NAME"
private const val NOTE_TEXT = "com.google.android.gms.actions.extra.TEXT"


private const val IMPORT_BYTES = 400_004


private val TILE_ROUTES = setOf("review", "calendar", "contexts", "board", "trash", "history", "settings")


private val SETTINGS_SCREENS = setOf("general", "notifications", "ai", "calendar", "advanced", "gtd", "gtd-archive", "gtd-capture", "gtd-inbox",
    "gtd-pomodoro", "gtd-review", "gtd-task-editor", "manage", "sync", "data", "about")


data class SettingsLink(val screen: String, val onboardingHandoff: Boolean)


internal fun settingsLinkOf(url: String?): SettingsLink? {
    val query = url?.let { runCatching { java.net.URI(it).rawQuery }.getOrNull() } ?: return null
    val params = query.split('&').mapNotNull { part ->
        part.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to java.net.URLDecoder.decode(it[1], "UTF-8") }
    }.toMap()
    val screen = params["settingsScreen"]?.let { if (it == "gtd-time-estimates") "gtd" else it }?.takeIf { it in SETTINGS_SCREENS } ?: return null
    return SettingsLink(screen, params["onboardingHandoff"] == "1")
}


fun Intent.entryInput(): JSONObject? = runCatching {
    fun JSONObject.extra(name: String, value: String?) = put(name, value ?: JSONObject.NULL)


    getStringExtra(CoreNotifications.EXTRA_OPEN)?.let { data -> return@runCatching JSONObject().put("kind", "notification").put("data", JSONObject(data)) }
    when (action) {
        Intent.ACTION_VIEW -> dataString?.let { JSONObject().put("kind", "link").put("url", it).put("scheme", BuildConfig.URL_SCHEME) }
        Intent.ACTION_SEND -> when {
            type == null -> null
            type!!.startsWith("text/plain") -> JSONObject().put("kind", "share")
                .extra("text", getStringExtra(Intent.EXTRA_TEXT)).extra("title", getCharSequenceExtra(Intent.EXTRA_TITLE)?.toString())
                .extra("subject", getStringExtra(Intent.EXTRA_SUBJECT))
            else -> fileShare(listOfNotNull(IntentCompat.getParcelableExtra(this, Intent.EXTRA_STREAM, Uri::class.java)))
        }
        Intent.ACTION_SEND_MULTIPLE -> fileShare(IntentCompat.getParcelableArrayListExtra(this, Intent.EXTRA_STREAM, Uri::class.java).orEmpty())
        CREATE_NOTE -> JSONObject().put("kind", "createNote").extra("name", getStringExtra(NOTE_NAME))
            .extra("text", getStringExtra(NOTE_TEXT)).extra("extraText", getStringExtra(Intent.EXTRA_TEXT))
        else -> null
    }
}.getOrNull()

private fun fileShare(uris: List<Uri>): JSONObject = JSONObject().put("kind", "files")
    .put("uris", JSONArray(uris.take(SharedFileStager.MAX_FILES).map { it.toString() }))


class ContentSharedFileSource(private val context: Context) : SharedFileStager.Source {
    override fun open(uri: String): InputStream? = context.contentResolver.openInputStream(Uri.parse(uri))
    override fun name(uri: String): String? = column(uri, android.provider.OpenableColumns.DISPLAY_NAME)
    override fun size(uri: String): Long? = column(uri, android.provider.OpenableColumns.SIZE)?.toLongOrNull()
    override fun mimeType(uri: String): String? = context.contentResolver.getType(Uri.parse(uri))
    override fun authority(uri: String): String? = Uri.parse(uri).authority

    override fun ownProvider(authority: String): Boolean = context.packageManager.resolveContentProvider(authority, 0)?.packageName == context.packageName
        && !(BuildConfig.DEBUG && authority == "${context.packageName}.sharetest")

    private fun column(uri: String, name: String): String? = context.contentResolver.query(Uri.parse(uri), arrayOf(name), null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(name)
        if (index >= 0 && cursor.moveToFirst() && !cursor.isNull(index)) cursor.getString(index) else null
    }
}


fun Context.readPickedText(uri: Uri): String? = runCatching {
    contentResolver.openInputStream(uri)?.use { input ->
        val bytes = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(8_192)
        while (bytes.size() < IMPORT_BYTES) {
            val read = input.read(buffer)
            if (read < 0) break
            bytes.write(buffer, 0, read)
        }
        if (bytes.size() >= IMPORT_BYTES) null else bytes.toString(Charsets.UTF_8.name())
    }
}.getOrNull()


class EntryRouter(private val shell: InboxViewModel, dir: File, private val stager: SharedFileStager) {
    private val queue = EntryQueue(dir)

    private val staging = mutableSetOf<String>()
    private val main = Handler(Looper.getMainLooper())

    private val threads = EntryThreads({ delayMs, job -> main.postDelayed({ job() }, delayMs) }, { main.removeCallbacksAndMessages(null) }).also { threads ->

        threads.background { runCatching { stager.keepOnly(queue.all().map { it.id }.toSet()) } }
    }

    private val lifecycle = EntryLifecycle(queue) { SystemClock.uptimeMillis() }

    private val hold = EntryLockHold()

    var head by mutableStateOf(lifecycle.head); private set


    fun receive(intent: Intent) {
        val input = intent.entryInput() ?: return
        if (!queue.add(input.toString())) Log.w(CoreHost.TAG, "Native Android entry point dropped: the queue is full")
        else if (input.optString("kind") == "files") queue.all().lastOrNull()?.let { stage(it) }
        head = lifecycle.head

        pump()
    }


    private fun stage(entry: EntryQueue.Entry) {
        if (!staging.add(entry.id)) return
        val uris = JSONObject(entry.input).optJSONArray("uris")?.let { list -> List(list.length()) { list.optString(it) } }.orEmpty()
        threads.background {
            val failure = runCatching { stager.stage(entry.id, uris) }.exceptionOrNull()
            if (failure != null) {

                val context = JSONObject().put("releaseCheck", "v1.3.7/native-share-files").put("error", failure.javaClass.simpleName)
                shell.coreHost()?.logLine("Native file share staging failed releaseCheck=v1.3.7/native-share-files", context)
                    ?: Log.w(CoreHost.TAG, "Native file share staging failed $context")
            }
            threads.later {
                staging.remove(entry.id)


                if (failure != null && lifecycle.head == entry.id) failed(entry, "Staging failed") else pump()
            }
        }
    }


    fun close() {
        threads.close()
    }


    private val ready: Boolean get() = with(shell) { writable && !busy && failedAction == null }


    private val locked: Boolean get() = shell.lock.enabled && shell.lock.locked


    val blocked: Boolean get() = !ready || locked || workOpen


    val workOpen: Boolean get() = with(shell) {
        !editorClean || processing?.hidden == false || capture != null || captureModal.open != null
            || menu.dialog != null || menu.focusControls.dialog != null || menu.calendar.composer != null || search?.saveName != null
            || menu.screen == MenuScreen.MindSweep


            || (menu.screen == MenuScreen.Settings && menu.settings.uncommitted)
            || (projectDraft.isNotBlank() && openProjectId == null && (menu.screen == MenuScreen.Projects
                || (menu.screen == null && screen == Screen.Projects && menu.quickView == "projects")))
    }


    fun pump(): Unit = with(shell) {
        if (Workspace.sandbox) return
        if (hold.holds(locked, queue.head(), ::held)) return
        val entry = lifecycle.next(!ready, workOpen) ?: return
        if (workOpen) return peek(entry)
        val input = JSONObject(entry.input)


        val staged = if (input.optString("kind") == "files") stager.staged(entry.id) ?: run {
            lifecycle.deferred(entry)
            stage(entry)
            return
        } else null
        perform { runtime ->
            val (reply, view) = try {
                val reply = if (staged == null) runtime.menuRead("entryPoint", entry.input) else runtime.attachmentRequest("prepareSharedFiles",

                    JSONObject().put("requestId", entry.id).put("files", staged).put("text", JSONObject.NULL).put("subject", JSONObject.NULL).toString())
                check(reply.getInt("version") == 1) { "Unsupported core contract" }


                reply to (reply.optJSONObject("capture")?.let { open ->
                    runtime.openQuickCapture()
                    runtime.quickCaptureView(JSONObject().put("text", open.getString("text")).put("options", open.getJSONObject("options")).toString())
                } ?: reply.optJSONObject("captureModal")?.let { modal ->
                    runtime.menuRead("captureModalOpen", JSONObject().put("params", modal.getJSONObject("params")).toString())
                })
            } catch (failure: Throwable) {
                ui(threads.guarded { failed(entry, failure.message) })

                if (!entryRetryable(failure.message)) return@perform
                throw failure
            }

            ui(threads.guarded { menu.whenIdle(threads.guarded { opened(entry, reply, view) }) })
        }
    }


    private fun held(entry: EntryQueue.Entry) {
        val kind = runCatching { JSONObject(entry.input).optString("kind") }.getOrDefault("")
        val context = JSONObject().put("kind", kind)

        threads.background {
            shell.coreHost()?.logLine("Native entry held until unlock", context)
                ?: Log.i(CoreHost.TAG, "Native entry held until unlock $context")
        }
    }


    private fun failed(entry: EntryQueue.Entry, message: String?) {
        when (val outcome = lifecycle.failed(entry, message)) {
            is EntryLifecycle.Failure.Retry -> threads.later(outcome.delayMs) { pump() }
            is EntryLifecycle.Failure.Refused -> {
                shell.showToast(null, outcome.notice, "warning")
                lifecycle.dismissed(entry)
                stager.discard(entry.id)
            }
        }
        head = lifecycle.head
    }


    private fun peek(entry: EntryQueue.Entry) {
        if (shell.coreHost() == null) return lifecycle.deferred(entry)
        shell.background(emptyList(), { runtime -> runCatching { runtime.menuRead("entryPoint", entry.input) }.getOrNull() }) { reply, _ ->
            threads.guarded {
                val automation = reply?.takeIf { it.optInt("version") == 1 }?.takeIf { it.optJSONObject("contextAutomation") != null }
                if (automation == null) lifecycle.deferred(entry) else opened(entry, automation, null)
                pump()
            }()
        }
    }


    private fun opened(entry: EntryQueue.Entry, reply: JSONObject, view: JSONObject?) {

        if (blocked && reply.optJSONObject("contextAutomation") == null) {
            lifecycle.deferred(entry)
            return
        }
        open(reply, view, runCatching { JSONObject(entry.input).optString("url").ifEmpty { null } }.getOrNull())
        lifecycle.opened(entry)

        stager.discard(entry.id)
        head = lifecycle.head
    }


    private fun open(reply: JSONObject, view: JSONObject?, url: String? = null): Unit = with(shell) {

        reply.optJSONObject("contextAutomation")?.let { trigger ->
            val outcome = queueTrigger(trigger.getString("action"), trigger.getString("context")) { CoreWork.enqueue(getApplication(), CoreJob.CONTEXT, it) }

            val fields = JSONObject().put("releaseCheck", "v1.3.8/native-context-link").put("outcome", outcome).put("action", trigger.getString("action")).put("overWork", workOpen)
            anyTime({ it.logLine("Native Android context link ran releaseCheck=v1.3.8/native-context-link", fields) }, {})
            if (outcome != "queued") Log.w(CoreHost.TAG, "Native Android context link dropped reason=$outcome")
            leaveApp = true
            return
        }

        reply.optJSONObject("notice")?.let { showToast(it) }
        if (reply.menuText("route") != null || reply.has("capture") && !reply.isNull("capture") || reply.has("captureModal") && !reply.isNull("captureModal")) {
            if (editor != null) anyTime({ it.logLine("Native Android task editor dismissed on navigation releaseCheck=v1.3.8/native-editor-navigation", JSONObject().put("releaseCheck", "v1.3.8/native-editor-navigation").put("outcome", "closed-clean")) }, {})
            closeEditor()
        }
        reply.menuText("route")?.let { go(it, reply, url) }
        reply.optJSONObject("captureModal")?.let { captureModal.opened(it.getJSONObject("params"), view ?: return) }
        val capture = reply.optJSONObject("capture") ?: return

        closeSearch()
        menu.toTabs()

        view?.let { openedCapture(it, capture.getString("text"), AutoRecord.forCaptureLink(url)) }
    }


    fun openRestored(pathname: String, params: JSONObject): Unit = with(shell) {
        when {
            pathname == "/inbox" -> { menu.toTabs(); show(Screen.Inbox) }

            pathname == "/menu" -> { menu.toTabs(); show(Screen.Focus); menu.toggleSheet() }
            pathname == "/history" -> menu.openRoute(if (params.optString("tab") == "archived") "/archived" else "/done")
            pathname.startsWith("/saved-search/") -> menu.openSavedSearch(pathname.removePrefix("/saved-search/"))
            else -> go(pathname, params)
        }
    }


    private fun go(route: String, reply: JSONObject, url: String? = null): Unit = with(shell) {
        if (route != "/global-search") closeSearch()
        menu.closeSheet()
        val name = route.removePrefix("/")
        when {

            route == "/projects" || route == "/projects-screen" -> reply.menuText("projectId").let { id ->
                if (id == null) closeProject()
                openFromSearch(Screen.Projects, id)
            }

            route == "/contexts" && reply.menuText("contextToken") != null -> menu.openContexts(reply.menuText("contextToken")!!)
            route == "/daily-review" -> menu.openReview("daily")
            route == "/weekly-review" -> menu.openReview("weekly")
            route == "/global-search" -> reply.getJSONObject("search").let { search ->
                openSearch(SearchState(search.getString("query"), search.optJSONObject("filters")))
            }
            route == "/focus" -> {
                menu.toTabs()
                menu.focusControls.openMainFocus()
                show(Screen.Focus)
                reply.menuText("taskId")?.let { id -> highlight(id); menu.whenIdle { openEditor(id, "view") } }
            }

            name.endsWith("-tab") && name.removeSuffix("-tab") in TILE_ROUTES -> name.removeSuffix("-tab").let { view ->
                if (menu.quickView == view) { menu.toTabs(); show(Screen.Projects) } else menu.openTile(view)
            }
            name == "settings" && settingsLinkOf(url) != null -> settingsLinkOf(url)!!.let { link -> menu.openSettingsScreen(link.screen, link.onboardingHandoff) }
            name in TILE_ROUTES -> menu.openTile(name)

            route.startsWith("/widget-list/") -> menu.openWidgetList(Uri.decode(route.removePrefix("/widget-list/")))
            menu.openRoute(route) -> Unit
            else -> { menu.toTabs(); show(Screen.Inbox) }
        }
    }
}
