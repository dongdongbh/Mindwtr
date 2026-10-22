package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.content.Context
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.InboxViewModel.Part
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.util.UUID

/*
 * The native Pomodoro on the Focus screen (pass R2b, design .orchestrator/tasks/native-r2b-20261022/design.md): RN's card
 * (components/pomodoro-panel.tsx) drawn from core's panel (native-pomodoro-panel.ts, the session iOS built), each control a
 * core transition (prepared, then committed with its receipt and the task's credit in one transaction, journaled), and the
 * completion alarms planned after each (PomodoroAlarms.kt).
 */

/** The card's state: core's panel, the open picker's rows, and the two presentation values core takes back (collapsed, the last feedback). */
class PomodoroModel(private val shell: InboxViewModel) {
    var panel by mutableStateOf<JSONObject?>(null); private set
    /** The picker's rows while it is open (core's getPomodoroTaskWindow), null while closed. */
    var picker by mutableStateOf<List<JSONObject>?>(null); private set
    private var pickerTotal = 0
    private var pickerRevision = ""
    /** Core's completion feedback (NativePomodoroFeedback), shown under the clock until the next transition. */
    private var feedback: JSONObject? = null

    private val app: Application get() = shell.getApplication()
    private val prefs get() = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    /** RN's card folded to its time row (RN's `@mindwtr_pomodoro_collapsed`, adopted once). Device-local, as RN's. */
    val collapsed: Boolean get() = prefs.getBoolean(COLLAPSED, false)

    private fun presentation() = JSONObject().put("collapsed", collapsed).put("lastEvent", feedback ?: JSONObject.NULL).toString()

    /**
     * Core's card again, in the background (each Focus read, a resume, the phase's end on screen). What core asks before anything
     * else runs as a write: the first start adopts RN's session, a linked task that went away is unlinked, an ended phase is
     * settled. [planAlarms]: plan the alerts after it (a start or resume, never before the ended phase settled: design §3b K5).
     */
    fun refresh(planAlarms: Boolean = false) {
        shell.background(listOf(Part.Pomodoro), { runtime -> runtime.pomodoroPanelRead(presentation()) }) { next, mine ->
            if (!shell.fresh(mine, Part.Pomodoro)) return@background
            panel = next
            if (owed(next) != null) settle(null, null)
            else if (planAlarms) planInBackground()
        }
    }

    /** A control's transition ([action] and its fields), then the card and the alarms again. */
    fun act(action: String, fields: JSONObject? = null) = settle(action, fields)

    /** RN's fold: presentation only (no transition), the card read again. */
    fun toggleCollapsed() {
        prefs.edit().putBoolean(COLLAPSED, !collapsed).apply()
        refresh()
    }

    /** What core asks of a card before any control: adopt RN's session, unlink a task that went away, settle an ended phase. */
    private fun owed(shown: JSONObject): String? = when {
        shown.getString("kind") == "uninitialized" -> "adoptLegacy"
        shown.optBoolean("selectionMissing") -> "selectTask"
        shown.optBoolean("needsReconcile") -> "reconcile"
        else -> null
    }

    private fun settle(requested: String?, fields: JSONObject?) = shell.menu.whenIdle {
        shell.perform { runtime ->
            val next = transition(runtime, requested, fields)
            shell.ui { panel = next }
        }
    }

