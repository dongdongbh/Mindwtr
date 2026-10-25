package tech.dongdongbh.mindwtr.pilot

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaPlayer
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.io.File
import java.util.UUID

/*
 * RN's attachments on core's contract (native-host-contract-attachments.ts): the task editor's Attachments field
 * (TaskEditContentField.tsx, use-task-edit-attachments.ts), its link sheet, image preview and audio player
 * (TaskEditOverlayModals.tsx), and the project screen's Attachments card (ProjectDetailModal.tsx, use-project-attachments.ts).
 * Kotlin does the platform IO only: the pickers, opening a file or a link, the share sheet, the preview and the player. Every
 * row, rule, message and write is core's. A task's commands answer the editor's next draft list (saved with the draft); a
 * project's write at once through receipts and hold their exact retry on the shell's command path.
 */

/** host-entry.ts's attachment commands (MENU_COMMANDS, a project's, journaled); only this file sends them. */
val ATTACHMENT_KINDS = setOf("attachmentAddFile", "attachmentLinks", "attachmentRemove")
/** The same commands on a task draft (host-entry.ts ATTACHMENT_REQUESTS): they write nothing, so they are never journaled. */
private val DRAFT_REQUESTS = mapOf("attachmentAddFile" to "draftAddFile", "attachmentLinks" to "draftLinks", "attachmentRemove" to "draftRemove")

/** RN's FileProvider authority for the files it opens and shares (expo-file-system's FileSystemFileProvider). */
fun attachmentAuthority(context: Context) = "${context.packageName}.FileSystemFileProvider"

/** This app's FileProvider for files/attachments/ (res/xml/attachment_paths.xml); its own class, as a manifest names each provider once. */
class AttachmentFileProvider : FileProvider()

/** One row as core lists it (getAttachmentList): its title, Missing or Download, Loading, a link's edit text, a project's transfer. */
data class AttachmentRowView(
    val id: String, val kind: String, val title: String, val missing: Boolean, val canDownload: Boolean, val downloading: Boolean,
    val editText: String?, val progress: Boolean, val percentage: Int?,
) {
    companion object {
        fun list(json: JSONObject) = json.menuObjects("rows").map { row ->
            val progress = row.optJSONObject("progress")
            AttachmentRowView(row.getString("id"), row.getString("kind"), row.getString("title"), row.getBoolean("missing"),
                row.getBoolean("canDownload"), row.getBoolean("downloading"), row.menuText("editText"), progress != null,
                progress?.takeUnless { it.isNull("percentage") }?.getInt("percentage"))
        }
    }
}

/** A task draft command's answer [reply] for the list [sent] is stale when the draft now holds [now] instead: send it again. */
internal fun draftMoved(sent: String, now: String, reply: JSONObject): Boolean = reply.optString("kind") == "saved" && sent != now

/**
 * The editor closes on a Discard ([settle]): its draft's copies are settled, except while a save is owed (its new copies are that
 * save's, settled when it lands), before the attachments were read, or in a read-only editor.
 */
internal fun discardSettles(settle: Boolean, saveOwed: Boolean, attachmentsRead: Boolean, readOnly: Boolean) =
    settle && !saveOwed && attachmentsRead && !readOnly

/**
 * A Save's settlement: [half] is the save's attachments (`base`, `value`), [saved] getTaskView after it. `committed` is the list the
 * Save wrote (its merge with a sync that landed meanwhile), never the draft, as RN's Save hands its cleanup (0b62f4725).
 */
internal fun savedSettlement(taskId: String, half: JSONObject, saved: JSONObject): JSONObject =
    JSONObject().put("taskId", taskId).put("taskRevision", saved.getString("taskRevision"))
        .put("baseline", half.getJSONArray("base")).put("draft", half.getJSONArray("value")).put("committed", saved.getJSONArray("attachmentsBase"))

/** Whose attachments: the open editor's draft (a task), or a project's stored list. */
data class AttachmentOwner(val kind: String, val id: String)

/**
 * RN's link sheet: whose list, the text as typed, whether Save was pressed on blank text, the link being edited (its ID and its
 * title and uri as the sheet opened, a task's only), core's line check, and the Save's request UUID (a retry sends it again).
 */
data class LinkSheet(
    val owner: AttachmentOwner, val text: String = "", val touched: Boolean = false, val editing: JSONObject? = null,
    val error: String? = null, val requestId: String = UUID.randomUUID().toString(),
)

/** RN's task link field marks itself touched when it loses focus, so a blank one shows "Required"; RN's project sheet has no such line. */
internal fun LinkSheet.blurred(): LinkSheet = if (owner.kind == "task") copy(touched = true) else this

/** What an Open showed: RN's image preview or audio player, with the title and the local file URI. */
data class AttachmentView(val kind: String, val title: String, val uri: String)

