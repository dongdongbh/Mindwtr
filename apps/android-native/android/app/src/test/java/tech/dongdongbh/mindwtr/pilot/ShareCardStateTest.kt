package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class ShareCardStateTest {
    @Test
    fun openedDuringAWriteTheCardIsReadOnceTheWriteEnds() {
        val state = ShareCardState()
        assertFalse(state.readWanted(busy = true, failed = false))
        assertFalse(state.readWanted(busy = false, failed = true))
        assertTrue(state.readWanted(busy = false, failed = false))
    }

    @Test
    fun shareWaitsForTheCardOfTheLatestStyleAndReflection() {
        val state = ShareCardState()
        state.card = JSONObject().put("style", "reflection").put("reflection", "Less")
        state.reflection = "Less"
        assertTrue(state.shown)
        assertFalse(state.readWanted(busy = false, failed = false))
        state.reflection = "Less but better"
        assertFalse(state.shown)
        assertTrue(state.readWanted(busy = false, failed = false))
        state.reflection = "Less"
        state.style = "ripple"
        assertFalse(state.shown)
    }
}
