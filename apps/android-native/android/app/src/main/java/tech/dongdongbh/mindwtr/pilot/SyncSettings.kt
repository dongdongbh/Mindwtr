package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.provider.DocumentsContract
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.core.net.toUri
import kotlinx.coroutines.delay
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.PendingSyncFolderPick
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/*
 * RN's Settings › Sync (sync-settings-screen.tsx in sync mode, its backend panels, sync-settings-sections.tsx and the encryption
 * card) on core's contract (native-host-contract-settings-sync.ts). Kotlin keeps only what RN keeps in React state for one visit:
 * the form as typed, the passphrase fields, which folds are open, and the command running. Every word, check, enabled state,
 * toast and write is core's.
 */

/**
 * Settings › Sync's screen commands (host-entry.ts MENU_COMMANDS). CoreHost.syncCommand sends them without holding the engine,
 * and never journals them (WriteJournal.UNJOURNALED; several carry a password).
 */
val SYNC_COMMANDS = setOf("openSyncSettings", "closeSyncSettings", "selectSyncBackend", "saveSyncBackend", "syncNow", "testSyncConnection",
    "pickSyncFolder", "connectDropbox", "disconnectDropbox", "runSyncEncryptionAction", "answerSyncMissingFiles")

/**
 * The WebDAV or self-hosted form as typed (RN's panel state). A null [password] or [token] was not edited: the field shows core's
 * dots and the stored one is kept.
 */
/** Core's dot for a stored password or token (native-host-contract-settings-sync.ts PASSWORD_DOTS). */
private const val MASK_DOT = "•"

data class SyncForm(val kind: String, val url: String, val username: String, val password: String?, val token: String?, val insecure: Boolean)

class SyncSettingsModel(private val menu: MenuModel) {
    private companion object {
        /** A visit's open and close, in order, never behind a long command: a late close must never end the next visit. */
        val visits: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-sync-visits") }
        /** The encryption card's light actions in the order sent: a passphrase field's text never overtakes an earlier keystroke. */
        val light: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-sync-light") }
        /** Backend chips in tap order, as RN sends each choice: Off tapped during a slow WebDAV choice is the one that stays. */
        val choices: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-sync-choices") }
    }
    private val shell get() = menu.shell
    private val settings get() = menu.settings

    /** openSyncSettings ran for this visit: RN reads the stored configuration once, when the screen mounts. */
    @Volatile private var opened = false
    var form by mutableStateOf<SyncForm?>(null); private set
    /** The encryption card's passphrase fields as typed (current, next, confirm); core holds their text too. */
    val passphrases = PassphraseFields()
    val fields: Map<String, String> get() = passphrases.texts
    var historyOpen by mutableStateOf(false); private set
    var preferencesOpen by mutableStateOf(false); private set
    var snapshotsOpen by mutableStateOf(false); private set
    /**
     * The missing-files question this visit already answered (its questionId): hidden until core's view drops it. The question
     * itself is core's view's `missingFiles`, shown while the asking command's activation waits (RN's Alert).
     */
    var answeredQuestion by mutableStateOf<String?>(null); private set
    /** How many commands run now (each its own thread, as RN's run side by side); core's view shows each control's spinner. */
    var running by mutableStateOf(0); private set
    /** The commands running, by key (a name, a backend choice): a second identical tap before core's view disables the control sends nothing. Main thread. */
    private val inFlight = HashSet<String>()
    /** The panel the form last followed (RN's form takes a stored value again whenever it changes). */
    private var followed: JSONObject? = null
    private var typed = 0

    /** Settings' read of this screen: it opens once per visit (its toasts shown), then core's view for the form's typed text. */
    fun read(runtime: CoreHost): JSONObject {
        open(runtime)
        val input = JSONObject().put("draft", draft()).toString()
        return try {
            runtime.menuRead("syncSettings", input)
        } catch (failure: Exception) {
            // Core has no open screen (a close that raced this visit): open it again, once.
            if (failure.message?.contains("(openSyncSettings)") != true) throw failure
            opened = false
            open(runtime)
            runtime.menuRead("syncSettings", input)
        }
    }

    /** One open per visit, after any close sent before it: a refresh and a reload can read at once. */
    private fun open(runtime: CoreHost) = visits.submit { openNow(runtime) }.get()

    /** On the visits thread. */
    private fun openNow(runtime: CoreHost) {
        if (!opened) {
            val reply = runtime.syncCommand("openSyncSettings", "{}")
            opened = true
            shell.ui { toasts("openSyncSettings", reply) }
        }
    }

    /** The form's typed URL and token (null: not edited), which core's checks follow. */
    private fun draft(): JSONObject = form?.let { typed ->
        JSONObject().put("url", typed.url).apply { if (typed.kind == "selfhosted") put("token", typed.token ?: JSONObject.NULL) }
    } ?: JSONObject()

