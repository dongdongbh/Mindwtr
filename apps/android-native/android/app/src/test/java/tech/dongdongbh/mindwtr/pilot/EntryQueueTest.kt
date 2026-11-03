package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File


class EntryQueueTest {
    @get:Rule val folder = TemporaryFolder()

    private fun queue(limit: Int = 20) = EntryQueue(File(folder.root, "entries"), limit)

    @Test fun entriesOpenInTheOrderTheyCame() {
        val queue = queue()
        assertTrue(queue.add("""{"kind":"share","text":"first"}"""))
        assertTrue(queue.add("""{"kind":"share","text":"second"}"""))
        assertEquals(listOf("""{"kind":"share","text":"first"}""", """{"kind":"share","text":"second"}"""), queue.all().map { it.input })
        assertEquals("""{"kind":"share","text":"first"}""", queue.head()?.input)
    }

    @Test fun aSecondEntryNeverReplacesTheFirst() {
        val queue = queue()
        queue.add("""{"kind":"share","text":"same"}""")
        queue.add("""{"kind":"share","text":"same"}""")
        val (first, second) = queue.all()
        assertTrue(first.id != second.id)

        queue.remove(first.id)
        assertEquals(listOf(second), queue.all())
    }

    @Test fun theQueueSurvivesANewProcess() {
        queue().add("""{"kind":"link","url":"mindwtr-native-dev:///focus","scheme":"mindwtr-native-dev"}""")
        val restarted = queue()
        assertEquals("""{"kind":"link","url":"mindwtr-native-dev:///focus","scheme":"mindwtr-native-dev"}""", restarted.head()?.input)
    }

    @Test fun anEntryStaysUntilItsOwnIdIsRemoved() {
        val queue = queue()
        queue.add("""{"kind":"share","text":"kept"}""")
        val head = queue.head()!!
        queue.remove("another-id")
        assertEquals(head, queue.head())
        queue.remove(head.id)
        assertNull(queue.head())
        assertTrue(queue().all().isEmpty())
    }

    @Test fun aFullQueueTakesNoMore() {
        val queue = queue(limit = 2)
        assertTrue(queue.add("""{"n":1}"""))
        assertTrue(queue.add("""{"n":2}"""))
        assertFalse(queue.add("""{"n":3}"""))
        assertEquals(listOf("""{"n":1}""", """{"n":2}"""), queue.all().map { it.input })
    }

    @Test fun anEntryWithALineBreakIsRefused() {
        val queue = queue()
        assertFalse(queue.add("{\"text\":\"a\nb\"}"))
        assertTrue(queue.all().isEmpty())
    }

    @Test fun aDamagedLineIsSkipped() {
        val dir = File(folder.root, "entries").apply { mkdirs() }
        File(dir, "queue").writeText("broken line\nid-1\t{\"n\":1}\n")
        assertEquals(listOf(EntryQueue.Entry("id-1", """{"n":1}""")), queue().all())
    }

    @Test fun onlyARefusedInputIsDroppedAfterAFailedRead() {

        assertFalse(entryRetryable("INVALID_INPUT: An entry point is a link, a share or a note"))
        assertTrue(entryRetryable("NOT_READY: Native storage has not been loaded and validated"))
        assertTrue(entryRetryable("SAVE_FAILED: disk full"))
        assertTrue(entryRetryable("Core menuRead timed out"))
        assertTrue(entryRetryable(null))
    }
}
