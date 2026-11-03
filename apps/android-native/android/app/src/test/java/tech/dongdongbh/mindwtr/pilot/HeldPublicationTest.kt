package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test


class HeldPublicationTest {
    private val held = HeldPublication<String>()

    @Test fun firstContentTakesTheHeldPublicationOnce() {
        held.hold("runtime")
        assertEquals("runtime", held.take())
        assertNull(held.take())
    }

    @Test fun aFallbackPublishesItsOwnHoldWhenNoContentCame() {
        val resume = held.hold("runtime")
        assertEquals("runtime", held.takeIf(resume))
        assertNull(held.take())
    }

    @Test fun aStaleFallbackLeavesALaterResumesHoldForItsFirstContent() {

        val resumeA = held.hold("runtime")
        assertTrue(held.leave())
        held.hold("runtime")
        assertNull(held.takeIf(resumeA))

        assertEquals("runtime", held.take())
    }

    @Test fun aFallbackAfterFirstContentPublishesNothing() {
        val resume = held.hold("runtime")
        assertEquals("runtime", held.take())
        assertNull(held.takeIf(resume))
    }

    @Test fun aLeaveWithAHeldPublicationPublishesItInFullAndOtherwiseOnlyFlushes() {

        held.hold("runtime")
        assertTrue(held.leave())
        assertNull(held.take())

        assertFalse(held.leave())
    }
}