    /** RN's form effects for core's new view: a form mounts with the stored values and takes each again when it changes. Main thread. */
    fun follow(view: JSONObject) {
        val panel = view.optJSONObject("panel")
        val kind = panel?.optString("kind")
        val prior = followed
        followed = panel
        if (panel == null || (kind != "webdav" && kind != "selfhosted")) { form = null; return }
        val stored = SyncForm(kind, panel.getJSONObject("url").getString("value"),
            if (kind == "webdav") panel.getJSONObject("username").getString("value") else "", null, null,
            panel.getJSONObject("allowInsecureHttp").getBoolean("value"))
        val current = form
        if (current == null || current.kind != kind || prior?.optString("kind") != kind) { form = stored; return }
        var next = current
        if (stored.url != prior.getJSONObject("url").getString("value")) next = next.copy(url = stored.url)
        if (stored.insecure != prior.getJSONObject("allowInsecureHttp").getBoolean("value")) next = next.copy(insecure = stored.insecure)
        if (kind == "webdav") {
            if (stored.username != prior.getJSONObject("username").getString("value")) next = next.copy(username = stored.username)
            if (panel.getJSONObject("password").getString("mask") != prior.getJSONObject("password").getString("mask")) next = next.copy(password = null)
        } else if (panel.getJSONObject("token").getString("mask") != prior.getJSONObject("token").getString("mask")) next = next.copy(token = null)
        form = next
    }

    /** A field of the form as typed; core's view is read again for it once typing pauses. */
    fun edit(change: SyncForm.() -> SyncForm) {
        form = form?.change() ?: return
        val mine = ++typed
        shell.ui { if (mine == typed) settings.refresh() }
    }

    /**
     * RN's secure field starts with the stored secret; here it starts with core's dots, so the first edit starts it over: the
     * text typed after the dots, or, for any other edit (a Backspace, a keystroke among the dots), what was typed, dots left out.
     */
    fun secret(masked: String?, mask: String, text: String): String = when {
        masked != null -> text
        text.startsWith(mask) -> text.removePrefix(mask)
        else -> text.replace(MASK_DOT, "")
    }

    fun toggleHistory() { historyOpen = !historyOpen }
    fun togglePreferences() { preferencesOpen = !preferencesOpen }
    fun toggleSnapshots() { snapshotsOpen = !snapshotsOpen }

    /** Leaving the screen (RN unmounts it): core drops a backend chosen but not proven, and the next visit opens afresh. */
    fun leave() {
        if (!opened && form == null) return
        opened = false
        form = null
        followed = null
        answeredQuestion = null
        passphrases.clear()
        historyOpen = false
        preferencesOpen = false
        snapshotsOpen = false
        val runtime = shell.coreHost() ?: return
        visits.execute { runCatching { runtime.syncCommand("closeSyncSettings", "{}") }.onFailure { Log.w(CoreHost.TAG, "Sync screen close failed ${failureForLog(it)}") } }
    }

    // ---- Commands: each tap sends core's command with a new request UUID ----

    /** A backend chip (core's option): a complete target activates through its first sync. */
    fun select(option: String) =
        run("selectSyncBackend", JSONObject().put("requestId", uuid()).put("option", option), key = "selectSyncBackend:$option", ordered = choices)

    /** The form's Save: core proves the settings with a sync, then stores them. [revision] is the view's configRevision. */
    fun save(view: JSONObject) = formFields()?.let { (name, fields) ->
        run("saveSyncBackend", JSONObject().put("requestId", uuid()).put("revision", view.getString("configRevision")).put(name, fields))
    }

    /** The panel's Sync now; the WebDAV and self-hosted forms sync what they hold, as RN's do. */
    fun syncNow(view: JSONObject) {
        val input = JSONObject().put("requestId", uuid())
        formFields()?.let { (name, fields) -> input.put("revision", view.getString("configRevision")).put(name, fields) }
        run("syncNow", input)
    }

    /**
     * The missing-files question's buttons: Continue lets the waiting activation go on with those files accepted, Cancel ends it
     * with nothing stored. The command that asked answers itself. File names show on screen only, never in the log.
     */
    fun answerMissingFiles(questionId: String, continueWithout: Boolean) {
        if (answeredQuestion == questionId) return
        answeredQuestion = questionId
        Log.i(CoreHost.TAG, "Native Android sync screen missing files answer=${if (continueWithout) "continue" else "cancel"}")
        run("answerSyncMissingFiles", JSONObject().put("questionId", questionId).put("continue", continueWithout), light = true)
    }

    /** The panel's Test connection (Dropbox sends no fields). */
    fun test() = run("testSyncConnection", formFields()?.let { (name, fields) -> JSONObject().put(name, fields) } ?: JSONObject())

    /**
     * The File panel's system folder picker answered (RN: expo's requestDirectoryPermissionsAsync). A cancel sends nothing. Else the
     * folder's grant is kept with the flags the picker gave, as expo keeps it, and core's pickSyncFolder takes the folder from the
     * host's slot (PendingSyncFolderPick) after this visit's open. A refused grant still runs it: core shows RN's failure toast.
     */
    fun folderPicked(context: Context, result: ActivityResult) {
        val tree = result.data?.data?.takeIf { result.resultCode == Activity.RESULT_OK } ?: return
        val flags = result.data!!.flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        val kept = runCatching { context.contentResolver.takePersistableUriPermission(tree, flags) }
            .onFailure { Log.w(CoreHost.TAG, "Sync folder grant refused ${failureForLog(it)}") }.isSuccess
        PendingSyncFolderPick.put(if (kept) JSONObject().put("treeUri", tree.toString()) else JSONObject().put("grant", "refused"))
        val runtime = shell.coreHost() ?: return
        // After a process death the picker answers into the recreated screen: the command waits for that visit's open. A failed
        // open must not end the visits thread (an uncaught throw there ends the app); the command then answers core's refusal.
        visits.execute { runCatching { openNow(runtime) }.onFailure { Log.w(CoreHost.TAG, "Sync screen open failed ${failureForLog(it)}") } }
        // Each pick its own key: a second pick while the first one's activation runs still reaches core, as RN sends it.
        val requestId = uuid()
        run("pickSyncFolder", JSONObject().put("requestId", requestId), key = "pickSyncFolder:$requestId", after = visits)
    }

