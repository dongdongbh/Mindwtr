package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class OrganizeDialogInputsTest {
    @Test
    fun contextsDestinationPickersAreSentOnlyToTheBulkRead() {
        val draft = JSONObject().put("estimateChoice", "30min")
        for (kind in listOf("project", "area")) {
            val open = JSONObject().put("kind", "organize").put("picker", kind).put("query", "Garden").put("draft", draft)
            val contexts = JSONObject().put("searchQuery", "task")
            listDialogInputs("contexts", open, contexts)
            assertFalse(contexts.has("organize"))
            assertFalse(contexts.has("picker"))
            assertEquals("task", contexts.getString("searchQuery"))

            val bulk = JSONObject().put("list", "contexts")
            organizeDialogInputs(open, bulk)
            assertEquals("30min", bulk.getJSONObject("organize").getJSONObject("draft").getString("estimateChoice"))
            assertEquals(kind, bulk.getJSONObject("picker").getString("kind"))
            assertEquals("Garden", bulk.getJSONObject("picker").getString("query"))

            val review = JSONObject()
            listDialogInputs("review", open, review)
            assertEquals(kind, review.getJSONObject("picker").getString("kind"))
        }
    }

    @Test
    fun contextsTokenPickerStillUsesTheListRead() {
        val open = JSONObject().put("kind", "tokens").put("list", "contexts")
            .put("field", "contexts").put("mode", "add").put("text", "Garden")
        val contexts = JSONObject()
        listDialogInputs("contexts", open, contexts)

        assertFalse(contexts.has("organize"))
        val picker = contexts.getJSONObject("picker")
        assertEquals("contexts", picker.getString("field"))
        assertEquals("add", picker.getString("mode"))
        assertEquals("Garden", picker.getString("query"))
        assertFalse(picker.has("kind"))
    }
}
