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


val ATTACHMENT_KINDS = setOf("attachmentAddFile", "attachmentLinks", "attachmentRemove")

private val DRAFT_REQUESTS = mapOf("attachmentAddFile" to "draftAddFile", "attachmentLinks" to "draftLinks", "attachmentRemove" to "draftRemove")


fun attachmentAuthority(context: Context) = "${context.packageName}.FileSystemFileProvider"


class AttachmentFileProvider : FileProvider()


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


internal fun draftMoved(sent: String, now: String, reply: JSONObject): Boolean = reply.optString("kind") == "saved" && sent != now


internal fun discardSettles(settle: Boolean, saveOwed: Boolean, attachmentsRead: Boolean, readOnly: Boolean) =
    settle && !saveOwed && attachmentsRead && !readOnly


internal fun savedSettlement(taskId: String, half: JSONObject, saved: JSONObject): JSONObject =
    JSONObject().put("taskId", taskId).put("taskRevision", saved.getString("taskRevision"))
        .put("baseline", half.getJSONArray("base")).put("draft", half.getJSONArray("value")).put("committed", saved.getJSONArray("attachmentsBase"))


data class AttachmentOwner(val kind: String, val id: String)


data class LinkSheet(
    val owner: AttachmentOwner, val text: String = "", val touched: Boolean = false, val editing: JSONObject? = null,
    val error: String? = null, val requestId: String = UUID.randomUUID().toString(),
)


internal fun LinkSheet.blurred(): LinkSheet = if (owner.kind == "task") copy(touched = true) else this


data class AttachmentView(val kind: String, val title: String, val uri: String)

class AttachmentsModel(private val shell: InboxViewModel) {

    var editorRows by mutableStateOf<List<AttachmentRowView>>(emptyList()); private set
    var projectRows by mutableStateOf<List<AttachmentRowView>>(emptyList()); private set
    var projectCanEdit by mutableStateOf(false); private set
    var projectId by mutableStateOf<String?>(null); private set

    var downloading by mutableStateOf<Set<String>>(emptySet()); private set

    var alert by mutableStateOf<String?>(null); private set
    var link by mutableStateOf<LinkSheet?>(null); private set
    var view by mutableStateOf<AttachmentView?>(null); private set

    var launch by mutableStateOf<JSONObject?>(null); private set

    private fun ownerJson(owner: AttachmentOwner): JSONObject = if (owner.kind == "task") {
        val editor = shell.editor?.takeIf { it.id == owner.id } ?: throw IllegalStateException("The editor closed")
        JSONObject().put("kind", "task").put("taskId", owner.id).put("attachments", JSONArray(editor.attachmentsNow))
    } else JSONObject().put("kind", "project").put("projectId", owner.id)


