package tech.dongdongbh.mindwtr.pilot

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.concurrent.CancellationException

/*
 * RN's AI actions on core's contract (native-host-contract-ai.ts): the task editor's copilot chips, Clarify and Break down
 * (TaskEditFormTab.tsx, use-task-edit-copilot.ts, use-task-edit-actions.ts), Process Inbox's Clarify (InboxCaptureCard.tsx),
 * the Weekly Review's analysis (review-modal.tsx) and the capture screen's copilot (capture-modal.tsx). Each request runs off the
 * engine (CoreHost.aiRequest) and writes nothing: an answer is RN's AIResponseModal whose buttons apply through the screen's own
 * edits (editTaskDraft, getInboxProcessingStep, runReviewAction's applySuggestions), or RN's alert. State lives in memory only.
 */

/** RN's AIResponseModal on screen: core's title, message and buttons; a button's `apply` goes to [apply] (null: it only closes). */
class AIAnswer(val title: String, val message: String?, val choices: List<JSONObject>, val apply: (Any) -> Unit)

/** The Weekly Review's analysis as RN's controller keeps it (aiRan, aiError, aiSuggestions, aiSelectedIds). */
data class ReviewAnalysis(val ran: Boolean = false, val error: String? = null, val suggestions: List<JSONObject> = emptyList(), val selected: Set<String> = emptySet())

class AIActionsModel(private val shell: InboxViewModel) {
    private val main = Handler(Looper.getMainLooper())
    /** The requests each scope still wants: a newer one, an input change or a close cancels a request (its provider call stops). */
    private val calls = AIRequestSlots<CoreHost.LongCall> { call -> shell.coreHost()?.cancel(call) }

    /** One AI request off the engine in [scope]; [answered] gets its result, unless a newer call, an input change or a close cancelled it. */
    private fun ask(scope: String, name: String, input: JSONObject, answered: (Result<JSONObject>) -> Unit) {
        val runtime = shell.coreHost() ?: return
        val handle = CoreHost.LongCall()
        calls.start(scope, handle)
        Thread({
            val result = runCatching { runtime.aiRequest(name, input.toString(), handle) }
            calls.reply(scope, handle, shell::ui) { answered(result) }
        }, "mindwtr-ai-$scope").start()
    }

    /** The action waiting on the provider ("editor", "inbox", "review"): its button shows RN's spinner and "Working...". */
    var working by mutableStateOf<String?>(null); private set
    /** RN's AIResponseModal, and RN's alert (a title and a message, OK only). */
    var answer by mutableStateOf<AIAnswer?>(null); private set
    var alert by mutableStateOf<Pair<String, String>?>(null); private set

    // ---- The task editor ----

    /** Core's AI parts for the editor's draft (getTaskEditorAI): the buttons, the chips, the applied line. */
    var editorAI by mutableStateOf<JSONObject?>(null); private set
    /** The copilot's kept suggestion and the chips applied so far, for this editor session. */
    private var suggestion: JSONObject? = null
    private var applied = JSONObject().put("tags", JSONArray())
    private var session: String? = null
    /** The text the copilot was last asked about (core's `copilot.request.text`). */
    private var asked: String? = null

    /** Core's AI parts for the draft as it is now, in the background; a new session starts its copilot afresh. */
    fun readEditor() {
        val editor = shell.editor ?: return
        if (editor.readOnly) { editorAI = null; return }
        if (session != editor.session) {
            cancelEditor()
            session = editor.session; suggestion = null; applied = JSONObject().put("tags", JSONArray()); asked = null; editorAI = null
        }
        // Any edit while Clarify or Break down waits stops it, as the copilot's text change does (review C1 verification 5).
        if (working == "editor" && editorAsked != snapshot()) { calls.cancel("editor"); working = null }
        val input = JSONObject().put("id", editor.id).put("draft", JSONObject(draftJson(editor.fullDraft())))
            .put("copilot", JSONObject().put("suggestion", suggestion ?: JSONObject.NULL).put("applied", applied))
        shell.background(emptyList(), { runtime -> runtime.menuRead("taskEditorAI", input.toString()) }) { view, _ ->
            if (shell.editor?.session != editor.session) return@background
            editorAI = view
            val request = view.getJSONObject("copilot").optJSONObject("request")
            if (request == null) { asked = null; calls.cancel("copilot"); if (suggestion != null) { suggestion = null; readEditor() }; return@background }
            val text = request.getString("text")
            if (text == asked) return@background
            asked = text
            calls.cancel("copilot")
            main.postDelayed({ askCopilot(editor.session, text) }, request.getLong("delayMs"))
        }
    }

