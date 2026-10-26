package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/** RN's scrollProcessingToTop (#1445): only a new question or item scrolls; a recreated screen keeps its place (review of 5bd4c41d4). */
class ProcessInboxScrollTest {
    @Test fun onlyANewQuestionOrItemScrolls() {
        assertEquals(StepScroll.Animate, stepScroll("a", "actionable", "a", "later"))
        assertEquals(StepScroll.Jump, stepScroll("a", "later", "b", "actionable"))
        // A rotation or a theme change recreates the screen on the same question: the user's place stays.
        assertEquals(StepScroll.Keep, stepScroll("a", "later", "a", "later"))
        // The first question shown starts at the top already.
        assertEquals(StepScroll.Keep, stepScroll(null, null, "a", "actionable"))
    }
}