    fun readEditor() {
        val editor = shell.editor?.takeIf { !it.readOnly } ?: return
        val list = editor.attachmentsNow
        val input = JSONObject().put("owner", ownerJson(AttachmentOwner("task", editor.id))).put("downloading", JSONArray(downloading.toList()))
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentList", input.toString()) }) { reply, _ ->
            if (shell.editor?.id == editor.id && shell.editor?.attachmentsNow == list) editorRows = AttachmentRowView.list(reply)
        }
    }


    fun readProject(id: String) {
        val input = JSONObject().put("owner", ownerJson(AttachmentOwner("project", id))).put("downloading", JSONArray(downloading.toList()))
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentList", input.toString()) }) { reply, _ ->
            if (shell.openProjectId != id) return@background
            projectId = id
            projectRows = AttachmentRowView.list(reply)
            projectCanEdit = reply.getBoolean("canEdit")
        }
    }


    fun addPicked(owner: AttachmentOwner, source: String, uri: Uri) {
        val requestId = UUID.randomUUID().toString()

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

        val input = JSONObject().put("text", text).put("editing", sheet.editing != null)
        shell.background(emptyList(), { runtime -> runtime.menuRead("attachmentLinkCheck", input.toString()) }) { reply, _ ->
            link?.takeIf { it.text == text }?.let { link = it.copy(error = reply.menuText("error")) }
        }
    }


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


    private fun command(owner: AttachmentOwner, kind: String, requestId: String, build: (Context) -> JSONObject) {
        val context = shell.getApplication<android.app.Application>()
        if (owner.kind == "task") {
            sendDraft(owner, kind, shell.editor?.takeIf { it.id == owner.id }?.attachmentsNow ?: return) { build(context) }
            return
        }

        Thread({
            val input = runCatching { build(context).put("owner", ownerJson(owner)) }.getOrElse { failure ->
                Log.w(CoreHost.TAG, "${attachmentLaunchLog("command", null, failure)} kind=$kind")
                shell.ui { alert = failure.message }
                return@Thread
            }
            shell.ui { send(FailedAction(kind, requestId, input.toString())) }
        }, "mindwtr-attachment-input").start()
    }


    private fun sendDraft(owner: AttachmentOwner, kind: String, list: String, build: () -> JSONObject) {
        val draftOwner = JSONObject().put("kind", "task").put("taskId", owner.id).put("attachments", JSONArray(list))
        shell.perform { runtime ->
            val reply = runtime.attachmentRequest(DRAFT_REQUESTS.getValue(kind), build().put("owner", draftOwner).toString())
            shell.ui {
                val now = shell.editor?.takeIf { it.id == owner.id }?.attachmentsNow ?: return@ui

                if (draftMoved(list, now, reply)) shell.ui { sendDraft(owner, kind, now, build) } else answered(owner, kind, reply)
            }
        }
    }


    private fun send(action: FailedAction) = shell.perform(action) { runtime ->
        val reply = runtime.menuCommand(action.kind, action.title)
        shell.acknowledged(action)
        shell.ui { answered(AttachmentOwner("project", JSONObject(action.title).getJSONObject("owner").getString("projectId")), action.kind, reply) }
    }


    fun retry(action: FailedAction) = send(action)


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


    fun download(owner: AttachmentOwner, attachmentId: String) = fetch(owner, attachmentId, open = false)


    fun open(owner: AttachmentOwner, attachmentId: String) = fetch(owner, attachmentId, open = true)

    private fun fetch(owner: AttachmentOwner, attachmentId: String, open: Boolean) {
        val runtime = shell.coreHost() ?: return
        if (attachmentId in downloading) return
        val input = runCatching { JSONObject().put("owner", ownerJson(owner)).put("attachmentId", attachmentId) }.getOrNull() ?: return
        downloading = downloading + attachmentId
        if (owner.kind == "task") readEditor() else readProject(owner.id)
        Thread({
            val result = runCatching { runtime.attachmentRequest(if (open) "openAttachment" else "downloadAttachment", input.toString()) }

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


    fun settle(taskId: String, taskRevision: String, baseline: String, draft: String, committed: String) {
        val runtime = shell.coreHost() ?: return
        val input = JSONObject().put("taskId", taskId).put("taskRevision", taskRevision).put("baseline", JSONArray(baseline))
            .put("draft", JSONArray(draft)).put("committed", JSONArray(committed))
        Thread({ settleOn(runtime, input) }, "mindwtr-attachment-settle").start()
    }


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


    fun closed() {
        editorRows = emptyList()
        if (link?.owner?.kind == "task") link = null
        view = null
    }

    companion object {

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


internal fun attachmentUriForLog(uri: String?): String {
    if (uri.isNullOrEmpty()) return "none"
    val scheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:").find(uri)?.value.orEmpty()
    val path = uri.substringBefore('?').substringBefore('#')
    val managed = scheme == "file:" && "/files/attachments/" in path
    val extension = Regex("\\.[A-Za-z0-9]{1,8}$").find(path.substringAfterLast('/'))?.value.orEmpty().lowercase()
    return "$scheme${if (managed) "managed" else "external"}${if (managed) extension else ""}"
}


internal fun attachmentCodeForLog(message: String?): String =
    message?.substringBefore(':')?.trim()?.takeIf { Regex("[A-Z][A-Z0-9_]{1,40}").matches(it) } ?: "other"


internal fun failureForLog(failure: Throwable): String = "error=${failure.javaClass.simpleName} code=${attachmentCodeForLog(failure.message)}"


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


fun startAttachmentPlan(context: Context, plan: JSONObject, t: (String) -> String, diagnostic: (String) -> Unit) {
    if (plan.getString("kind") == "link") {

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


private fun contentUri(context: Context, uri: String): Uri =
    if (uri.startsWith("content://")) Uri.parse(uri)
    else FileProvider.getUriForFile(context, attachmentAuthority(context), File(requireNotNull(Uri.parse(uri).path)))

private fun shareIntent(uri: Uri, mimeType: String?): Intent = Intent.createChooser(
    Intent(Intent.ACTION_SEND).setType(mimeType ?: "*/*").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null)


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


@Composable
fun EditorAttachments(model: InboxViewModel, editor: TaskEditor, locked: Boolean) = with(model.attachments) {
    val c = LocalTheme.current.colors
    val owner = AttachmentOwner("task", editor.id)
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { addPicked(owner, "file", it) } }

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

    else AttachmentList(editorRows, true, open = { open(owner, it) }, download = { download(owner, it) }) { row ->
        if (row.kind == "link") RowIcon(Lucide.Pencil, t("common.edit"), !locked) { openLink(owner, row.id) }
        RowIcon(Lucide.Trash2, t("attachments.remove"), !locked) { remove(owner, row.id) }
    }
}


@Composable
private fun AttachmentList(rows: List<AttachmentRowView>, enabled: Boolean, open: (String) -> Unit, download: (String) -> Unit, top: Int = 8,
                           actions: @Composable (AttachmentRowView) -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.padding(top = top.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)) {
        for (row in rows) {
            Row(Modifier.fillMaxWidth().rnBorderBottom(c.border).padding(horizontal = 12.dp, vertical = 10.dp).testTag("attachment-row"),
                verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 10.dp).clickable(enabled = !row.downloading, role = Role.Button) { open(row.id) }
                    .semantics { contentDescription = row.title; if (row.downloading) disabled() }) {
                    Text(row.title, style = rnText(13, 600), color = c.tint, maxLines = 1, overflow = TextOverflow.Ellipsis)

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


@Composable
private fun RowIcon(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    val c = LocalTheme.current.colors
    Box(Modifier.size(30.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = c.tint, modifier = Modifier.size(14.dp).fade(0.85f))
    }
}


@Composable
fun ProjectAttachments(model: InboxViewModel, projectId: String) = with(model.attachments) {
    val c = LocalTheme.current.colors
    val owner = AttachmentOwner("project", projectId)
    val pickFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let { addPicked(owner, "file", it) } }
    LaunchedEffect(projectId, model.busy, downloading) { if (!model.busy) readProject(projectId) }

    LaunchedEffect(projectId, downloading) { while (downloading.isNotEmpty()) { delay(500); readProject(projectId) } }
    val rows = if (this.projectId == projectId) projectRows else emptyList()
    val canEdit = this.projectId == projectId && projectCanEdit && !model.busy
    Column(Modifier.fillMaxWidth().background(c.cardBg).rnBorderBottom(c.border).testTag("project-details-attachments")
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


@Composable
private fun LinkSheetDialog(model: InboxViewModel, sheet: LinkSheet) = with(model.attachments) {
    val theme = LocalTheme.current
    val c = theme.colors
    BackHandler(onBack = ::closeLink)
    val multiline = sheet.editing == null
    var focused by remember { mutableStateOf(false) }

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

                    runCatching { context.startActivity(shareIntent(contentUri(context, shown.uri), null)) }
                        .onFailure { Log.w(CoreHost.TAG, attachmentLaunchLog("share", shown.uri, it)); showAlert(t("share.unavailable")) }
                }) { Text(t("common.share"), style = rnText(14, 700), color = c.tint) }
                TextButton(onClick = ::closeView) { Text(t("common.close"), style = rnText(14, 700), color = c.secondaryText) }
            }
            image?.let { Image(it.asImageBitmap(), shown.title, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxWidth().heightIn(max = 520.dp).padding(top = 8.dp)) }
        }
    }
}


private fun decodeFitted(context: Context, uri: String, max: Int): Bitmap? = runCatching {
    val open = { context.contentResolver.openInputStream(if (uri.startsWith("content://")) Uri.parse(uri) else Uri.fromFile(File(requireNotNull(Uri.parse(uri).path)))) }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / sample > max) sample *= 2
    open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
}.getOrNull()


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


private fun clock(ms: Int): String = (ms / 1000).let { "${it / 60}:${(it % 60).toString().padStart(2, '0')}" }


@Composable
fun AttachmentThumbnail(uri: String, title: String) {
    val context = LocalContext.current
    val image by produceState<Bitmap?>(null, uri) { value = withContext(Dispatchers.IO) { decodeFitted(context, uri, 512) } }
    image?.let { Image(it.asImageBitmap(), title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().height(90.dp).clip(RoundedCornerShape(10.dp))) }
}
