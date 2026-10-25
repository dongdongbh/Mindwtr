package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** A project's "+" (O2f-parity b3): the opener's preset survives process death, on the draft and on its owed Save. */
class CaptureDraftPresetTest {
    private val preset = JSONObject().put("projectId", "p-home").put("status", "next")
    private val opened = CaptureDraft("session", "Oil the hinge", JSONObject().put("projectId", "p-home"), JSONObject())

    @Test fun aRestoredDraftKeepsItsPresetAndItsOwedSaveKeepsItToo() {
        val owed = FailedAction("capture", "capture-id", "Oil the hinge", patch = mapOf("options" to "{}", "openAfterSave" to "false", "preset" to preset.toString()))
        val restored = CaptureDraft.restore(opened.copy(preset = preset, pending = owed).state())
        assertEquals(preset.toString(), restored.preset.toString())
        // Try again after a restart sends the same request, preset included: the task never lands in the Inbox.
        assertEquals(preset.toString(), restored.pending?.patch?.get("preset"))
    }

    @Test fun theCenterPlusHasNoPreset() {
        assertNull(CaptureDraft.restore(opened.state()).preset)
    }
}
