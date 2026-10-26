package tech.dongdongbh.mindwtr.pilot

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.SavedStateHandle
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/*
 * RN's capture confirmation screen (app/capture-modal.tsx), which capture links, text shares, assistant notes and a widget's
 * quick capture open (EntryPoints.kt), on core's capture screen contract (native-host-contract-capture-modal.ts). Kotlin keeps
 * what RN's screen keeps: the entry's route params, core's draft with the typed text on top, and the several-lines question
 * with one capture UUID per line. Reads and commands run on InboxViewModel's paths (perform, background, the exact-retry lock).
 */

/** The capture screen's Save and Create tasks (host-entry.ts captureModalSubmit and captureModalLines); core can refuse each before writing. */
val CAPTURE_MODAL_KINDS = setOf("captureModal", "captureModalLines")

/** A read of core's view for the draft as it is (no edit), queued with the edits. */
private val READ = JSONObject().put("read", true)

/**
 * The open screen. [params] are the entry's route params and [draft] core's draft (the typed text and description on top of
 * core's last), both sent with every call; [view] is core's last view. [edits] wait for core and go one at a time; they are
 * part of the durable screen and are sent again after process death. [pending] is an answer whose outcome is unknown (its exact
 * request); [confirm] core's several-lines question with one capture ID per line ([lineIds]); [queuedSave] a Save tapped while
 * edits waited (true: Save & edit).
 */
data class CaptureModal(
    val session: String,
    val params: JSONObject,
    val draft: JSONObject,
    val view: JSONObject,
    val edits: List<JSONObject> = emptyList(),
    val captureId: String = UUID.randomUUID().toString(),
    val confirm: JSONObject? = null,
    val lineIds: List<String> = emptyList(),
    val pending: FailedAction? = null,
    val queuedSave: Boolean? = null,
) {
    val failed: Boolean get() = draft.optBoolean("failed")

    /** [draft] with [name] set: typed text, or the failure line. */
    fun drafted(name: String, value: Any): CaptureModal = copy(draft = JSONObject(draft.toString()).put(name, value))

    fun state(): JSONObject = JSONObject().put("session", session).put("params", params).put("draft", draft).put("view", view)
        .put("edits", JSONArray(edits)).put("captureId", captureId).put("confirm", confirm ?: JSONObject.NULL).put("lineIds", JSONArray(lineIds))
        .put("pending", pending?.let { JSONObject().put("kind", it.kind).put("id", it.id).put("request", it.patch["request"]) } ?: JSONObject.NULL)

    companion object {
        fun restore(saved: JSONObject): CaptureModal {
            val edits = saved.getJSONArray("edits")
            val ids = saved.getJSONArray("lineIds")
            return CaptureModal(saved.getString("session"), saved.getJSONObject("params"), saved.getJSONObject("draft"), saved.getJSONObject("view"),
                List(edits.length()) { edits.getJSONObject(it) }, saved.getString("captureId"), saved.optJSONObject("confirm"),
                List(ids.length()) { ids.getString(it) },
                saved.optJSONObject("pending")?.let { FailedAction(it.getString("kind"), it.getString("id"), patch = mapOf("request" to it.getString("request"))) })
        }
    }
}

class CaptureModalModel(private val shell: InboxViewModel, private val saved: SavedStateHandle, private val dir: File) {
    /** The open screen, on disk (synced) before anything else; the Bundle holds only whether it is open. */
    var open by mutableStateOf<CaptureModal?>(null); private set
    private val file = File(dir, "modal")
    /** The edit core is answering now. */
    private var inFlight: JSONObject? = null

    private fun keep(value: CaptureModal?, persist: Boolean = true) {
        if (value == null && open != null) shell.ai.cancelCapture()
        open = value
        saved["captureModal"] = value != null
        if (value == null) file.delete() else if (persist) write(value.state().toString())
    }

    private fun write(text: String) {
        dir.mkdirs()
        val partial = File(dir, "modal-partial")
        FileOutputStream(partial).use { out -> out.write(text.toByteArray()); out.fd.sync() }
        check(partial.renameTo(file)) { "Cannot save the capture screen" }
    }

    private fun stored(): CaptureModal? = runCatching { CaptureModal.restore(JSONObject(file.readText())) }.getOrNull()

    /** An entry's screen: core's openCaptureModal [reply] (the first draft and view) for its route [params]. */
    fun opened(params: JSONObject, reply: JSONObject) {
        inFlight = null
        keep(CaptureModal(UUID.randomUUID().toString(), params, reply.getJSONObject("draft"), reply.getJSONObject("view")))
    }

