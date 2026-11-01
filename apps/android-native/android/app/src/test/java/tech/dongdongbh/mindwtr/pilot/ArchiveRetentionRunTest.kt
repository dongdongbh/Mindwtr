package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** InboxViewModel's Archive retention run: whether an editor is open is read once core is quiet, a tap still opening one included. */
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

    // Review BLOCK 1: a tap on an old archived task during a long sync takes busy at once; its editor is set only after its read.
    @Test fun aTapWhoseEditorIsStillBeingReadSkips() {
        run { busy = true }
        assertEquals(listOf(true), sent)
    }

    @Test fun anAppThatLeftTheFrontSendsNothing() {
        assertNull(run { active = false })
        assertEquals(emptyList<Boolean>(), sent)
    }
}
