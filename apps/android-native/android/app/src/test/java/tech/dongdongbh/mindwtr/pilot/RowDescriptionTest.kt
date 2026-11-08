package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class RowDescriptionTest {
    private fun row(description: JSONObject?) = JSONObject().put("id", "t1").put("title", "Paint").put("status", "next").put("isFocusedToday", false)
        .put("laterToday", false).put("meta", JSONObject().put("parts", org.json.JSONArray()).put("canFocus", true)
            .put("swipe", JSONObject().put("target", "done").put("label", "Done").put("icon", "check"))
            .put("textDirection", "ltr").put("accessibilityLabel", "Paint")
            .put("descriptionPreview", if (description == null) JSONObject.NULL else "Two coats")
            .apply { if (description != null) put("description", description) })

    @Test fun aRowKeepsCoresDescriptionPreviewForRnsOneLineText() {
        val description = JSONObject().put("inline", org.json.JSONArray().put(JSONObject().put("type", "text").put("text", "Two coats"))).put("labels", JSONObject())
        val meta = row(description).taskRow().meta
        assertEquals("Two coats", meta.description?.let { JSONObject(it).getJSONArray("inline").getJSONObject(0).getString("text") })
        assertEquals(true, meta.hasDescription)
        assertNull(row(null).taskRow().meta.description)
    }
}
