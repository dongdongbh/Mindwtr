package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The widget publication a resume holds until the screen's first content (ProcessCoreHost.appState), or its fallback. */
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
        // Resume A holds and schedules its fallback; a pause clears; resume B holds before A's fallback runs.
        val resumeA = held.hold("runtime")
        assertTrue(held.leave())
        held.hold("runtime")
        assertNull(held.takeIf(resumeA))
        // B's first content still publishes, after it drew.
        assertEquals("runtime", held.take())
    }

    @Test fun aFallbackAfterFirstContentPublishesNothing() {
        val resume = held.hold("runtime")
        assertEquals("runtime", held.take())
        assertNull(held.takeIf(resume))
    }

    @Test fun aLeaveWithAHeldPublicationPublishesItInFullAndOtherwiseOnlyFlushes() {
        // A resume left within its fallback, with no first content: its publication (a new day, a theme) must still run.
        held.hold("runtime")
        assertTrue(held.leave())
        assertNull(held.take())
        // Nothing held: the leave flushes only a waiting change.
        assertFalse(held.leave())
    }
}
