package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.Operation
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import tech.dongdongbh.mindwtr.pilot.core.HostNetwork
import tech.dongdongbh.mindwtr.pilot.core.debugProperty
import java.util.concurrent.TimeUnit

/**
 * CoreWork (D7): a WorkManager job that runs one named core job ([CoreJob]) while the app may be closed: the capture intent's
 * queue drain and its sync, a context trigger's notification, a reminder's Done or Snooze, the reminders planned again, the
 * scheduled background sync. It runs in the app's process on this process's one host: a running app's own,
 * or one this job boots with the app's boot order (ProcessCoreHost: validated load, journal replay, queue drain). Never in
 * another process: two hosts on one database reject each other's writes.
 */
class CoreWork(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        private const val JOB = "job"
        /**
         * Drains share one queue, so a new request replaces a waiting one (a drain waiting out a retry's back-off starts again
         * now); one in flight goes on to its end, and the new one runs anyway, so a file written meanwhile is never missed.
         * Core runs one drain at a time.
         */
        private const val INGEST_WORK = "mindwtr-core-ingest"

        /**
         * The scheduled background sync (CoreJob.SYNC), as RN's expo-background-task schedules its worker: one job 15 minutes
         * (core's MOBILE_BACKGROUND_SYNC_MINIMUM_INTERVAL_MINUTES) after the last ended, only with a network, that queues its own
         * next run when it ends. A one-time chain, not a periodic request, for two reasons: it is RN's own mechanism (Expo's worker
         * on Android 8+, which RN has shipped since its background sync), and WorkManager holds a periodic run back until its
         * period is due, so `cmd jobscheduler run -f` could not run it on the device check. A run whose next run WorkManager did not
         * store retries (CoreJob), and every foreground reconcile queues one when none is (KEEP), so the chain cannot end unseen.
         */
        const val SYNC_WORK = "mindwtr-core-background-sync"
        const val SYNC_INTERVAL_MINUTES = 15L
        /** RN's background sync worker (expo-background-task's BackgroundTaskScheduler WORKER_IDENTIFIER), in the same WorkManager. */
        const val RN_SYNC_WORK = "EXPO_BACKGROUND_WORKER"
        /** How long a job waits for WorkManager to store the work it queues; past it, the job retries. */
        private const val STORE_WAIT_SECONDS = 10L

        /**
         * Queues job [job] with [input] to run now, expedited where Android runs expedited work without a foreground notification
         * (Android 12+). Debug builds only: `debug.mindwtr.native.core_work_delay_ms` holds it back that long, so
         * check-runner-device.mjs can run it through JobScheduler (`cmd jobscheduler run -f`).
         */
        fun enqueue(context: Context, job: String, input: Map<String, String> = emptyMap()): Operation = enqueue(context, job, input, ExistingWorkPolicy.REPLACE)

        /**
         * Job [job] from a receiver whose process may end once it returns (a notification's button, a reboot): the receiver stays
         * alive (goAsync) until WorkManager stored the job, and only then [done] runs (the notification goes). A job WorkManager did
         * not store leaves the notification for another tap.
         */
        fun enqueueDurably(receiver: BroadcastReceiver, context: Context, job: String, input: Map<String, String>, done: () -> Unit = {}) {
            val pending = receiver.goAsync()
            DurableQueue.run(
                queue = { settle ->
                    val operation = enqueue(context, job, input)
                    operation.result.addListener({ settle(runCatching { operation.result.get() }.exceptionOrNull()) }, Runnable::run)
                },
                done = done,
                finish = pending::finish,
                failed = {
                    Log.w(CoreHost.TAG, "Native Android core work not queued job=$job", it)
                    // Every caller is a reminder receiver: the next plan's summary line reports it.
                    runCatching { ReminderReceiverCounts.of(context).add(ReminderReceiverCounts.NOT_QUEUED) }
                },
            )
        }

        /**
         * Core's schedule decision (host-sync.ts reconcileBackgroundSync): [on] keeps a queued or running sync job as it is (KEEP: a
         * reconcile never cancels the run that woke this process, RN's #1001 fix) or queues one; off cancels the chain.
         */
        fun scheduleSync(context: Context, on: Boolean): Operation = WorkManager.getInstance(context).let { work ->
            if (on) work.enqueueUniqueWork(SYNC_WORK, ExistingWorkPolicy.KEEP, syncRequest()) else work.cancelUniqueWork(SYNC_WORK)
        }

        /**
         * [scheduleSync] once WorkManager stored it (or cancelled it), waiting at most [STORE_WAIT_SECONDS]: the engine's bridge call
         * (CoreHost's bgSyncSchedule) returns its failure to core, which logs it; the next reconcile (start, resume, leave) retries.
         */
        fun scheduleSyncStored(context: Context, on: Boolean) {
            scheduleSync(context, on).result.get(STORE_WAIT_SECONDS, TimeUnit.SECONDS)
        }

        /** The running sync job's next run, appended after it: it waits its 15 minutes from this run's end. */
        fun syncAgain(context: Context): Operation =
            WorkManager.getInstance(context).enqueueUniqueWork(SYNC_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, syncRequest())

        /**
         * RN's background sync worker cancelled, at every process start (a no-op once gone): after the upgrade its class is not in
         * this app, and the native job replaces it. Never both. An RN recovery build schedules its own again when it runs.
         */
        fun cancelRnSync(context: Context): Operation = WorkManager.getInstance(context).cancelUniqueWork(RN_SYNC_WORK)

        /** What the queue drains stored and no background run settled yet (core's capture run sends it), in this app's preferences. */
        internal fun owedUploads(context: Context) = context.getSharedPreferences(BACKGROUND_SYNC_PREFS, Context.MODE_PRIVATE).let { prefs ->
            OwedUploads(read = { prefs.getInt(OWED_UPLOADS_KEY, 0) },
                write = { check(prefs.edit().putInt(OWED_UPLOADS_KEY, it).commit()) { "The owed upload count was not stored" } })
        }
        private const val BACKGROUND_SYNC_PREFS = "mindwtr-background-sync"
        private const val OWED_UPLOADS_KEY = "owedUploads"

        private fun syncRequest() = OneTimeWorkRequest.Builder(CoreWork::class.java)
            .setInputData(Data.Builder().putString(JOB, CoreJob.SYNC).build())
            .setInitialDelay(SYNC_INTERVAL_MINUTES, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()

        /**
         * A drain that did not finish, retried as the ingest job (ProcessCoreHost.recovered). KEEP: a drain job already waiting or
         * running (this boot may be its own) retries with its back-off instead.
         */
        fun retryDrain(context: Context) = enqueue(context, CoreJob.INGEST, emptyMap(), ExistingWorkPolicy.KEEP)

        private fun enqueue(context: Context, job: String, input: Map<String, String>, policy: ExistingWorkPolicy): Operation {
            val delayMs = debugProperty("core_work_delay_ms").toLongOrNull() ?: 0L
            val request = OneTimeWorkRequest.Builder(CoreWork::class.java)
                .setInputData(Data.Builder().putAll(input + (JOB to job)).build())
                .apply {
                    if (delayMs > 0) setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                }
                .build()
            val work = WorkManager.getInstance(context)
            val requestId = input["requestId"]
            return when {
                job == CoreJob.INGEST -> work.enqueueUniqueWork(INGEST_WORK, policy, request)
                // A reminder's Done or Snooze: a second tap on the same notification is the same request, queued once.
                requestId != null -> work.enqueueUniqueWork("mindwtr-core-$job-$requestId", ExistingWorkPolicy.KEEP, request)
                else -> work.enqueue(request)
            }
        }
    }

    override fun doWork(): Result {
        val app = applicationContext as Application
        val input = inputData.keyValueMap.filterKeys { it != JOB }.mapValues { it.value as? String }
        var booted: CoreHost? = null
        // Core's logger (logcat, and RN's diagnostics log while Debug logging is on) once the host is up; logcat before.
        val log: (String, JSONObject) -> Unit = { message, fields ->
            booted.let { host -> if (host != null) host.logLine(message, fields) else Log.i(CoreHost.TAG, "$message $fields") }
        }
        val outcome = CoreJob.run(inputData.getString(JOB), input,
            boot = {
                // The language chosen in this app's Settings, as the screens boot with it (InboxViewModel).
                val language = app.getSharedPreferences(DEVICE_PREFS, Context.MODE_PRIVATE).getString(LANGUAGE_KEY, null)
                val host = ProcessCoreHost.get(app, language).also { booted = it }
                object : CoreJob.Calls {
                    override fun recover() = ProcessCoreHost.recover(host)
                    override fun drain() = ProcessCoreHost.recovered(app, host)
                    override fun contextAutomation(json: String) = host.contextAutomation(json)
                    override fun reminders(mode: String, key: String) = host.remindersCycle(mode, key).also {
                        // A reboot, a clock change or an update: the Pomodoro's alerts are planned again with no phase settled first, as
                        // RN's boot receiver re-arms its stored alarm (at most a day late, stamped with its end; design R2b §4b).
                        if (mode == "rebuild") runCatching { PomodoroAlarms(app).plan(host) }
                            .onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro alarms not planned after a reschedule", it) }
                    }
                    override fun reminderDone(requestId: String, taskId: String) = host.reminderDone(requestId, taskId)
                    override fun reminderSnooze(json: String) = host.reminderSnooze(json)
                    override fun backgroundSync(trigger: String): JSONObject {
                        // What the drains stored goes with this run, unless the app is in front: its own triggers send it. It stays
                        // owed until the run settled (a throw keeps it for the retry).
                        val owed = owedUploads(app)
                        val stored = owed.owed()
                        // The network state, which no screen gave this process (sync's triggers start with the first screen).
                        runCatching { host.syncNetwork(HostNetwork(app) {}.state()) }
                        return host.backgroundSync(trigger, if (ProcessCoreHost.appActive) 0 else stored).also { owed.settle(stored) }
                    }
                    override fun appActive() = ProcessCoreHost.appActive
                }
            },
            post = { details ->
                val shown = CoreNotifications.post(app, details)
                log("Native Android notification", JSONObject().put("kind", details.optJSONObject("data")?.optString("kind") ?: JSONObject.NULL)
                    .put("outcome", if (shown) "posted" else "blocked"))
            },
            // What the job stored reaches the home-screen widgets before the job ends.
            refreshWidgets = { runCatching { booted?.refreshWidgets() }.onFailure { Log.w(CoreHost.TAG, "Native Android widget refresh failed", it) } },
            log = log,
            // Not once WorkManager stopped this run (sync turned off cancels the chain). Stored, or this run retries.
            syncAgain = { isStopped || runCatching { syncAgain(app).result.get(STORE_WAIT_SECONDS, TimeUnit.SECONDS) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android sync job not queued again", it) }.isSuccess },
            // A capture's upload owned: the scheduled job stored (KEEP: one queued or running stays as it is).
            ensureSync = { runCatching { scheduleSyncStored(app, true) }.onFailure { Log.w(CoreHost.TAG, "Native Android sync job not stored", it) }.isSuccess })
        return when (outcome) {
            CoreJob.Outcome.Success -> Result.success()
            CoreJob.Outcome.Retry -> Result.retry()
            CoreJob.Outcome.Failure -> Result.failure()
        }
    }
}

/**
 * A receiver's job handed to CoreWork (CoreWork.enqueueDurably; JVM-tested: ReminderJobTest): [queue] enqueues it and calls its
 * argument once WorkManager answered (null: stored). [done] runs only once stored, [failed] otherwise, then [finish] (the receiver's
 * end), once, whatever happened.
 */
internal object DurableQueue {
    fun run(queue: ((Throwable?) -> Unit) -> Unit, done: () -> Unit, finish: () -> Unit, failed: (Throwable) -> Unit) {
        val settled = java.util.concurrent.atomic.AtomicBoolean(false)
        val settle = { failure: Throwable? ->
            if (settled.compareAndSet(false, true)) {
                try {
                    if (failure == null) done() else failed(failure)
                } finally {
                    finish()
                }
            }
        }
        try {
            queue(settle)
        } catch (failure: Throwable) {
            settle(failure)
        }
    }
}