    fun dropbox(connected: Boolean) = run(if (connected) "disconnectDropbox" else "connectDropbox", JSONObject().put("requestId", uuid()))

    /** A settings sync option: a synced setting, so it goes through the Menu tab's journaled command path. */
    fun preference(key: String, value: Boolean) = menu.command("syncPreference", JSONObject().put("key", key).put("value", value))

    /** The encryption card: core's action; a submit or decline takes a request UUID, and Generate fills both new fields. */
    fun encryption(action: JSONObject) {
        val type = action.getString("type")
        val input = JSONObject().put("action", action).apply { if (type == "submit" || type == "decline") put("requestId", uuid()) }
        val heavy = type == "submit" || type == "decline"
        // A field core refused (past its limit, or its `typed` command failed) still holds the older text core kept: never submit
        // that. A flow change drops the fields' refusals.
        passphrases.admit(action)?.let { refusal -> shell.showToast(null, refusal, "error"); return }
        // A submit runs with the fields core holds: it waits for every keystroke sent before it (the light queue), never overtakes
        // one, and then asks again, as a keystroke core refused in that wait counts too.
        run("runSyncEncryptionAction", input, light = !heavy, after = if (heavy) SyncSettingsModel.light else null,
            admit = if (type == "submit") ({ passphrases.admit(action) }) else null) { reply ->
            reply.menuText("passphrase")?.let { phrase -> passphrases.generated(phrase) }
            if (type == "cancel" || type == "submit" || type == "decline") passphrases.clear()
        }
    }

    /**
     * A passphrase field as typed; core keeps its copy (`typed`), which also clears the card's error. An edit past core's limit
     * ([maxLength], the row's) is refused with core's words ([tooLongText]) and never reaches core.
     */
    fun typePassphrase(field: String, text: String, maxLength: Int, tooLongText: String) {
        val edit = passphrases.type(field, text, maxLength, tooLongText) ?: return shell.showToast(null, tooLongText, "error")
        run("runSyncEncryptionAction", JSONObject().put("action", JSONObject().put("type", "typed").put("field", field).put("value", text)), light = true,
            failed = { message -> passphrases.settled(field, edit, message) }) { passphrases.settled(field, edit, null) }
    }

    /** The form's fields as core takes them: `webdav` or `selfHosted`, a password or token left null when not edited. */
    private fun formFields(): Pair<String, JSONObject>? {
        val typed = form ?: return null
        return if (typed.kind == "webdav") {
            "webdav" to JSONObject().put("url", typed.url).put("username", typed.username).put("password", typed.password ?: JSONObject.NULL)
                .put("allowInsecureHttp", typed.insecure)
        } else {
            "selfHosted" to JSONObject().put("url", typed.url).put("token", typed.token ?: JSONObject.NULL).put("allowInsecureHttp", typed.insecure)
        }
    }

    /**
     * Sends a screen command off the main thread, in order. A [light] one (a field's text, opening a flow) is not the command
     * running; the screen reads core's view again after each. [key] names a pending command a repeat tap drops, an [ordered] one
     * waits behind the earlier ones sent there, and one sent [after] a queue starts once that queue's earlier work is done (and
     * leaves the queue free while it runs).
     */
    /**
     * [admit] runs on the main thread once [after] drains (its answers settled there first): a refusal it returns stops the command
     * with that toast. [failed] gets a failed command's message as its toast shows it.
     */
    private fun run(name: String, input: JSONObject, light: Boolean = false, key: String = name, ordered: ExecutorService? = null,
                    after: ExecutorService? = null, admit: (() -> String?)? = null, failed: (String) -> Unit = {},
                    done: (JSONObject) -> Unit = {}) {
        val runtime = shell.coreHost() ?: return
        if (!light && !inFlight.add(key)) return
        if (!light) running += 1
        val work = Runnable {
            val result = runCatching {
                after?.submit {}?.get()
                admit?.let { check -> onMain(check)?.let { refusal -> throw IllegalStateException("PASSPHRASE_REFUSED: $refusal") } }
                runtime.syncCommand(name, input.toString())
            }
            shell.ui {
                if (!light) { inFlight.remove(key); running -= 1 }
                result.onSuccess { reply -> toasts(name, reply); done(reply) }
                result.exceptionOrNull()?.let { error ->
                    Log.w(CoreHost.TAG, "Sync screen command failed command=$name code=${error.message?.substringBefore(':')}")
                    val message = error.message.orEmpty()
                    failed(message.substringAfter(": "))
                    shell.showToast(null, message.substringAfter(": "), if (message.startsWith("STALE_REVISION")) "warning" else "error")
                }
                settings.refresh()
            }
        }
        when {
            light -> SyncSettingsModel.light.execute(work)
            ordered != null -> ordered.execute(work)
            else -> Thread(work, "mindwtr-sync-$name").start()
        }
    }

    /**
     * Core's toasts for the command, RN's in order: the last one stays on screen, as RN's toast shows the newest. The log names
     * each toast's tone and title (core's fixed words; a message can quote a server) for the device check.
     */
    private fun toasts(name: String, reply: JSONObject) {
        val all = reply.menuObjects("toasts")
        if (all.isNotEmpty()) Log.i(CoreHost.TAG, "Native Android sync screen command=$name toasts=${all.joinToString("|") { "${it.optString("tone")}:${it.optString("title")}" }}")
        val toast = all.lastOrNull() ?: return
        shell.showToast(toast)
    }

