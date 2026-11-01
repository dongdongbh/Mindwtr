package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

/** The project next-action prompt's model (NextActionPrompt.kt): what a reply, a refusal and a failure do to the open prompt. */
class NextActionPromptModelTest {
    private val sent = mutableListOf<JSONObject>()
    private val toasts = mutableListOf<String>()
    private val opened = mutableListOf<String>()
    private val model = NextActionPromptModel(command = { sent += it }, toast = { title, _ -> toasts += title }, openEditor = { opened += it })

    private fun prompt(revision: String = "1", sectionId: String? = null) = JSONObject().put("taskId", "done-task").put("projectId", "project")
        .put("sectionId", sectionId ?: JSONObject.NULL).put("projectRevision", revision).put("failure", JSONObject().put("title", "Error").put("message", "Could not"))

    @Test fun showNeverReplacesTypedTextAndIgnoresNoPrompt() {
        model.show(null)
        assertNull(model.prompt)
        val first = prompt()
        model.show(first)
        model.type("Draft brief")
        model.show(prompt("2"))
        assertSame(first, model.prompt)
        assertEquals("Draft brief", model.title)
    }

    @Test fun addSendsThePromptsProjectAndSection() {
        model.show(prompt(sectionId = "one"))
        model.type("Next")
        model.add(openAfterSave = false)
        val input = sent.single()
        assertEquals("project", input.getString("projectId"))
        assertEquals("one", input.getString("sectionId"))
        assertEquals("done-task", input.getString("taskId"))
    }

    @Test fun aRefusalKeepsThePromptAndItsText() {
        val shown = prompt()
        model.show(shown)
        model.type("Draft")
        model.add(openAfterSave = false)
        model.refused()
        assertSame(shown, model.prompt)
        assertEquals("Draft", model.title)
        assertEquals(listOf("Error"), toasts)
    }

    /** Review N1: a stale prompt takes core's prompt read again for the same task, keeps the typed text, and closes when none is owed. */
    @Test fun aStaleRefusalTakesTheFreshPromptOrCloses() {
        model.show(prompt())
        model.type("Draft")
        model.completeProject()
        val fresh = prompt("2")
        model.refused(stale = true, fresh = fresh)
        assertSame(fresh, model.prompt)
        assertEquals("Draft", model.title)
        model.completeProject()
        assertEquals("2", sent.last().getString("projectRevision"))
        model.refused(stale = true, fresh = null)
        assertNull(model.prompt)
    }

    /** Review N2: a failure that leaves a retry owed (SAVE_FAILED) closes the prompt, so the failure banner's Try again is reachable. */
    @Test fun anOwedFailureClosesThePrompt() {
        model.show(prompt())
        model.type("Draft")
        model.add(openAfterSave = true)
        model.owed()
        assertNull(model.prompt)
        // The owed retry's later reply opens nothing: the prompt it came from is gone.
        model.done(JSONObject().put("action", "add").put("id", "new").put("openAfterSave", true))
        assertEquals(emptyList<String>(), opened)
    }

    /** Review N4: Save & edit opens the editor only while its prompt is still open. */
    @Test fun saveAndEditOpensTheEditorOnlyForTheOpenPrompt() {
        model.show(prompt())
        model.type("Plan")
        model.add(openAfterSave = true)
        val reply = JSONObject().put("action", "add").put("id", "new").put("openAfterSave", true)
        model.close()
        model.done(reply)
        assertEquals(emptyList<String>(), opened)
        model.show(prompt())
        model.type("Plan")
        model.add(openAfterSave = true)
        model.done(reply)
        assertNull(model.prompt)
        assertEquals(listOf("new"), opened)
    }
}
