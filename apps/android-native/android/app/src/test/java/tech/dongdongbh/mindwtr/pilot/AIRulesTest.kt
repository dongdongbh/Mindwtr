package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Test


class AIRulesTest {
    private val cancelled = mutableListOf<String>()
    private val slots = AIRequestSlots<String> { cancelled += it }

    @Test fun aNewRequestInAScopeCancelsTheOneBefore() {
        slots.start("copilot", "a")
        slots.start("copilot", "b")
        assertEquals(listOf("a"), cancelled)
        assertTrue(slots.wanted("copilot", "b"))
        assertFalse(slots.wanted("copilot", "a"))
    }

    @Test fun closingAScopeCancelsItsRequestAndAnAnsweredOneIsNotCancelled() {
        slots.start("editor", "clarify")
        slots.start("copilot", "chips")
        slots.finished("copilot", "chips")
        slots.cancel("editor", "copilot")
        assertEquals(listOf("clarify"), cancelled)
    }

    @Test fun anOlderAnswerNeverFreesTheNewerRequestsScope() {
        slots.start("review", "first")
        slots.start("review", "second")
        slots.finished("review", "first")
        assertTrue(slots.wanted("review", "second"))
    }

    @Test fun anInboxAnswerBelongsToItsSessionAndStep() {
        fun flow(session: String, step: String) = InboxProcessing(session, JSONObject().put("taskId", "t1").put("step", step))
        val asked = InboxStepKey.of(flow("s1", "actionable"))
        assertEquals(asked, InboxStepKey.of(flow("s1", "actionable")))

        assertNotEquals(asked, InboxStepKey.of(flow("s2", "actionable")))
        assertNotEquals(asked, InboxStepKey.of(flow("s1", "decisions")))
        assertEquals(null, InboxStepKey.of(null))
    }

    @Test fun theCaptureScreensQuestionIsKeyedByItsSession() {
        assertNotEquals(captureCopilotKey("one", """{"title":"Call"}"""), captureCopilotKey("two", """{"title":"Call"}"""))
        assertEquals(null, captureCopilotKey("one", null))
    }

    @Test fun aKeyFieldNeverStoresCoresDots() {
        val mask = "•••"

        assertEquals("s", typedKey(null, mask, "•••s"))
        assertEquals("x", typedKey(null, mask, "••x•"))
        assertEquals("", typedKey(null, mask, "••"))

        assertEquals("sk", typedKey("s", mask, "•••sk"))
        assertEquals("ske", typedKey("sk", mask, "ske"))
    }


    @Test fun aReplyPostedBeforeACloseAndReopenNeverShows() {
        val posted = ArrayDeque<() -> Unit>()
        val shown = mutableListOf<String>()
        slots.start("review", "first")
        slots.reply("review", "first", posted::addLast) { shown += "first" }

        slots.cancel("review")
        slots.start("review", "second")
        while (posted.isNotEmpty()) posted.removeFirst()()
        slots.reply("review", "second", posted::addLast) { shown += "second" }
        while (posted.isNotEmpty()) posted.removeFirst()()
        assertEquals(listOf("second"), shown)
        assertFalse(slots.wanted("review", "second"))
    }


    @Test fun aBlursSavedCallbackNeverClearsANewerEdit() {
        val texts = KeyTexts()
        texts.typed("assistant", "sk-1")
        val blurred = texts.edit("assistant")
        texts.typed("assistant", "x")
        texts.saved("assistant", blurred)
        assertEquals(mapOf("assistant" to "x"), texts.shown)
        texts.saved("assistant", texts.edit("assistant"))
        assertEquals(emptyMap<String, String>(), texts.shown)
    }
}

