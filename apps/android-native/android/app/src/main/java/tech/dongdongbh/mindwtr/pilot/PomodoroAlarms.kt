package tech.dongdongbh.mindwtr.pilot

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.security.MessageDigest


internal data class PomodoroOccurrence(val identifier: String, val scope: String, val sessionID: String, val phase: String, val fireAtMs: Long) {
    fun observation(): JSONObject = JSONObject().put("identifier", identifier).put("scope", scope).put("sessionID", sessionID)
        .put("phase", phase).put("fireAtMs", fireAtMs)

    fun json(): String = observation().toString()

    companion object {
        fun parse(value: String): PomodoroOccurrence = JSONObject(value).let {
            PomodoroOccurrence(it.getString("identifier"), it.getString("scope"), it.getString("sessionID"), it.getString("phase"), it.getLong("fireAtMs"))
        }
    }
}


internal class PomodoroAlarmBook(private val read: () -> Map<String, String>, private val write: (Map<String, String?>) -> Boolean) {
    companion object {

        const val LATE_LIMIT_MS = 24 * 60 * 60 * 1000L

        const val KEEP_MS = 2 * LATE_LIMIT_MS
        const val RECORD = "record"

        const val UPGRADED_AT = "upgradedAt"
        private const val ARMED = "armed:"
        private const val FIRED = "fired:"
        private const val PREFS = "mindwtr_pomodoro_alarms"

        fun of(context: Context): PomodoroAlarmBook {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return PomodoroAlarmBook(read = { prefs.all.mapValues { it.value.toString() } },
                write = { changes -> prefs.edit().apply { changes.forEach { (key, value) -> if (value == null) remove(key) else putString(key, value) } }.commit() })
        }

        private fun sha256(text: String): String =
            MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }


        fun scope(packageName: String): String = "$packageName:${sha256(packageName)}"


        fun identifier(scope: String, sessionID: String, phase: String, fireAtMs: Long): String =
            "mindwtr-native-pomodoro:${sha256("$scope|$sessionID|$phase|$fireAtMs")}"


        fun requestCode(identifier: String): Int = identifier.substringAfter(':').take(8).toLong(16).toInt()
    }

    private fun entries(prefix: String): List<PomodoroOccurrence> =
        read().filterKeys { it.startsWith(prefix) }.values.mapNotNull { runCatching { PomodoroOccurrence.parse(it) }.getOrNull() }

    fun record(): String? = read()[RECORD]


    fun saveRecord(value: String?) = check(write(mapOf(RECORD to value))) { "The Pomodoro alarm record was not written" }

    fun upgradedAt(): Long? = read()[UPGRADED_AT]?.toLongOrNull()

    fun saveUpgradedAt(value: Long) = check(write(mapOf(UPGRADED_AT to value.toString()))) { "The Pomodoro upgrade time was not written" }

    fun armed(): List<PomodoroOccurrence> = entries(ARMED)


    fun arm(occurrence: PomodoroOccurrence) = check(write(mapOf(ARMED + occurrence.identifier to occurrence.json()))) { "The Pomodoro alarm was not recorded" }

    fun disarm(identifier: String) { write(mapOf(ARMED + identifier to null)) }

    fun fired(identifier: String): Boolean = read().containsKey(FIRED + identifier)


    fun inventories(held: (PomodoroOccurrence) -> Boolean, shown: Set<String>): Pair<JSONArray, JSONArray> {
        val fired = entries(FIRED).filter { !it.identifier.startsWith("rn:") }
        val firedIds = fired.map { it.identifier }.toSet()
        val armed = armed()
        val pending = armed.filter { it.identifier !in firedIds && held(it) }
        val delivered = fired + armed.filter { it.identifier in shown && it.identifier !in firedIds }
        return JSONArray(pending.map { it.observation() }) to JSONArray(delivered.map { it.observation() })
    }


    fun deliver(occurrence: PomodoroOccurrence, nowMs: Long): Boolean {
        if (fired(occurrence.identifier) || nowMs - occurrence.fireAtMs > LATE_LIMIT_MS) return false
        check(write(mapOf(FIRED + occurrence.identifier to occurrence.json(), ARMED + occurrence.identifier to null))) {
            "The Pomodoro delivery was not recorded"
        }
        return true
    }


    fun prune(nowMs: Long) {
        val old = read().filter { (key, value) ->
            (key.startsWith(ARMED) || key.startsWith(FIRED)) && runCatching { PomodoroOccurrence.parse(value).fireAtMs }.getOrNull()?.let { nowMs - it > KEEP_MS } != false
        }.keys
        if (old.isNotEmpty()) write(old.associateWith { null })
    }
}


