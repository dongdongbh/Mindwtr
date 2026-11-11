package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject


internal object CoreJob {


    const val INGEST = "ingest"

    const val CONTEXT = "context"


    const val REMINDERS = "reminders"

    const val REMINDER_DONE = "reminderDone"

    const val REMINDER_SNOOZE = "reminderSnooze"

    const val SYNC = "backgroundSync"
    const val WIDGET_REFRESH = "widgetRefresh"
    private val JOBS = setOf(INGEST, CONTEXT, REMINDERS, REMINDER_DONE, REMINDER_SNOOZE, SYNC, WIDGET_REFRESH)

    private val TASK_CHANGING_JOBS = setOf(INGEST, REMINDER_DONE, SYNC)

    enum class Outcome { Success, Retry, Failure }

    const val LINE = "Native Android core work"


    interface Calls {

        fun recover(): Boolean

        fun drain(): Boolean

        fun contextAutomation(json: String): JSONObject

        fun reminders(mode: String, key: String): JSONObject = throw UnsupportedOperationException("reminders")

        fun reminderDone(requestId: String, taskId: String): JSONObject = throw UnsupportedOperationException("reminderDone")

        fun reminderSnooze(json: String): JSONObject = throw UnsupportedOperationException("reminderSnooze")


        fun backgroundSync(trigger: String): JSONObject = throw UnsupportedOperationException("backgroundSync")

        fun appActive(): Boolean = false

        fun calendarSnapshot(): String? = null

        fun calendarPush(job: String, snapshot: String): String = "unavailable"
    }


    fun run(name: String?, input: Map<String, String?>, boot: () -> Calls, post: (JSONObject) -> Unit, refreshWidgets: () -> Unit,
            log: (String, JSONObject) -> Unit, syncAgain: () -> Boolean = { true }, ensureSync: () -> Boolean = { true }): Outcome {
        val line = JSONObject().put("job", name ?: JSONObject.NULL)
        if (name !in JOBS) {
            log(LINE, line.put("outcome", "unknown"))
            return Outcome.Failure
        }
        var recovered = false
        var calls: Calls? = null
        var snapshot: String? = null
        val outcome = try {
            val host = boot().also { calls = it }
            if (name in TASK_CHANGING_JOBS && !host.appActive()) snapshot = runCatching { host.calendarSnapshot() }.getOrNull()
            if (!host.recover() || !host.drain()) Outcome.Retry
            else when (name) {
                WIDGET_REFRESH -> {
                    refreshWidgets()
                    line.put("releaseCheck", "v1.3.8/widget-selection-refresh").put("refresh", "requested")
                    Outcome.Success
                }
                INGEST -> {

                    refreshWidgets()
                    planReminders(host, line, "capture")

                    val wanted = host.backgroundSync("capture").optBoolean("schedule").also { planReminders(host, line, "sync") }
                    if (wanted && !ensureSync()) Outcome.Retry else Outcome.Success
                }
                SYNC -> {
                    val again = if (host.appActive()) {
                        line.put("skipped", "foreground")
                        true
                    } else host.backgroundSync("scheduled").optBoolean("schedule").also { planReminders(host, line, "sync") }
                    if (again && !syncAgain()) Outcome.Retry else Outcome.Success
                }
                REMINDERS -> {
                    host.reminders(input["mode"] ?: "cycle", input["key"].orEmpty())
                    Outcome.Success
                }
                REMINDER_DONE -> {
                    host.reminderDone(input["requestId"].orEmpty(), input["taskId"].orEmpty())
                    host.reminders("cycle", "")
                    Outcome.Success
                }
                REMINDER_SNOOZE -> {
                    val request = JSONObject().put("requestId", input["requestId"].orEmpty())
                        .put("requestedAt", input["requestedAt"]?.toLongOrNull() ?: JSONObject.NULL)
                        .put("details", input["details"]?.let(::JSONObject) ?: JSONObject.NULL)
                    host.reminderSnooze(request.toString())
                    Outcome.Success
                }
                else -> {
                    recovered = true
                    val trigger = JSONObject().put("action", input["action"] ?: JSONObject.NULL).put("context", input["context"] ?: JSONObject.NULL)
                    host.contextAutomation(trigger.toString()).optJSONObject("notification")?.let(post)
                    Outcome.Success
                }
            }
        } catch (failure: Throwable) {
            line.put("error", (failure.message ?: failure.javaClass.simpleName).substringBefore(':'))
            val refused = failure.message?.startsWith("INVALID_INPUT") == true
            if (recovered || refused) Outcome.Failure else Outcome.Retry
        }
        log(LINE, line.put("outcome", outcome.name.lowercase()))
        if (outcome == Outcome.Success && name != WIDGET_REFRESH) refreshWidgets()
        val taken = snapshot
        val host = calls
        if (outcome == Outcome.Success && taken != null && host != null && !host.appActive()) runCatching { host.calendarPush(name.orEmpty(), taken) }
        return outcome
    }


    private fun planReminders(host: Calls, line: JSONObject, reason: String) {
        val planned = runCatching { host.reminders("background", reason).optString("outcome") == "cycle-completed" }.getOrDefault(false)
        line.put("reminders", if (planned) "cycled" else "failed")
    }
}


internal class OwedUploads(private val read: () -> Int, private val write: (Int) -> Unit) {

    private companion object { val LOCK = Any() }

    fun add(count: Int) = synchronized(LOCK) {
        if (count > 0) write(read() + count)
    }

    fun owed(): Int = synchronized(LOCK) { read() }

    fun settle(count: Int) = synchronized(LOCK) {
        if (count > 0) write(maxOf(0, read() - count))
    }
}
