package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Settings › Calendar's visits (C3 review): an open that ends after Back counts for nothing, and the next visit opens afresh. */
class CalendarVisitTest {
    @Test fun anOpenThatEndsAfterTheScreenLeftCountsForNothing() {
        val visits = CalendarVisit()
        val first = visits.current
        visits.leave()
        assertFalse(visits.opened(first))
        assertFalse(visits.isOpen)
        assertFalse(visits.isCurrent(first))
    }

    @Test fun theNextVisitOpensAfresh() {
        val visits = CalendarVisit()
        val first = visits.current
        assertTrue(visits.opened(first))
        assertTrue(visits.isOpen)
        visits.leave()
        assertFalse(visits.isOpen)
        val second = visits.current
        assertEquals(first + 1, second)
        assertTrue(visits.opened(second))
        assertTrue(visits.isCurrent(second))
    }

    // RN's 5bfa6bf6b: a picked local .ics stays readable after a reboot only through a persisted read grant. The pick is an
    // ACTION_OPEN_DOCUMENT (OpenDocument), whose result allows one; addFile takes it for reading only, and a refusal is logged
    // while the feed is still added.
    @Test fun aPickedCalendarFileKeepsAPersistedReadGrant() {
        val taken = mutableListOf<Int>()
        assertEquals(null, keepPickedFileReadable { flags -> taken += flags })
        assertEquals(listOf(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION), taken)
        val refused = SecurityException("No persistable permission grants found")
        assertEquals(refused, keepPickedFileReadable { throw refused })
    }
}
