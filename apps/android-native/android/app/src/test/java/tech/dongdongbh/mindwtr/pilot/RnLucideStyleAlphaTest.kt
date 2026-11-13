package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class RnLucideStyleAlphaTest {
    @Test fun aLucideIconWithStyleOpacityRendersAtItsCube() {
        assertEquals(0.729f, rnLucideStyleAlpha(0.9f), 0.001f)
        assertEquals(1f, rnLucideStyleAlpha(1f), 0f)
    }
}