class AttachmentsModel(private val shell: InboxViewModel) {
    /** The editor's rows for its draft list, and the project card's rows for [projectId]. */
    var editorRows by mutableStateOf<List<AttachmentRowView>>(emptyList()); private set
    var projectRows by mutableStateOf<List<AttachmentRowView>>(emptyList()); private set
    var projectCanEdit by mutableStateOf(false); private set
    var projectId by mutableStateOf<String?>(null); private set
    /** Attachments with a Download or Open in flight (core's `downloading`): their rows show Loading. */
    var downloading by mutableStateOf<Set<String>>(emptySet()); private set
    /** RN's Alert under the Attachments title: core's message. */
    var alert by mutableStateOf<String?>(null); private set
    var link by mutableStateOf<LinkSheet?>(null); private set
    var view by mutableStateOf<AttachmentView?>(null); private set
    /** An open plan (a link or a file) for the screen to start with its Activity, then cleared. */
    var launch by mutableStateOf<JSONObject?>(null); private set

    private fun ownerJson(owner: AttachmentOwner): JSONObject = if (owner.kind == "task") {
        val editor = shell.editor?.takeIf { it.id == owner.id } ?: throw IllegalStateException("The editor closed")
        JSONObject().put("kind", "task").put("taskId", owner.id).put("attachments", JSONArray(editor.attachmentsNow))
    } else JSONObject().put("kind", "project").put("projectId", owner.id)

    // ---- Rows ----

