package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test


class ReminderJobTest {
    private val events = mutableListOf<String>()
    private var recovered = true
    private var doneFailure: Throwable? = null
    private val lines = mutableListOf<String>()

    private val calls = object : CoreJob.Calls {
        override fun recover(): Boolean { events += "recover"; return recovered }
        override fun drain(): Boolean { events += "drain"; return true }
        override fun contextAutomation(json: String): JSONObject = error("no context job here")
        override fun reminders(mode: String, key: String): JSONObject { events += "reminders $mode $key".trim(); return JSONObject() }
        override fun reminderDone(requestId: String, taskId: String): JSONObject {
            events += "done $requestId $taskId"
            doneFailure?.let { throw it }
            return JSONObject().put("changed", true)
        }
        override fun reminderSnooze(json: String): JSONObject {
            val input = JSONObject(json)
            events += "snooze ${input.getString("requestId")} ${input.getLong("requestedAt")} ${input.getJSONObject("details").getString("title")}"
            return JSONObject().put("id", 1_073_741_900).put("key", "snooze:${input.getString("requestId")}")
        }
    }

    private fun run(job: String, input: Map<String, String?>) = CoreJob.run(job, input,
        boot = { events += "boot"; calls },
        post = { events += "post" },
        refreshWidgets = { events += "widgets" },
        log = { message, fields -> lines += "$message ${fields.optString("job")} ${fields.optString("outcome")} ${fields.optString("error")}".trim() })

    @Test fun doneCompletesThroughCoreThenPlansTheAlarmsAgain() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.REMINDER_DONE, mapOf("requestId" to "r1", "taskId" to "t1")))
        assertEquals(listOf("boot", "recover", "drain", "done r1 t1", "reminders cycle", "widgets"), events)
    }

    @Test fun doneWaitsForRecoveryAndKeepsItsRequestForTheRetry() {
        recovered = false
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.REMINDER_DONE, mapOf("requestId" to "r1", "taskId" to "t1")))
        recovered = true
        doneFailure = IllegalStateException("SAVE_FAILED: disk full")
        assertEquals(CoreJob.Outcome.Retry, run(CoreJob.REMINDER_DONE, mapOf("requestId" to "r1", "taskId" to "t1")))
        doneFailure = null
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.REMINDER_DONE, mapOf("requestId" to "r1", "taskId" to "t1")))

        assertEquals(2, events.count { it == "done r1 t1" })
    }

    @Test fun aRefusedDoneNeverRetries() {
        doneFailure = IllegalStateException("INVALID_INPUT: A request UUID and a task ID are required")
        assertEquals(CoreJob.Outcome.Failure, run(CoreJob.REMINDER_DONE, mapOf("requestId" to "r1", "taskId" to "")))
        assertEquals(listOf("Native Android core work reminderDone failure INVALID_INPUT"), lines)
    }

    @Test fun snoozeSendsTheTapTimeWithItsRequestAndLeavesTheAlarmToTheEngine() {

        val details = JSONObject().put("title", "Pay rent").put("snooze_interval", 10).toString()
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.REMINDER_SNOOZE, mapOf("requestId" to "r2", "requestedAt" to "1790000000000", "details" to details)))
        assertEquals(listOf("boot", "recover", "drain", "snooze r2 1790000000000 Pay rent", "widgets"), events)
    }

    @Test fun aRepeatingAlarmThatFiredIsMadeAgainByCoresPlan() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.REMINDERS, mapOf("mode" to "fired", "key" to "digest:morning")))
        assertEquals(listOf("boot", "recover", "drain", "reminders fired digest:morning", "widgets"), events)
    }

    @Test fun aRescheduleRunsCoresPlanInItsMode() {
        assertEquals(CoreJob.Outcome.Success, run(CoreJob.REMINDERS, mapOf("mode" to "rebuild")))
        assertEquals(listOf("boot", "recover", "drain", "reminders rebuild", "widgets"), events)
    }


    private fun queueWith(queue: ((Throwable?) -> Unit) -> Unit) = DurableQueue.run(queue,
        done = { events += "dismiss" }, finish = { events += "finish" }, failed = { events += "failed ${it.message}" })

    @Test fun aButtonsNotificationGoesOnlyAfterWorkManagerStoredItsJob() {
        var stored: ((Throwable?) -> Unit)? = null
        queueWith { settle -> events += "enqueue"; stored = settle }
        assertEquals(listOf("enqueue"), events)
        stored!!(null)
        stored!!(null)
        assertEquals(listOf("enqueue", "dismiss", "finish"), events)
    }

    @Test fun aJobWorkManagerDidNotStoreKeepsTheNotificationAndStillEndsTheReceiver() {
        queueWith { settle -> settle(IllegalStateException("disk full")) }
        assertEquals(listOf("failed disk full", "finish"), events)
        events.clear()
        queueWith { throw IllegalStateException("no WorkManager") }
        assertEquals(listOf("failed no WorkManager", "finish"), events)
    }
}