    private fun uuid() = UUID.randomUUID().toString()

    /** [read] on the main thread, from a command's worker, after everything the main thread was already given. */
    private fun <T> onMain(read: () -> T): T {
        val answer = java.util.concurrent.atomic.AtomicReference<Result<T>>()
        val done = java.util.concurrent.CountDownLatch(1)
        shell.ui { answer.set(runCatching(read)); done.countDown() }
        done.await()
        return answer.get().getOrThrow()
    }
}

// ---- The screen ----

/** RN's Sync screen from core's view; while a command runs, the view is read again every half second (RN re-renders as it goes). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SyncSettings(model: InboxViewModel, view: JSONObject) {
    val sync = model.menu.settings.sync
    val c = LocalTheme.current.colors
    // Paused while the missing-files question shows (nothing changes until it is answered) and while the app is in the background.
    val owner = LocalLifecycleOwner.current
    val polling = sync.running > 0 && view.optJSONObject("missingFiles") == null
    LaunchedEffect(polling, owner) {
        if (!polling) return@LaunchedEffect
        owner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (sync.running > 0) {
                delay(500)
                model.menu.settings.refresh()
            }
        }
    }
    val backend = view.getJSONObject("backend")
    OnboardingHandoffCard(model)
    Card {
        Column(Modifier.padding(16.dp)) {
            Text(backend.getString("title"), style = rnText(16, 500, 21), color = c.text)
            Text(backend.getString("current"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            Text(backend.getString("hint"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
            FlowRow(Modifier.padding(top = 10.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (option in backend.menuObjects("options")) BackendChip(sync, option)
            }
            backend.optJSONObject("group")?.let { group ->
                Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(group.getString("title"), style = rnText(16, 500, 21), color = c.text)
                    Text(group.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText)
                }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    GuideLink(view.getJSONObject("guide"), "sync-guide-link")
    view.optJSONObject("off")?.let { off -> HelpBox(off.getString("title"), listOf(off.getString("description"))) }
    view.optJSONObject("panel")?.let { panel ->
        when (panel.getString("kind")) {
            "webdav", "selfhosted" -> FormPanel(model, view, panel)
            "file" -> FilePanel(sync, view, panel)
            "dropbox" -> DropboxPanel(sync, view, panel)
            else -> CloudKitPanel(sync, view, panel)
        }
    }
    view.optJSONObject("encryption")?.let { EncryptionCard(sync, it) }
    PreferencesCard(model, view.getJSONObject("preferences"), view.getJSONObject("disclosure"))
    SnapshotsCard(model, sync, view.getJSONObject("recoverySnapshots"), view.getJSONObject("disclosure"))
    view.optJSONObject("missingFiles")?.takeIf { it.getString("questionId") != sync.answeredQuestion }?.let { question -> MissingFilesDialog(sync, question) }
}

/** RN's Alert for files a new sync location cannot find: its title, the listed files, Cancel and "Continue without these files". */
@Composable
private fun MissingFilesDialog(sync: SyncSettingsModel, question: JSONObject) {
    AlertDialog(
        onDismissRequest = { sync.answerMissingFiles(question.getString("questionId"), false) },
        title = { Text(question.getString("title")) },
        // RN's Alert.alert on Android: the message scrolls, and the buttons draw in capitals with Cancel at the left.
        text = { Text(question.getString("message"), modifier = Modifier.verticalScroll(rememberScrollState())) },
        confirmButton = {
            TextButton(onClick = { sync.answerMissingFiles(question.getString("questionId"), true) }, Modifier.testTag("sync-missing-files-continue")) {
                Text(question.getString("continueLabel").uppercase())
            }
        },
        dismissButton = {
            TextButton(onClick = { sync.answerMissingFiles(question.getString("questionId"), false) }, Modifier.testTag("sync-missing-files-cancel")) {
                Text(question.getString("cancelLabel").uppercase())
            }
        },
    )
}

/** RN's backendOption chip: the chosen one outlined in the tint on the filter wash. */
@Composable
private fun BackendChip(sync: SyncSettingsModel, option: JSONObject) {
    val c = LocalTheme.current.colors
    val selected = option.getBoolean("selected")
    val label = option.getString("label")
    val shape = RoundedCornerShape(16.dp)
    Box(Modifier.clip(shape).background(if (selected) c.filterBg else Color.Transparent).rnBorder(1.dp, if (selected) c.tint else c.border, shape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; this.selected = selected; testTag = "sync-backend-${option.getString("option")}"
            onClick { sync.select(option.getString("option")); true } }
        .clickable { sync.select(option.getString("option")) }.padding(horizontal = 10.dp, vertical = 6.dp)) {
        Text(label, style = rnText(13, 700, 17), color = if (selected) c.tint else c.secondaryText, maxLines = 2, textAlign = TextAlign.Center)
    }
}

/** RN's SettingsGuideLink: the title in the tint with lucide's external-link; it opens the guide in the browser. */
@Composable
internal fun GuideLink(guide: JSONObject, tag: String, bottom: Int = 12) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    val title = guide.getString("title")
    val spoken = "$title. ${guide.getString("description")}"
    val open = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, guide.getString("url").toUri())) } }
    Row(Modifier.padding(bottom = bottom.dp).heightIn(min = 32.dp)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = tag; onClick { open(); true } }
        .clickable { open() }.padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = rnText(13, 700), color = c.tint)
        Icon(Lucide.ExternalLink, null, tint = c.tint, modifier = Modifier.padding(start = 6.dp).size(15.dp))
    }
}