    /** Core's rows for the open editor's draft list, in the background. */
    fun readEditor() {
        val editor = shell.editor?.takeIf { !it.readOnly } ?: return
        val list = editor.attachmentsNow
        val input = JSONObject().put("owner", ownerJson(AttachmentOwner("task", editor.id))).put("downloading", JSONArray(downloading.toList()))
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentList", input.toString()) }) { reply, _ ->
            if (shell.editor?.id == editor.id && shell.editor?.attachmentsNow == list) editorRows = AttachmentRowView.list(reply)
        }
    }

    /** Core's rows for project [id] (its transfer progress included), in the background. */
    fun readProject(id: String) {
        val input = JSONObject().put("owner", ownerJson(AttachmentOwner("project", id))).put("downloading", JSONArray(downloading.toList()))
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentList", input.toString()) }) { reply, _ ->
            if (shell.openProjectId != id) return@background
            projectId = id
            projectRows = AttachmentRowView.list(reply)
            projectCanEdit = reply.getBoolean("canEdit")
        }
    }

    // ---- Commands: Add file, Add photo, the link sheet's Save, Remove ----

    /** Add file (`file`) or Add photo (`image`) with the picked document [uri]: core validates it and copies it in. */
    fun addPicked(owner: AttachmentOwner, source: String, uri: Uri) {
        val requestId = UUID.randomUUID().toString()
        // The picker's metadata (RN's asset: name, mimeType, size), read with the copy, off the main thread.
        command(owner, "attachmentAddFile", requestId) { context ->
            JSONObject().put("requestId", requestId).put("source", source).put("picked", picked(context, uri))
        }
    }

    fun openLink(owner: AttachmentOwner, editing: String? = null) {
        val record = editing?.let { id -> shell.editor?.attachmentsNow?.let(::JSONArray)?.let { list ->
            (0 until list.length()).map(list::getJSONObject).firstOrNull { it.getString("id") == id } } }
        link = LinkSheet(owner, text = editorRows.firstOrNull { it.id == editing }?.editText.orEmpty(),
            editing = record?.let { JSONObject().put("attachmentId", it.getString("id")).put("title", it.optString("title")).put("uri", it.optString("uri")) })
    }

    fun typeLink(text: String) {
        val sheet = link ?: return
        link = sheet.copy(text = text)
        // RN's sheet checks the lines while typing (the first line that is not a link); core says which.
        val input = JSONObject().put("text", text).put("editing", sheet.editing != null)
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentLinkCheck", input.toString()) }) { reply, _ ->
            link?.takeIf { it.text == text }?.let { link = it.copy(error = reply.menuText("error")) }
        }
    }

    /** The link field lost focus ([blurred]). */
    fun blurLink() { link = link?.blurred() }

    fun closeLink() { link = null }

    fun saveLink() {
        val sheet = link ?: return
        command(sheet.owner, "attachmentLinks", sheet.requestId) {
            JSONObject().put("requestId", sheet.requestId).put("text", sheet.text).apply { sheet.editing?.let { put("editing", it) } }
        }
    }

    fun remove(owner: AttachmentOwner, attachmentId: String) {
        val requestId = UUID.randomUUID().toString()
        command(owner, "attachmentRemove", requestId) { JSONObject().put("requestId", requestId).put("attachmentId", attachmentId) }
    }

    /**
     * One attachment command. A task's writes nothing (its answer is the draft's next list); a project's is written at once,
     * with its exact request held for the retry (the banner's Try again sends it again: [retry]).
     */
    private fun command(owner: AttachmentOwner, kind: String, requestId: String, build: (Context) -> JSONObject) {
        val context = shell.getApplication<android.app.Application>()
        if (owner.kind == "task") {
            sendDraft(owner, kind, shell.editor?.takeIf { it.id == owner.id }?.attachmentsNow ?: return) { build(context) }
            return
        }
        // A project's: built first (the picked document's metadata), then sent as an exact request.
        Thread({
            val input = runCatching { build(context).put("owner", ownerJson(owner)) }.getOrElse { failure ->
                Log.w(CoreHost.TAG, "${attachmentLaunchLog("command", null, failure)} kind=$kind")
                shell.ui { alert = failure.message }
                return@Thread
            }
            shell.ui { send(FailedAction(kind, requestId, input.toString())) }
        }, "mindwtr-attachment-input").start()
    }

    /**
     * A task draft's command on the draft list [list]. Its answer applies only while the draft still holds that list; one that
     * moved meanwhile (a download's update landed) is sent again on the draft as it is now, with the same request UUID, so core
     * answers it target-state and a download's local fields are never dropped.
     */
    private fun sendDraft(owner: AttachmentOwner, kind: String, list: String, build: () -> JSONObject) {
        val draftOwner = JSONObject().put("kind", "task").put("taskId", owner.id).put("attachments", JSONArray(list))
        shell.perform { runtime ->
            val reply = runtime.attachmentRequest(DRAFT_REQUESTS.getValue(kind), build().put("owner", draftOwner).toString())
            shell.ui {
                val now = shell.editor?.takeIf { it.id == owner.id }?.attachmentsNow ?: return@ui
                // Posted once more, so it starts after this action's end frees the shell.
                if (draftMoved(list, now, reply)) shell.ui { sendDraft(owner, kind, now, build) } else answered(owner, kind, reply)
            }
        }
    }

    /** A project's command with [action]'s exact request (its id is the request UUID, its title core's input). */
    private fun send(action: FailedAction) = shell.perform(action) { runtime ->
        val reply = runtime.menuCommand(action.kind, action.title)
        shell.acknowledged(action)
        shell.ui { answered(AttachmentOwner("project", JSONObject(action.title).getJSONObject("owner").getString("projectId")), action.kind, reply) }
    }

    /** The failure banner's Try again for an owed project command. */
    fun retry(action: FailedAction) = send(action)

    /** Core's answer on screen: a refusal's message, the blank link field, the draft's next list, the sheet closing. */
    private fun answered(owner: AttachmentOwner, kind: String, reply: JSONObject) {
        when (reply.getString("kind")) {
            "refused" -> alert = reply.getString("message")
            "empty" -> link = link?.copy(touched = true)
            "nothing" -> Unit
            "blocked" -> if (kind == "attachmentLinks") link = null
            "saved" -> {
                if (kind == "attachmentLinks") link = null
                if (owner.kind == "task") reply.optJSONArray("attachments")?.let { shell.setDraftAttachments(owner.id, it.toString()) }
                else readProject(owner.id)
            }
        }
    }

    // ---- Download and Open: long calls off the engine (CoreHost.attachmentRequest) ----

    /** Download, or its retry: a synced file's bytes. */
    fun download(owner: AttachmentOwner, attachmentId: String) = fetch(owner, attachmentId, open = false)

    /** Open: the bytes first (downloading a synced file), then core's open plan. */
    fun open(owner: AttachmentOwner, attachmentId: String) = fetch(owner, attachmentId, open = true)

    private fun fetch(owner: AttachmentOwner, attachmentId: String, open: Boolean) {
        val runtime = shell.coreHost() ?: return
        if (attachmentId in downloading) return
        val input = runCatching { JSONObject().put("owner", ownerJson(owner)).put("attachmentId", attachmentId) }.getOrNull() ?: return
        downloading = downloading + attachmentId
        if (owner.kind == "task") readEditor() else readProject(owner.id)
        Thread({
            val result = runCatching { runtime.attachmentRequest(if (open) "openAttachment" else "downloadAttachment", input.toString()) }
            // A task's change goes onto the draft as it is when the answer lands (core's applyAttachmentUpdate drops a stale one).
            val update = result.getOrNull()?.optJSONObject("update")
            shell.ui {
                downloading = downloading - attachmentId
                result.onFailure { failure ->
                    Log.w(CoreHost.TAG, "Attachment ${if (open) "open" else "download"} failed code=${attachmentCodeForLog(failure.message)}")
                    alert = failure.message.orEmpty().substringAfter(": ")
                }
                result.onSuccess { reply ->
                    reply.menuText("message")?.let { alert = it }
                    if (open) reply.optJSONObject("open")?.let(::show)
                }
                if (update != null && owner.kind == "task") applyUpdate(owner.id, update) else if (owner.kind == "task") readEditor() else readProject(owner.id)
            }
        }, "mindwtr-attachment").start()
    }

    /** A task download's change onto the draft list as it is now; one that changed meanwhile is asked again with the new list. */
    private fun applyUpdate(taskId: String, update: JSONObject) {
        val list = shell.editor?.takeIf { it.id == taskId }?.attachmentsNow ?: return
        val input = JSONObject().put("attachments", JSONArray(list)).put("update", update)
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentUpdate", input.toString()) }) { reply, _ ->
            val now = shell.editor?.takeIf { it.id == taskId } ?: return@background
            if (now.attachmentsNow != list) return@background applyUpdate(taskId, update)
            val next = reply.getJSONArray("attachments").toString()
            if (next != list) shell.setDraftAttachments(taskId, next) else readEditor()
        }
    }

    /** Core's open plan: an alert, a link, the audio player, the image preview, or a file for Android's viewer. */
    private fun show(plan: JSONObject) {
        when (plan.getString("kind")) {
            "alert" -> alert = plan.getString("message")
            "audio", "image" -> plan.getJSONObject("attachment").let { view = AttachmentView(plan.getString("kind"), it.optString("title"), it.getString("uri")) }
            else -> launch = plan
        }
    }

    fun launched() { launch = null }
    fun showAlert(message: String) { alert = message }
    fun dismissAlert() { alert = null }
    fun closeView() { view = null }

    // ---- The editor's draft settlement (RN's settleDraftAttachments) ----

    /** After a Discard: the copies the draft added and no record keeps go. Best effort, off every caller's thread. */
    fun settle(taskId: String, taskRevision: String, baseline: String, draft: String, committed: String) {
        val runtime = shell.coreHost() ?: return
        val input = JSONObject().put("taskId", taskId).put("taskRevision", taskRevision).put("baseline", JSONArray(baseline))
            .put("draft", JSONArray(draft)).put("committed", JSONArray(committed))
        Thread({ settleOn(runtime, input) }, "mindwtr-attachment-settle").start()
    }

    /** After a Save that carried attachments ([half]: its base and value), on the save's thread: settled against what was saved. */
    fun settleSaved(runtime: CoreHost, taskId: String, half: JSONObject) {
        runCatching {
            val saved = runtime.taskView(JSONObject().put("id", taskId).put("limit", 1).toString())
            settleOn(runtime, savedSettlement(taskId, half, saved))
        }.onFailure { Log.w(CoreHost.TAG, "Attachment settlement not read code=${attachmentCodeForLog(it.message)}") }
    }

    private fun settleOn(runtime: CoreHost, input: JSONObject) {
        runCatching { runtime.attachmentRequest("settleTaskDraftAttachments", input.toString()) }
            .onSuccess { Log.i(CoreHost.TAG, "Native Android attachment settlement deleted=${it.optInt("deleted")}") }
            .onFailure { Log.w(CoreHost.TAG, "Native Android attachment settlement failed code=${attachmentCodeForLog(it.message)}") }
    }

    /** The editor closed: its rows, sheet and player go. */
    fun closed() {
        editorRows = emptyList()
        if (link?.owner?.kind == "task") link = null
        view = null
    }

    companion object {
        /** What RN's pickers hand back for a document (DocumentPicker's asset, ImagePicker's): its name, type and size, or null. */
        fun picked(context: Context, uri: Uri): JSONObject {
            val resolver = context.contentResolver
            var name: String? = null
            var size: Long? = null
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
                if (row.moveToFirst()) {
                    if (!row.isNull(0)) name = row.getString(0)
                    if (!row.isNull(1)) size = row.getLong(1)
                }
            }
            return JSONObject().put("uri", uri.toString()).put("name", name ?: JSONObject.NULL)
                .put("mimeType", resolver.getType(uri) ?: JSONObject.NULL).put("size", size ?: JSONObject.NULL)
        }
    }
}

