package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.text.style.LineHeightStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class RnTextTest {
    @Test fun lineHeightKeepsTheFullLineBox() {
        assertEquals(LineHeightStyle(LineHeightStyle.Alignment.Proportional, LineHeightStyle.Trim.None), rnText(16, 500, 21).lineHeightStyle)
        assertNull(rnText(13, 600).lineHeightStyle)
    }
}