    /** The copilot for [text], once typing paused on it: an answer for text the editor no longer shows is dropped. */
    private fun askCopilot(forSession: String, text: String) {
        val editor = shell.editor?.takeIf { it.session == forSession && asked == text } ?: return
        val input = JSONObject().put("id", editor.id).put("draft", JSONObject(draftJson(editor.fullDraft())))
        ask("copilot", "requestTaskEditorCopilot", input) { result ->
            result.exceptionOrNull()?.let { if (it !is CancellationException) Log.w(CoreHost.TAG, "AI copilot failed code=${it.message?.substringBefore(':')}") }
            val reply = result.getOrNull() ?: return@ask
            if (shell.editor?.session != forSession || asked != text || reply.menuText("text") != text) return@ask
            suggestion = reply.optJSONObject("suggestion")
            readEditor()
        }
    }

    /** The editor closed: its copilot and its Clarify or Break down stop. */
    fun cancelEditor() {
        calls.cancel("copilot", "editor")
        if (working == "editor") working = null
    }

    /** A chip (or Apply all): core's draft edit, and the applied parts it leaves. */
    fun applyChip(chip: JSONObject) {
        applied = chip.getJSONObject("applied")
        shell.applyAIEdit(chip.getJSONObject("edit"))
        readEditor()
    }

    /** The draft and checklist Clarify or Break down was asked on: an answer shows and applies only while the editor still holds them. */
    private var editorAsked: String? = null
    private fun snapshot(): String? = shell.editor?.let { "${it.session}\n${draftJson(it.fullDraft())}\n${JSONArray(it.checklistNow)}" }
    private fun editorFits(): () -> Boolean {
        val asked = snapshot()
        editorAsked = asked
        return { asked != null && snapshot() == asked }
    }

    /** RN's Clarify: core's dialog, whose buttons edit the draft (a new title, or the suggestion's title, estimate and context). */
    fun clarify() {
        val editor = shell.editor ?: return
        val fits = editorFits()
        request("editor", "requestTaskEditorClarify", JSONObject().put("id", editor.id).put("draft", JSONObject(draftJson(editor.fullDraft()))), fits) { apply ->
            if (fits()) shell.applyAIEdit(apply as JSONObject)
        }
    }

    /** RN's Break down: core's steps dialog; "Add steps" puts core's checklist on the draft (and a list task's status). */
    fun breakdown() {
        val editor = shell.editor ?: return
        val input = JSONObject().put("id", editor.id).put("draft", JSONObject(draftJson(editor.fullDraft()))).put("checklist", JSONArray(editor.checklistNow))
        val fits = editorFits()
        request("editor", "requestTaskEditorBreakdown", input, fits) { apply ->
            val steps = apply as JSONObject
            if (fits()) shell.addAISteps(steps.getJSONArray("checklist").toString(), steps.optJSONObject("edit"))
        }
    }

    // ---- Process Inbox ----

