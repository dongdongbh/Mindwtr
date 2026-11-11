package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test


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
    private var calendarOutcome = "unavailable"
    private var calendarFailure: Throwable? = null
    private val calendarPushes = mutableListOf<String>()
    private val calendarSnapshots = mutableListOf<String>()

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
        override fun calendarSnapshot(): String {
            calendarSnapshots += "after ${events.last()}"
            return "snap${calendarSnapshots.size}"
        }
        override fun calendarPush(job: String, snapshot: String): String {
            calendarPushes += "$job $snapshot after ${events.last()}"
            calendarFailure?.let { throw it }
            return calendarOutcome
        }
        override fun reminderDone(requestId: String, taskId: String): JSONObject {
            events += "done $taskId"
            return JSONObject()
        }
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
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "reminders background sync", "ensure", "widgets"), events)
    }


    @Test fun aCaptureJobSendsWhatItStoredBeforeItEnds() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "reminders background sync", "ensure", "widgets"), events)
        assertEquals(listOf("Native Android core work ingest success"), lines)
    }


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
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "reminders background sync", "widgets"), events)
    }

    @Test fun aCaptureWhoseScheduledJobIsNotStoredRetries() {
        ensured = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture", "reminders background sync", "ensure"), events)
    }

    @Test fun aCaptureWhoseSyncThrowsRetriesItsUpload() {

        syncFailure = IllegalStateException("Core backgroundSync timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(listOf("boot", "recover", "drain", "widgets", "reminders background capture", "sync capture"), events)
        assertEquals(listOf("Native Android core work ingest retry Core backgroundSync timed out"), lines)
    }

    @Test fun whatTheDrainsStoredIsOwedUntilARunSettlesItAcrossProcessDeath() {
        var stored = 0
        val first = OwedUploads(read = { stored }, write = { stored = it })
        first.add(2)

        val restarted = OwedUploads(read = { stored }, write = { stored = it })
        val owed = restarted.owed()
        assertEquals(2, owed)

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


    @Test fun aBackgroundSyncPlansTheRemindersOfWhatItSyncedBeforeItEnds() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("sync scheduled", "reminders background sync"), events.filter { it.startsWith("sync") || it.startsWith("reminders") })
        assertEquals("cycled", diagnostics.single().getString("reminders"))
    }


    @Test fun aCaptureJobPlansItsRemindersBeforeItSends() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("reminders background capture", "sync capture", "reminders background sync"), events.filter { it.startsWith("sync") || it.startsWith("reminders") })
        assertEquals("cycled", diagnostics.single().getString("reminders"))
    }


    @Test fun aReminderPlanThatFailsNeverFailsTheJob() {
        remindersFailure = IllegalStateException("NOT_READY: storage")
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals("failed", diagnostics.single().getString("reminders"))
        events.clear(); diagnostics.clear()
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals("failed", diagnostics.single().getString("reminders"))
    }

    @Test fun theSyncJobSkipsWhileTheAppIsInFrontAndQueuesItsNext() {

        appActive = true
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "again", "widgets"), events)
    }

    @Test fun aSyncJobWhoseRunFailsRetriesAndKeepsItsPlaceInTheChain() {
        syncFailure = IllegalStateException("Core backgroundSync timed out")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.SYNC))
        assertEquals(listOf("boot", "recover", "drain", "sync scheduled"), events)
    }


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

        assertEquals(CoreJob.Outcome.Failure, run(CoreJob.CONTEXT, mapOf("action" to "activate", "context" to "@home")))
        assertEquals(listOf("boot", "recover", "drain", "context activate @home"), events)
    }

    @Test fun anUnknownJobBootsNothing() {
        assertEquals(CoreJob.Outcome.Failure, run("sync"))
        assertEquals(CoreJob.Outcome.Failure, run(null))
        assertEquals(emptyList<String>(), events)
    }


    @Test fun aBackgroundJobThatChangesTasksSnapshotsBeforeItsWorkAndPushesAfterTheWidgets() {
        calendarOutcome = "pushed"
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.REMINDER_DONE, mapOf("requestId" to "r", "taskId" to "t")))
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.SYNC))
        assertEquals(listOf("after boot", "after boot", "after boot"), calendarSnapshots)
        assertEquals(listOf("ingest snap1 after widgets", "reminderDone snap2 after widgets", "backgroundSync snap3 after widgets"), calendarPushes)
    }


    @Test fun theCalendarWaitsForTheAppWhenItIsOpenAndNeverRunsAfterOtherJobsOrAFailure() {
        calendarOutcome = "pushed"
        appActive = true
        run(CoreJob.INGEST)
        appActive = false
        run(CoreJob.REMINDER_SNOOZE, mapOf("requestId" to "r"))
        run(CoreJob.REMINDERS, mapOf("mode" to "cycle"))
        drained = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.INGEST))
        assertEquals(emptyList<String>(), calendarPushes)
        assertEquals(listOf("after boot"), calendarSnapshots)
    }


    @Test fun aFailedCalendarPushNeverFailsTheJob() {
        calendarFailure = IllegalStateException("boom")
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.INGEST))
        assertEquals(listOf("ingest snap1 after widgets"), calendarPushes)
        assertEquals("Native Android core work ingest success", lines.last())
    }
}