    /**
     * After boot: the screen left open at process death comes back with its draft. A Save whose outcome was unknown comes back
     * even without saved state (a force-stop or a crash), and is sent again exactly first: core answers it from its receipt.
     */
    fun resume() {
        val restored = stored()?.takeIf { saved.get<Boolean>("captureModal") == true || it.pending != null }
        if (restored == null) { keep(null); return }
        // Core's view as it reads now: the data, the language or the minute may have moved since it was saved.
        keep(restored.copy(edits = restored.edits + READ))
        val action = restored.pending ?: return pump()
        if (shell.failedAction != null) return
        shell.owe(action)
        send(action)
    }

    /** A new screen in this process reopens on an owed Save, never re-sent here (InboxViewModel.restore). */
    fun restored(action: FailedAction) { stored()?.let { keep(it.copy(pending = action)) } }

    /** The failure banner's Try again: the owed request again. */
    fun retry(action: FailedAction) = send(action)

    /** Typing in the title field: shown at once, then core's setText for the preview (a later keystroke replaces a waiting one). */
    fun type(text: String) = typed("text", JSONObject().put("type", "setText").put("value", text))

    fun describe(text: String) = typed("description", JSONObject().put("type", "setDescription").put("value", text))

    private fun typed(field: String, edit: JSONObject) {
        val current = open ?: return
        val waiting = current.edits.drop(if (inFlight != null) 1 else 0)
        val edits = if (waiting.lastOrNull()?.optString("type") == edit.getString("type")) current.edits.dropLast(1) else current.edits
        keep(current.drafted(field, edit.getString("value")).copy(edits = edits + edit))
        pump()
    }

    /** A control's edit as core's view carries it (the ? button); queued, then sent one at a time. */
    fun edit(edit: JSONObject) {
        val current = open ?: return
        keep(current.copy(edits = current.edits + edit))
        pump()
    }

    /** Sends the next waiting edit, then a queued Save. The screen calls it again whenever no action runs. */
    fun pump() {
        val current = open ?: return
        if (inFlight != null || !shell.writable || shell.busy || shell.failedAction != null) return
        val next = current.edits.firstOrNull()
        if (next == null) { current.queuedSave?.let(::save); return }
        inFlight = next
        val read = next.optBoolean("read")
        val request = JSONObject().put("params", current.params).put("draft", current.draft).apply { if (!read) put("edit", next) }
        shell.background(emptyList(), { runtime -> runCatching { runtime.menuRead(if (read) "captureModalView" else "captureModalEdit", request.toString()) } }) { reply, _ ->
            if (inFlight === next) inFlight = null
            // A reply counts only for its screen and the edit it answers, still first in the queue.
            val now = open?.takeIf { it.session == current.session && it.edits.firstOrNull() === next } ?: return@background pump()
            reply.onSuccess { result ->
                if (read) return@onSuccess keep(now.copy(view = result, edits = now.edits.drop(1)))
                // The fields keep what was typed since: that keystroke's own edit still waits.
                val draft = result.getJSONObject("draft").put("text", now.draft.getString("text")).put("description", now.draft.getString("description"))
                keep(now.copy(draft = draft, view = result.getJSONObject("view"), edits = now.edits.drop(1)))
            }.onFailure { failure ->
                // Core refused the edit: its message shows, and the queue (with a queued Save) is dropped.
                Log.w(CoreHost.TAG, "Capture screen edit refused", failure)
                shell.showToast(null, (failure.message ?: failure.javaClass.simpleName).substringAfter(": "), "warning")
                keep(now.copy(edits = emptyList(), queuedSave = null))
            }
            pump()
        }
    }

    /** The screen's draft as a request sends it: a save clears the failure line, as RN's does when it starts. */
    private fun sent(current: CaptureModal) = JSONObject(current.draft.toString()).put("failed", false)

    /** RN's Save (Save & edit: [openAfterSave]): waiting edits go first; the exact request is on disk before the call. */
    fun save(openAfterSave: Boolean) {
        val current = open ?: return
        if (current.edits.isNotEmpty() || inFlight != null) { keep(current.copy(queuedSave = openAfterSave), persist = false); return }
        // An owed request (a Save's, or Create tasks' once its question closed on the failure) is sent again exactly.
        val action = current.pending ?: FailedAction("captureModal", current.captureId, patch = mapOf("request" to
            JSONObject().put("params", current.params).put("draft", sent(current)).put("captureId", current.captureId).put("openAfterSave", openAfterSave).toString()))
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        keep(current.copy(pending = action, queuedSave = null).drafted("failed", false))
        send(action)
    }

