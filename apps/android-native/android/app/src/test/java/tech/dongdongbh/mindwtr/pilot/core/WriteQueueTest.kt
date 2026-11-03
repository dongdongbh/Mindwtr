package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test


class WriteQueueTest {
    private data class Call(val method: String, val write: Boolean)

    @Test fun aWriteWaitsForTheWriteBeforeItWhileReadsStartAtOnce() {
        val queue = WriteQueue<Call> { it.write }

        val addFile = Call("attachmentAddFile", write = true)
        val links = Call("attachmentLinks", write = true)
        val read = Call("window", write = false)
        assertTrue(queue.admit(addFile))
        assertFalse("attachmentLinks waits for attachmentAddFile", queue.admit(links))
        assertTrue("a read starts while a write waits", queue.admit(read))
        assertNull("a read ending starts nothing", queue.ended(read))
        assertSame("attachmentAddFile answered: attachmentLinks starts", links, queue.ended(addFile))
        assertNull(queue.ended(links))
        assertTrue(queue.admit(Call("complete", write = true)))
    }

    @Test fun writesStartInTheOrderTheyCame() {
        val queue = WriteQueue<Call> { it.write }
        val writes = (1..4).map { Call("w$it", write = true) }
        assertTrue(queue.admit(writes[0]))
        writes.drop(1).forEach { assertFalse(queue.admit(it)) }
        val started = mutableListOf(writes[0])
        var next: Call? = queue.ended(writes[0])
        while (next != null) {
            started += next
            next = queue.ended(next)
        }
        assertEquals(writes, started)
    }

    @Test fun onlyTheRunningWriteEndingStartsTheNextAndCloseHandsBackTheWaiting() {
        val queue = WriteQueue<Call> { it.write }
        val first = Call("a", write = true)
        val second = Call("b", write = true)
        val nested = Call("nested", write = true)
        assertTrue(queue.admit(first))
        assertFalse(queue.admit(second))
        assertNull("a write never admitted (a nested call) ends without starting another", queue.ended(nested))
        assertEquals(listOf(second), queue.close())
        assertNull(queue.ended(first))
        assertTrue(queue.admit(Call("c", write = true)))
    }
}
