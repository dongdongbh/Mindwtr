package tech.dongdongbh.mindwtr.pilot

import android.Manifest
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.RnKeyValue
import tech.dongdongbh.mindwtr.pilot.core.debugProperty

/*
 * Reminder alarms on AlarmManager, as React Native's patched alarm library (react-native-alarm-notification, patched by
 * plugins/patch-alarm-notification-gradle.js) sets and shows them. Core decides every alarm: which, when, its id, why one goes,
 * and when to plan again (native-host-contract-reminders.ts; bundle/host-reminders.ts runs the timers in the engine). Kotlin
 * applies core's plan in core's order, posts what a fired alarm carries, and hands Done and Snooze to CoreWork.
 */

/** Core's plan applied in core's order, apart from Android (JVM-tested: ReminderPlanTest). */
internal object ReminderPlan {
    /** RN's alarm map in RN's RKStorage (core's REMINDER_ALARM_MAP_STORAGE_KEY). */
    const val MAP_KEY = "mindwtr:local:alarms:v1"
    /** The native host's own reminder state beside it (core's NATIVE_REMINDER_STATE_STORAGE_KEY); RN never reads it. */
    const val STATE_KEY = "mindwtr:native:reminders:v1"

    interface Port {
        /** RKStorage [entries] in one write, on disk before this returns. */
        fun store(entries: Map<String, String>)
        /** The notification alarm [id] delivered, if it is still shown. */
        fun removeDelivered(id: Int)
        fun cancel(id: Int)
        /** Core's alarm (NativeReminderAlarm) under its id: an alarm held under that id is replaced. */
        fun schedule(alarm: JSONObject)
        /** Every delivered reminder notification: no notification permission. */
        fun clearDelivered()
        /** The ledger on disk (ReminderLedger): [cancelled] ids gone, [armed] ids at their times; before any alarm changes. */
        fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) {}
    }

    /**
     * [plan] (core's NativeReminderAlarmPlan): `writeAhead` and `stateAhead` (a Snooze about to be made) stored (on disk) in one
     * write, then each cancel, then each alarm made, then `alarms`
     * (not when `unchanged`: the stored map already says it) and `state` (null when unchanged) stored in one write, so a delivered
     * reminder core lets expire is remembered whenever its alarm leaves the map. A withdrawn alarm's delivered notification goes before its
     * cancel; an expired one's stays. A failed removal never
     * stops a cancel. A refused alarm throws before `alarms` is stored: the next plan, from `writeAhead`, makes the pending alarms
     * again under the same ids, so nothing is made twice or left behind. [checkpoint] names each point a process death is safe at.
     */
    fun apply(plan: JSONObject, port: Port, checkpoint: (String) -> Unit = {}) {
        val ahead = buildMap {
            if (!plan.isNull("writeAhead")) put(MAP_KEY, plan.getString("writeAhead"))
            if (plan.has("stateAhead") && !plan.isNull("stateAhead")) put(STATE_KEY, plan.getString("stateAhead"))
        }
        if (ahead.isNotEmpty()) {
            port.store(ahead)
            checkpoint("write-ahead")
        }
        val cancel = plan.getJSONArray("cancel")
        val schedule = plan.getJSONArray("schedule")
        // The ledger first: a delivery checks it, so a cancelled alarm never shows even if the process dies before cancelling it.
        port.record(cancelled = List(cancel.length()) { cancel.getJSONObject(it).getInt("id") },
            armed = List(schedule.length()) { schedule.getJSONObject(it).let { alarm -> alarm.getInt("id") to alarm.getLong("fireAtMs") } })
        for (index in 0 until cancel.length()) {
            val item = cancel.getJSONObject(index)
            val id = item.getInt("id")
            if (item.getString("reason") == "withdrawn") runCatching { port.removeDelivered(id) }
            port.cancel(id)
        }
        for (index in 0 until schedule.length()) {
            val alarm = schedule.getJSONObject(index)
            if (alarm.optString("replacing") == "withdrawn") runCatching { port.removeDelivered(alarm.getInt("id")) }
            port.schedule(alarm)
        }
        checkpoint("scheduled")
        if (plan.optBoolean("clearDelivered")) runCatching { port.clearDelivered() }
        // As RN's saveAlarmMap: a map that did not change is not written again (#766).
        val after = buildMap {
            if (!plan.optBoolean("unchanged")) put(MAP_KEY, plan.getString("alarms"))
            if (plan.has("state") && !plan.isNull("state")) put(STATE_KEY, plan.getString("state"))
        }
        if (after.isNotEmpty()) port.store(after)
    }
}

