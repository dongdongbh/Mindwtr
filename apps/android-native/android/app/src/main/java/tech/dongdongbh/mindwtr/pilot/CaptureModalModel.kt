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


val CAPTURE_MODAL_KINDS = setOf("captureModal", "captureModalLines")


private val READ = JSONObject().put("read", true)


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

    var open by mutableStateOf<CaptureModal?>(null); private set
    private val file = File(dir, "modal")

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


    fun opened(params: JSONObject, reply: JSONObject) {
        inFlight = null
        keep(CaptureModal(UUID.randomUUID().toString(), params, reply.getJSONObject("draft"), reply.getJSONObject("view")))
    }


    fun resume() {
        val restored = stored()?.takeIf { saved.get<Boolean>("captureModal") == true || it.pending != null }
        if (restored == null) { keep(null); return }

        keep(restored.copy(edits = restored.edits + READ))
        val action = restored.pending ?: return pump()
        if (shell.failedAction != null) return
        shell.owe(action)
        send(action)
    }


    fun restored(action: FailedAction) { stored()?.let { keep(it.copy(pending = action)) } }


    fun retry(action: FailedAction) = send(action)


    fun type(text: String) = typed("text", JSONObject().put("type", "setText").put("value", text))

    fun describe(text: String) = typed("description", JSONObject().put("type", "setDescription").put("value", text))

    private fun typed(field: String, edit: JSONObject) {
        val current = open ?: return
        val waiting = current.edits.drop(if (inFlight != null) 1 else 0)
        val edits = if (waiting.lastOrNull()?.optString("type") == edit.getString("type")) current.edits.dropLast(1) else current.edits
        keep(current.drafted(field, edit.getString("value")).copy(edits = edits + edit))
        pump()
    }


    fun edit(edit: JSONObject) {
        val current = open ?: return
        keep(current.copy(edits = current.edits + edit))
        pump()
    }


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

            val now = open?.takeIf { it.session == current.session && it.edits.firstOrNull() === next } ?: return@background pump()
            reply.onSuccess { result ->
                if (read) return@onSuccess keep(now.copy(view = result, edits = now.edits.drop(1)))

                val draft = result.getJSONObject("draft").put("text", now.draft.getString("text")).put("description", now.draft.getString("description"))
                keep(now.copy(draft = draft, view = result.getJSONObject("view"), edits = now.edits.drop(1)))
            }.onFailure { failure ->

                Log.w(CoreHost.TAG, "Capture screen edit refused", failure)
                shell.showToast(null, (failure.message ?: failure.javaClass.simpleName).substringAfter(": "), "warning")
                keep(now.copy(edits = emptyList(), queuedSave = null))
            }
            pump()
        }
    }


    private fun sent(current: CaptureModal) = JSONObject(current.draft.toString()).put("failed", false)


    fun save(openAfterSave: Boolean) {
        val current = open ?: return
        if (current.edits.isNotEmpty() || inFlight != null) { keep(current.copy(queuedSave = openAfterSave), persist = false); return }

        val action = current.pending ?: FailedAction("captureModal", current.captureId, patch = mapOf("request" to
            JSONObject().put("params", current.params).put("draft", sent(current)).put("captureId", current.captureId).put("openAfterSave", openAfterSave).toString()))
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        keep(current.copy(pending = action, queuedSave = null).drafted("failed", false))
        send(action)
    }


    fun createLines() {
        val current = open ?: return
        if (current.lineIds.isEmpty()) return
        val action = current.pending ?: FailedAction("captureModalLines", current.lineIds.first(), patch = mapOf("request" to
            JSONObject().put("params", current.params).put("draft", sent(current)).put("captureIds", JSONArray(current.lineIds)).toString()))
        if (shell.busy || (shell.failedAction != null && shell.failedAction != action)) return
        keep(current.copy(pending = action, queuedSave = null).drafted("failed", false))
        send(action)
    }


    fun cancelLines() { open?.let { keep(it.copy(confirm = null, lineIds = emptyList())) } }


    fun cancel(leave: Boolean = true) {
        val current = open ?: return


        if (shell.failedAction != null) { keep(null); inFlight = null; return }
        shell.perform { runtime ->
            val close = runtime.menuRead("captureModalDiscard", JSONObject().put("params", current.params).toString()).getJSONObject("close")
            shell.ui { if (open?.session == current.session) end(close, leave) }
        }
    }


    private fun send(action: FailedAction) = shell.perform(action) { runtime ->
        val request = action.patch["request"]!!
        val reply = try {
            if (action.kind == "captureModal") runtime.submitCaptureModal(request) else runtime.submitCaptureModalLines(request)
        } catch (failure: Exception) {


            if (failure.message?.startsWith("ACTION_FAILED") == true) {
                shell.acknowledged(action)
                shell.ui { failed(refused = true) }
                return@perform
            }
            val refused = UPDATE_REFUSALS.any { failure.message?.startsWith(it) == true }

            if (refused) shell.acknowledged(action)
            shell.ui { failed(refused) }
            throw failure
        }
        shell.acknowledged(action)
        shell.ui { answered(reply) }
    }


    private fun failed(refused: Boolean) {
        val current = open?.drafted("failed", true) ?: return
        keep(if (refused) current.copy(pending = null, captureId = UUID.randomUUID().toString(), confirm = null, lineIds = emptyList()) else current.copy(confirm = null))
    }


    private fun answered(reply: JSONObject) {
        val current = open ?: return
        val fresh = current.copy(pending = null, captureId = UUID.randomUUID().toString(), confirm = null, lineIds = emptyList())
        when (reply.getString("kind")) {


            "saved" -> when (reply.optString("next")) {
                "openInProject" -> {
                    keep(null)
                    reopenProjectWithTask(reply.getString("projectId"), reply.getString("taskId"))
                }
                "open" -> {
                    keep(null)
                    shell.openSavedTask(reply.getString("taskId"), reply.menuText("projectId"))
                }
                else -> end(reply.getJSONObject("close"))
            }
            "refused" -> {
                reply.getJSONObject("notice").let { shell.showToast(it) }
                keep(fresh)
            }
            "confirmLines" -> keep(fresh.copy(confirm = reply.getJSONObject("confirm"), lineIds = List(reply.getInt("lineCount")) { UUID.randomUUID().toString() }))
            else -> keep(fresh)
        }
    }


    private fun reopenProjectWithTask(projectId: String, taskId: String) {
        shell.menu.whenIdle {
            shell.openProject(projectId)
            shell.menu.whenIdle { shell.openEditor(taskId, "task") }
        }
    }


    private fun end(close: JSONObject, leave: Boolean = true) {
        keep(null)
        inFlight = null

        close.menuText("returnToProjectId")?.let { id -> shell.menu.whenIdle { shell.openProject(id) } }
        if (leave && close.getBoolean("returnToPreviousApp")) shell.leaveApp = true
    }
}
