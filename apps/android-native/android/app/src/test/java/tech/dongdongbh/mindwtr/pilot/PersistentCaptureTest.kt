package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


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


    @Test fun anUnreadableSwitchKeepsTheNotificationAndIsLogged() {
        val applied = mutableListOf<JSONObject>()
        val lines = mutableListOf<String>()
        PersistentCapture.restoreWith(read = { throw IllegalStateException("ACTION_FAILED: The persistent capture switch could not be read") },
            granted = { true }, apply = { applied += it }, log = { m, _ -> lines += m })
        assertEquals(0, applied.size)
        assertEquals(listOf(PersistentCapture.FAILED), lines)
    }


    @Test fun anInterruptedOffIsUndoneAtTheNextStart() {
        var mirror = true
        var shown = false
        PersistentCapture.startWith(restore = { if (mirror) shown = true }, keep = {})
        assertTrue(shown)
        PersistentCapture.restoreWith(read = { off }, granted = { true }, apply = { reply -> if (reply.isNull("post")) { mirror = false; shown = false } },
            log = { _, _ -> })
        assertFalse(shown)
        assertFalse(mirror)

        PersistentCapture.startWith(restore = { if (mirror) shown = true }, keep = {})
        assertFalse(shown)
    }


    @Test fun aRestoreTheSwitchOvertookAppliesNothing() {
        val applied = mutableListOf<JSONObject>()
        val logged = mutableListOf<String>()
        val log = { line: String, _: JSONObject -> logged += line }
        PersistentCapture.restoreWith(read = { PersistentCapture.switchApplied(); on }, granted = { true }, apply = { applied += it }, log = log)
        PersistentCapture.restoreWith(read = { on }, granted = { PersistentCapture.switchApplied(); true }, apply = { applied += it }, log = log)
        assertEquals(0, applied.size)

        assertEquals(listOf(PersistentCapture.OVERTAKEN, PersistentCapture.OVERTAKEN), logged)

        PersistentCapture.restoreWith(read = { on }, granted = { true }, apply = { applied += it }, log = log)
        assertEquals(listOf(on), applied)
        assertEquals(2, logged.size)
    }


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
