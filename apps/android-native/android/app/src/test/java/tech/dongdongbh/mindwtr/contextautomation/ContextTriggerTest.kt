package tech.dongdongbh.mindwtr.contextautomation

import org.junit.Assert.assertEquals
import org.junit.Test


class ContextTriggerTest {
    private val queued = mutableListOf<Map<String, String>>()

    @Test fun aTriggerIsQueuedWithItsActionAndContext() {
        assertEquals("queued", queueTrigger("activate", "@home") { queued += it })
        assertEquals(listOf(mapOf("action" to "activate", "context" to "@home")), queued)
    }

    @Test fun aContextPastCoresBoundIsDroppedBeforeWorkManagerSeesIt() {

        assertEquals("too-long", queueTrigger("activate", "x".repeat(12 * 1024)) { queued += it })
        assertEquals("queued", queueTrigger("activate", "x".repeat(2000)) { queued += it })
        assertEquals(1, queued.size)
    }

    @Test fun anEnqueueThatThrowsDropsTheTrigger() {
        assertEquals("failed", queueTrigger("deactivate", "@home") { throw IllegalStateException("Data cannot occupy more than 10240 bytes") })
    }
}
