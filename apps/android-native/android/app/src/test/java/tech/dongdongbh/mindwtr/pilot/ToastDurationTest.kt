package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test
import org.json.JSONObject


class ToastDurationTest {
    @Test fun aCoreToastShowsForItsOwnTime() {
        assertEquals(4_200L, toastDurationMs(JSONObject().put("message", "m").put("durationMs", 4200), null))
        assertEquals(4_800L, toastDurationMs(JSONObject().put("message", "m").put("durationMs", 4800), "Undo"))
    }

    @Test fun withoutATimeItTakesRnsDefault() {
        assertEquals(3_200L, toastDurationMs(JSONObject().put("message", "m"), null))
        assertEquals(3_200L, toastDurationMs(JSONObject().put("message", "m").put("durationMs", JSONObject.NULL), null))
        assertEquals(5_200L, toastDurationMs(JSONObject().put("message", "m"), "Undo"))
        assertEquals(3_200L, toastDurationMs(null, null))
    }
}
