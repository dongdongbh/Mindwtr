package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/** RN's processingHeader starts max(status bar, 10) below the screen's top; native draws it below the status bar already. */
class ProcessInboxHeaderTest {
    @Test fun theHeaderSitsWhereRnsDoes() {
        // A phone's status bar (the S23's is 24 dp or more): no extra space, which was the 10 dp native added (#1445 pair).
        assertEquals(0f, headerTopPadding(24f))
        assertEquals(0f, headerTopPadding(10f))
        // No status bar (a window in multi-window mode): RN's 10.
        assertEquals(10f, headerTopPadding(0f))
        assertEquals(6f, headerTopPadding(4f))
    }

    /** RN's minHeight 60 counts its status bar padding (border-box); below the status bar only the rest is left (phone pair, 9 px). */
    @Test fun theHeaderIsAsTallAsRns() {
        assertEquals(24f, headerMinHeight(36f))
        assertEquals(60f, headerMinHeight(0f))
        assertEquals(0f, headerMinHeight(80f))
    }
}