/**
 * Deliveries the alarm receiver dropped and receiver jobs WorkManager did not store, counted on disk (a receiver may run with no
 * engine) until the next plan's summary line takes them (JVM-tested: ReminderStartTest). Guarded by [ReminderAlarms.LOCK].
 */
internal class ReminderReceiverCounts(private val read: (String) -> Int, private val write: (Map<String, Int>) -> Unit) {
    companion object {
        const val DROPPED = "dropped"
        const val NOT_QUEUED = "notQueued"
        private const val PREFS = "mindwtr_reminder_receiver"

        fun of(context: Context): ReminderReceiverCounts {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return ReminderReceiverCounts(read = { prefs.getInt(it, 0) },
                write = { values -> prefs.edit().apply { values.forEach { (name, value) -> putInt(name, value) } }.commit() })
        }
    }

    fun add(name: String) = synchronized(ReminderAlarms.LOCK) { write(mapOf(name to read(name) + 1)) }

    fun take(): JSONObject = synchronized(ReminderAlarms.LOCK) {
        JSONObject().put(DROPPED, read(DROPPED)).put(NOT_QUEUED, read(NOT_QUEUED))
            .also { taken -> if (taken.getInt(DROPPED) + taken.getInt(NOT_QUEUED) > 0) write(mapOf(DROPPED to 0, NOT_QUEUED to 0)) }
    }
}

/**
 * Each alarm this app holds in AlarmManager, on disk (SharedPreferences `mindwtr_reminder_ledger`; JVM-tested: ReminderPlanTest):
 * `armed:<time>`, or `fired:<time>` once a one-shot showed. A delivery shows only while its alarm is armed at its time, so one a
 * plan cancelled or made again for another time shows nothing, in this process or the next. Each plan records its cancels and
 * alarms before it changes any; the receiver records a one-shot that showed (core reads the fired ones: a Snooze that showed is
 * never made again). Guarded by [ReminderAlarms.LOCK], which each apply and each delivery hold.
 */
internal class ReminderLedger(private val read: () -> Map<Int, String>, private val write: (Map<Int, String?>) -> Boolean) {
    companion object {
        /** RN's patched library discards a one-shot delivered more than a day late (patch-alarm-notification-gradle.js). */
        const val ONE_SHOT_LATE_LIMIT_MS = 24 * 60 * 60 * 1000L
        private const val PREFS = "mindwtr_reminder_ledger"

        fun of(context: Context): ReminderLedger {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            return ReminderLedger(read = { prefs.all.mapNotNull { (id, value) -> id.toIntOrNull()?.let { it to value.toString() } }.toMap() },
                write = { changes -> prefs.edit().apply { changes.forEach { (id, value) -> if (value == null) remove("$id") else putString("$id", value) } }.commit() })
        }
    }

    /** Only what changes is written (nothing at all when nothing does: the upgrade keeps every other file as RN left it). */
    fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) {
        val held = read()
        val changes = cancelled.filter { it in held }.associateWith { null as String? } +
            armed.filter { (id, at) -> held[id] != "armed:$at" }.associate { (id, at) -> id to "armed:$at" }
        // A write that did not reach the disk stops the plan before any alarm changes; the cycle retries.
        if (changes.isNotEmpty()) check(write(changes)) { "The reminder ledger was not written" }
    }

    /** Whether a delivery of alarm [id], armed for [fireAtMs], shows at [nowMs]; a one-shot that shows is recorded as fired. */
    fun deliver(id: Int, fireAtMs: Long, repeat: String, nowMs: Long): Boolean {
        if (read()[id] != "armed:$fireAtMs") return false
        if (repeat != "once") return true
        if (nowMs - fireAtMs > ONE_SHOT_LATE_LIMIT_MS) return false
        // Shown even when the fired mark is not written: one more showing after a restart is better than silence.
        write(mapOf(id to "fired:$fireAtMs"))
        return true
    }

    fun fired(): List<Int> = read().filterValues { it.startsWith("fired:") }.keys.sorted()

    fun ids(): Set<Int> = read().keys

    /** Throws when the write did not reach the disk: the RN cleanup then stops and runs again at the next start. */
    fun clear() { read().keys.takeIf { it.isNotEmpty() }?.let { ids -> check(write(ids.associateWith { null })) { "The reminder ledger was not cleared" } } }
}

