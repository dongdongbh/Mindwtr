package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * RN b7bccbbc3 (#1475, apps/mobile/tests/use-root-layout-external-capture.test.tsx): a widget task or a share that arrives while
 * the app lock covers the app waits for the unlock, then opens once; the held entry is reported once.
 */
class EntryLockHoldTest {
    @get:Rule val folder = TemporaryFolder()

    private val queue by lazy { EntryQueue(File(folder.root, "entries")) }
    private val lifecycle by lazy { EntryLifecycle(queue) { 1_000L } }
    private val hold = EntryLockHold()
    private val reported = mutableListOf<String>()

    /** One EntryRouter.pump: the entry core would read now, or null. */
    private fun pump(locked: Boolean): EntryQueue.Entry? {
        if (hold.holds(locked, queue.head()) { reported += it.input }) return null
        return lifecycle.next(blocked = false)
    }

    @Test fun holdsATaskLinkWhileLockedAndOpensItOnceAfterTheUnlock() {
        val link = """{"kind":"link","url":"mindwtr://open?task=task-1"}"""
        queue.add(link)
        assertNull(pump(locked = true))
        assertNull(pump(locked = true))
        assertEquals(listOf(link), reported)

        val read = pump(locked = false)!!
        assertEquals(link, read.input)
        lifecycle.opened(read)
        assertNull(pump(locked = false))
        assertTrue(queue.all().isEmpty())
        assertEquals(listOf(link), reported)
    }

    @Test fun holdsAShareWhileLocked() {
        val share = """{"kind":"share","text":"Shared note","title":null,"subject":null}"""
        queue.add(share)
        assertNull(pump(locked = true))
        assertEquals(listOf(share), queue.all().map { it.input })
        assertEquals(share, pump(locked = false)?.input)
    }
}
