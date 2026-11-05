package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


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

        assertEquals("Next", row("Next", statusHidden = null).meta.statusControl)

        assertNull(row(null, statusHidden = false).meta.statusControl)
    }
}