    /**
     * Process Inbox's Clarify on the step shown: core's dialog, whose buttons are step edits sent in order. The answer shows
     * and applies only on the session and step it was asked on (a Process Inbox opened again is a new session).
     */
    fun inboxClarify(flow: InboxProcessing) {
        val asked = InboxStepKey.of(flow)
        val fits = { InboxStepKey.of(shell.processing) == asked }
        val input = JSONObject().put("sessionId", flow.sessionId).put("taskId", flow.taskId).put("step", flow.step)
        request("inbox", "requestInboxClarify", input, fits) { apply ->
            val edits = apply as JSONArray
            if (!fits()) return@request
            for (index in 0 until edits.length()) shell.editStep(JSONObject().put("edit", edits.getJSONObject(index)))
        }
    }

    /** Process Inbox closed: its Clarify stops, and an answer on screen for it closes. */
    fun cancelInbox() {
        calls.cancel("inbox")
        if (working == "inbox") working = null
    }

    // ---- The Weekly Review ----

    var review by mutableStateOf(ReviewAnalysis()); private set

    /** RN's Run analysis on the stale step: core's suggestions (the actionable ones chosen), or its error line. */
    fun runAnalysis() {
        if (working != null || shell.coreHost() == null) return
        review = review.copy(ran = true, error = null)
        working = "review"
        ask("review", "requestWeeklyReviewAnalysis", JSONObject()) { result ->
            working = null
            result.onSuccess { reply ->
                var next = review.copy(error = reply.menuText("error"))
                reply.optJSONArray("suggestions")?.let { list -> next = next.copy(suggestions = List(list.length()) { list.getJSONObject(it) }) }
                reply.optJSONArray("selectedIds")?.let { ids -> next = next.copy(selected = List(ids.length()) { ids.getString(it) }.toSet()) }
                review = next
            }.onFailure { if (it !is CancellationException) review = review.copy(error = it.message.orEmpty().substringAfter(": ")) }
        }
    }

    fun toggleSuggestion(id: String) { review = review.copy(selected = if (id in review.selected) review.selected - id else review.selected + id) }

    /** RN's Apply (n): the chosen suggestions through runReviewAction's applySuggestions, each task at the revision the analysis read. */
    fun applySuggestions() {
        val chosen = review.suggestions.filter { it.getString("id") in review.selected }
        if (chosen.none { it.getBoolean("actionable") }) return
        val revisions = JSONObject().apply { chosen.filter { it.getBoolean("actionable") }.forEach { entry -> entry.menuText("taskRevision")?.let { put(entry.getString("id"), it) } } }
        val suggestions = JSONArray().apply { chosen.forEach { put(JSONObject().put("id", it.getString("id")).put("action", it.getString("action")).put("reason", it.getString("reason"))) } }
        shell.menu.act("reviewAction", JSONObject().put("type", "applySuggestions").put("suggestions", suggestions).put("taskRevisions", revisions))
    }

    /** RN's review modal state goes with it. */
    fun leaveReview() { calls.cancel("review"); review = ReviewAnalysis(); if (working == "review") working = null }

    // ---- The capture screen ----

    /** The capture screen's question last asked: its screen session with core's `copilot.request` (captureCopilotKey). */
    private var captureAsked: String? = null

    /** Core's capture view asks the copilot ([request]); once typing paused, requestAICopilot, and its answer as setSuggestion. */
    fun captureCopilot(session: String, request: JSONObject?) {
        val key = captureCopilotKey(session, request?.toString())
        if (key == captureAsked) return
        captureAsked = key
        calls.cancel("capture")
        if (request == null) return
        main.postDelayed({
            if (shell.captureModal.open?.session != session || captureAsked != key) return@postDelayed
            ask("capture", "requestAICopilot", JSONObject().put("request", request)) { result ->
                result.exceptionOrNull()?.let { if (it !is CancellationException) Log.w(CoreHost.TAG, "AI copilot failed code=${it.message?.substringBefore(':')}") }
                val reply = result.getOrNull() ?: return@ask
                if (shell.captureModal.open?.session != session || captureAsked != key) return@ask
                // No suggestion: an empty one, which core keeps as none.
                shell.captureModal.edit(JSONObject().put("type", "setSuggestion").put("title", request.getString("title"))
                    .put("suggestion", reply.optJSONObject("suggestion") ?: JSONObject()))
            }
        }, CAPTURE_COPILOT_DELAY_MS)
    }