/**
 * A URI as a log line names it, as core's describeAttachmentUriForLog does: its scheme, managed (under files/attachments/) or
 * external, and its extension. Never the URI itself: a link can carry a user name, a password or a token.
 */
internal fun attachmentUriForLog(uri: String?): String {
    if (uri.isNullOrEmpty()) return "none"
    val scheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:").find(uri)?.value.orEmpty()
    val path = uri.substringBefore('?').substringBefore('#')
    val managed = scheme == "file:" && "/files/attachments/" in path
    val extension = Regex("\\.[A-Za-z0-9]{1,8}$").find(path.substringAfterLast('/'))?.value.orEmpty().lowercase()
    return "$scheme${if (managed) "managed" else "external"}${if (managed) extension else ""}"
}

/** Core's error code at the head of a failure's text ("STALE_REVISION: …"), or "other": never the rest of the text. */
internal fun attachmentCodeForLog(message: String?): String =
    message?.substringBefore(':')?.trim()?.takeIf { Regex("[A-Z][A-Z0-9_]{1,40}").matches(it) } ?: "other"

/**
 * A failure as a log line holds it on a path that can carry a URI (attachments, links, sync, the shared log): its class and core's
 * code, never its message or stack, which can hold a URI with a user name, a password or a token.
 */
internal fun failureForLog(failure: Throwable): String = "error=${failure.javaClass.simpleName} code=${attachmentCodeForLog(failure.message)}"

