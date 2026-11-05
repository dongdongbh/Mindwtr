package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class ProcessInboxHeaderTest {
    @Test fun theHeaderSitsWhereRnsDoes() {

        assertEquals(0f, headerTopPadding(24f))
        assertEquals(0f, headerTopPadding(10f))

        assertEquals(10f, headerTopPadding(0f))
        assertEquals(6f, headerTopPadding(4f))
    }


    @Test fun theHeaderIsAsTallAsRns() {
        assertEquals(24f, headerMinHeight(36f))
        assertEquals(60f, headerMinHeight(0f))
        assertEquals(0f, headerMinHeight(80f))
    }
}
