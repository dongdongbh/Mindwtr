package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test


class PassphraseFieldsTest {
    private val tooLong = "A passphrase can be at most 1,000 characters."
    private fun submit(flow: String) = JSONObject().put("type", "submit").put("flow", flow)

    @Test fun anEditPastTheLimitIsRefusedAndBlocksSubmit() {
        val fields = PassphraseFields()
        assertNotNull(fields.type("next", "x".repeat(1000), 1000, tooLong))
        assertTrue(fields.submittable)
        assertNull(fields.type("next", "x".repeat(1001), 1000, tooLong))

        assertEquals("x".repeat(1000), fields.texts["next"])
        assertFalse(fields.submittable)
        assertEquals(tooLong, fields.admit(submit("enable")))

        assertNotNull(fields.type("confirm", "y", 1000, tooLong))
        assertFalse(fields.submittable)
        assertNotNull(fields.type("next", "x".repeat(999), 1000, tooLong))
        assertTrue(fields.submittable)
    }

    @Test fun anEditCoreRefusesBlocksSubmitUntilCoreTakesALaterOne() {
        val fields = PassphraseFields()

        val first = fields.type("next", "correct horse", 1000, tooLong)!!
        fields.settled("next", first, "Storage is busy")
        assertFalse(fields.submittable)
        assertEquals("Storage is busy", fields.admit(submit("change")))

        val second = fields.type("next", "correct horse battery", 1000, tooLong)!!
        val third = fields.type("next", "correct horse battery staple", 1000, tooLong)!!
        fields.settled("next", second, "Storage is busy")
        fields.settled("next", third, null)
        assertTrue(fields.submittable)
        fields.settled("next", second, "Storage is busy")
        assertTrue(fields.submittable)

        val fourth = fields.type("next", "ok", 1000, tooLong)!!
        assertNull(fields.type("next", "x".repeat(1001), 1000, tooLong))
        fields.settled("next", fourth, null)
        assertEquals(tooLong, fields.admit(submit("change")))
    }

    @Test fun changingFlowDropsARefusalSoAbandonIsNeverBlocked() {
        val fields = PassphraseFields()

        fields.settled("current", fields.type("current", "p", 1000, tooLong)!!, "Storage is busy")
        assertFalse(fields.submittable)

        assertNull(fields.admit(submit("abandon")))
        assertNull(fields.admit(JSONObject().put("type", "open").put("flow", "abandon")))
        assertTrue(fields.submittable)
        assertEquals(emptyMap<String, String>(), fields.texts)

        assertNull(fields.type("next", "x".repeat(1001), 1000, tooLong))
        assertNull(fields.admit(JSONObject().put("type", "cancel")))
        assertTrue(fields.submittable)
        assertNull(fields.type("next", "x".repeat(1001), 1000, tooLong))
        assertNull(fields.admit(JSONObject().put("type", "retry")))
        assertTrue(fields.submittable)
    }

    @Test fun aGeneratedPassphraseFillsBothNewFieldsAndClearingForgetsEverything() {
        val fields = PassphraseFields()
        assertNull(fields.type("confirm", "z".repeat(1001), 1000, tooLong))
        val pending = fields.type("next", "typed before generate", 1000, tooLong)!!
        fields.generated("acid tremble anchor velvet orbit")
        assertEquals(mapOf("next" to "acid tremble anchor velvet orbit", "confirm" to "acid tremble anchor velvet orbit"), fields.texts)
        assertTrue(fields.submittable)

        fields.settled("next", pending, "Storage is busy")
        assertTrue(fields.submittable)
        assertNull(fields.type("current", "c".repeat(2000), 1000, tooLong))
        fields.clear()
        assertEquals(emptyMap<String, String>(), fields.texts)
        assertTrue(fields.submittable)
    }
}
