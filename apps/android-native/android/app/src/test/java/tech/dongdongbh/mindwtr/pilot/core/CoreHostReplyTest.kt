package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * A host method's reply as CoreHost reads it. Core answers some methods with no value (closeSyncSettings; before O2f also the
 * prompt activity request): reading that as a JSON object threw JSONException after the method had done its work, so every
 * start logged "Prompt activity not recorded" and every Sync screen close "Sync screen close failed".
 */
class CoreHostReplyTest {
    @Test fun aReplyWithNoValueIsAnEmptyObject() {
        assertEquals("{}", replyValue(JSONObject("""{"ok":true,"value":null}""")).toString())
        assertEquals("{}", replyValue(JSONObject("""{"ok":true}""")).toString())
    }

    @Test fun aReplyKeepsItsValueAndItsError() {
        assertEquals("""{"sent":true}""", replyValue(JSONObject("""{"ok":true,"value":{"sent":true}}""")).toString())
        val failure = assertThrows(IllegalStateException::class.java) { replyValue(JSONObject("""{"ok":false,"error":"ACTION_FAILED: no"}""")) }
        assertEquals("ACTION_FAILED: no", failure.message)
    }
}
