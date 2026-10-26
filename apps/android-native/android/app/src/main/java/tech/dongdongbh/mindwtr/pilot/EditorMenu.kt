package tech.dongdongbh.mindwtr.pilot

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** The editor menu's Menu command: its owed retry is EditorMenuModel.run, and core can refuse it before writing. */
val EDITOR_MENU_KINDS = setOf("taskEditorAction")

/** One row of RN's TaskEditHeader "..." menu; [danger] rows are drawn in RN's danger color. */
internal enum class EditorMenuAction(val danger: Boolean = false) {
    CopyLink, CopyId, Share, Duplicate, Promote, ConvertToAction, ConvertToSection, Skip, Cancel(danger = true), Delete(danger = true)
}

/**
 * RN's menu rows in RN's order (TaskEditHeader, its props from task-edit-modal.tsx): the copy rows for any saved task, then, unless
 * the editor is read-only, Share, Duplicate, Create project, Convert to action for a Reference draft, Convert to section for a draft
 * in a project, Skip when core says the occurrence can be skipped, Cancel when core says the task can be cancelled, and Delete.
 */
internal fun editorMenuActions(readOnly: Boolean, reference: Boolean, hasProject: Boolean, canSkip: Boolean, canCancel: Boolean): List<EditorMenuAction> =
    listOf(EditorMenuAction.CopyLink, EditorMenuAction.CopyId) + if (readOnly) emptyList() else listOfNotNull(
        EditorMenuAction.Share, EditorMenuAction.Duplicate, EditorMenuAction.Promote,
        EditorMenuAction.ConvertToAction.takeIf { reference }, EditorMenuAction.ConvertToSection.takeIf { hasProject },
        EditorMenuAction.Skip.takeIf { canSkip }, EditorMenuAction.Cancel.takeIf { canCancel }, EditorMenuAction.Delete,
    )

/**
 * RN's TaskEditHeader menu and its actions (use-task-edit-actions.ts). The writes are core's one journaled taskEditorAction
 * (runTaskEditorAction): a request UUID per tap, on disk before it is sent, so a lost answer is sent again and core answers it once.
 */
class EditorMenuModel(private val shell: InboxViewModel) {
    /** The menu card shows. */
    var open by mutableStateOf(false)
    /** RN's TaskProjectConversionModal for a task with a checklist: the project title being typed, while it shows. */
    var promoteTitle by mutableStateOf<String?>(null)
    /** Create project or Convert to section held for the editor's own Save (RN saves the draft first): the task, kind and title. */
    private var afterSave: Triple<String, String, String?>? = null

    internal fun choose(action: EditorMenuAction, context: Context) {
        open = false
        val editor = shell.editor ?: return
        when (action) {
            EditorMenuAction.CopyLink -> copy(context, "${BuildConfig.URL_SCHEME}://open?task=${Uri.encode(editor.id)}")
            EditorMenuAction.CopyId -> copy(context, editor.id)
            EditorMenuAction.Share -> share(context, editor)
            // RN duplicates the saved task, closes the editor, and opens the copy on its Form tab (Board's duplicate does the opening).
            EditorMenuAction.Duplicate -> { shell.closeEditor(); shell.menu.board.duplicate(editor.id) }
            // RN asks first only for a task with a checklist (its TaskProjectConversionModal); otherwise the draft's title goes at once.
            EditorMenuAction.Promote ->
                if (JSONArray(editor.checklistNow).length() > 0) promoteTitle = editor.text("title") else promote(editor.text("title"))
            // RN's requestStatusChange('next'): the draft's status, saved with the editor's Save.
            EditorMenuAction.ConvertToAction -> shell.editFields(mapOf("status" to "next"))
            EditorMenuAction.ConvertToSection -> afterSaving(editor, "convertToSection", null)
            // Skip and Cancel carry the draft's save, as RN's draftLifecycle.save / cancel do; core writes both in one.
            EditorMenuAction.Skip -> send(editor.id, editor.model.taskRevision, JSONObject().put("kind", "skip").put("save", save(editor)))
            EditorMenuAction.Cancel -> send(editor.id, editor.model.taskRevision, JSONObject().put("kind", "cancel").put("save", save(editor)))
            // RN deletes the saved task; the draft goes with the editor.
            EditorMenuAction.Delete -> send(editor.id, editor.model.taskRevision, JSONObject().put("kind", "delete"))
        }
    }

