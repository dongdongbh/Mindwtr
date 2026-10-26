package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/** A focused editor field scrolls into view as RN's scrollHandleIntoView does (#738, #767, #755, #1347). */
class TaskEditorFocusRevealTest {
    // RN on the S23: a 143 px Contexts field in an 840 px form above the keyboard ends 151 px (18%) above the keyboard.
    @Test fun aShortFieldKeepsEighteenPercentOfTheFormClearAboveTheKeyboard() =
        assertEquals(143 + 151.2f, focusRevealBottom(143, 840), 0.01f)

    // A field taller than 40% of the form shows its top 40% only, so its top line stays on screen.
    @Test fun aTallFieldRevealsAtMostFortyPercentOfTheForm() =
        assertEquals(336f + 151.2f, focusRevealBottom(600, 840), 0.01f)
}