    /** The capture screen closed: its copilot stops. */
    fun cancelCapture() { calls.cancel("capture"); captureAsked = null }

    // ---- Answers ----

    /**
     * One AI action (Clarify, Break down, Process Inbox's Clarify) in [action]'s scope; its answer is shown while [fits] (its
     * editor or step is still on screen), and a button's `apply` goes to [apply]. A cancelled one shows nothing.
     */
    private fun request(action: String, name: String, input: JSONObject, fits: () -> Boolean, apply: (Any) -> Unit) {
        if (working != null || shell.coreHost() == null) return
        working = action
        ask(action, name, input) { result ->
            if (working == action) working = null
            result.onSuccess { if (fits()) show(it, apply) }.onFailure { failure ->
                if (failure is CancellationException) return@onFailure
                Log.w(CoreHost.TAG, "AI request failed request=$name code=${failure.message?.substringBefore(':')}")
                shell.showToast(null, failure.message.orEmpty().substringAfter(": "), "error")
            }
        }
    }

    /** Core's answer: nothing, RN's alert, RN's toast (its Open goes to Settings › AI), or RN's AIResponseModal. */
    private fun show(reply: JSONObject, apply: (Any) -> Unit) {
        when (reply.getString("kind")) {
            "alert" -> alert = reply.getString("title") to reply.getString("message")
            "toast" -> reply.getJSONObject("toast").let { toast ->
                shell.showToast(toast, toast.getJSONObject("action").getString("label")) {
                    shell.closeProcessing()
                    shell.menu.openAISettings()
                }
            }
            "dialog" -> answer = AIAnswer(reply.getString("title"), reply.menuText("message"), reply.menuObjects("choices"), apply)
        }
    }

    /** A button of the open answer: it closes, then applies what it carries (Cancel carries nothing). */
    fun choose(choice: JSONObject) {
        val open = answer ?: return
        answer = null
        if (!choice.isNull("apply")) open.apply(choice.get("apply"))
    }

    fun dismiss() { answer = null; alert = null }

    private companion object {
        /** RN's capture screen asks the copilot this long after the title last changed (capture-modal.tsx). */
        const val CAPTURE_COPILOT_DELAY_MS = 800L
    }
}

