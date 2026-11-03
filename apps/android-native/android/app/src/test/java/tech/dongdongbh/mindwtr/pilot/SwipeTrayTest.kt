package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class SwipeTrayTest {
    private fun action(id: String, label: String, status: String? = null, focused: Boolean? = null) = JSONObject().put("id", id).put("label", label)
        .put("enabled", true).apply { status?.let { put("status", it) }; focused?.let { put("focused", it) } }

    @Test fun readsCoresTraysPerStatusAndStar() {
        val reply = JSONObject().put("trays", JSONObject()
            .put("next", JSONObject().put("swipeRight", JSONArray().put(action("done", "Done", "done")).put(action("focus", "Focus", focused = false)))
                .put("swipeLeft", JSONArray().put(action("organize", "Organize")).put(action("dates", "Dates…")).put(action("delete", "Delete"))))
            .put("next:focused", JSONObject().put("swipeRight", JSONArray().put(action("focus", "Remove from focus", focused = true))).put("swipeLeft", JSONArray()))
            .put("reference", JSONObject().put("swipeRight", JSONArray().put(action("next", "Next", "next"))).put("swipeLeft", JSONArray())))
        val trays = SwipeTrays.parse(reply)
        assertEquals(listOf("done", "focus"), trays.getValue("next").swipeRight.map { it.id })
        assertEquals(listOf("organize", "dates", "delete"), trays.getValue("next").swipeLeft.map { it.id })
        assertEquals(TrayAction("done", "Done", "done", false), trays.getValue("next").swipeRight[0])
        assertEquals(TrayAction("focus", "Remove from focus", null, true), trays.getValue("next:focused").swipeRight[0])
        assertEquals("next", trays.getValue("reference").swipeRight[0].status)
    }

    @Test fun trayWidthsAreRnsButtonsGapsAndMargin() {
        assertEquals(0, trayWidthDp(0))
        assertEquals(84, trayWidthDp(1))
        assertEquals(166, trayWidthDp(2))
        assertEquals(248, trayWidthDp(3))
    }

    @Test fun releaseFollowsRnsSwipeableThreshold() {
        val left = 166f
        val right = 248f
        assertEquals(left, settleTray(0f, 73f, 0f, 72f, left, right))
        assertEquals(0f, settleTray(0f, 71f, 0f, 72f, left, right))
        assertEquals(-right, settleTray(0f, -73f, 0f, 72f, left, right))
        assertEquals(0f, settleTray(0f, -73f, 0f, 72f, left, 0f))
        assertEquals(left, settleTray(0f, 40f, 1000f, 72f, left, right))
        assertEquals(0f, settleTray(left, left - 73f, 0f, 72f, left, right))
        assertEquals(left, settleTray(left, left - 50f, 0f, 72f, left, right))
        assertEquals(-right, settleTray(-right, -right + 50f, 0f, 72f, left, right))
        assertEquals(0f, settleTray(-right, -right + 73f, 0f, 72f, left, right))
    }

    @Test fun dragMovesTheRowOnlyPastRnsActivationDistance() {
        val left = 166f
        val right = 248f
        assertEquals(0f, trayDragOffset(0f, 27f, 28f, left, right))
        assertEquals(0f, trayDragOffset(0f, -27f, 28f, left, right))
        assertEquals(40f, trayDragOffset(0f, 50f, 28f, left, right))
        assertEquals(left, trayDragOffset(0f, 1000f, 28f, left, right))
        assertEquals(-right, trayDragOffset(0f, -1000f, 28f, left, right))
        assertEquals(left, trayDragOffset(left, 20f, 28f, left, right))
        assertEquals(left - 40f, trayDragOffset(left, -50f, 28f, left, right))
    }
}
