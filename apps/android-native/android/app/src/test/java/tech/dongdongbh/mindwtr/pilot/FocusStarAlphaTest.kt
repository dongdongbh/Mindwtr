package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class FocusStarAlphaTest {
    @Test fun anUnfocusedStarIsAsFaintAsRnsLucideStar() {
        assertEquals(0.216f, focusStarAlpha(focused = false, disabled = false), 0.001f)
        assertEquals(0.027f, focusStarAlpha(focused = false, disabled = true), 0.001f)
        assertEquals(1f, focusStarAlpha(focused = true, disabled = false), 0f)
    }
}
