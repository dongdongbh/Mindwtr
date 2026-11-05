package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class PickerDialogTest {
    @Test fun coresDayOpensTheDialogOnThatDay() {
        assertEquals(Triple(2026, 0, 31), pickerStart("2026-01-31"))
        assertEquals(Triple(2026, 11, 1), pickerStart("2026-12-01"))

        assertNull(pickerStart(null))
        assertNull(pickerStart(""))
        assertNull(pickerStart("2026-01-31T09:00"))
    }

    @Test fun thePickedDayIsCoresDay() {
        assertEquals("2026-01-05", pickedDay(2026, 0, 5))
        assertEquals("2026-12-31", pickedDay(2026, 11, 31))
        assertEquals(pickedDay(2026, 1, 28), pickerStart("2026-02-28")!!.let { (year, month, day) -> pickedDay(year, month, day) })
    }
}
