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

/*
 * RN's system entry points (app/+native-intent.ts and hooks/root-layout/use-root-layout-external-capture.ts, with the share
 * and assistant intents of app.json and plugins/android-app-shortcuts.js): a link of the app's scheme, a text share, an
 * assistant note, a file share, and a tap on one of the app's notifications (RN's use-root-layout-notification-open-handler.ts). Kotlin reads only the intent's data, text extras and shared
 * file URIs; core's resolveNativeEntryPoint, or prepareSharedFiles for a file share (native-host-contract-entry-points.ts), says
 * where the entry goes, and this opens what core names.
 */

/** Google Assistant's note action and its extras, as RN's MainActivity reads them (plugins/android-startup-trace.js). */
private const val CREATE_NOTE = "com.google.android.gms.actions.CREATE_NOTE"
private const val NOTE_NAME = "com.google.android.gms.actions.extra.NAME"
private const val NOTE_TEXT = "com.google.android.gms.actions.extra.TEXT"

/** A text file core can import is at most its 100,000 characters; four bytes each is the most UTF-8 can take. */
private const val IMPORT_BYTES = 400_004

/** The Menu screens a route opens by core's tile id (MenuModel.openTile). */
private val TILE_ROUTES = setOf("review", "calendar", "contexts", "board", "trash", "history", "settings")

/**
 * The intent as core's entry point input, or null for any other launch (the launcher's). Only strings are read, as
 * expo-share-intent reads a text share (EXTRA_TEXT as a string; EXTRA_TITLE's text, and EXTRA_SUBJECT, which core uses
 * when the title is missing). A share of any other type, and every SEND_MULTIPLE, is a file share (`files`): its EXTRA_STREAM
 * URIs, at most RN's six (a later one is never read), and nothing else: RN's Android share module sends a file share's files
 * only (no EXTRA_TEXT or EXTRA_SUBJECT; keeping them is RN bug (d), for RN and this app together). An extra another app broke reads as
 * no entry; the input is untrusted, and core checks it again.
 */