    /** RN's label for [action] (Cancel's is core's: Cancel task, or Cancel recurring series). */
    internal fun label(action: EditorMenuAction, editor: TaskEditor): String = when (action) {
        EditorMenuAction.CopyLink -> t("task.copyTaskLink")
        EditorMenuAction.CopyId -> t("task.copyTaskId")
        EditorMenuAction.Share -> t("common.share")
        EditorMenuAction.Duplicate -> t("taskEdit.duplicateTask")
        EditorMenuAction.Promote -> t("task.createProjectFromTask")
        EditorMenuAction.ConvertToAction -> t("reference.convertToAction")
        EditorMenuAction.ConvertToSection -> t("task.convertToSection")
        EditorMenuAction.Skip -> t("task.skipOccurrence")
        EditorMenuAction.Cancel -> editor.model.cancelLabel
        EditorMenuAction.Delete -> t("common.delete")
    }

    /** Create project with [title] (its dialog's, or the draft's own). */
    fun promote(title: String) {
        promoteTitle = null
        shell.editor?.let { afterSaving(it, "promote", title.trim()) }
    }

    /** The editor closed: its menu and dialog go (an action held for a Save already left through [saved]). */
    fun closed() {
        open = false
        promoteTitle = null
        afterSave = null
    }

    /**
     * RN saves the draft first (draftLifecycle.save): an editor with unsaved edits saves, and the action follows once that save
     * landed ([saved]), at the task's revision then.
     */
    private fun afterSaving(editor: TaskEditor, kind: String, title: String?) {
        val input = JSONObject().put("kind", kind).apply { title?.let { put("title", it) } }
        if (!editor.dirty && !shell.editsPending) return send(editor.id, editor.model.taskRevision, input)
        afterSave = Triple(editor.id, kind, title)
        shell.saveEditor()
    }

    /** The editor's Save of [id] landed: the action it held goes, at the revision the save left. */
    fun saved(id: String) {
        val (owner, kind, title) = afterSave ?: return
        afterSave = null
        if (owner != id) return
        shell.perform { runtime ->
            val revision = runtime.taskView(JSONObject().put("id", id).put("offset", 0).put("limit", 1).toString()).getString("taskRevision")
            shell.ui { send(id, revision, JSONObject().put("kind", kind).apply { title?.let { put("title", it) } }) }
        }
    }

    /** The editor's draft save for Skip and Cancel: the fields Save sends, and the bases core reads a change since against. */
    private fun save(editor: TaskEditor) = JSONObject().put("base", JSONObject(draftJson(editor.base))).put("patch", JSONObject(draftJson(editor.patch)))
        .put("scheduleBase", editor.model.scheduleBase ?: JSONObject())
        .apply {
            editor.model.recurrenceBase?.let { put("recurrenceBase", it) }
            editor.checklistSave.takeIf { it.isNotEmpty() }?.let { put("checklist", JSONObject(it)) }
            editor.attachmentsSave.takeIf { it.isNotEmpty() }?.let { put("attachments", JSONObject(it)) }
        }

    private fun send(taskId: String, taskRevision: String, kind: JSONObject) {
        val requestId = UUID.randomUUID().toString()
        val input = JSONObject(kind.toString()).put("requestId", requestId).put("taskId", taskId).put("taskRevision", taskRevision)
        run(FailedAction("taskEditorAction", taskId, input.toString(), requestId = requestId))
    }

    /** The command, or its owed retry: [action] holds its exact input, so a retry is the same request. */
    fun run(action: FailedAction) = shell.perform(action) { runtime ->
        val input = JSONObject(action.title)
        val reply = runtime.menuCommand("taskEditorAction", input.toString())
        shell.acknowledged(action)
        shell.ui { done(input, reply) }
    }

