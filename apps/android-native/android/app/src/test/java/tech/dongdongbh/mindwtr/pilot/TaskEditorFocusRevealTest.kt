package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class TaskEditorFocusRevealTest {

    @Test fun aShortFieldKeepsEighteenPercentOfTheFormClearAboveTheKeyboard() =
        assertEquals(143 + 151.2f, focusRevealBottom(143, 840), 0.01f)


    @Test fun aTallFieldRevealsAtMostFortyPercentOfTheForm() =
        assertEquals(336f + 151.2f, focusRevealBottom(600, 840), 0.01f)
}
