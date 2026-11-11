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


class CoreWork(context: Context, params: WorkerParameters) : Worker(context, params) {
    companion object {
        private const val JOB = "job"


        private const val INGEST_WORK = "mindwtr-core-ingest"


        const val SYNC_WORK = "mindwtr-core-background-sync"
        const val SYNC_INTERVAL_MINUTES = 15L

        const val RN_SYNC_WORK = "EXPO_BACKGROUND_WORKER"

        private const val STORE_WAIT_SECONDS = 10L


        fun enqueue(context: Context, job: String, input: Map<String, String> = emptyMap()): Operation = enqueue(context, job, input, ExistingWorkPolicy.REPLACE)


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

                    runCatching { ReminderReceiverCounts.of(context).add(ReminderReceiverCounts.NOT_QUEUED) }
                },
            )
        }


        fun scheduleSync(context: Context, on: Boolean): Operation = WorkManager.getInstance(context).let { work ->
            if (on) work.enqueueUniqueWork(SYNC_WORK, ExistingWorkPolicy.KEEP, syncRequest()) else work.cancelUniqueWork(SYNC_WORK)
        }


        fun scheduleSyncStored(context: Context, on: Boolean) {
            scheduleSync(context, on).result.get(STORE_WAIT_SECONDS, TimeUnit.SECONDS)
        }


        fun syncAgain(context: Context): Operation =
            WorkManager.getInstance(context).enqueueUniqueWork(SYNC_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, syncRequest())


        fun cancelRnSync(context: Context): Operation = WorkManager.getInstance(context).cancelUniqueWork(RN_SYNC_WORK)


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

                requestId != null -> work.enqueueUniqueWork("mindwtr-core-$job-$requestId", ExistingWorkPolicy.KEEP, request)
                else -> work.enqueue(request)
            }
        }
    }

    override fun doWork(): Result {
        val app = applicationContext as Application
        if (Workspace.sandbox) return Result.retry()
        val input = inputData.keyValueMap.filterKeys { it != JOB }.mapValues { it.value as? String }
        var booted: CoreHost? = null

        val log: (String, JSONObject) -> Unit = { message, fields ->
            booted.let { host -> if (host != null) host.logLine(message, fields) else Log.i(CoreHost.TAG, "$message $fields") }
        }
        val outcome = CoreJob.run(inputData.getString(JOB), input,
            boot = {

                val language = app.getSharedPreferences(DEVICE_PREFS, Context.MODE_PRIVATE).getString(LANGUAGE_KEY, null)
                val host = ProcessCoreHost.get(app, language).also { booted = it }
                check(!ProcessCoreHost.isSandbox(host)) { "A background job never runs in a sandbox process" }
                object : CoreJob.Calls {
                    override fun recover() = ProcessCoreHost.recover(host)
                    override fun drain() = ProcessCoreHost.recovered(app, host)
                    override fun contextAutomation(json: String) = host.contextAutomation(json)
                    override fun reminders(mode: String, key: String) = host.remindersCycle(mode, key).also {


                        if (mode == "rebuild") runCatching { PomodoroAlarms(app).plan(host) }
                            .onFailure { Log.w(CoreHost.TAG, "Native Android Pomodoro alarms not planned after a reschedule", it) }
                    }
                    override fun reminderDone(requestId: String, taskId: String) = host.reminderDone(requestId, taskId)
                    override fun reminderSnooze(json: String) = host.reminderSnooze(json)
                    override fun backgroundSync(trigger: String): JSONObject {


                        val owed = owedUploads(app)
                        val stored = owed.owed()

                        runCatching { host.syncNetwork(HostNetwork(app) {}.state()) }
                        return host.backgroundSync(trigger, if (ProcessCoreHost.appActive) 0 else stored).also { owed.settle(stored) }
                    }
                    override fun appActive() = ProcessCoreHost.appActive
                    override fun calendarSnapshot() = host.calendarPushSnapshot()
                    override fun calendarPush(job: String, snapshot: String): String {
                        val outcome = runCatching { host.calendarPushBackground(snapshot) }.getOrDefault("failed")
                        if (outcome == "pushed" || outcome == "failed" || outcome == "timeout") host.logLine("Native Android calendar push after background work releaseCheck=v1.3.9/native-calendar-push-background",
                            JSONObject().put("releaseCheck", "v1.3.9/native-calendar-push-background").put("job", job).put("outcome", outcome))
                        return outcome
                    }
                }
            },
            post = { details ->
                val shown = CoreNotifications.post(app, details)
                log("Native Android notification", JSONObject().put("kind", details.optJSONObject("data")?.optString("kind") ?: JSONObject.NULL)
                    .put("outcome", if (shown) "posted" else "blocked"))
            },

            refreshWidgets = { runCatching { booted?.refreshWidgets() }.onFailure { Log.w(CoreHost.TAG, "Native Android widget refresh failed", it) } },
            log = log,

            syncAgain = { isStopped || runCatching { syncAgain(app).result.get(STORE_WAIT_SECONDS, TimeUnit.SECONDS) }
                .onFailure { Log.w(CoreHost.TAG, "Native Android sync job not queued again", it) }.isSuccess },

            ensureSync = { runCatching { scheduleSyncStored(app, true) }.onFailure { Log.w(CoreHost.TAG, "Native Android sync job not stored", it) }.isSuccess })
        return when (outcome) {
            CoreJob.Outcome.Success -> Result.success()
            CoreJob.Outcome.Retry -> Result.retry()
            CoreJob.Outcome.Failure -> Result.failure()
        }
    }
}


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
