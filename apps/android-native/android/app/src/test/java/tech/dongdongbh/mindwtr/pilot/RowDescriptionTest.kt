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

    @Test fun focusSchedulePresentationKeepsExactSpokenDatesAndDefaultsOtherRowsToAbsolute() {
        val payload = row(null)
        assertEquals(false, payload.taskRow().meta.relativeScheduleDates)
        payload.getJSONObject("meta").put("relativeScheduleDates", true).put("validUntil", 1800000000000L)
            .put("parts", org.json.JSONArray()
                .put(JSONObject().put("kind", "start").put("text", "Start: Tomorrow").put("detail", false).put("accessibilityLabel", "Start: 2026-11-11"))
                .put(JSONObject().put("kind", "due").put("text", "Thursday · 14:30").put("tone", "dueSoon").put("detail", false).put("accessibilityLabel", "Due: 2026-11-12 14:30")))
        val meta = payload.taskRow().meta
        assertEquals(true, meta.relativeScheduleDates)
        assertEquals(1800000000000L, meta.validUntil)
        assertEquals(listOf("Start: 2026-11-11", "Due: 2026-11-12 14:30"), meta.parts.map { it.spoken })
        assertEquals(listOf("Start: Tomorrow", "Thursday · 14:30"), meta.parts.map { it.text })
    }
}
