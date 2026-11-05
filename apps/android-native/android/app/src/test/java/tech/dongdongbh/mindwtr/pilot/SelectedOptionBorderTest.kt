package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Test


class SelectedOptionBorderTest {
    @Test fun aSelectedOptionGetsRnsTwoPointOutlineAndOthersKeepOne_3b64d4959() {
        assertEquals(2.dp, selectedOptionBorder(selected = true))
        assertEquals(1.dp, selectedOptionBorder(selected = false))
    }
}
