package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** One CoreWork run: the host's boot first (the app's boot order), then the one named job, then the widgets' refresh. */
class CoreJobTest {
    private val events = mutableListOf<String>()
    private var drained = true
    private var recovered = true
    private var notification: JSONObject? = JSONObject().put("title", "@home next action")
    private var bootFailure: Throwable? = null
    private var jobFailure: Throwable? = null
    private var contextFailure: Throwable? = null
    private var syncFailure: Throwable? = null
    private var syncWanted = true
    private var appActive = false
    private var nextStored = true
    private var ensured = true
    private var remindersFailure: Throwable? = null

    private val calls = object : CoreJob.Calls {
        override fun recover(): Boolean {
            events += "recover"
            return recovered
        }
        override fun drain(): Boolean {
            events += "drain"
            jobFailure?.let { throw it }
            return drained
        }
        override fun contextAutomation(json: String): JSONObject {
            JSONObject(json).let { events += "context ${it.getString("action")} ${it.getString("context")}" }
            contextFailure?.let { throw it }
            return JSONObject().put("notification", notification ?: JSONObject.NULL)
        }
        override fun backgroundSync(trigger: String): JSONObject {
            events += "sync $trigger"
            syncFailure?.let { throw it }
            return JSONObject().put("schedule", syncWanted)
        }
        override fun appActive() = appActive
        override fun reminders(mode: String, key: String): JSONObject {
            events += "reminders $mode $key"
            remindersFailure?.let { throw it }
            return JSONObject().put("outcome", "cycle-completed")
        }
    }

    private fun run(job: String?, input: Map<String, String?> = emptyMap()) = CoreJob.run(job, input,
        boot = { events += "boot"; bootFailure?.let { throw it }; calls },
        post = { events += "post ${it.getString("title")}" },
        refreshWidgets = { events += "widgets" },
        syncAgain = { events += "again"; nextStored },
        ensureSync = { events += "ensure"; ensured },
        log = { message, fields ->
            diagnostics += fields
            lines += "$message ${fields.optString("job")} ${fields.optString("outcome")} ${fields.optString("error")}".trim()
        })

    private val lines = mutableListOf<String>()
    private val diagnostics = mutableListOf<JSONObject>()

