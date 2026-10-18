package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.text.style.LineHeightStyle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RN's line height is the whole line box: rnText keeps it on the first and last lines, or settings rows come out ~5 dp short. */
class RnTextTest {
    @Test fun lineHeightKeepsTheFullLineBox() {
        assertEquals(LineHeightStyle(LineHeightStyle.Alignment.Proportional, LineHeightStyle.Trim.None), rnText(16, 500, 21).lineHeightStyle)
        assertNull(rnText(13, 600).lineHeightStyle)
    }
}
