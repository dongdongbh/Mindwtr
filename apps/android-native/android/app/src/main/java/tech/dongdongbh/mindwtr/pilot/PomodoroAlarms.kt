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

/**
 * One Pomodoro alert this app owns: its session, phase and end time (core's alarm identity), under the [scope] of this library.
 * [identifier] is core's observation id (`mindwtr-native-pomodoro:<64 hex>`); RN's alert owed at the upgrade uses `rn:<time>:<phase>`.
 */
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

/**
 * What Android cannot list for core's Pomodoro plan (design R2b §3, §3b; JVM-tested: PomodoroAlarmBookTest), on disk
 * (SharedPreferences `mindwtr_pomodoro_alarms`): core's record (`record`, written ahead of each plan's effects and after them), each
 * alert armed in AlarmManager (`armed:<id>`), and each alert shown (`fired:<id>`, the delivery ledger). The receiver writes `fired`
 * before it posts, and an alert in the ledger is never shown again, so core may show an alert found in neither inventory without a
 * duplicate. Ledger entries stay two days past their time, longer than core's 24 h late limit. Guarded by [PomodoroAlarms.LOCK].
 */
internal class PomodoroAlarmBook(private val read: () -> Map<String, String>, private val write: (Map<String, String?>) -> Boolean) {
    companion object {
        /** RN's patched library discards a one-shot shown more than a day late; core's NATIVE_POMODORO_LATE_LIMIT_MS. */
        const val LATE_LIMIT_MS = 24 * 60 * 60 * 1000L
        /** How long a ledger entry outlives its alert's time: longer than [LATE_LIMIT_MS], so a late plan still finds it. */
        const val KEEP_MS = 2 * LATE_LIMIT_MS
        const val RECORD = "record"
        /** PackageInfo.lastUpdateTime at the first native start: when this app replaced RN (core's pomodoroLegacyAlert). */
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

        /** This library's scope in core's record: the package and a hash of it (core's `<name>:<64 hex>`). */
        fun scope(packageName: String): String = "$packageName:${sha256(packageName)}"

        /** Core's alarm identity as one id: a new session, phase or end time is a new alert, so the next phase never replaces a due one. */
        fun identifier(scope: String, sessionID: String, phase: String, fireAtMs: Long): String =
            "mindwtr-native-pomodoro:${sha256("$scope|$sessionID|$phase|$fireAtMs")}"

        /** The alarm's PendingIntent request code, from its id (its own receiver, so no reminder alarm shares it). */
        fun requestCode(identifier: String): Int = identifier.substringAfter(':').take(8).toLong(16).toInt()
    }

    private fun entries(prefix: String): List<PomodoroOccurrence> =
        read().filterKeys { it.startsWith(prefix) }.values.mapNotNull { runCatching { PomodoroOccurrence.parse(it) }.getOrNull() }

    fun record(): String? = read()[RECORD]

    /** Throws when the write did not reach the disk: the plan stops before any effect, and the next plan runs it again. */
    fun saveRecord(value: String?) = check(write(mapOf(RECORD to value))) { "The Pomodoro alarm record was not written" }

    fun upgradedAt(): Long? = read()[UPGRADED_AT]?.toLongOrNull()

    fun saveUpgradedAt(value: Long) = check(write(mapOf(UPGRADED_AT to value.toString()))) { "The Pomodoro upgrade time was not written" }

    fun armed(): List<PomodoroOccurrence> = entries(ARMED)

    /** Recorded before AlarmManager holds it: a process death in between leaves an entry with no PendingIntent, which reads as not armed. */
    fun arm(occurrence: PomodoroOccurrence) = check(write(mapOf(ARMED + occurrence.identifier to occurrence.json()))) { "The Pomodoro alarm was not recorded" }

    fun disarm(identifier: String) { write(mapOf(ARMED + identifier to null)) }

    fun fired(identifier: String): Boolean = read().containsKey(FIRED + identifier)