/** The Ionicons RN's editor copilot pill draws (@expo/vector-icons 15.0.3's glyph outlines, as SettingsIcons.kt builds them). */
private object CopilotIonicons {
    val SparklesOutline = ionicon("SparklesOutline",
        "M81 2Q95 -5 102 9Q104 12 112 33Q120 54 121 55Q122 56 145 65Q172 76 175 82Q180 94 170 101Q168 102 144.5 111" +
        "Q121 120 120.5 121Q120 122 111 145Q104 163 101.5 168Q99 173 94 175Q88 177 81.5 174.5Q75 172 65 145" +
        "Q56 122 55 121Q54 120 33 112Q7 102 5 99Q0 94 0 88Q0 81 5 76Q7 74 30.5 65Q54 56 55 55Q56 54 65 31Q74 8 76 5.5" +
        "Q78 3 81 2ZM392 34Q401 30 409 35Q413 38 428 75Q439 105 439 105Q439 105 470 117Q501 129 503 130Q509 133 511 139" +
        "Q515 149 506 156Q503 158 471 171L439 183L427 215Q414 247 412 250Q408 256 400 256Q392 256 387 250" +
        "Q386 248 373.5 215.5Q361 183 361 183Q361 183 329 171Q293 157 290 152Q285 141 293 133Q296 130 328 118" +
        "Q360 106 360.5 105Q361 104 373.5 72.5Q386 41 387.5 38.5Q389 36 392 34ZM91 69 88 61 86 65Q85 69 84 72" +
        "Q81 80 71 84Q63 87 62.5 88Q62 89 69 91Q77 95 79.5 97Q82 99 84.5 106.5Q87 114 87.5 114Q88 114 91 107" +
        "Q96 96 107 91Q114 89 114 88Q114 87 106.5 84.5Q99 82 97 79.5Q95 77 91 69ZM406 108Q401 94 400 94Q400 94 399 95.5" +
        "Q398 97 397 100.5Q396 104 394 108Q388 123 387 126Q384 130 364 138Q360 140 356.5 141Q353 142 351.5 143" +
        "Q350 144 350 144Q350 145 364 150Q381 156 385 160Q387 162 393 178Q395 183 396.5 186.5Q398 190 399 192" +
        "Q400 194 400 194Q401 193 407 178Q412 163 415.5 159.5Q419 156 434 151Q450 145 450 144Q450 144 448 143" +
        "Q446 142 442.5 140.5Q439 139 434 137Q418 131 416 129Q412 125 406 108ZM200 130Q215 124 227 137" +
        "Q230 141 251.5 197Q273 253 274 254Q275 255 330 276Q385 297 387 298Q393 301 397 309Q403 320 397 331" +
        "Q393 339 387 342Q385 343 330 364Q275 385 274 386Q273 387 252 443L230 500L225 504Q218 512 208 512" +
        "Q196 512 188 502Q186 499 164 442.5Q142 386 142 386Q142 386 87 364.5Q32 343 28 341Q16 334 16 320Q16 306 28 299" +
        "Q31 297 86.5 275.5Q142 254 142 254Q142 254 163.5 198Q185 142 187 139Q191 133 200 130ZM227 223Q227 223 227 223" +
        "Q209 175 208 174Q208 174 205.5 180Q203 186 198.5 197Q194 208 189 221Q171 268 169.5 271Q168 274 164 278" +
        "Q160 282 98 306Q61 320 61 320Q61 320 98 334Q160 358 164 362Q168 366 169.5 369Q171 372 189 419" +
        "Q194 432 198.5 443Q203 454 205.5 460Q208 466 208 466Q209 465 227.5 417Q246 369 249 365Q252 361 257 358.5" +
        "Q262 356 308 338.5Q354 321 354 320Q354 319 305.5 300.5Q257 282 254 280Q251 278 248.5 274.5Q246 271 227 223Z")
    val CheckmarkCircleOutline = ionicon("CheckmarkCircleOutline",
        "M241 49Q256 48 269 49Q351 54 407 113Q452 161 462 228Q464 238 464 256Q464 274 462 284Q454 339 421 382" +
        "Q405 405 382 421Q339 454 284 462Q274 464 256 464Q238 464 228 462Q173 454 130 421Q107 405 91 382Q58 339 50 284" +
        "Q48 274 48 256Q48 238 50 228Q58 174 91 130Q107 108 130 91Q181 53 241 49ZM284 82Q278 81 261.5 80.5" +
        "Q245 80 240 81Q212 84 193 92Q149 109 119.5 145Q90 181 82 229Q81 238 81 256Q81 274 82 283Q89 326 114 360" +
        "Q139 394 178 414Q214 432 256 432Q298 432 334 414Q372 394 397 360.5Q422 327 430 284Q431 275 431 256.5" +
        "Q431 238 430 229Q420 169 378 129Q338 92 284 82ZM345 162Q345 162 345 162Q348 161 352.5 160.5Q357 160 359 162" +
        "Q365 165 367 170Q370 177 366 184Q364 187 296 268Q228 349 225 350Q218 354 210 350Q208 349 177.5 315.5" +
        "Q147 282 145 278Q140 266 151 259Q160 253 168 258Q171 260 194 286Q217 312 218.5 310Q220 308 278 238.5" +
        "Q336 169 339.5 166Q343 163 345 162Z")
}

