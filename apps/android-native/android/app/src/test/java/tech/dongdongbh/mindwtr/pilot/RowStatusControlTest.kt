package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Core's row meta as Android reads it: the status control hides on core's statusHidden flag, and the label stays (#1405). */
class RowStatusControlTest {
    private fun row(statusLabel: String?, statusHidden: Boolean?) = JSONObject().put("id", "t").put("title", "Task").put("status", "next")
        .put("isFocusedToday", false).put("laterToday", false)
        .put("meta", JSONObject().put("parts", JSONArray()).put("priority", JSONObject.NULL).put("statusLabel", statusLabel ?: JSONObject.NULL)
            .put("canFocus", true).put("swipe", JSONObject().put("target", "done").put("label", "Done").put("icon", "done"))
            .put("textDirection", "ltr").put("accessibilityLabel", "Task").put("descriptionPreview", JSONObject.NULL)
            .apply { statusHidden?.let { put("statusHidden", it) } })
        .taskRow()

    @Test fun hiddenStatusShowsNoControlButKeepsTheLabel() {
        val hidden = row("Next", statusHidden = true)
        assertNull(hidden.meta.statusControl)
        assertEquals("Next", hidden.meta.statusLabel)
        assertEquals("Next", row("Next", statusHidden = false).meta.statusControl)
        // A core older than the flag: the control shows, as before.
        assertEquals("Next", row("Next", statusHidden = null).meta.statusControl)
        // Reference has no control either way.
        assertNull(row(null, statusHidden = false).meta.statusControl)
    }
}
