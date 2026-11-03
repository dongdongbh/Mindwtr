package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class ArchiveRetentionRunTest {
    private var editor = false
    private var project = false
    private var busy = false
    private var active = true
    private val sent = mutableListOf<Boolean>()

    private fun run(quiet: () -> Unit = {}) =
        archiveRetentionRun(quiet, { active }, { editor }, { project }, { busy }) { sent += it; "unchanged" }

    @Test fun nothingOpenRunsCore() {
        assertEquals("unchanged", run())
        assertEquals(listOf(false), sent)
    }

    @Test fun anEditorOrProjectOpenedWhileCoreWasBusySkips() {
        run { editor = true }
        editor = false
        run { project = true }
        assertEquals(listOf(true, true), sent)
    }


    @Test fun aTapWhoseEditorIsStillBeingReadSkips() {
        run { busy = true }
        assertEquals(listOf(true), sent)
    }

    @Test fun anAppThatLeftTheFrontSendsNothing() {
        assertNull(run { active = false })
        assertEquals(emptyList<Boolean>(), sent)
    }
}