/** A failed launch's log line: the event, the URI as [attachmentUriForLog] names it, and the failure's class. Never its message, which
 * Android 7 fills with the Intent's URI. */
internal fun attachmentLaunchLog(kind: String, uri: String?, failure: Throwable): String {
    val event = when (kind) {
        "link" -> "Attachment link not opened"
        "viewer" -> "Attachment viewer not started"
        "share" -> "Attachment share sheet not started"
        "audio" -> "Audio attachment not loaded"
        "command" -> "Attachment command not sent"
        else -> "Attachment URI not opened"
    }
    return "$event uri=${attachmentUriForLog(uri)} error=${failure.javaClass.simpleName}"
}

/**
 * Core's open plan for a link or a file, started with [context] (an Activity). A file goes to Android's viewer (ACTION_VIEW on
 * the FileProvider URI with core's view type), else the share sheet, else its URI, as RN's open-file-externally and its
 * fallbacks do. A link nothing opens offers Copy link (RN's openExternalLink).
 */
fun startAttachmentPlan(context: Context, plan: JSONObject, t: (String) -> String, diagnostic: (String) -> Unit) {
    if (plan.getString("kind") == "link") {
        // RN's attachment hooks open a link with openExternalLink: when nothing opens it, its alert offers Copy link.
        val uri = plan.getString("uri")
        openExternalLink(context, uri, t, { failure -> Log.w(CoreHost.TAG, attachmentLaunchLog("link", uri, failure)) }, diagnostic)
        return
    }
    val raw = plan.getString("uri")
    val shared = runCatching { contentUri(context, raw) }.getOrNull()
    if (shared != null) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(shared, plan.getString("viewMimeType")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            return
        } catch (_: ActivityNotFoundException) {
            // No viewer for the type: the share sheet is still a way out.
        } catch (failure: Exception) {
            Log.w(CoreHost.TAG, attachmentLaunchLog("viewer", raw, failure))
        }
        try {
            context.startActivity(shareIntent(shared, plan.menuText("mimeType")))
            return
        } catch (failure: Exception) {
            Log.w(CoreHost.TAG, attachmentLaunchLog("share", raw, failure))
        }
    }
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw))) }.onFailure { Log.w(CoreHost.TAG, attachmentLaunchLog("uri", raw, it)) }
}

/** A local attachment's URI another app may read: files/attachments/ through the FileProvider; a picked `content://` as it is. */
private fun contentUri(context: Context, uri: String): Uri =
    if (uri.startsWith("content://")) Uri.parse(uri)
    else FileProvider.getUriForFile(context, attachmentAuthority(context), File(requireNotNull(Uri.parse(uri).path)))

private fun shareIntent(uri: Uri, mimeType: String?): Intent = Intent.createChooser(
    Intent(Intent.ACTION_SEND).setType(mimeType ?: "*/*").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null)

// ---- Screens ----

/** RN's attachment button (attachmentButton): the icon and the label in the tint, one third of the row. */
@Composable
private fun AttachmentButton(icon: ImageVector, label: String, enabled: Boolean, modifier: Modifier, tag: String, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(8.dp)
    Row(modifier.fade(if (enabled) 1f else 0.5f).heightIn(min = 44.dp).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .clickable(enabled = enabled, role = Role.Button, onClick = onClick).testTag(tag).padding(horizontal = 8.dp, vertical = 9.dp),
        horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = c.tint, modifier = Modifier.size(16.dp))
        Text(label, style = rnText(12, 700), color = c.tint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 5.dp))
    }
}

/**
 * RN's attachments field (TaskEditContentField's `attachments`): Add file, Add photo and Add link, then "None" or core's rows,
 * each with its title (opens it), Loading, Download or Missing, a link's pencil, and Remove.
 */