/**
 * React Native's alarms, cancelled once at the first native start, before the first plan (JVM-tested: ReminderPlanTest). RN's
 * library keeps them in `databases/rnandb`, table `alarmtbl`; each is a broadcast to its AlarmReceiver under the request code in
 * the row's `alarmId`. Their order makes a process death safe anywhere: every alarm is cancelled (RN's, and this app's own from
 * before an RN build ran), then RN's delivered reminders lose
 * their buttons (Done, Snooze and Dismiss target RN's receiver, which is gone; a tap still opens the app), then RN's alarm map goes (core
 * plans every alarm afresh; RN's Pomodoro record stays for the Pomodoro pass), then the table. Until the table is gone each
 * start runs it again, and cancelling twice is harmless; no plan runs before it finished.
 */
internal object RnAlarmCleanup {
    /**
     * RN's RKStorage keys the cleanup removes: its alarm map only (core plans every alarm afresh). RN's Pomodoro record stays as RN
     * left it (the Pomodoro pass, R2, owns it); its alarm is cancelled with the others.
     */
    val FORGOTTEN_KEYS = listOf(ReminderPlan.MAP_KEY)

    /** [rows]: each RN alarm's request code, null when RN left no table. The number cancelled. */
    /** [rows]: each RN alarm row's candidate request codes, null when RN left no table. The number of RN alarms. */
    fun run(rows: () -> List<List<Int>>?, cancel: (Int) -> Unit, cancelNative: () -> Unit, stripButtons: () -> Unit, forgetMaps: () -> Unit,
            deleteTable: () -> Unit): Int {
        val ids = rows() ?: return 0
        ids.flatten().forEach(cancel)
        cancelNative()
        stripButtons()
        forgetMaps()
        deleteTable()
        return ids.size
    }

    /**
     * Each row's candidate request codes. RN's library cancels an alarm under its `gson_data`'s `alarmId`, but RN's release builds
     * shrink AlarmModel's field names (R8: `"q":1790000001`), so every whole number in the row is a candidate: one that names no RN
     * alarm finds no PendingIntent and cancels nothing. A row that cannot be read, or holds no whole number, throws: its alarm may
     * still be set under a code only that row holds, so the cleanup fails and keeps the table and the map for the next start.
     */
    fun requestCodes(rows: List<String?>): List<List<Int>> = rows.map { row ->
        val data = runCatching { JSONObject(row!!) }.getOrElse { throw IllegalStateException("An RN alarm row cannot be read", it) }
        val codes = data.keys().asSequence().mapNotNull { name ->
            (data.get(name) as? Number)?.toDouble()?.takeIf { it % 1.0 == 0.0 && it in Int.MIN_VALUE.toDouble()..Int.MAX_VALUE.toDouble() }?.toInt()
        }.distinct().toList()
        // The real field first when the build kept its name.
        val named = data.optInt("alarmId", Int.MIN_VALUE).takeIf { data.has("alarmId") && it != Int.MIN_VALUE }
        val ordered = if (named != null) listOf(named) else codes.sorted()
        ordered.ifEmpty { throw IllegalStateException("An RN alarm row holds no request code fields=[${data.keys().asSequence().sorted().joinToString(",")}]") }
    }

    /** RN's database without its table (a stop inside its onCreate) holds no alarm; any other failed read fails the cleanup. */
    fun isMissingTable(failure: Throwable): Boolean = failure.message?.contains("no such table") == true
}

/**
 * The reminder alarms' start on the process's host (ProcessCoreHost; JVM-tested: ReminderStartTest): once the boot reached it,
 * [start] runs core's first plan and arms core's timers. A resume plans once more after a start (RN's start runs one more cycle),
 * or starts again after a start that failed, so a transient failure never leaves the timers unarmed until the next process.
 */
internal class ReminderStart<H : Any>(private val start: (H) -> JSONObject, private val cycle: (H) -> Unit) {
    /** The start's reply (`ask`: RN would ask for the notification permission now); null until a start succeeded. */
    @Volatile var reply: JSONObject? = null; private set
    @Volatile private var started: H? = null
    @Volatile private var failed: H? = null

    /** True when it started now; throws what the start threw. A host already started is not started again. */
    @Synchronized fun start(host: H): Boolean {
        if (started != null) return false
        failed = host
        reply = start.invoke(host)
        started = host
        failed = null
        return true
    }

    /** Throws what the plan or the start threw. */
    fun resume() {
        started?.let { cycle(it); return }
        failed?.let(::start)
    }
}

