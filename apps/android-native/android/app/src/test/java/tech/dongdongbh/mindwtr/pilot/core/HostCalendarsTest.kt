package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test


class HostCalendarsTest {
    @Test fun thePairIsGrantedOnlyWhenBothAre() {
        assertEquals("granted", HostCalendars.status(listOf(true, true), listOf(true, true)))
        assertEquals("undetermined", HostCalendars.status(listOf(true, false), listOf(true, true)))
    }

    @Test fun neverAskedIsUndeterminedAndRefusedOnceAskedIsDenied() {
        assertEquals("undetermined", HostCalendars.status(listOf(false, false), listOf(false, false)))
        assertEquals("denied", HostCalendars.status(listOf(false, false), listOf(true, true)))
        assertEquals("undetermined", HostCalendars.status(listOf(false, false), listOf(true, false)))
    }

    private class Rows(private val found: Boolean, private val description: String?) : AutoCloseable {
        var closed = false
        fun first() = found
        fun description() = description
        override fun close() { closed = true }
    }

    @Test fun anEventReadThatGetsNoCursorFailsSoCoreKeepsTheRowAsRnDoesFor9541eec09() {
        val failure = assertThrows(IllegalStateException::class.java) { (null as Rows?).liveDescription(Rows::first, Rows::description) }
        assertEquals(CalendarPushWrites.EVENT_READ_FAILED, failure.message)
        assertFalse(failure.message!!.lowercase().contains("not found"))
    }

    @Test fun anEventReadReturnsTheNotesOrNothingWhenNoLiveEventMatches() {
        val notes = Rows(found = true, description = "Mindwtr-Task-ID: t1")
        assertEquals("Mindwtr-Task-ID: t1", notes.liveDescription(Rows::first, Rows::description))
        assertTrue(notes.closed)
        assertEquals("", Rows(found = true, description = null).liveDescription(Rows::first, Rows::description))
        assertNull(Rows(found = false, description = "x").liveDescription(Rows::first, Rows::description))
    }
}