    /** RN's Create tasks on the several-lines question: one capture UUID per line; the request is on disk before the call. */
    fun createLines() {
        val current = open ?: return
        if (current.lineIds.isEmpty()) return
        val action = current.pending ?: FailedAction("captureModalLines", current.lineIds.first(), patch = mapOf("request" to
            JSONObject().put("params", current.params).put("draft", sent(current)).put("captureIds", JSONArray(current.lineIds)).toString()))
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        keep(current.copy(pending = action, queuedSave = null).drafted("failed", false))
        send(action)
    }

    /** The question's Cancel, its backdrop, and Back: no task is created. */
    fun cancelLines() { open?.let { keep(it.copy(confirm = null, lineIds = emptyList())) } }

    /**
     * RN's Cancel: nothing is written; core's discard says whether the app then goes behind the previous one ([leave]). Back
     * passes false: RN's Back pops the route and the app stays. It stays usable while a save is owed, as RN's Cancel does.
     */
    fun cancel(leave: Boolean = true) {
        val current = open ?: return
        // While a save is owed (or any command), no read runs: the screen closes in the app, and the exact retry stays owed on the
        // tabs' banner. It cannot be dropped: the write may have landed, and the journal replays it at the next boot.
        if (shell.failedAction != null) { keep(null); inFlight = null; return }
        shell.perform { runtime ->
            val close = runtime.menuRead("captureModalDiscard", JSONObject().put("params", current.params).toString()).getJSONObject("close")
            shell.ui { if (open?.session == current.session) end(close, leave) }
        }
    }

    /**
     * Core's submitCaptureModal or submitCaptureModalLines with [action]'s exact request. A failure shows RN's failure line on the
     * card: a refusal wrote nothing (the capture UUIDs are free), any other failure keeps the exact retry.
     */
    private fun send(action: FailedAction) = shell.perform(action) { runtime ->
        val request = action.patch["request"]!!
        val reply = try {
            if (action.kind == "captureModal") runtime.submitCaptureModal(request) else runtime.submitCaptureModalLines(request)
        } catch (failure: Exception) {
            // ACTION_FAILED: core wrote no task and the journal dropped the entry. As RN, the card says so and the next Save is
            // a fresh attempt; nothing is owed (MenuModel's LANDLESS).
            if (failure.message?.startsWith("ACTION_FAILED") == true) {
                shell.acknowledged(action)
                shell.ui { failed(refused = true) }
                return@perform
            }
            val refused = UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }
            // A refused retry of an owed save wrote nothing either: nothing is owed any more, and the screen unlocks.
            if (refused) shell.acknowledged(action)
            shell.ui { failed(refused) }
            throw failure
        }
        shell.acknowledged(action)
        shell.ui { answered(reply) }
    }

    /** RN's failure line on the card; the several-lines question closes, as RN's does (an owed retry stays: Save or Try again). */
    private fun failed(refused: Boolean) {
        val current = open?.drafted("failed", true) ?: return
        keep(if (refused) current.copy(pending = null, captureId = UUID.randomUUID().toString(), confirm = null, lineIds = emptyList()) else current.copy(confirm = null))
    }

    /**
     * Core's answer: saved (close, or the task's editor for Save & edit), refused (core's toast; the draft stays), several lines
     * (RN's question), or nothing (a blank title).
     */
    private fun answered(reply: JSONObject) {
        val current = open ?: return
        val fresh = current.copy(pending = null, captureId = UUID.randomUUID().toString(), confirm = null, lineIds = emptyList())
        when (reply.getString("kind")) {
            // Save & edit: RN replaces the screen with the task's project (else Focus) and its editor on the Task tab, so backing out
            // never reopens the saved text (#1029).
            "saved" -> if (reply.optString("next") == "open" || reply.optString("next") == "openInProject") {
                keep(null)
                shell.openSavedTask(reply.getString("taskId"), reply.menuText("projectId"))
            } else end(reply.getJSONObject("close"))
            "refused" -> {
                reply.getJSONObject("notice").let { shell.showToast(it) }
                keep(fresh)
            }
            "confirmLines" -> keep(fresh.copy(confirm = reply.getJSONObject("confirm"), lineIds = List(reply.getInt("lineCount")) { UUID.randomUUID().toString() }))
            else -> keep(fresh)
        }
    }

    /**
     * The screen closes to the screen behind it (this app always has one, so core's returnTo path is never needed); a project's "+"
     * opened it, and that project (core's returnToProjectId) opens again, as RN's project screen does when capture pops. A system
     * capture then puts the app behind the previous one (RN's finishCapture, #1169).
     */
    private fun end(close: JSONObject, leave: Boolean = true) {
        keep(null)
        inFlight = null
        // openProject's read refuses to start while the save's action still runs: open the project once it ends.
        close.menuText("returnToProjectId")?.let { id -> shell.menu.whenIdle { shell.openProject(id) } }
        if (leave && close.getBoolean("returnToPreviousApp")) shell.leaveApp = true
    }
}