fun Intent.entryInput(): JSONObject? = runCatching {
    fun JSONObject.extra(name: String, value: String?) = put(name, value ?: JSONObject.NULL)
    // A tap on this app's own notification (CoreNotifications): its data, which core routes (routeNotificationOpen). Only this app
    // can start MainActivity itself (its exported alias carries no such extra into a route core would not check again).
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

/** A file share's provider, as RN's share module reads it: OpenableColumns' name and size, and the resolver's type. */
class ContentSharedFileSource(private val context: Context) : SharedFileStager.Source {
    override fun open(uri: String): InputStream? = context.contentResolver.openInputStream(Uri.parse(uri))
    override fun name(uri: String): String? = column(uri, android.provider.OpenableColumns.DISPLAY_NAME)
    override fun size(uri: String): Long? = column(uri, android.provider.OpenableColumns.SIZE)?.toLongOrNull()
    override fun mimeType(uri: String): String? = context.contentResolver.getType(Uri.parse(uri))
    override fun authority(uri: String): String? = Uri.parse(uri).authority
    /** This app's providers (a hostile share naming this app's own files); the debug build's share test provider plays another app. */
    override fun ownProvider(authority: String): Boolean = context.packageManager.resolveContentProvider(authority, 0)?.packageName == context.packageName
        && !(BuildConfig.DEBUG && authority == "${context.packageName}.sharetest")
    /** One column of the provider's first row, or null (no row, no column: RN's empty-cursor fallback, #1117). */
    private fun column(uri: String, name: String): String? = context.contentResolver.query(Uri.parse(uri), arrayOf(name), null, null, null)?.use { cursor ->
        val index = cursor.getColumnIndex(name)
        if (index >= 0 && cursor.moveToFirst() && !cursor.isNull(index)) cursor.getString(index) else null
    }
}

/**
 * The picked file's text for core's Import .txt, as UTF-8 (expo-file-system's default), or null when it cannot be read or
 * is longer than core takes. Runs off the main thread.
 */
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

/**
 * The entries waiting to open, oldest first ([EntryQueue], on disk from the intent's arrival, so a process death or a
 * force-stop keeps them). The oldest opens once no command runs or is owed and nothing the user is working in is open (the
 * editor, Process Inbox, Mind Sweep, the capture popup, a Menu or Focus dialog, the Calendar's composer, the search's save
 * dialog, a Settings field typed and not yet sent, the Add new project field with text): that work stays, and the entry opens
 * when it ends. An entry leaves the queue only after its screen or popup opened;
 * a failed read keeps it for another try (after [EntryLifecycle]'s wait), unless core refused the input itself.
 */
class EntryRouter(private val shell: InboxViewModel, dir: File, private val stager: SharedFileStager) {
    private val queue = EntryQueue(dir)
    /** File shares being staged (one at a time, off the main thread); a staged one is read like any entry. */
    private val staging = mutableSetOf<String>()
    private val main = Handler(Looper.getMainLooper())
    /** The staging thread and this router's main-thread jobs, all stopped by [close] (EntryThreads, JVM-tested). */
    private val threads = EntryThreads({ delayMs, job -> main.postDelayed({ job() }, delayMs) }, { main.removeCallbacksAndMessages(null) }).also { threads ->
        // Staged files of an entry that left while the process was gone.
        threads.background { runCatching { stager.keepOnly(queue.all().map { it.id }.toSet()) } }
    }
    /** Which entry core reads, when a failed read tries again, and when an entry leaves (EntryLifecycle.kt, JVM-tested). */
    private val lifecycle = EntryLifecycle(queue) { SystemClock.uptimeMillis() }
    /** The oldest waiting entry's id: MainActivity pumps again when it changes. */
    var head by mutableStateOf(lifecycle.head); private set

    /**
     * A new intent's entry (a launch without saved state, or onNewIntent), last in the queue. A file share is queued first, then
     * its files are staged at once, while the share's read grant holds; an entry that left while the process was gone leaves
     * no staged files behind.
     */
    fun receive(intent: Intent) {
        val input = intent.entryInput() ?: return
        if (!queue.add(input.toString())) Log.w(CoreHost.TAG, "Native Android entry point dropped: the queue is full")
        else if (input.optString("kind") == "files") queue.all().lastOrNull()?.let { stage(it) }
        head = lifecycle.head
    }

    /** Stages [entry]'s files off the main thread, then reads the queue again. */
    private fun stage(entry: EntryQueue.Entry) {
        if (!staging.add(entry.id)) return
        val uris = JSONObject(entry.input).optJSONArray("uris")?.let { list -> List(list.length()) { list.optString(it) } }.orEmpty()
        threads.background {
            val failure = runCatching { stager.stage(entry.id, uris) }.exceptionOrNull()
            if (failure != null) {
                // The tester's diagnostics log: the failure's class only (a message can name the shared file).
                val context = JSONObject().put("releaseCheck", "v1.3.7/native-share-files").put("error", failure.javaClass.simpleName)
                shell.coreHost()?.logLine("Native file share staging failed releaseCheck=v1.3.7/native-share-files", context)
                    ?: Log.w(CoreHost.TAG, "Native file share staging failed $context")
            }
            threads.later {
                staging.remove(entry.id)
                // A staging that failed (the disk full) waits as a failed read does, then stages again; never a loop. Only the
                // head entry's failure waits: a later one stages again when it is the head.
                if (failure != null && lifecycle.head == entry.id) failed(entry, "Staging failed") else pump()
            }
        }
    }

    /** The ViewModel is gone: no more staging, retries or reads (a relaunched router stages what is left). */
    fun close() {
        threads.close()
    }

    /**
     * Something keeps the entry from opening now: the app is not ready, a command runs or is owed, or the user's work is open. An
     * editor with nothing to save is no work (#1410): an entry that goes somewhere closes it, as RN's editor closes on navigation.
     */
    val blocked: Boolean get() = with(shell) {
        !writable || busy || failedAction != null || !editorClean || processing?.hidden == false || capture != null || captureModal.open != null
            || menu.dialog != null || menu.focusControls.dialog != null || menu.calendar.composer != null || search?.saveName != null
            || menu.screen == MenuScreen.MindSweep
            // Typed text not yet sent: a Settings field before its commit, and the Add new project field while the list shows it
            // (the draft itself survives any route; only covering the field would take it from under the user's typing).
            || (menu.screen == MenuScreen.Settings && menu.settings.uncommitted)
            || (projectDraft.isNotBlank() && openProjectId == null && (menu.screen == MenuScreen.Projects
                || (menu.screen == null && screen == Screen.Projects && menu.quickView == "projects")))
    }

    /** Reads the oldest entry once the app is free, then opens it once no action runs; MainActivity calls it whenever that may change. */
    fun pump(): Unit = with(shell) {
        val entry = lifecycle.next(blocked) ?: return
        val input = JSONObject(entry.input)
        // A file share opens once its files are staged (a process death mid-copy stages it again; a grant gone by then reads as
        // unreadable files, and core says so).
        val staged = if (input.optString("kind") == "files") stager.staged(entry.id) ?: run {
            lifecycle.deferred(entry)
            stage(entry)
            return
        } else null
        perform { runtime ->
            val (reply, view) = try {
                val reply = if (staged == null) runtime.menuRead("entryPoint", entry.input) else runtime.attachmentRequest("prepareSharedFiles",
                    // RN's Android file share carries no text or subject (see entryInput).
                    JSONObject().put("requestId", entry.id).put("files", staged).put("text", JSONObject.NULL).put("subject", JSONObject.NULL).toString())
                check(reply.getInt("version") == 1) { "Unsupported core contract" }
                // A capture opens RN's popup: core rebuilds its known tokens (openQuickCapture), then reads the entry's draft.
                // RN's capture screen opens on the route params core answered: its first draft and view.
                reply to (reply.optJSONObject("capture")?.let { open ->
                    runtime.openQuickCapture()
                    runtime.quickCaptureView(JSONObject().put("text", open.getString("text")).put("options", open.getJSONObject("options")).toString())
                } ?: reply.optJSONObject("captureModal")?.let { modal ->
                    runtime.menuRead("captureModalOpen", JSONObject().put("params", modal.getJSONObject("params")).toString())
                })
            } catch (failure: Throwable) {
                ui(threads.guarded { failed(entry, failure.message) })
                // A refused input shows its own notice; any other failure is the read's, with the screen's retry.
                if (!entryRetryable(failure.message)) return@perform
                throw failure
            }
            // A closed router's answer opens nothing and keeps the entry and its staged files for the next router.
            ui(threads.guarded { menu.whenIdle(threads.guarded { opened(entry, reply, view) }) })
        }
    }

    /**
     * Core's read failed: the entry stays and is read again after the lifecycle's wait; or core refused the input itself, and
     * core's words show as a notice before the entry leaves, never a silent drop.
     */
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

    /** Opens core's answer, then (only then) the entry leaves the queue. Work opened meanwhile keeps it for a later read. */
    private fun opened(entry: EntryQueue.Entry, reply: JSONObject, view: JSONObject?) {
        // A context automation link opens nothing, so work opened meanwhile never holds it.
        if (blocked && reply.optJSONObject("contextAutomation") == null) {
            lifecycle.deferred(entry)
            return
        }
        open(reply, view)
        lifecycle.opened(entry)
        // Core copied what it took into the managed attachments folder; the staged files are done.
        stager.discard(entry.id)
        head = lifecycle.head
    }

    /** Core's answer: its toast, its route (with the task or project it names), then RN's capture screen over it, or the popup over the tabs. */
    private fun open(reply: JSONObject, view: JSONObject?): Unit = with(shell) {
        // RN's quiet context automation link: the broadcast's job (its notification), then the app leaves, as RN's exitApp.
        reply.optJSONObject("contextAutomation")?.let { trigger ->
            val outcome = queueTrigger(trigger.getString("action"), trigger.getString("context")) { CoreWork.enqueue(getApplication(), CoreJob.CONTEXT, it) }
            if (outcome != "queued") Log.w(CoreHost.TAG, "Native Android context link dropped reason=$outcome")
            leaveApp = true
            return
        }
        // A missing task link's notice has no title (#1368): showToast(JSONObject) reads an absent or empty title as none.
        reply.optJSONObject("notice")?.let { showToast(it) }
        if (reply.menuText("route") != null || reply.has("capture") && !reply.isNull("capture") || reply.has("captureModal") && !reply.isNull("captureModal")) closeEditor()
        reply.menuText("route")?.let { go(it, reply) }
        reply.optJSONObject("captureModal")?.let { captureModal.opened(it.getJSONObject("params"), view ?: return) }
        val capture = reply.optJSONObject("capture") ?: return
        // RN's capture screen replaces the screen it opens over; this popup shows over the tabs.
        closeSearch()
        menu.toTabs()
        view?.let { openedCapture(it, capture.getString("text")) }
    }

    /**
     * RN's last screen, as core read it at a cold start (SessionRestore.kt): History on its tab, a saved search by its id, the
     * Inbox tab; any other route as an entry opens it ([go]), its params as core's reply (the open project).
     */
    fun openRestored(pathname: String, params: JSONObject): Unit = with(shell) {
        when {
            pathname == "/inbox" -> { menu.toTabs(); show(Screen.Inbox) }
            // RN's Menu tab: the More sheet over Focus (RN's home tab).
            pathname == "/menu" -> { menu.toTabs(); show(Screen.Focus); menu.toggleSheet() }
            pathname == "/history" -> menu.openRoute(if (params.optString("tab") == "archived") "/archived" else "/done")
            pathname.startsWith("/saved-search/") -> menu.openSavedSearch(pathname.removePrefix("/saved-search/"))
            else -> go(pathname, params)
        }
    }

    /**
     * Opens RN's route [route] as this app has it: a tab, a Menu screen (a list, or a tile's screen), the Projects screen
     * with core's project, Focus with core's task in the editor (outlined on its row, as RN's setHighlightTask), or the global
     * search with core's query. A route this app has no screen for opens the Inbox.
     */
    private fun go(route: String, reply: JSONObject): Unit = with(shell) {
        if (route != "/global-search") closeSearch()
        menu.closeSheet()
        val name = route.removePrefix("/")
        when {
            // The project core names, or the list (an area's link): a project left open there closes.
            route == "/projects" || route == "/projects-screen" -> reply.menuText("projectId").let { id ->
                if (id == null) closeProject()
                openFromSearch(Screen.Projects, id)
            }
            // A notification's routes (core's routeNotificationOpen): a context automation's context, a digest, the weekly review.
            route == "/contexts" && reply.menuText("contextToken") != null -> menu.openContexts(reply.menuText("contextToken")!!)
            route == "/daily-review" -> menu.openReview("daily")
            route == "/weekly-review" -> menu.openReview("weekly")
            route == "/global-search" -> reply.getJSONObject("search").let { search ->
                openSearch(SearchState(search.getString("query"), search.optJSONObject("filters")))
            }
            route == "/focus" -> {
                menu.toTabs()
                show(Screen.Focus)
                reply.menuText("taskId")?.let { id -> highlight(id); menu.whenIdle { openEditor(id, "view") } }
            }
            // RN's quick-access tab routes: the tab while it holds that view, else its Menu screen.
            name.endsWith("-tab") && name.removeSuffix("-tab") in TILE_ROUTES -> name.removeSuffix("-tab").let { view ->
                if (menu.quickView == view) { menu.toTabs(); show(Screen.Projects) } else menu.openTile(view)
            }
            name in TILE_ROUTES -> menu.openTile(name)
            // A Tasks widget's header (core's openUri `mindwtr:///widget-list/<id>`, the id URI-encoded); core checks the id.
            route.startsWith("/widget-list/") -> menu.openWidgetList(Uri.decode(route.removePrefix("/widget-list/")))
            menu.openRoute(route) -> Unit
            else -> { menu.toTabs(); show(Screen.Inbox) }
        }
    }
}