@Composable
fun EditorAttachments(model: InboxViewModel, editor: TaskEditor, locked: Boolean) = with(model.attachments) {
    val c = LocalTheme.current.colors
    val owner = AttachmentOwner("task", editor.id)
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { addPicked(owner, "file", it) } }
    // RN's image picker is the system photo picker on Android; the camera stays out, as in RN.
    val pickImage = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> uri?.let { addPicked(owner, "image", it) } }
    LaunchedEffect(editor.id, editor.attachmentsNow, downloading, model.busy) { if (!model.busy) readEditor() }
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        AttachmentButton(Ionicons.DocumentAttachOutline, t("attachments.addFile"), !locked, Modifier.weight(1f), "attachment-add-file") { pickFile.launch(arrayOf("*/*")) }
        AttachmentButton(Ionicons.ImageOutline, t("attachments.addPhoto"), !locked, Modifier.weight(1f), "attachment-add-photo") {
            pickImage.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
        AttachmentButton(Ionicons.LinkOutline, t("attachments.addLink"), !locked, Modifier.weight(1f), "attachment-add-link") { openLink(owner) }
    }
    if (editorRows.isEmpty()) Text(t("common.none"), style = rnText(13, 400), color = c.secondaryText, modifier = Modifier.padding(top = 6.dp))
    // RN's Download is never disabled, as the project card's (it only fetches the bytes).
    else AttachmentList(editorRows, true, open = { open(owner, it) }, download = { download(owner, it) }) { row ->
        if (row.kind == "link") RowIcon(Lucide.Pencil, t("common.edit"), !locked) { openLink(owner, row.id) }
        RowIcon(Lucide.Trash2, t("attachments.remove"), !locked) { remove(owner, row.id) }
    }
}

/** RN's attachments list (attachmentsList and its rows): [actions] draws each row's buttons at its end. */
@Composable
private fun AttachmentList(rows: List<AttachmentRowView>, enabled: Boolean, open: (String) -> Unit, download: (String) -> Unit, top: Int = 8,
                           actions: @Composable (AttachmentRowView) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(top = top.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)) {
        for (row in rows) {
            Row(Modifier.fillMaxWidth().hairline(c.border, top = false).padding(horizontal = 12.dp, vertical = 10.dp).testTag("attachment-row"),
                verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 10.dp).clickable(enabled = !row.downloading, role = Role.Button) { open(row.id) }
                    .semantics { contentDescription = row.title; if (row.downloading) disabled() }) {
                    Text(row.title, style = rnText(13, 600), color = c.tint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    // A project row's transfer (RN's AttachmentProgressIndicator).
                    if (row.progress) LinearProgressIndicator(progress = { (row.percentage ?: 0) / 100f }, color = c.tint, trackColor = c.border,
                        modifier = Modifier.padding(top = 4.dp).fillMaxWidth().height(3.dp))
                }
                when {
                    row.downloading -> Text(t("common.loading"), style = rnText(12, 500), color = c.secondaryText, modifier = Modifier.padding(end = 10.dp))
                    row.canDownload -> Text(t("attachments.download"), style = rnText(12, 600), color = c.tint, modifier = Modifier.padding(end = 10.dp)
                        .clickable(enabled = enabled, role = Role.Button) { download(row.id) })
                    row.missing -> Text(t("attachments.missing"), style = rnText(12, 500), color = c.secondaryText, modifier = Modifier.padding(end = 10.dp))
                }
                actions(row)
            }
        }
    }
}

/** RN's row action (the pencil, the trash): a 14 glyph in the tint with an 8 hit slop. */
@Composable
private fun RowIcon(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.size(30.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = c.tint, modifier = Modifier.size(14.dp).fade(0.85f))
    }
}

/**
 * RN's project Attachments block inside the project's Details (ProjectDetailModal's attachmentsContainer): the title with Add file
 * and Add link, and core's rows with Remove. An archived project takes no edit (its buttons are off).
 */
@Composable
fun ProjectAttachments(model: InboxViewModel, projectId: String) = with(model.attachments) {
    val c = LocalTheme.current.colors
    val owner = AttachmentOwner("project", projectId)
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { addPicked(owner, "file", it) } }
    LaunchedEffect(projectId, model.busy, downloading) { if (!model.busy) readProject(projectId) }
    // A transfer's progress: read again while one runs.
    LaunchedEffect(projectId, downloading) { while (downloading.isNotEmpty()) { delay(500); readProject(projectId) } }
    val rows = if (this.projectId == projectId) projectRows else emptyList()
    val canEdit = this.projectId == projectId && projectCanEdit && !model.busy
    Column(Modifier.fillMaxWidth().background(c.cardBg).hairline(c.border, top = false).testTag("project-details-attachments")
        .padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(t("attachments.title"), style = rnText(14, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            SmallButton(t("attachments.addFile"), canEdit, "project-attachment-add-file") { pickFile.launch(arrayOf("*/*")) }
            Spacer(Modifier.width(8.dp))
            SmallButton(t("attachments.addLink"), canEdit, "project-attachment-add-link") { openLink(owner) }
        }
        if (rows.isNotEmpty()) AttachmentList(rows, true, open = { open(owner, it) }, download = { download(owner, it) }, top = 10) { row ->
            Text(t("attachments.remove"), style = rnText(12, 700), color = c.secondaryText, modifier = Modifier.fade(if (canEdit) 1f else 0.5f)
                .clickable(enabled = canEdit, role = Role.Button) { remove(owner, row.id) })
        }
    }
}

