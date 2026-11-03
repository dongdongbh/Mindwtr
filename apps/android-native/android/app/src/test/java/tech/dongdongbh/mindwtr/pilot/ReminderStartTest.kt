package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test


class ReminderStartTest {
    private val events = mutableListOf<String>()
    private var startFailure: Throwable? = null
    private val start = ReminderStart<String>(
        start = { host -> events += "start $host"; startFailure?.let { throw it }; JSONObject().put("ask", true) },
        cycle = { host -> events += "cycle $host" },
    )

    @Test fun aResumeBeforeTheBootStartedTheRemindersDoesNothing() {
        start.resume()
        assertEquals(emptyList<String>(), events)
    }

    @Test fun aResumeAfterAFailedStartStartsAgainThenEachLaterResumePlansOnce() {
        startFailure = IllegalStateException("plan failed")
        assertThrows(IllegalStateException::class.java) { start.start("host") }
        assertEquals(null, start.reply)
        startFailure = null
        start.resume()
        assertEquals(true, start.reply?.optBoolean("ask"))
        start.resume()
        start.start("host")
        assertEquals(listOf("start host", "start host", "cycle host"), events)
    }

    @Test fun aReceiversDropsAndUnstoredJobsAreCountedUntilThePlansSummaryTakesThem() {
        val stored = mutableMapOf<String, Int>()
        val counts = ReminderReceiverCounts(read = { stored[it] ?: 0 }, write = { stored.putAll(it) })
        counts.add(ReminderReceiverCounts.DROPPED)
        counts.add(ReminderReceiverCounts.DROPPED)
        counts.add(ReminderReceiverCounts.NOT_QUEUED)
        fun text(counts: org.json.JSONObject) = "${counts.getInt("dropped")} ${counts.getInt("notQueued")}"
        assertEquals("2 1", text(counts.take()))
        assertEquals("0 0", text(counts.take()))
    }
}