/** RN's helpBox: a bordered card with a 15/600 title and 13/20 lines. */
@Composable
private fun HelpBox(title: String, lines: List<String>) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.padding(bottom = 8.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(16.dp)) {
        Text(title, style = rnText(15, 600), color = c.text, modifier = Modifier.padding(bottom = 8.dp))
        lines.forEachIndexed { index, line ->
            Text(line, style = rnText(13, 400, 20), color = c.secondaryText, modifier = Modifier.padding(top = if (index > 0) 8.dp else 0.dp))
        }
    }
}

/** RN's pressable settingRow with a colored label, its description, and RN's small spinner while it runs. */
@Composable
private fun SyncAction(action: JSONObject, tag: String, divider: Boolean = true, press: () -> Unit) {
    val c = LocalTheme.current.colors
    val label = action.getString("label")
    val description = action.menuText("description")
    val enabled = action.getBoolean("enabled")
    val busy = action.getBoolean("busy")
    val spoken = if (description == null) label else "$label, $description"
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (divider) Modifier.hairline(c.border, top = true) else Modifier)
        .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = tag; if (enabled) onClick { press(); true } else disabled() }
        .clickable(enabled = enabled, onClick = press).padding(16.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(label, style = rnText(16, 500, 21), color = if (action.getBoolean("tinted")) c.tint else c.secondaryText)
            description?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
        }
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
    }
}

/** RN's textInput inside an inputGroup: a bordered field on the input color. */
@Composable
private fun SyncInput(value: String, label: String, placeholder: String?, secure: Boolean, tag: String, keyboard: KeyboardType, change: (String) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    BasicTextField(value, change, singleLine = true, cursorBrush = SolidColor(c.tint), textStyle = rnText(14, 400).copy(color = c.text),
        visualTransformation = if (secure) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = keyboard, imeAction = ImeAction.Done),
        modifier = Modifier.padding(top = 8.dp).fillMaxWidth().clip(shape).background(c.inputBg).rnBorder(1.dp, c.border, shape)
            .semantics { contentDescription = label }.testTag(tag),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                if (value.isEmpty() && placeholder != null) Text(placeholder, style = rnText(14, 400), color = c.secondaryText)
                inner()
            }
        })
}

/** RN's inputGroup: 16 around, a hairline above unless first. */
@Composable
private fun InputGroup(divider: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val c = LocalTheme.current.colors
    Column(Modifier.fillMaxWidth().then(if (divider) Modifier.hairline(c.border, top = true) else Modifier).padding(16.dp), content = content)
}

/** The WebDAV and self-hosted forms (RN's SyncWebDavBackendPanel, SyncSelfHostedBackendPanel), with the last sync card below. */
@Composable
private fun FormPanel(model: InboxViewModel, view: JSONObject, panel: JSONObject) {
    val sync = model.menu.settings.sync
    val form = sync.form ?: return
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    val webdav = panel.getString("kind") == "webdav"
    if (webdav) SectionTitle(panel.getString("title"), top = 16, color = c.text) else Spacer(Modifier.height(12.dp))
    Card {
        val url = panel.getJSONObject("url")
        InputGroup(divider = false) {
            Text(url.getString("label"), style = rnText(16, 500, 21), color = c.text)
            SyncInput(form.url, url.getString("label"), url.menuText("placeholder"), false, "sync-url", KeyboardType.Uri) { text -> sync.edit { copy(url = text) } }
            val hints = if (webdav) listOf(url.getString("hint")) else url.getJSONArray("hints").let { list -> List(list.length()) { list.getString(it) } }
            for (hint in hints) Text(hint, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            url.menuText("invalid")?.let { Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 2.dp)) }
        }
        val insecure = panel.getJSONObject("allowInsecureHttp")
        InputGroup(divider = true) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 16.dp)) {
                    Text(insecure.getString("label"), style = rnText(16, 500, 21), color = c.text)
                    Text(insecure.getString("hint"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                }
                RnSwitch(form.insecure, true, insecure.getString("label"), theme.settingsSwitch) { sync.edit { copy(insecure = !this.insecure) } }
            }
        }
        if (webdav) {
            val username = panel.getJSONObject("username")
            InputGroup(divider = true) {
                Text(username.getString("label"), style = rnText(16, 500, 21), color = c.text)
                SyncInput(form.username, username.getString("label"), username.menuText("placeholder"), false, "sync-username", KeyboardType.Email) { text -> sync.edit { copy(username = text) } }
            }
            val password = panel.getJSONObject("password")
            val mask = password.getString("mask")
            InputGroup(divider = true) {
                Text(password.getString("label"), style = rnText(16, 500, 21), color = c.text)
                SyncInput(form.password ?: mask, password.getString("label"), password.getString("placeholder"), true, "sync-password", KeyboardType.Password) { text ->
                    sync.edit { copy(password = sync.secret(this.password, mask, text)) }
                }
            }
        } else {
            val token = panel.getJSONObject("token")
            val mask = token.getString("mask")
            InputGroup(divider = true) {
                Text(token.getString("label"), style = rnText(16, 500, 21), color = c.text)
                SyncInput(form.token ?: mask, token.getString("label"), token.getString("placeholder"), true, "sync-token", KeyboardType.Password) { text ->
                    sync.edit { copy(token = sync.secret(this.token, mask, text)) }
                }
                Text(token.getString("hint"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
                token.menuText("invalid")?.let { Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 2.dp)) }
            }
        }
        SyncAction(panel.getJSONObject("save"), "sync-save") { sync.save(view) }
        SyncAction(panel.getJSONObject("syncNow"), "sync-now") { sync.syncNow(view) }
        SyncAction(panel.getJSONObject("test"), "sync-test") { sync.test() }
    }
    LastSyncCard(sync, panel.getJSONObject("lastSync"))
}