/**
 * The Android side of core's reminder alarms (CoreHost's alarm bridges): AlarmManager, the tray, RN's old alarms. Called on the
 * engine thread, which alone opens RKStorage.
 */
internal class ReminderAlarms(
    private val context: Context,
    private val keyValue: RnKeyValue,
    /** RN's `RKStorage` byte copy (LegacyRnStoreGuard.checkpointRnState), taken before this class first writes it. */
    private val checkpointRnState: () -> Unit,
) : CoreHost.Reminders, ReminderPlan.Port {
    companion object {
        /** RN's library, which no longer exists here: its alarms are cancelled through its component name. */
        private const val RN_RECEIVER = "com.emekalites.react.alarm.notification.AlarmReceiver"
        private const val RN_DATABASE = "rnandb"
        const val FIRE = "tech.dongdongbh.mindwtr.reminder.FIRE"
        /** The alarm (core's NativeReminderAlarm, with the channel's name), as JSON. */
        const val EXTRA_ALARM = "alarm"

        /** Held by each plan's apply and each delivery, so a delivery sees the plan before it or after it whole. */
        val LOCK = Any()

        private fun fireIntent(context: Context) = Intent(context, ReminderAlarmReceiver::class.java).setAction(FIRE)

        /**
         * Alarm [alarm] under its id (a held alarm under that id is replaced), as RN's library sets one: exact while Android allows
         * exact alarms (Android 12+ asks the user), else inexact but still allowed while idle.
         */
        fun arm(context: Context, alarm: JSONObject) {
            val manager = context.getSystemService(AlarmManager::class.java)
            val intent = PendingIntent.getBroadcast(context, alarm.getInt("id"), fireIntent(context).putExtra(EXTRA_ALARM, alarm.toString()),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val at = alarm.getLong("fireAtMs")
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
            }
        }

        /** RN's exact-alarm check (exact-alarm-permission.ts): only Android 12+ can withhold exact alarms. */
        fun exactAlarmsDenied(context: Context): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            && !context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()

        /** Android's Alarms & reminders page for this app (RN's openExactAlarmSettings). */
        fun openExactAlarmSettings(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
            runCatching { context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${context.packageName}"))) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android exact-alarm settings not opened", it) }
        }

        /** RN's rule (getAndroidNotificationPermissionStatus): before Android 13 notifications need no permission. */
        fun permissionGranted(context: Context): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private val alarms = context.getSystemService(AlarmManager::class.java)
    private val notifications = context.getSystemService(NotificationManager::class.java)
    /** The reminder channel's name core sent with the plan (core's REMINDER_NOTIFICATION_CHANNEL_NAME). */
    private var channelName = ""

    override fun apply(plan: String) {
        val parsed = JSONObject(plan)
        channelName = parsed.optString("channelName")
        synchronized(LOCK) { applyLocked(parsed) }
    }

    private fun applyLocked(parsed: JSONObject) {
        ReminderPlan.apply(parsed, this) { point ->
            // Debug builds only (check-reminders-device.mjs): `debug.mindwtr.native.reminder_stop=<point>` kills the process there.
            if (debugProperty("reminder_stop") == point) {
                Log.i(CoreHost.TAG, "Native Android reminder stop at=$point")
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        }
    }

    override fun permissionGranted() = permissionGranted(context)

    override fun receiverCounts(): String = ReminderReceiverCounts.of(context).take().toString()

    override fun ledger(): String = synchronized(LOCK) {
        val shown = notifications.activeNotifications.filter { NotificationCompat.getChannelId(it.notification) == CoreNotifications.REMINDER_CHANNEL }
            .map(CoreNotifications::reminderAlarmId)
        JSONObject().put("fired", JSONArray(ReminderLedger.of(context).fired())).put("shown", JSONArray(shown)).toString()
    }

    override fun cleanupRn(): Int = RnAlarmCleanup.run(rows = ::rnAlarmIds, cancel = ::cancelRn, cancelNative = ::cancelEveryNative,
        stripButtons = ::stripRnButtons,
        // Only maps that exist: an RN user who never had reminders keeps RKStorage untouched.
        forgetMaps = { keyValue.multiGet(RnAlarmCleanup.FORGOTTEN_KEYS).filterValues { it != null }.keys.toList()
            .takeIf { it.isNotEmpty() }?.let { keys -> beforeWrite(); keyValue.multiRemove(keys) }; Unit },
        deleteTable = { check(context.deleteDatabase(RN_DATABASE) || !context.getDatabasePath(RN_DATABASE).exists()) { "Cannot delete $RN_DATABASE" } })

    override fun store(entries: Map<String, String>) {
        beforeWrite()
        keyValue.multiSet(entries.toList())
    }

    private var checkpointed = false

    private fun beforeWrite() {
        if (checkpointed) return
        checkpointRnState()
        checkpointed = true
    }

    override fun removeDelivered(id: Int) = CoreNotifications.cancelReminder(context, id)

    override fun record(cancelled: List<Int>, armed: List<Pair<Int, Long>>) = ReminderLedger.of(context).record(cancelled, armed)

    override fun cancel(id: Int) {
        PendingIntent.getBroadcast(context, id, fireIntent(context), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let {
            alarms.cancel(it)
            it.cancel()
        }
    }

    override fun schedule(alarm: JSONObject) = arm(context, JSONObject(alarm.toString()).put("channelName", channelName))

    override fun clearDelivered() {
        for (shown in notifications.activeNotifications) {
            if (NotificationCompat.getChannelId(shown.notification) == CoreNotifications.REMINDER_CHANNEL) notifications.cancel(shown.tag, shown.id)
        }
    }

    /** Each RN alarm's request code (its row's `alarmId`); null when RN left no alarm database. */
    private fun rnAlarmIds(): List<List<Int>>? {
        val file = context.getDatabasePath(RN_DATABASE)
        if (!file.exists()) return null
        return SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { database ->
            val cursor = try {
                database.rawQuery("SELECT gson_data FROM alarmtbl", null)
            } catch (failure: Exception) {
                if (RnAlarmCleanup.isMissingTable(failure)) return emptyList()
                throw failure
            }
            RnAlarmCleanup.requestCodes(cursor.use { rows -> buildList { while (rows.moveToNext()) add(rows.getString(0)) } })
        }
    }

    /**
     * Every alarm this app made before an RN build ran (native → RN → native): RN's map no longer names them, so a plan would not
     * cancel one whose task was completed in RN, and Android keeps alarms across a package replace. The ledger goes with them.
     */
    private fun cancelEveryNative() = synchronized(LOCK) {
        val ledger = ReminderLedger.of(context)
        ledger.ids().forEach(::cancel)
        ledger.clear()
    }

    /**
     * RN's delivered reminders, shown again as they are without their buttons (RN's library posts each under its alarm's id on the
     * reminder channel). The first native plan runs after this cleanup, so a native reminder is here only after an RN recovery build
     * ran in between; it keeps its tap too.
     */
    private fun stripRnButtons() {
        for (shown in notifications.activeNotifications) {
            val notification = shown.notification
            if (NotificationCompat.getChannelId(notification) != CoreNotifications.REMINDER_CHANNEL || notification.actions.isNullOrEmpty()) continue
            notifications.notify(shown.tag, shown.id, Notification.Builder.recoverBuilder(context, notification).setActions().build())
        }
    }

    /** RN's alarm [id] as RN's library cancels it (AlarmUtil.stopAlarm): its explicit broadcast under that request code. */
    private fun cancelRn(id: Int) {
        val intent = Intent().setComponent(ComponentName(context.packageName, RN_RECEIVER))
        PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)?.let {
            alarms.cancel(it)
            it.cancel()
        }
    }
}

/**
 * An alarm fired: its notification, as RN's AlarmReceiver posts it, unless a plan cancelled the alarm or made it again for another
 * time while this delivery was on its way, or a one-shot comes more than a day late. A daily or weekly alarm is then made again by
 * core's plan (CoreWork), at the next time core's schedule gives, or not at all once it was turned off.
 */
class ReminderAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ReminderAlarms.FIRE) return
        val alarm = runCatching { JSONObject(intent.getStringExtra(ReminderAlarms.EXTRA_ALARM)!!) }.getOrNull() ?: return
        val repeat = alarm.optString("repeat", "once")
        val shown = runCatching {
            synchronized(ReminderAlarms.LOCK) {
                ReminderLedger.of(context).deliver(alarm.getInt("id"), alarm.getLong("fireAtMs"), repeat, System.currentTimeMillis())
                    .also { if (it) CoreNotifications.postReminder(context, alarm) }
            }
        }.onFailure { Log.w(CoreHost.TAG, "Native Android reminder not posted", it) }.getOrDefault(false)
        if (!shown) {
            Log.i(CoreHost.TAG, "Native Android reminder delivery dropped repeat=$repeat")
            runCatching { ReminderReceiverCounts.of(context).add(ReminderReceiverCounts.DROPPED) }
        }
        if (repeat != "once") {
            runCatching { CoreWork.enqueueDurably(this, context, CoreJob.REMINDERS, mapOf("mode" to "fired", "key" to alarm.getString("key"))) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android repeating reminder not queued", it) }
        }
    }
}

