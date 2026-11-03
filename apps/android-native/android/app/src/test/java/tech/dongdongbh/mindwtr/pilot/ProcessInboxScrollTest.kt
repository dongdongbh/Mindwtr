package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class ProcessInboxScrollTest {
    @Test fun onlyANewQuestionOrItemScrolls() {
        assertEquals(StepScroll.Animate, stepScroll("a", "actionable", "a", "later"))
        assertEquals(StepScroll.Jump, stepScroll("a", "later", "b", "actionable"))

        assertEquals(StepScroll.Keep, stepScroll("a", "later", "a", "later"))

        assertEquals(StepScroll.Keep, stepScroll(null, null, "a", "actionable"))
    }
}