/** RN's File Sync panel: the how-to box, then the folder and Sync now, with the last sync card inside the card. */
@Composable
private fun FilePanel(sync: SyncSettingsModel, view: JSONObject, panel: JSONObject) {
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    // RN's expo picker: ACTION_OPEN_DOCUMENT_TREE with no start folder. Debug builds only (check-file-sync-device.mjs):
    // `debug.mindwtr.native.sync_tree` opens it in the check's test folder.
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { sync.folderPicked(context, it) }
    val pickFolder = {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        tech.dongdongbh.mindwtr.pilot.core.debugProperty("sync_tree").ifEmpty { null }
            ?.let { intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, it.toUri()) }
        runCatching { picker.launch(intent) }.onFailure { Log.w(CoreHost.TAG, "Sync folder picker unavailable ${failureForLog(it)}") }
        Unit
    }
    val help = panel.getJSONObject("help")
    HelpBox(help.getString("title"), listOf(help.getString("text"), help.getString("tip")))
    SectionTitle(panel.getString("title"), top = 16, color = c.text)
    Card {
        val folder = panel.getJSONObject("folder")
        val select = folder.getJSONObject("select")
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(16.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f).padding(end = 16.dp)) {
                Text(folder.getString("label"), style = rnText(16, 500, 21), color = c.text)
                Text(folder.getString("value"), style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 1, modifier = Modifier.padding(top = 2.dp))
            }
            Text(select.getString("label"), style = rnText(16, 400, 21), color = c.tint, textAlign = TextAlign.End,
                modifier = Modifier.clearAndSetSemantics { contentDescription = select.getString("label"); role = Role.Button; testTag = "sync-select-folder"
                    if (select.getBoolean("enabled")) onClick { pickFolder(); true } else disabled() }
                    .clickable(enabled = select.getBoolean("enabled"), onClick = pickFolder))
        }
        SyncAction(panel.getJSONObject("syncNow"), "sync-now") { sync.syncNow(view) }
        // RN's file panel puts the whole status card (its margin and padding) inside a setting row's info column.
        Column(Modifier.fillMaxWidth().hairline(c.border, top = true).padding(16.dp)) {
            Column(Modifier.padding(end = 16.dp)) { LastSyncCard(sync, panel.getJSONObject("lastSync")) }
        }
    }
}

/** RN's Dropbox panel: the app key text, the account status, Connect or Disconnect, Test connection and Sync now. */
@Composable
private fun DropboxPanel(sync: SyncSettingsModel, view: JSONObject, panel: JSONObject) {
    val c = LocalTheme.current.colors
    Card(top = 12) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(panel.getString("title"), style = rnText(16, 500, 21), color = c.text)
            Text(panel.getString("description"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp))
            Text(panel.getString("redirect"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp))
            panel.menuText("notConfigured")?.let { Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 8.dp)) }
            Text(panel.getString("status"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
        }
        SyncAction(panel.getJSONObject("connect"), "sync-dropbox-connect") { sync.dropbox(panel.getBoolean("connected")) }
        SyncAction(panel.getJSONObject("test"), "sync-test") { sync.test() }
        SyncAction(panel.getJSONObject("syncNow"), "sync-now") { sync.syncNow(view) }
    }
    LastSyncCard(sync, panel.getJSONObject("lastSync"))
}

/** RN's iCloud panel (iOS only; drawn for completeness of core's view). */
@Composable
private fun CloudKitPanel(sync: SyncSettingsModel, view: JSONObject, panel: JSONObject) {
    val help = panel.getJSONObject("help")
    HelpBox(help.getString("title"), listOf(help.getString("text"), help.getString("status")))
    Card { SyncAction(panel.getJSONObject("syncNow"), "sync-now", divider = false) { sync.syncNow(view) } }
    LastSyncCard(sync, panel.getJSONObject("lastSync"))
}