@OptIn(ExperimentalComposeUiApi::class)
/** RN's AIResponseModal: a dimmed backdrop, the card with its title, its message (scrolled past 220), and one button per line. */
@Composable
fun AIResponseDialog(model: InboxViewModel, answer: AIAnswer) {
    val theme = LocalTheme.current
    val c = theme.colors
    val ai = model.ai
    Dialog(onDismissRequest = { ai.dismiss() }) {
        val shape = RoundedCornerShape(16.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape).padding(20.dp).semantics { testTagsAsResourceId = true }.testTag("ai-answer"),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(answer.title, style = rnText(16, 700), color = c.text)
            answer.message?.let { Box(Modifier.heightIn(max = 220.dp).verticalScroll(rememberScrollState())) { Text(it, style = rnText(14, 400, 20), color = c.secondaryText) } }
            Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                answer.choices.forEachIndexed { index, choice ->
                    val primary = choice.menuText("variant") == "primary"
                    val label = choice.getString("label")
                    val button = RoundedCornerShape(10.dp)
                    Box(Modifier.fillMaxWidth().clip(button).background(if (primary) c.tint else c.filterBg).rnBorder(1.dp, c.border, button)
                        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = "ai-answer-$index"; onClick { ai.choose(choice); true } }
                        .clickable { ai.choose(choice) }.padding(horizontal = 12.dp, vertical = 10.dp), contentAlignment = Alignment.Center) {
                        Text(label, style = rnText(14, 600), color = if (primary) c.onTint else c.text, textAlign = TextAlign.Center)
                    }
                }
            }
        }
    }
}

/** RN's Alert.alert with core's title and message, and OK. */
@Composable
fun AIAlert(model: InboxViewModel, alert: Pair<String, String>) {
    AlertDialog(
        onDismissRequest = { model.ai.dismiss() },
        title = { Text(alert.first) },
        text = { Text(alert.second) },
        confirmButton = { TextButton(onClick = { model.ai.dismiss() }, modifier = Modifier.testTag("ai-alert-ok")) { Text(t("common.ok")) } },
    )
}

/** The open AI answer or alert over any screen. */
@Composable
fun AIOverlays(model: InboxViewModel) {
    model.ai.answer?.let { AIResponseDialog(model, it) }
    model.ai.alert?.let { AIAlert(model, it) }
}

/**
 * The editor's AI rows under the title (TaskEditFormTab.tsx): Clarify and Break down with RN's spinner while one runs, the
 * copilot's suggested chips with Apply all and the hint, and the applied line.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EditorAIRows(model: InboxViewModel, locked: Boolean) {
    val ai = model.ai
    val view = ai.editorAI?.takeIf { it.getBoolean("enabled") } ?: return
    val c = LocalTheme.current.colors
    val busy = ai.working != null
    Row(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        for ((label, tag, run) in listOf(Triple(view.getString("clarify"), "ai-clarify", ai::clarify), Triple(view.getString("breakdown"), "ai-breakdown", ai::breakdown))) {
            val enabled = !busy && !locked
            val shape = RoundedCornerShape(16.dp)
            Box(Modifier.clip(shape).background(c.filterBg).rnBorder(1.dp, c.border, shape)
                .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = tag; if (enabled) onClick { run(); true } else disabled() }
                .clickable(enabled = enabled) { run() }.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(label, style = rnText(12, 600), color = c.tint)
            }
        }
        if (ai.working == "editor") Row(Modifier.padding(start = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(20.dp), color = c.tint, strokeWidth = 2.dp)
            Text(view.getString("working"), style = rnText(12, 500), color = c.secondaryText)
        }
    }
    val copilot = view.getJSONObject("copilot")
    copilot.optJSONObject("suggested")?.let { suggested ->
        CopilotPill(c.filterBg, RoundedCornerShape(12.dp), Modifier.padding(bottom = 12.dp).fillMaxWidth()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Icon(CopilotIonicons.SparklesOutline, null, tint = c.text, modifier = Modifier.size(16.dp))
                Text(suggested.getString("label"), style = rnText(12, 600), color = c.text)
                for (part in suggested.menuObjects("parts")) CopilotChip(part.getString("label"), "ai-chip", !locked) { ai.applyChip(part) }
                suggested.optJSONObject("applyAll")?.let { all -> CopilotApplyAll(all.getString("label"), !locked) { ai.applyChip(all) } }
            }
            Text(suggested.getString("hint"), style = rnText(11, 400), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        }
    }
    copilot.menuText("applied")?.let { line ->
        CopilotPill(c.filterBg, RoundedCornerShape(12.dp), Modifier.padding(bottom = 12.dp).fillMaxWidth()) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(CopilotIonicons.CheckmarkCircleOutline, null, tint = c.text, modifier = Modifier.size(16.dp))
                Text(line, style = rnText(12, 600), color = c.text, modifier = Modifier.testTag("ai-applied"))
            }
        }
    }
}

/** RN's copilotPill: a bordered pill on [fill] holding the chips or the applied line. */
@Composable
private fun CopilotPill(fill: Color, shape: RoundedCornerShape, modifier: Modifier, content: @Composable () -> Unit) {
    val c = LocalTheme.current.colors
    Column(modifier.clip(shape).background(fill).rnBorder(1.dp, c.border, shape).padding(horizontal = 12.dp, vertical = 8.dp)) { content() }
}