/**
 * A reminder notification's buttons, as RN's AlarmReceiver takes them: Dismiss clears it; Done and Snooze go to CoreWork as core's
 * journaled commands under the request UUID the notification was posted with, so a second tap or a retry is the same request.
 * Snooze sends the tap's time with it. The notification goes once WorkManager stored the job. Not exported: only this app's notifications
 * send these.
 */
class ReminderActionReceiver : BroadcastReceiver() {
    companion object {
        const val COMPLETE = "ACTION_COMPLETE"
        const val SNOOZE = "ACTION_SNOOZE"
        const val DISMISS = "ACTION_DISMISS"
        const val EXTRA_ID = "notificationId"
        const val EXTRA_REQUEST = "requestId"
        const val EXTRA_TASK = "taskId"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getIntExtra(EXTRA_ID, 0)
        val dismiss = { CoreNotifications.cancelReminder(context, id) }
        runCatching {
            when (intent.action) {
                DISMISS -> dismiss()
                COMPLETE -> CoreWork.enqueueDurably(this, context, CoreJob.REMINDER_DONE, mapOf(
                    "requestId" to intent.getStringExtra(EXTRA_REQUEST)!!, "taskId" to intent.getStringExtra(EXTRA_TASK)!!), done = dismiss)
                SNOOZE -> {
                    val alarm = JSONObject(intent.getStringExtra(ReminderAlarms.EXTRA_ALARM)!!)
                    val details = alarm.getJSONObject("details")
                    // Debug builds only (check-reminders-device.mjs): `debug.mindwtr.native.snooze_minutes` shortens RN's 10 minutes.
                    debugProperty("snooze_minutes").toDoubleOrNull()?.let { details.put("snooze_interval", it) }
                    CoreWork.enqueueDurably(this, context, CoreJob.REMINDER_SNOOZE, mapOf("requestId" to intent.getStringExtra(EXTRA_REQUEST)!!,
                        "requestedAt" to System.currentTimeMillis().toString(), "details" to details.toString()), done = dismiss)
                }
                else -> Unit
            }
        }.onFailure { Log.w(CoreHost.TAG, "Native Android reminder action not queued action=${intent.action}", it) }
    }
}