    /**
     * Core's inventories. Pending: each armed alert whose PendingIntent still exists ([held]; force-stop and reboot drop them) and that
     * has not fired. Delivered: each alert in the ledger, dismissed or not, and each shown one still in the tray ([shown], by id).
     * RN's owed alert (`rn:`) is in neither: core's planner owns only its own ids.
     */
    fun inventories(held: (PomodoroOccurrence) -> Boolean, shown: Set<String>): Pair<JSONArray, JSONArray> {
        val fired = entries(FIRED).filter { !it.identifier.startsWith("rn:") }
        val firedIds = fired.map { it.identifier }.toSet()
        val armed = armed()
        val pending = armed.filter { it.identifier !in firedIds && held(it) }
        val delivered = fired + armed.filter { it.identifier in shown && it.identifier !in firedIds }
        return JSONArray(pending.map { it.observation() }) to JSONArray(delivered.map { it.observation() })
    }

    /**
     * Whether [occurrence], due now, is shown: not shown before, and at most a day late. A shown one is recorded first (its post then
     * follows): a process death between the two loses that one alert, and never shows it twice.
     */
    fun deliver(occurrence: PomodoroOccurrence, nowMs: Long): Boolean {
        if (fired(occurrence.identifier) || nowMs - occurrence.fireAtMs > LATE_LIMIT_MS) return false
        check(write(mapOf(FIRED + occurrence.identifier to occurrence.json(), ARMED + occurrence.identifier to null))) {
            "The Pomodoro delivery was not recorded"
        }
        return true
    }

    /** Drops what is two days past its time: armed alerts long gone and ledger entries core can no longer show. */
    fun prune(nowMs: Long) {
        val old = read().filter { (key, value) ->
            (key.startsWith(ARMED) || key.startsWith(FIRED)) && runCatching { PomodoroOccurrence.parse(value).fireAtMs }.getOrNull()?.let { nowMs - it > KEEP_MS } != false
        }.keys
        if (old.isNotEmpty()) write(old.associateWith { null })
    }
}

/**
 * The Android side of core's Pomodoro alarm plan (host-entry.ts pomodoroAlarmPlan; design R2b §3, §3b): it gives core the inventories,
 * writes core's record ahead of the effects, cancels and arms as core says, then writes the published record. Plans and deliveries
 * hold [LOCK], so a plan never sees an alert between its firing and its ledger entry (K1), and one plan runs at a time (K7).
 */
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

        /** The alarm's PendingIntent, or null when AlarmManager holds none for it (never armed, cancelled, force-stopped, rebooted). */
        fun held(context: Context, occurrence: PomodoroOccurrence): PendingIntent? = PendingIntent.getBroadcast(context,
            PomodoroAlarmBook.requestCode(occurrence.identifier), fireIntent(context, occurrence, null), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
    }

    private val book = PomodoroAlarmBook.of(context)
    private val scope = PomodoroAlarmBook.scope(context.packageName)

    /** One plan, start to end; throws what core or the disk threw (the next trigger plans again). Answers core's outcome. */
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
        // A delivered alert leaves the tray; its ledger entry stays, so it is never shown again (K3).
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

    /** RN's alert owed at the upgrade (core's pomodoroLegacyAlert), shown once through the ledger (K6). */
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

    /** The first native start's upgrade time (PackageInfo.lastUpdateTime then, never firstInstallTime, which is RN's), once. */
    fun rememberUpgrade() = synchronized(LOCK) {
        if (book.upgradedAt() == null) book.saveUpgradedAt(context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime)
    }

    /** RN's exact-alarm rule (ReminderAlarms.arm): exact while Android allows it, else inexact but allowed while idle. */
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
            // A PendingIntent AlarmManager does not hold must not read as armed: the next plan arms it again.
            intent.cancel()
            book.disarm(occurrence.identifier)
            throw failure
        }
    }

    /** The immediate path: the ledger first, then the post (K2), as the receiver does. */
    private fun show(occurrence: PomodoroOccurrence, details: String, now: Long): Boolean {
        if (!book.deliver(occurrence, now)) return false
        CoreNotifications.postPomodoro(context, occurrence.identifier, JSONObject(details))
        return true
    }
}

/**
 * A Pomodoro alarm that came due: under [PomodoroAlarms.LOCK], its ledger entry first, then its notification (stamped with its phase's
 * end), unless it was shown already or is more than a day late. Not exported: only this app's AlarmManager sends it.
 */
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
