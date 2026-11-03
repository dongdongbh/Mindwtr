package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test


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
