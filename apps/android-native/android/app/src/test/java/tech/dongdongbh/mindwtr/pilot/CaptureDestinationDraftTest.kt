package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class CaptureDestinationDraftTest {
    @Test fun destinationAndSectionSurviveDraftRecreationWithQueuedEdits() {
        val destination = JSONObject().put("kind", "project").put("id", "project-1").put("sectionId", "section-1")
        val options = JSONObject().put("destination", destination).put("projectId", "project-1").put("sectionId", "section-1")
        val view = JSONObject().put("options", options)
        val edit = JSONObject().put("type", "selectDestination").put("destination", JSONObject().put("kind", "none"))
        val opened = CaptureDraft.opened(view).copy(text = "Keep draft", requests = listOf(JSONObject().put("edit", edit)))

        val restored = CaptureDraft.restore(JSONObject(opened.state().toString()))

        assertEquals(opened.captureId, restored.captureId)
        assertEquals("Keep draft", restored.text)
        assertEquals(destination.toString(), restored.options.getJSONObject("destination").toString())
        assertEquals("section-1", restored.options.getString("sectionId"))
        assertEquals("none", restored.requests.single().getJSONObject("edit").getJSONObject("destination").getString("kind"))
    }
}
