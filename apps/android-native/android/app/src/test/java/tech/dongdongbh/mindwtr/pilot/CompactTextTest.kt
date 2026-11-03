package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test


class CompactTextTest {
    @Test fun aLabelGrowsWithTheFontScaleUpToTheCap() {
        assertEquals(1f, compactFontFactor(1f), 0.0001f)
        assertEquals(1f, compactFontFactor(1.2f), 0.0001f)
        assertEquals(1f, compactFontFactor(0.85f), 0.0001f)
    }

    @Test fun pastTheCapTheLabelStaysAt1Point2x() {

        assertEquals(1.2f, 2f * compactFontFactor(2f), 0.0001f)
        assertEquals(1.2f, 1.5f * compactFontFactor(1.5f), 0.0001f)
    }


    private class NonlinearDensity(override val fontScale: Float) : Density {
        override val density = 2.625f
        override fun TextUnit.toDp(): Dp = Dp(if (value <= 10f) value * fontScale else 10f * fontScale + (value - 10f) * (1f + (fontScale - 1f) / 2f))
        override fun Dp.toSp(): TextUnit {
            val small = 10f * fontScale
            return (if (value <= small) value / fontScale else 10f + (value - small) / (1f + (fontScale - 1f) / 2f)).sp
        }
    }

    @Test fun theLineHeightIsRnsUncappedSpLineHeight() {


        for (scale in listOf(1f, 1.3f, 2f)) {
            val density = NonlinearDensity(scale)
            val style = rnText(13, 700, 17).compact(density)
            val rn = with(density) { 17.sp.toDp() }.value
            assertTrue("font scale $scale", style.lineHeight.isEm)
            assertEquals("font scale $scale", rn, style.lineHeight.value * with(density) { style.fontSize.toDp() }.value, 0.01f)
        }


        assertEquals(LineHeightStyle.Trim.None, rnText(13, 700, 17).compact(NonlinearDensity(1f)).lineHeightStyle?.trim)

        assertEquals(13f * 1.2f / 2f, rnText(13, 700, 17).compact(NonlinearDensity(2f)).fontSize.value, 0.01f)
    }
}
