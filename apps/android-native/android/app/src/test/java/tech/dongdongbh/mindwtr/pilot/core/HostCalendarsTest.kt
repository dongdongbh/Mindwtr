package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
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
}
