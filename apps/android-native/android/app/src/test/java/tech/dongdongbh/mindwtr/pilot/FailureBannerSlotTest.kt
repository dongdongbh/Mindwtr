package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RN's one floating failure banner: the root shows the newest screen's failure; a screen that leaves gives the one under it back. */
class FailureBannerSlotTest {
    @Test fun theNewestFailureShowsAndALeavingScreenGivesTheOneUnderItBack() {
        val slot = FailureBannerSlot<String>()
        assertNull(slot.shown)
        val tabs = slot.put("tabs")
        val editor = slot.put("editor")
        assertEquals("editor", slot.shown)
        editor()
        assertEquals("tabs", slot.shown)
        editor()
        assertEquals("tabs", slot.shown)
        tabs()
        assertNull(slot.shown)
    }

    @Test fun twoScreensWithTheSameTextKeepTheirOwnPlaces() {
        val slot = FailureBannerSlot<Any>()
        val first = Any()
        val removeFirst = slot.put(first)
        val second = Any()
        slot.put(second)
        removeFirst()
        assertEquals(second, slot.shown)
    }
}