/** RN's copilotChip: a part's value on the card color; a tap applies it. */
@Composable
private fun CopilotChip(label: String, tag: String, enabled: Boolean, apply: () -> Unit) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(10.dp)
    Box(Modifier.clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
        .clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = tag; if (enabled) onClick { apply(); true } else disabled() }
        .clickable(enabled = enabled, onClick = apply).padding(horizontal = 8.dp, vertical = 4.dp)) {
        Text(label, style = rnText(12, 600), color = c.text)
    }
}

/** RN's copilotApplyAll: the label in the tint. */
@Composable
private fun CopilotApplyAll(label: String, enabled: Boolean, apply: () -> Unit) {
    Box(Modifier.clearAndSetSemantics { contentDescription = label; role = Role.Button; testTag = "ai-apply-all"; if (enabled) onClick { apply(); true } else disabled() }
        .clickable(enabled = enabled, onClick = apply).padding(4.dp)) {
        Text(label, style = rnText(12, 600), color = LocalTheme.current.colors.tint)
    }
}

/** The capture screen's copilot (capture-modal.tsx): the suggested chips in RN's round pill, and the applied line with Check. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CaptureCopilot(model: InboxViewModel, copilot: JSONObject, enabled: Boolean) {
    val c = LocalTheme.current.colors
    val pill = RoundedCornerShape(999.dp)
    copilot.optJSONObject("suggested")?.let { suggested ->
        CopilotPill(c.inputBg, pill, Modifier) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Icon(Lucide.Sparkles, null, tint = c.text, modifier = Modifier.size(13.dp))
                Text(suggested.getString("label"), style = rnText(12, 600), color = c.text)
                for (part in suggested.menuObjects("parts")) CopilotChip(part.getString("label"), "capture-ai-chip", enabled) { model.captureModal.edit(part.getJSONObject("edit")) }
                suggested.optJSONObject("applyAll")?.let { all -> CopilotApplyAll(all.getString("label"), enabled) { model.captureModal.edit(all.getJSONObject("edit")) } }
            }
            Text(suggested.getString("hint"), style = rnText(11, 400), color = c.secondaryText, modifier = Modifier.padding(top = 2.dp))
        }
    }
    copilot.menuText("applied")?.let { line ->
        CopilotPill(c.inputBg, pill, Modifier) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(Lucide.Check, null, tint = c.text, modifier = Modifier.padding(top = 1.dp).size(13.dp))
                Text(line, style = rnText(12, 600), color = c.text)
            }
        }
    }
}