    /** Core's answer, shown as RN shows each action's outcome. */
    private fun done(input: JSONObject, reply: JSONObject) {
        val taskId = input.getString("taskId")
        val revision = input.getString("taskRevision")
        when (input.getString("kind")) {
            "promote" -> {
                shell.showToast(t("common.success"), t(if (reply.optBoolean("reused")) "task.promoteToProjectMoved" else "task.promoteToProjectCreated"), "success")
                shell.closeEditor()
                shell.menu.openProjects(reply.getString("projectId"))
            }
            "convertToSection" -> {
                // The tester's line: the conversion landed (or a replay found it landed); never the task's or section's text.
                val fields = JSONObject().put("releaseCheck", "v1.3.8/native-convert-to-section").put("outcome", reply.optString("outcome"))
                shell.anyTime({ it.logLine("Native task converted to a section releaseCheck=v1.3.8/native-convert-to-section", fields) }, {})
                shell.closeEditor()
                shell.showToast(t("common.success"), t("task.convertToSectionCreated"), "success")
            }
            "delete" -> {
                shell.closeEditor()
                shell.showToast(t("common.notice"), t("list.taskDeleted"), "info", t("common.undo"), 5200) {
                    send(taskId, revision, JSONObject().put("kind", "deleteUndo").put("deleteRequestId", input.getString("requestId")))
                }
            }
            "cancel" -> {
                shell.closeEditor()
                reply.optJSONObject("cancellation")?.let { cancelled ->
                    val undo = cancelled.getString("undoLabel").takeIf { cancelled.optBoolean("undoEnabled") }
                    shell.showToast(t("common.notice"), cancelled.getString("message"), "info", undo, 5200) {
                        send(taskId, revision, JSONObject().put("kind", "cancelUndo").put("cancelRequestId", input.getString("requestId")))
                    }
                }
            }
            "skip" -> shell.closeEditor()
        }
    }

    private fun copy(context: Context, text: String) {
        val copied = runCatching {
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Mindwtr", text))
        }.isSuccess
        shell.showToast(null, t(if (copied) "list.taskCopied" else "list.taskCopyFailed"), if (copied) "success" else "error")
    }

    /** RN's Share.share: core's text for the draft (getTaskShare), in the system share sheet; its title rides as the subject. */
    private fun share(context: Context, editor: TaskEditor) = shell.perform { runtime ->
        val input = JSONObject().put("id", editor.id).put("taskRevision", editor.model.taskRevision)
            .put("draft", JSONObject(draftJson(editor.fullDraft()))).put("checklist", JSONArray(editor.checklistNow))
        val content = runtime.menuRead("taskShare", input.toString())
        shell.ui {
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, content.getString("message"))
            content.menuText("title")?.let { send.putExtra(Intent.EXTRA_SUBJECT, it) }
            context.startActivity(Intent.createChooser(send, null))
        }
    }
}

/** RN's More button beside Close (MoreHorizontal 24, the tint): it opens the menu. */
@Composable
fun EditorMoreButton(model: InboxViewModel, editor: TaskEditor) = with(model) {
    val c = LocalTheme.current.colors
    val label = t("common.more")
    Box(Modifier.size(44.dp).clickable(enabled = !busy, role = Role.Button) { editorMenu.open = true }
        .semantics { contentDescription = label }.testTag("editor-more"), contentAlignment = Alignment.Center) {
        Icon(Lucide.MoreHorizontal, null, tint = c.tint, modifier = Modifier.size(24.dp))
    }
    EditorMenuCard(model, editor)
    PromoteDialog(model)
}

/** RN's dimmed screen (40% black) with a centered card: Back and a tap outside close it. The platform's own dim is off. */
@Composable
private fun MenuOverlay(dismiss: () -> Unit, content: @Composable () -> Unit) {
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        (LocalView.current.parent as? DialogWindowProvider)?.window?.setDimAmount(0f)
        Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.4f)).clickable(onClick = dismiss).imePadding()
            .semantics { testTagsAsResourceId = true }, contentAlignment = Alignment.Center) { content() }
    }
}