/** RN's SyncLastStatusCard: the last sync, its counts and conflicts, the error in the danger color, and the folded history. */
@Composable
private fun LastSyncCard(sync: SyncSettingsModel, card: JSONObject) {
    val c = LocalTheme.current.colors
    val body: @Composable ColumnScope.() -> Unit = {
        Text(card.getString("title"), style = rnText(16, 500, 21), color = c.text)
        Text(card.getString("status"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp).testTag("sync-status"))
        for (line in card.getJSONArray("lines").let { list -> List(list.length()) { list.getString(it) } }) {
            Text(line, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        }
        card.menuText("error")?.let {
            Text(it, style = rnText(13, 400, 18), color = c.danger, modifier = Modifier.padding(top = 2.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("sync-error"))
        }
        card.optJSONObject("history")?.let { history ->
            val open = sync.historyOpen
            val toggle = if (open) history.getString("open") else history.getString("closed")
            Text(toggle, style = rnText(13, 600, 18), color = c.secondaryText,
                modifier = Modifier.padding(top = 8.dp).clearAndSetSemantics { contentDescription = toggle; role = Role.Button; testTag = "sync-history"
                    onClick { sync.toggleHistory(); true }; if (open) collapse { sync.toggleHistory(); true } else expand { sync.toggleHistory(); true } }
                    .clickable { sync.toggleHistory() })
            if (open) for (entry in history.getJSONArray("entries").let { list -> List(list.length()) { list.getString(it) } }) {
                Text(entry, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
            }
        }
    }
    Card(top = 12) { Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(16.dp), content = body) }
}

/** The encryption card (RN's SyncEncryptionCard): core's rows in order; a field's text goes back to core as typed. */
@Composable
private fun EncryptionCard(sync: SyncSettingsModel, card: JSONObject) {
    val c = LocalTheme.current.colors
    SectionTitle(card.getString("title"), top = 16, color = c.text)
    card.optJSONObject("guide")?.let { GuideLink(it, "sync-encryption-guide-link") }
    // RN groups consecutive texts in one settingRowColumn, but a warning or an error starts its own (the enable flow's warnings sit
    // below the description, an error stands alone). Every block after the first has a hairline above, except the generated
    // passphrase's hint under Generate.
    val blocks = mutableListOf<List<JSONObject>>()
    for (row in card.menuObjects("rows")) {
        val last = blocks.lastOrNull()
        val tone = row.optString("tone")
        val joins = row.getString("kind") == "text" && last?.first()?.getString("kind") == "text" && tone != "danger"
            && last.last().optString("tone") != "danger" && (tone != "warning" || last.last().optString("tone") == "warning")
        if (joins) blocks[blocks.size - 1] = last!! + row else blocks += listOf(row)
    }
    Card {
        blocks.forEachIndexed { index, block ->
            val divider = index > 0 && !(block.first().getString("kind") == "text"
                && blocks[index - 1].first().optJSONObject("action")?.optString("type") == "generate")
            val row = block.first()
            when (row.getString("kind")) {
                "text" -> Column(Modifier.fillMaxWidth().then(if (divider) Modifier.hairline(c.border, top = true) else Modifier).padding(16.dp)) {
                    block.forEachIndexed { at, line ->
                        val tone = line.getString("tone")
                        val gap = if (at == 0) 0 else if (tone == "description" && block[at - 1].getString("tone") == "label") 2 else 8
                        Text(line.getString("text"), style = if (tone == "label") rnText(16, 500, 21) else rnText(13, 400, 18),
                            color = when (tone) { "label" -> c.text; "warning" -> c.warning; "danger" -> c.danger; else -> c.secondaryText },
                            modifier = Modifier.padding(top = gap.dp))
                    }
                }
                "field" -> {
                    val field = row.getString("field")
                    val label = row.getString("label")
                    InputGroup(divider) {
                        Text(label, style = rnText(16, 500, 21), color = c.text)
                        SyncInput(sync.fields[field].orEmpty(), label, null, row.getBoolean("secure"), "sync-passphrase-$field", KeyboardType.Password) { text ->
                            sync.typePassphrase(field, text, row.getInt("maxLength"), row.getString("tooLong"))
                        }
                    }
                }
                "reveal" -> {
                    val label = row.getString("label")
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (divider) Modifier.hairline(c.border, top = true) else Modifier)
                        // RN's switch states whether the passphrase shows (accessibilityState checked).
                        .clearAndSetSemantics { contentDescription = label; role = Role.Switch; toggleableState = ToggleableState(row.getBoolean("revealed"))
                            onClick { sync.encryption(row.getJSONObject("action")); true } }
                        .clickable { sync.encryption(row.getJSONObject("action")) }.padding(16.dp)) {
                        Text(label, style = rnText(16, 500, 21), color = c.tint)
                    }
                }
                else -> {
                    val label = row.getString("label")
                    val enabled = row.getBoolean("enabled")
                    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (divider) Modifier.hairline(c.border, top = true) else Modifier)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = "sync-encryption-${row.getJSONObject("action").getString("type")}"
                            if (enabled) onClick { sync.encryption(row.getJSONObject("action")); true } else disabled() }
                        .clickable(enabled = enabled) { sync.encryption(row.getJSONObject("action")) }.padding(16.dp), verticalAlignment = Alignment.Top) {
                        Text(label, style = rnText(16, 500, 21), color = if (enabled) c.tint else c.secondaryText, modifier = Modifier.weight(1f).padding(end = 16.dp))
                        if (row.getBoolean("busy")) CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
                    }
                }
            }
        }
    }
}

/**
 * The encryption card's passphrase fields as typed, for one visit. Core takes at most the row's `maxLength` characters a field:
 * a longer edit is refused, never cut to fit, and while a refused edit stands no submit runs (it would run with the shorter text
 * core kept, a passphrase other devices could never match).
 */
class PassphraseFields {
    var texts by mutableStateOf(emptyMap<String, String>()); private set
    /** A refused field and what to say about it: core's limit, or core's answer to its `typed` command. */
    private var refused by mutableStateOf(emptyMap<String, String>())
    /** Each field's newest edit; core's answer to an older one changes nothing (the light queue answers in order). */
    private val edits = HashMap<String, Int>()
    val submittable: Boolean get() = refused.isEmpty()

    /**
     * The edit's number when it is taken (it goes to core, whose answer comes to [settled]); null when [text] is past
     * [maxLength] (the field keeps what it held and stays refused with [tooLong]).
     */
    fun type(field: String, text: String, maxLength: Int, tooLong: String): Int? {
        val edit = next(field)
        if (text.length > maxLength) {
            refused = refused + (field to tooLong)
            return null
        }
        texts = texts + (field to text)
        refused = refused - field
        return edit
    }