internal class PomodoroAlarms(private val context: Context) {
    companion object {
        const val FIRE = "tech.dongdongbh.mindwtr.pomodoro.FIRE"
        const val EXTRA_OCCURRENCE = "occurrence"
        const val EXTRA_DETAILS = "details"
        val LOCK = Any()

        private fun fireIntent(context: Context, occurrence: PomodoroOccurrence, details: String?) =
            Intent(context, PomodoroAlarmReceiver::class.java).setAction(FIRE).apply {
                putExtra(EXTRA_OCCURRENCE, occurrence.json())
                details?.let { putExtra(EXTRA_DETAILS, it) }
            }


        fun held(context: Context, occurrence: PomodoroOccurrence): PendingIntent? = PendingIntent.getBroadcast(context,
            PomodoroAlarmBook.requestCode(occurrence.identifier), fireIntent(context, occurrence, null), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
    }

    private val book = PomodoroAlarmBook.of(context)
    private val scope = PomodoroAlarmBook.scope(context.packageName)


    fun plan(host: CoreHost): String = synchronized(LOCK) {
        val now = System.currentTimeMillis()
        book.prune(now)
        val notifications = context.getSystemService(NotificationManager::class.java)
        val shown = notifications.activeNotifications.mapNotNull { it.tag?.takeIf { tag -> tag.startsWith("mindwtr-native-pomodoro:") } }.toSet()
        val (pending, delivered) = book.inventories(held = { held(context, it) != null }, shown = shown)
        val plan = host.pomodoroAlarmPlan(ReminderAlarms.permissionGranted(context), book.record(), scope, pending.toString(), delivered.toString())
        val outcome = plan.getString("outcome")
        if (outcome == "uninitialized") return outcome
        book.saveRecord(plan.optString("writeAhead").takeIf { !plan.isNull("writeAhead") })
        fun each(name: String, block: (PomodoroOccurrence) -> Unit) = plan.optJSONArray(name)?.let { list ->
            for (i in 0 until list.length()) block(PomodoroOccurrence.parse(list.getJSONObject(i).toString()))
        }
        each("cancelPending") { occurrence ->
            held(context, occurrence)?.let { context.getSystemService(AlarmManager::class.java).cancel(it); it.cancel() }
            book.disarm(occurrence.identifier)
        }

        each("cancelDelivered") { CoreNotifications.cancelPomodoro(context, it.identifier) }
        plan.optJSONObject("schedule")?.let { schedule ->
            val fireAtMs = schedule.getLong("fireAtMs")
            val occurrence = PomodoroOccurrence(PomodoroAlarmBook.identifier(scope, schedule.getString("sessionID"), schedule.getString("phase"), fireAtMs),
                scope, schedule.getString("sessionID"), schedule.getString("phase"), fireAtMs)
            val details = schedule.getJSONObject("details").toString()
            if (schedule.getBoolean("immediate")) show(occurrence, details, now) else arm(occurrence, details)
        }
        book.saveRecord(plan.optString("published").takeIf { !plan.isNull("published") })
        book.saveRecord(plan.optString("after").takeIf { !plan.isNull("after") })
        runCatching { host.pomodoroAlarmSaved(outcome) }.onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro alarm line not logged", it) }
        outcome
    }


    fun showLegacy(host: CoreHost, rnRecord: String?): Boolean = synchronized(LOCK) {
        val upgradedAt = book.upgradedAt() ?: return false
        val alert = host.pomodoroLegacyAlert(rnRecord, upgradedAt)
        if (alert.getString("kind") != "show") return false
        val fireAtMs = alert.getLong("fireAtMs")
        val occurrence = PomodoroOccurrence(alert.getString("identifier"), scope, "", alert.getJSONObject("details").getJSONObject("data").optString("phase"), fireAtMs)
        val shown = show(occurrence, alert.getJSONObject("details").toString(), System.currentTimeMillis())
        if (shown) runCatching { host.pomodoroAlarmSaved("legacy-shown") }
        shown
    }


    fun rememberUpgrade() = synchronized(LOCK) {
        if (book.upgradedAt() == null) book.saveUpgradedAt(context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime)
    }


    private fun arm(occurrence: PomodoroOccurrence, details: String) {
        book.arm(occurrence)
        val intent = PendingIntent.getBroadcast(context, PomodoroAlarmBook.requestCode(occurrence.identifier), fireIntent(context, occurrence, details),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val manager = context.getSystemService(AlarmManager::class.java)
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, occurrence.fireAtMs, intent)
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, occurrence.fireAtMs, intent)
            }
        } catch (failure: RuntimeException) {

            intent.cancel()
            book.disarm(occurrence.identifier)
            throw failure
        }
    }


    private fun show(occurrence: PomodoroOccurrence, details: String, now: Long): Boolean {
        if (!book.deliver(occurrence, now)) return false
        CoreNotifications.postPomodoro(context, occurrence.identifier, JSONObject(details))
        return true
    }
}


class PomodoroAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != PomodoroAlarms.FIRE) return
        val occurrence = runCatching { PomodoroOccurrence.parse(intent.getStringExtra(PomodoroAlarms.EXTRA_OCCURRENCE)!!) }.getOrNull() ?: return
        val details = runCatching { JSONObject(intent.getStringExtra(PomodoroAlarms.EXTRA_DETAILS)!!) }.getOrNull() ?: return
        runCatching {
            synchronized(PomodoroAlarms.LOCK) {
                if (PomodoroAlarmBook.of(context).deliver(occurrence, System.currentTimeMillis())) {
                    CoreNotifications.postPomodoro(context, occurrence.identifier, details)
                } else {
                    Log.i(CoreHost.TAG, "Native Android Pomodoro alert dropped (shown before or more than a day late)")
                }
            }
        }.onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro alert not posted", it) }
    }
}