/** RN's menu Modal: a 220-wide card (radius 12, border, 8 above and below, at most 82% of the screen) with RN's rows. */
@Composable
private fun EditorMenuCard(model: InboxViewModel, editor: TaskEditor) = with(model) {
    if (!editorMenu.open) return
    val c = LocalTheme.current.colors
    val context = LocalContext.current
    val actions = editorMenuActions(editor.readOnly, editor.text("status") == "reference", editor.text("projectId").isNotEmpty(),
        editor.model.canSkipOccurrence, editor.model.canCancel)
    val maxHeight = (LocalConfiguration.current.screenHeightDp * 0.82f).dp
    MenuOverlay({ editorMenu.open = false }) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.width(220.dp).heightIn(max = maxHeight).clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .clickable(enabled = false) {}.verticalScroll(rememberScrollState()).padding(vertical = 8.dp).testTag("editor-menu")) {
            for (action in actions) {
                val label = editorMenu.label(action, editor)
                Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button) { editorMenu.choose(action, context) }
                    .semantics { contentDescription = label }.padding(horizontal = 16.dp, vertical = 10.dp), contentAlignment = Alignment.CenterStart) {
                    Text(label, style = rnText(14, 600), color = if (action.danger) c.danger else c.text)
                }
            }
        }
    }
}

/**
 * RN's TaskProjectConversionModal for a task with a checklist: the project's name (the draft's title to start), the note that the
 * task and its checklist move into the project, then Cancel and Create project from task. RN's Expand checklist switch is not built.
 */
@Composable
private fun PromoteDialog(model: InboxViewModel) = with(model) {
    val title = editorMenu.promoteTitle ?: return
    val c = LocalTheme.current.colors
    MenuOverlay({ editorMenu.promoteTitle = null }) {
        val shape = RoundedCornerShape(12.dp)
        Column(Modifier.padding(20.dp).fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).clickable(enabled = false) {}
            .padding(16.dp).testTag("promote-dialog")) {
            Text(t("task.createProjectFromTask"), style = rnText(18, 700), color = c.text, modifier = Modifier.padding(bottom = 12.dp).semantics { heading() })
            Text(t("projects.projectName"), style = rnText(14, 400), color = c.text)
            val inputShape = RoundedCornerShape(8.dp)
            val name = t("projects.projectName")
            BasicTextField(title, { editorMenu.promoteTitle = it }, enabled = !busy, singleLine = true, textStyle = rnText(16, 400).copy(color = c.text),
                cursorBrush = SolidColor(c.tint), modifier = Modifier.padding(top = 8.dp).fillMaxWidth().clip(inputShape).background(c.inputBg)
                    .rnBorder(1.dp, c.border, inputShape).padding(12.dp).semantics { contentDescription = name }.testTag("promote-title"))
            Text(t("task.keepChecklistDescription"), style = rnText(14, 400), color = c.secondaryText, modifier = Modifier.padding(vertical = 12.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                Box(Modifier.heightIn(min = 44.dp).clickable(enabled = !busy, role = Role.Button) { editorMenu.promoteTitle = null }.padding(horizontal = 12.dp),
                    contentAlignment = Alignment.Center) { Text(t("common.cancel"), style = rnText(14, 400), color = c.secondaryText) }
                val ready = !busy && title.isNotBlank()
                Box(Modifier.heightIn(min = 44.dp).clickable(enabled = ready, role = Role.Button) { editorMenu.promote(title) }.padding(horizontal = 12.dp)
                    .testTag("promote-confirm"), contentAlignment = Alignment.Center) {
                    Text(t("task.createProjectFromTask"), style = rnText(14, 400), color = c.tint.copy(alpha = if (ready) 1f else 0.5f))
                }
            }
        }
    }
}