    @Test fun selectingAWidgetListRecoversThenRefreshesWithoutRequestingSync() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.WIDGET_REFRESH))
        assertEquals(listOf("boot", "recover", "drain", "widgets"), events)
        assertEquals(listOf("Native Android core work widgetRefresh success"), lines)
        assertEquals("v1.3.8/widget-selection-refresh", diagnostics.single().getString("releaseCheck"))
        assertEquals("requested", diagnostics.single().getString("refresh"))
    }

    @Test fun selectingAWidgetListWaitsForCanonicalRecovery() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.WIDGET_REFRESH))
        assertEquals(listOf("boot", "recover"), events)
    }

    @Test fun theHostBootsBeforeTheJobAndWidgetsRefreshAfterIt() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "ensure", "widgets"), events)
    }

    // #1257: what a capture job stored while the app was closed is sent before the job ends (core's capture run), never after.
    @Test fun aCaptureJobSendsWhatItStoredBeforeItEnds() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "ensure", "widgets"), events)
        assertEquals(listOf("Native Android core work ingest success"), lines)
    }

    // Review S4a 2: a capture job succeeds only once its upload is owned: sent, or failed and recorded with the scheduled job in
    // WorkManager to retry it (the first native start after RN's may be a capture, with no screen to schedule it).
    // A widget tap or a capture is stored and drawn before the job waits for any sync (a dead server can hold that for minutes).
    @Test fun aCaptureJobStoresAndDrawsWhatItDrainedBeforeItWaitsForTheSync() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("drain", "widgets", "reminders background capture", "sync capture"), events.filter { it in setOf("drain", "widgets", "reminders background capture", "sync capture") }.take(4))
    }

    @Test fun aCaptureJobMakesSureTheScheduledJobExistsWhenCoreWantsIt() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("sync capture", "ensure"), events.filter { it == "sync capture" || it == "ensure" })
        events.clear()
        syncWanted = false
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "widgets"), events)
    }

    @Test fun aCaptureWhoseScheduledJobIsNotStoredRetries() {
        ensured = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "ensure"), events)
    }

    @Test fun aCaptureWhoseSyncThrowsRetriesItsUpload() {
        // The capture is committed; the retry sends it (the count it owes survives in OwedUploads).
        syncFailure = IllegalStateException("Core backgroundSync timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture"), events)
        assertEquals(listOf("Native Android core work ingest retry Core backgroundSync timed out"), lines)
    }

    @Test fun whatTheDrainsStoredIsOwedUntilARunSettlesItAcrossProcessDeath() {
        var stored = 0
        val first = OwedUploads(read = { stored }, write = { stored = it })
        first.add(2)
        // A new process reads the same store.
        val restarted = OwedUploads(read = { stored }, write = { stored = it })
        val owed = restarted.owed()
        assertEquals(2, owed)
        // A capture stored while that run went on stays owed.
        restarted.add(1)
        restarted.settle(owed)
        assertEquals(1, restarted.owed())
        first.add(0)
        assertEquals(1, stored)
    }

    @Test fun theSyncJobRunsCoresScheduledRunThenQueuesItsNext() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled", "reminders background sync", "again", "widgets"), events)
    }

    @Test fun theSyncJobQueuesNoNextRunOnceCoreSaysItIsNotWanted() {
        syncWanted = false
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled", "reminders background sync", "widgets"), events)
    }

    // #1424 (RN 64f35d79d): tasks a background sync brought get their alarms before the job ends; core's 2.5 s store timer may
    // never fire in a job's process, and a cold job planned once before the sync.
    @Test fun aBackgroundSyncPlansTheRemindersOfWhatItSyncedBeforeItEnds() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("sync scheduled", "reminders background sync"), events.filter { it.startsWith("sync") || it.startsWith("reminders") })
        assertEquals("cycled", diagnostics.single().getString("reminders"))
    }

    // #1398 (RN a7da952cf): a capture's reminder is set by the job that stored it, before its sync's wait.
    @Test fun aCaptureJobPlansItsRemindersBeforeItSends() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("reminders background capture", "sync capture"), events.filter { it.startsWith("sync") || it.startsWith("reminders") })
        assertEquals("cycled", diagnostics.single().getString("reminders"))
    }

    // RN's background reconcile never fails its job: a plan that throws is logged, and the sync still runs.
    @Test fun aReminderPlanThatFailsNeverFailsTheJob() {
        remindersFailure = IllegalStateException("NOT_READY: storage")
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals("failed", diagnostics.single().getString("reminders"))
        events.clear(); diagnostics.clear()
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals("failed", diagnostics.single().getString("reminders"))
    }

    @Test fun theSyncJobSkipsWhileTheAppIsInFrontAndQueuesItsNext() {
        // RN's Expo worker runs nothing while the app is in the foreground (its triggers sync) and schedules the next run.
        appActive = true
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "again", "widgets"), events)
    }

    @Test fun aSyncJobWhoseRunFailsRetriesAndKeepsItsPlaceInTheChain() {
        syncFailure = IllegalStateException("Core backgroundSync timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled"), events)
    }

    // Review S4a 3: a next run WorkManager did not store would end the chain; the job retries instead of reporting success.
    @Test fun aSyncJobWhoseNextRunIsNotStoredRetries() {
        nextStored = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled", "reminders background sync", "again"), events)
    }

    @Test fun aSyncJobWaitsForRecoveryAndTheDrain() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover"), events)
    }

    @Test fun anOwedJournalThatStillFailsRetriesLaterAndDrainsNothing() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover"), events)
    }

    @Test fun aContextTriggerWaitsForRecoveryAndTheDrain() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        recovered = true
        drained = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        // Nothing was posted from unfinished state.
        assertEquals(listOf("boot", "recover", "boot", "recover", "drain"), events)
    }

    @Test fun aDrainThatMustWaitRetriesLater() {
        drained = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain"), events)
    }

    @Test fun aFailedDrainRetriesLater() {
        jobFailure = IllegalStateException("Core ingest timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain"), events)
    }

    @Test fun eachRunLogsOneLineWithItsJobOutcomeAndOnlyAFailuresCode() {
        run(CoreJob.INGEST)
        jobFailure = IllegalStateException("SAVE_FAILED: Buy milk for Anna")
        run(CoreJob.INGEST)
        run("sync")
        assertEquals(listOf("Native Android core work ingest success", "Native Android core work ingest retry SAVE_FAILED",
            "Native Android core work sync unknown"), lines)
    }

    @Test fun aBootThatFailsRunsNoJob() {
        bootFailure = IllegalStateException("Incomplete tasks load")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        // A trigger whose recovery cannot finish waits for it too.
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "boot"), events)
    }

    @Test fun aContextTriggerPostsCoresNotification() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context activate @home", "post @home next action", "widgets"), events)
    }

    @Test fun aTriggerCoreAnswersWithNoNotificationPostsNothing() {
        notification = null
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.CONTEXT, mapOf("action" to "deactivate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context deactivate @home", "widgets"), events)
    }

    @Test fun aFailedTriggerIsNotRetried() {
        contextFailure = IllegalStateException("Core contextAutomation timed out")
        // A late notification would describe a moment that has passed: RN's headless task does not retry either.
        assertEquals(CoreJob.Outcome.Failure, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context activate @home"), events)
    }

    @Test fun anUnknownJobBootsNothing() {
        assertEquals(CoreJob.Outcome.Failure, run("sync"))
        assertEquals(CoreJob.Outcome.Failure, run(null))
        assertEquals(emptyList<String>(), events)
    }
}
