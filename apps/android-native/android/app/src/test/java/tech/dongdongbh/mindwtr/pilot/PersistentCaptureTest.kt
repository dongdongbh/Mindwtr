package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The persistent capture notification's restore paths: core's answer applied whole, and every failure in core's log. */
class PersistentCaptureTest {
    private val on = JSONObject().put("post", JSONObject().put("title", "Quick capture").put("text", "Tap").put("channelName", "Capture"))
    private val off = JSONObject().put("post", JSONObject.NULL)

    @Test fun aFailedPostReachesTheDiagnosticsLog() {
        val lines = mutableListOf<Pair<String, String>>()
        PersistentCapture.restoreWith(read = { on }, granted = { true }, apply = { throw SecurityException("posting refused") },
            log = { message, context -> lines += message to context.toString() })
        assertEquals(listOf(PersistentCapture.FAILED to """{"error":"SecurityException"}"""), lines)
    }

    @Test fun offIsAppliedWithOrWithoutPermissionAndOnOnlyWithIt() {
        val applied = mutableListOf<JSONObject>()
        val lines = mutableListOf<String>()
        PersistentCapture.restoreWith(read = { off }, granted = { false }, apply = { applied += it }, log = { m, _ -> lines += m })
        PersistentCapture.restoreWith(read = { on }, granted = { false }, apply = { applied += it }, log = { m, _ -> lines += m })
        assertEquals(listOf(off), applied)
        assertEquals(0, lines.size)
    }

    /** Core answers ACTION_FAILED for a switch it cannot read (menuRead throws): nothing is posted or removed, one line is logged. */
    @Test fun anUnreadableSwitchKeepsTheNotificationAndIsLogged() {
        val applied = mutableListOf<JSONObject>()
        val lines = mutableListOf<String>()
        PersistentCapture.restoreWith(read = { throw IllegalStateException("ACTION_FAILED: The persistent capture switch could not be read") },
            granted = { true }, apply = { applied += it }, log = { m, _ -> lines += m })
        assertEquals(0, applied.size)
        assertEquals(listOf(PersistentCapture.FAILED), lines)
    }

    /** Off stored, then the process died before the notifier's mirror was cleared: the next start re-pins, the boot removes it. */
    @Test fun anInterruptedOffIsUndoneAtTheNextStart() {
        var mirror = true
        var shown = false
        PersistentCapture.startWith(restore = { if (mirror) shown = true }, keep = {})
        assertTrue(shown)
        PersistentCapture.restoreWith(read = { off }, granted = { true }, apply = { reply -> if (reply.isNull("post")) { mirror = false; shown = false } },
            log = { _, _ -> })
        assertFalse(shown)
        assertFalse(mirror)
        // And the start after that one re-pins nothing.
        PersistentCapture.startWith(restore = { if (mirror) shown = true }, keep = {})
        assertFalse(shown)
    }

    /**
     * RN 29b363e6e: a restore whose read the switch overtook acts on nothing; the switch already applied what is stored now.
     * Without it, turning the notification off while a resume's restore was reading could post it again.
     */
    @Test fun aRestoreTheSwitchOvertookAppliesNothing() {
        val applied = mutableListOf<JSONObject>()
        val logged = mutableListOf<String>()
        val log = { line: String, _: JSONObject -> logged += line }
        PersistentCapture.restoreWith(read = { PersistentCapture.switchApplied(); on }, granted = { true }, apply = { applied += it }, log = log)
        PersistentCapture.restoreWith(read = { on }, granted = { PersistentCapture.switchApplied(); true }, apply = { applied += it }, log = log)
        assertEquals(0, applied.size)
        // Each skip is in Settings › Diagnostics, so a tester's log shows the new path ran.
        assertEquals(listOf(PersistentCapture.OVERTAKEN, PersistentCapture.OVERTAKEN), logged)
        // A restore no switch overtook still applies, and logs nothing.
        PersistentCapture.restoreWith(read = { on }, granted = { true }, apply = { applied += it }, log = log)
        assertEquals(listOf(on), applied)
        assertEquals(2, logged.size)
    }

    /** A process start has no engine yet: its failure is kept (one short name) and the next boot's restore logs it once. */
    @Test fun aProcessStartFailureReachesTheDiagnosticsLogOnce() {
        var kept: String? = null
        PersistentCapture.startWith(restore = { throw IllegalStateException("no channel") }, keep = { kept = it })
        assertEquals("IllegalStateException", kept)
        val lines = mutableListOf<Pair<String, Map<String, String>>>()
        val take = { kept.also { kept = null } }
        repeat(2) {
            PersistentCapture.restoreWith(read = { off }, granted = { true }, apply = {}, startFailure = take,
                log = { m, c -> lines += m to c.keys().asSequence().associateWith { c.getString(it) } })
        }
        assertEquals(listOf(PersistentCapture.FAILED to mapOf("error" to "IllegalStateException", "path" to "process-start")), lines)
    }
}