/**
 * Remakes every alarm after a reboot (Android dropped them all; RN's library re-arms its rows then), a clock or time zone change, an
 * update, and once Android allows exact alarms (RN's rescheduleLocalAlarmsAsExact). A remake, not a plain plan: the stored map says
 * each alarm is held, and only a remake re-arms one Android dropped. Exported as RN's boot receiver is: each of these actions only
 * the system sends. CoreWork runs core's plan; nothing here decides an alarm.
 */
class ReminderRescheduleReceiver : BroadcastReceiver() {
    companion object {
        /** Debug builds only (check-reminders-device.mjs): the same path, for a reboot or a time change the test phone cannot have. */
        const val DEBUG_RESCHEDULE = "tech.dongdongbh.mindwtr.debug.RESCHEDULE_REMINDERS"
        private val ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_MY_PACKAGE_REPLACED, AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action !in ACTIONS && !(action == DEBUG_RESCHEDULE && BuildConfig.DEBUG)) return
        // Device check only: cancellation after another alarm replaced the old alarm's task slot.
        if (action == DEBUG_RESCHEDULE && BuildConfig.DEBUG && intent.hasExtra("cancelReminderId")) {
            intent.getStringExtra("replacementAlarm")?.let { CoreNotifications.postReminder(context, JSONObject(it)) }
            CoreNotifications.cancelReminder(context, intent.getIntExtra("cancelReminderId", 0))
            return
        }
        Log.i(CoreHost.TAG, "Native Android reminders reschedule action=$action")
        // Held until WorkManager stored the job: a process that ends first would lose the remake until the next start.
        runCatching { CoreWork.enqueueDurably(this, context, CoreJob.REMINDERS, mapOf("mode" to "rebuild")) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android reminders reschedule not queued", it) }
    }
}