    /**
     * iOS's order (CoreModel.swift runtime admission): read, then the transition core owes or the control asked, read again, and
     * plan the alerts only once nothing is owed any more. A transition core refuses as stale or busy wrote nothing; the next
     * refresh tries again.
     */
    private fun transition(runtime: CoreHost, requested: String?, fields: JSONObject?): JSONObject {
        val before = runtime.pomodoroPanelRead(presentation())
        // iOS's order: adoption first, then the control (core's prepare settles an ended phase inside any action), then what is owed.
        val owed = owed(before)
        val action = (if (owed == "adoptLegacy") owed else requested ?: owed) ?: return before.also { plan(runtime) }
        val legacy = if (action == "adoptLegacy") adoptionInput(runtime) else null
        val request = JSONObject().put("action", action).put("requestId", UUID.randomUUID().toString())
            .put("observedAtMs", before.getJSONObject("observation").getLong("nowMs"))
            .put("localDayKey", before.getJSONObject("observation").getString("localDayKey"))
            .put("autoStart", before.getJSONObject("autoStart"))
        legacy?.let { request.put("legacy", it) }
        if (action == "selectTask" && action != requested) request.put("taskId", JSONObject.NULL)
        fields?.keys()?.forEach { request.put(it, fields.get(it)) }
        val prepared = runtime.pomodoroTransitionPrepare(request.toString())
        if (prepared.getString("kind") == "prepared") {
            val result = runtime.pomodoroTransitionCommit(prepared.getString("planJSON")).getJSONObject("result")
            // Core's feedback rule (iOS's pomodoroFeedback): a phase that ended in this transition says so under the clock.
            val event = before.optString("completionEvent")
            feedback = if (action in FEEDBACK_ACTIONS && event in EVENTS && result.getLong("generation") == before.optLong("generation") + 1) {
                JSONObject().put("sessionID", result.getString("sessionID")).put("generation", result.getLong("generation")).put("value", event)
            } else null
            if (legacy != null) prefs.edit().putBoolean(COLLAPSED, legacy.optString("collapsedRaw") == "true").apply()
        }
        val after = runtime.pomodoroPanelRead(presentation())
        // One owed transition per pass: the next refresh settles the rest before any plan.
        if (owed(after) == null) plan(runtime)
        return after
    }

    /**
     * RN's stored session for core's adoption (RN's AsyncStorage keys in RKStorage), at the first start: the upgrade time is kept
     * first, and RN's alert that fell due between the upgrade and this start is shown once (design §3b K6).
     */
    private fun adoptionInput(runtime: CoreHost): JSONObject {
        val alarms = PomodoroAlarms(app)
        runCatching { alarms.rememberUpgrade() }.onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro upgrade time not kept", it) }
        runCatching { alarms.showLegacy(runtime, runtime.rnValue(RN_ALARM_KEY)) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android RN Pomodoro alert not shown", it) }
        return JSONObject().put("version", 1).put("namespace", app.packageName)
            .put("sessionRaw", runtime.rnValue(RN_SESSION_KEY) ?: JSONObject.NULL)
            .put("collapsedRaw", runtime.rnValue(RN_COLLAPSED_KEY) ?: JSONObject.NULL)
    }

    private fun plan(runtime: CoreHost) {
        runCatching { PomodoroAlarms(app).plan(runtime) }.onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro alarms not planned", it) }
    }

    /** The alerts again with no read before (the alert setting or the permission changed). */
    fun planInBackground() = shell.background(listOf(Part.Pomodoro), { runtime -> plan(runtime) }) { _, _ -> }

    fun openPicker() { picker = emptyList(); pickerTotal = 0; pickerRevision = ""; more() }
    fun closePicker() { picker = null }

    /** The picker's next window of Focus tasks (RN's card takes the Focus screen's lists), for the Focus controls on screen. */
    fun more() {
        val loaded = picker ?: return
        if (loaded.isNotEmpty() && loaded.size >= pickerTotal) return
        val controls = shell.menu.focusControls.state.toString()
        val revision = pickerRevision.ifEmpty { shell.focusRevision() }
        shell.background(listOf(Part.Pomodoro), { runtime ->
            runtime.pomodoroTasks(JSONObject().put("offset", loaded.size).put("limit", WINDOW).put("revision", revision)
                .put("controls", JSONObject(controls)).toString())
        }) { next, _ ->
            val shown = picker ?: return@background
            if (shown.size != loaded.size) return@background
            pickerTotal = next.getInt("total")
            pickerRevision = next.getString("revision")
            picker = shown + next.menuObjects("rows")
        }
    }

    companion object {
        private const val PREFS = "mindwtr-pomodoro"
        private const val COLLAPSED = "collapsed"
        private const val WINDOW = 100
        /** RN's AsyncStorage keys (apps/mobile/lib/pomodoro-session.ts) and RN's alarm record (core's POMODORO_ALARM_STORAGE_KEY). */
        const val RN_SESSION_KEY = "@mindwtr_pomodoro_state"
        const val RN_COLLAPSED_KEY = "@mindwtr_pomodoro_collapsed"
        const val RN_ALARM_KEY = "mindwtr:local:pomodoro-alarm:v1"
        private val FEEDBACK_ACTIONS = setOf("reconcile", "toggle", "selectTask")
        private val EVENTS = setOf("focus-finished", "break-finished")
    }
}