/**
 * The attachments' overlays on the screen that shows them: RN's Alert, the link sheet, the image preview and the audio player,
 * and an open plan started with this screen's Activity.
 */
@Composable
fun AttachmentOverlays(model: InboxViewModel) = with(model.attachments) {
    val context = LocalContext.current
    LaunchedEffect(launch) { launch?.let { plan -> launched(); startAttachmentPlan(context, plan, ::t) { outcome -> model.anyTime({ it.logLinkHandoff(outcome, "attachment") }, {}) } } }
    alert?.let { message ->
        AlertDialog(onDismissRequest = ::dismissAlert, title = { Text(t("attachments.title")) }, text = { Text(message) },
            confirmButton = { TextButton(onClick = ::dismissAlert) { Text(t("common.ok")) } })
    }
    link?.let { LinkSheetDialog(model, it) }
    view?.let { shown -> if (shown.kind == "image") ImagePreview(model, shown) else AudioPlayer(model, shown) }
}

/** RN's link sheet (TaskEditLinkModal, ProjectLinkModal): the field, its hint, core's line check, Cancel and Save. */
@Composable
private fun LinkSheetDialog(model: InboxViewModel, sheet: LinkSheet) = with(model.attachments) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler(onBack = ::closeLink)
    val multiline = sheet.editing == null
    var focused by remember { mutableStateOf(false) }
    // Drawn over the screens, outside their semantics roots: its tags are resource IDs on their own (the device check finds them).
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).imePadding().padding(20.dp).semantics { testTagsAsResourceId = true }
        .testTag("attachment-link-sheet"), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp)) {
            val title = t(if (sheet.editing != null) "common.edit" else "attachments.addLink")
            Text(title, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                val fieldShape = RoundedCornerShape(10.dp)
                BasicTextField(sheet.text, ::typeLink, singleLine = !multiline, textStyle = rnText(16, 400).copy(color = c.text), cursorBrush = SolidColor(c.tint),
                    modifier = Modifier.fillMaxWidth().then(if (multiline) Modifier.height(120.dp) else Modifier)
                        .onFocusChanged { state -> if (state.isFocused) focused = true else if (focused) blurLink() }.clip(fieldShape).background(c.inputBg)
                        .rnBorder(1.dp, c.border, fieldShape).testTag("attachment-link-input").semantics { contentDescription = t("attachments.addLink") },
                    decorationBox = { inner ->
                        Box(Modifier.padding(12.dp)) {
                            if (sheet.text.isEmpty()) Text(t("attachments.linkPlaceholder"), style = rnText(16, 400), color = c.secondaryText)
                            inner()
                        }
                    })
                Text(t(if (multiline) "attachments.linkBatchHint" else "attachments.linkInputHint"), style = rnText(12, 400), color = c.secondaryText,
                    modifier = Modifier.padding(top = 8.dp))
                if (sheet.touched && sheet.text.isBlank()) Text(t("common.validationRequired"), style = rnText(12, 600), color = c.danger, modifier = Modifier.padding(top = 6.dp))
                sheet.error?.let { Text(it, style = rnText(12, 600), color = c.danger, modifier = Modifier.padding(top = 6.dp)) }
            }
            val canSave = sheet.text.isNotBlank() && sheet.error == null && !model.busy
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.End) {
                Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = ::closeLink).padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(t("common.cancel"), style = rnText(14, 700), color = c.secondaryText)
                }
                Box(Modifier.heightIn(min = 44.dp).clickable(enabled = canSave, role = Role.Button, onClick = ::saveLink).testTag("attachment-link-save")
                    .padding(horizontal = 10.dp), contentAlignment = Alignment.Center) {
                    Text(t("common.save"), style = rnText(14, 700), color = c.tint, modifier = Modifier.fade(if (canSave) 1f else 0.5f))
                }
            }
        }
    }
}