    /** Core's answer to [edit] of [field]: null took it; a refusal ([refusal], core's words) stands until core takes a later edit. */
    fun settled(field: String, edit: Int, refusal: String?) {
        if (edits[field] != edit) return
        refused = if (refusal == null) refused - field else refused + (field to refusal)
    }

    /** Generate's passphrase, in both new-passphrase fields (core set it, so an older edit's answer no longer counts). */
    fun generated(phrase: String) {
        next("next"); next("confirm")
        texts = texts + mapOf("next" to phrase, "confirm" to phrase)
        refused = refused - "next" - "confirm"
    }

    /**
     * What blocks [action], or null. A flow change (open, cancel, retry) starts the fields afresh, so a refusal never outlives its
     * flow; a submit waits for every refused field, except Abandon setup's, which asks for no passphrase.
     */
    fun admit(action: JSONObject): String? = when (action.optString("type")) {
        "open", "cancel", "retry" -> { clear(); null }
        "submit" -> if (action.optString("flow") == "abandon") null else refused.values.firstOrNull()
        else -> null
    }

    /** Counters are kept, so an answer to an edit made before the clear never matches a new one. */
    fun clear() {
        edits.keys.forEach { next(it) }
        texts = emptyMap()
        refused = emptyMap()
    }

    private fun next(field: String): Int = ((edits[field] ?: 0) + 1).also { edits[field] = it }
}

/** RN's folded card heading (Settings sync options, Recovery snapshots): its title, description and ▸ or ▾. */
@Composable
private fun FoldHeading(title: String, description: String, open: Boolean, glyphs: JSONObject, tag: String, toggle: () -> Unit) {
    val c = LocalTheme.current.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
        .clearAndSetSemantics { contentDescription = "$title, $description"; role = Role.Button; testTag = tag
            onClick { toggle(); true }; if (open) collapse { toggle(); true } else expand { toggle(); true } }
        .clickable(onClick = toggle).padding(16.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(title, style = rnText(16, 500, 21), color = c.text)
            Text(description, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        }
        Text(if (open) glyphs.getString("open") else glyphs.getString("closed"), style = rnText(24, 300), color = c.secondaryText)
    }
}

/** RN's SyncPreferencesCard: folded; each option's switch sends core's setSyncPreference. */
@Composable
private fun PreferencesCard(model: InboxViewModel, preferences: JSONObject, glyphs: JSONObject) {
    val sync = model.menu.settings.sync
    val c = LocalTheme.current.colors
    val theme = LocalTheme.current
    Card(top = 16) {
        FoldHeading(preferences.getString("title"), preferences.getString("description"), sync.preferencesOpen, glyphs, "sync-preferences-disclosure") { sync.togglePreferences() }
        if (sync.preferencesOpen) for (row in preferences.menuObjects("rows")) {
            val label = row.getString("label")
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(c.border, top = true).padding(16.dp), verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f).padding(end = 16.dp)) {
                    Text(label, style = rnText(16, 500, 21), color = c.text)
                    row.menuText("hint")?.let { Text(it, style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp)) }
                }
                RnSwitch(row.getBoolean("value"), model.menu.idle, label, theme.settingsSwitch) { sync.preference(row.getString("key"), !row.getBoolean("value")) }
            }
        }
    }
}

/**
 * RN's RecoverySnapshotsCard, folded: each snapshot's date label over its file name and RN's Restore word (its spinner while it
 * restores); a row asks core's question first (DataTransfer.kt), and every row is off while a sync or any data action runs.
 */
@Composable
private fun SnapshotsCard(model: InboxViewModel, sync: SyncSettingsModel, snapshots: JSONObject, glyphs: JSONObject) {
    val c = LocalTheme.current.colors
    val transfer = model.menu.settings.transfer
    Card(top = 16) {
        FoldHeading(snapshots.getString("title"), snapshots.getString("description"), sync.snapshotsOpen, glyphs, "recovery-snapshots-disclosure") { sync.toggleSnapshots() }
        if (sync.snapshotsOpen) {
            val rows = snapshots.optJSONArray("rows")?.let { list -> List(list.length()) { list.getJSONObject(it) } }.orEmpty()
            if (rows.isEmpty()) Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(c.border, top = true).padding(16.dp)) {
                Text(snapshots.getString("empty"), style = rnText(13, 400, 18), color = c.secondaryText)
            }
            val enabled = snapshots.optBoolean("enabled", true) && !transfer.busy
            for (row in rows) {
                val name = row.getString("name")
                val busy = transfer.action == "snapshot:$name"
                val spoken = row.getString("accessibilityLabel") + ", " + row.getString("accessibilityHint")
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).hairline(c.border, top = true)
                    .clearAndSetSemantics { contentDescription = spoken; role = Role.Button; testTag = "recovery-snapshot-$name"
                        if (busy) stateDescription = "busy"
                        if (enabled) onClick { transfer.askSnapshot(name, undo = false); true } else disabled() }
                    .clickable(enabled = enabled) { transfer.askSnapshot(name, undo = false) }.padding(16.dp), verticalAlignment = Alignment.Top) {
                    Column(Modifier.weight(1f).padding(end = 16.dp)) {
                        Text(row.getString("label"), style = rnText(16, 500, 21), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(name, style = rnText(13, 400, 18), color = c.secondaryText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                    }
                    if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
                    else Text(snapshots.getString("restoreLabel"), style = rnText(16, 500, 21), color = c.tint)
                }
            }
        }
    }
}