/** RN's image preview (TaskEditImagePreviewModal): the title, Share, Close, and the image fitted, decoded off the main thread. */
@Composable
private fun ImagePreview(model: InboxViewModel, shown: AttachmentView) = with(model.attachments) {
    val theme = LocalTheme.current
    val c = theme.colors
    val context = LocalContext.current
    BackHandler(onBack = ::closeView)
    val image by produceState<Bitmap?>(null, shown.uri) { value = withContext(Dispatchers.IO) { decodeFitted(context, shown.uri, 2048) } }
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { closeView() } }.padding(16.dp)
        .testTag("attachment-image-preview"), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).pointerInput(Unit) { detectTapGestures { } }.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(shown.title.ifEmpty { t("attachments.title") }, style = rnText(16, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f))
                TextButton(onClick = {
                    // RN's shareFileWithFeedback: a share that cannot start says so under the Attachments title.
                    runCatching { context.startActivity(shareIntent(contentUri(context, shown.uri), null)) }
                        .onFailure { Log.w(CoreHost.TAG, attachmentLaunchLog("share", shown.uri, it)); showAlert(t("share.unavailable")) }
                }) { Text(t("common.share"), style = rnText(14, 700), color = c.tint) }
                TextButton(onClick = ::closeView) { Text(t("common.close"), style = rnText(14, 700), color = c.secondaryText) }
            }
            image?.let { Image(it.asImageBitmap(), shown.title, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().heightIn(max = 520.dp).padding(top = 8.dp)) }
        }
    }
}

/** [uri]'s image at most [max] pixels on its longer side, or null when it cannot be read. */
private fun decodeFitted(context: Context, uri: String, max: Int): Bitmap? = runCatching {
    val open = { context.contentResolver.openInputStream(if (uri.startsWith("content://")) Uri.parse(uri) else Uri.fromFile(File(requireNotNull(Uri.parse(uri).path)))) }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > max) sample *= 2
    open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
}.getOrNull()

/**
 * RN's audio player (TaskEditAudioModal): the title, the time, Play or Pause, and Close. Re-transcribe stays RN's: speech
 * transcription comes with the speech pass.
 */
@Composable
private fun AudioPlayer(model: InboxViewModel, shown: AttachmentView) = with(model.attachments) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler(onBack = ::closeView)
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableStateOf(0) }
    var duration by remember { mutableStateOf<Int?>(null) }
    val player = remember(shown.uri) {
        runCatching { MediaPlayer().apply { setDataSource(requireNotNull(Uri.parse(shown.uri).path)); prepare() } }
            .onFailure { Log.w(CoreHost.TAG, attachmentLaunchLog("audio", shown.uri, it)) }.getOrNull()
    }
    DisposableEffect(player) { onDispose { runCatching { player?.release() } } }
    LaunchedEffect(player) {
        if (player == null) { showAlert(t("quickAdd.audioErrorBody")); closeView(); return@LaunchedEffect }
        duration = player.duration
        player.setOnCompletionListener { playing = false }
        player.start()
        playing = true
        while (true) { position = runCatching { player.currentPosition }.getOrDefault(position); delay(500) }
    }
    Box(Modifier.fillMaxSize().background(theme.pickerScrim).pointerInput(Unit) { detectTapGestures { closeView() } }.padding(20.dp)
        .testTag("attachment-audio"), contentAlignment = Alignment.Center) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.widthIn(max = 420.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .pointerInput(Unit) { detectTapGestures { } }.padding(16.dp)) {
            Text(shown.title.ifEmpty { t("quickAdd.audioNoteTitle") }, style = rnText(16, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp))
            Text(duration?.let { "${clock(position)} / ${clock(it)}" } ?: t("audio.loading"), style = rnText(13, 600), color = c.secondaryText)
            Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.End) {
                TextButton(enabled = player != null, onClick = {
                    val p = player ?: return@TextButton
                    if (p.isPlaying) { p.pause(); playing = false } else { if (position >= (duration ?: 0) - 100) p.seekTo(0); p.start(); playing = true }
                }) { Text(t(if (playing) "common.pause" else "common.play"), style = rnText(14, 700), color = c.tint) }
                TextButton(onClick = ::closeView) { Text(t("common.close"), style = rnText(14, 700), color = c.secondaryText) }
            }
        }
    }
}

/** RN's formatAudioTimestamp: m:ss. */
private fun clock(ms: Int): String = (ms / 1000).let { "${it / 60}:${(it % 60).toString().padStart(2, '0')}" }

/** RN's View tab picture of an image attachment (viewAttachmentImage: full width, 90 high, cover), decoded off the main thread. */
@Composable
fun AttachmentThumbnail(uri: String, title: String) {
    val context = LocalContext.current
    val image by produceState<Bitmap?>(null, uri) { value = withContext(Dispatchers.IO) { decodeFitted(context, uri, 512) } }
    image?.let { Image(it.asImageBitmap(), title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(90.dp).clip(RoundedCornerShape(10.dp))) }
}
