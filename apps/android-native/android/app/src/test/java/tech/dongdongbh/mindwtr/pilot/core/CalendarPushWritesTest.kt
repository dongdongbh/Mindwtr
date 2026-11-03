package tech.dongdongbh.mindwtr.pilot.core

import android.provider.CalendarContract
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CalendarPushWritesTest {
    private class FakeRows : CalendarPushWrites.Rows {
        val calendars = mutableMapOf<Long, Map<String, Any>>()
        val accounts = mutableMapOf<Long, Pair<String, String>>()
        val events = mutableMapOf<Long, MutableMap<String, Any>>()
        val deleted = mutableSetOf<Long>()
        val reminders = mutableMapOf<Long, Int>()
        var refuseCalendarDelete = false
        private var next = 100L

        override fun calendarExists(id: Long) = id in calendars
        override fun calendarName(id: Long) = calendars[id]?.get(CalendarContract.Calendars.NAME) as String?
        override fun insertCalendar(accountName: String, accountType: String, values: Map<String, Any>): Long =
            (next++).also { calendars[it] = values; accounts[it] = accountName to accountType }
        override fun deleteCalendar(id: Long): Int = if (refuseCalendarDelete || calendars.remove(id) == null) 0 else 1
        override fun insertEvent(values: Map<String, Any>): Long = (next++).also { events[it] = values.toMutableMap() }
        override fun liveEventDescription(id: Long, calendarId: Long?): String? = events[id]
            ?.takeIf { id !in deleted && (calendarId == null || it[CalendarContract.Events.CALENDAR_ID] == calendarId) }
            ?.let { it[CalendarContract.Events.DESCRIPTION] as String? ?: "" }
        override fun updateEvent(id: Long, values: Map<String, Any>): Int = events[id]?.let { it.putAll(values); 1 } ?: 0
        override fun deleteEvent(id: Long): Int = if (events.remove(id) != null) 1 else 0
        override fun deleteReminders(eventId: Long) { reminders.remove(eventId) }
    }

    private val rows = FakeRows()
    private val writes = CalendarPushWrites(rows) { "Europe/Berlin" }

    private fun seed(source: JSONObject = JSONObject().put("name", "me@example.com").put("type", "com.google")) = JSONObject()
        .put("title", "Mindwtr").put("color", "#3B82F6").put("entityType", "event").put("name", "mindwtr:0f0e0d0c-0b0a-4908-8706-050403020100")
        .put("ownerAccount", "me@example.com").put("accessLevel", "owner").put("source", source).put("isVisible", true).put("isSynced", true)

    private fun event(allDay: Boolean = false) = JSONObject().put("title", "Task").put("startMs", 1_000L).put("endMs", 2_000L)
        .put("allDay", allDay).put("notes", "Status: Next").put("location", "")
        .apply { if (allDay) put("timeZone", "UTC").put("endTimeZone", "UTC") }

    @Test fun createCalendarKeepsTheMarkerNameSoACutShortCreationIsAdopted_38368fa80() {
        val id = writes.createCalendar(seed()).toLong()
        assertEquals("mindwtr:0f0e0d0c-0b0a-4908-8706-050403020100", rows.calendars[id]!![CalendarContract.Calendars.NAME])
        assertEquals("Mindwtr", rows.calendars[id]!![CalendarContract.Calendars.CALENDAR_DISPLAY_NAME])
    }

    @Test fun createCalendarGoesOnTheSeedAccountAsItsSyncAdapterAndLocalForALocalAccount_236d4fc47_0161cf99f() {
        val google = writes.createCalendar(seed()).toLong()
        assertEquals("me@example.com" to "com.google", rows.accounts[google])
        assertEquals(CalendarContract.Calendars.CAL_ACCESS_OWNER, rows.calendars[google]!![CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL])
        assertEquals("me@example.com", rows.calendars[google]!![CalendarContract.Calendars.OWNER_ACCOUNT])
        assertEquals(1, rows.calendars[google]!![CalendarContract.Calendars.VISIBLE])
        val local = writes.createCalendar(seed(JSONObject().put("name", "Phone").put("isLocalAccount", true))).toLong()
        assertEquals("Phone" to CalendarContract.ACCOUNT_TYPE_LOCAL, rows.accounts[local])
        assertThrows(IllegalArgumentException::class.java) { writes.createCalendar(seed(JSONObject().put("name", "Phone"))) }
    }

    @Test fun createCalendarWritesTheColorAtCreationTheOnlyTimeAndroidKeepsIt_145a8c1c0() {
        val id = writes.createCalendar(seed().put("color", "#DB2777")).toLong()
        assertEquals(0xFFDB2777.toInt(), rows.calendars[id]!![CalendarContract.Calendars.CALENDAR_COLOR])
        assertThrows(IllegalArgumentException::class.java) { writes.createCalendar(seed().put("color", "blue")) }
    }

    @Test fun allDayEventsTakeCoresUtcZoneAndTimedOnesThePhonesZone_b3bdca5cd_e87170576() {
        val calendar = writes.createCalendar(seed())
        val allDay = rows.events[writes.createEvent(calendar, event(allDay = true)).toLong()]!!
        assertEquals(1, allDay[CalendarContract.Events.ALL_DAY])
        assertEquals("UTC", allDay[CalendarContract.Events.EVENT_TIMEZONE])
        assertEquals("UTC", allDay[CalendarContract.Events.EVENT_END_TIMEZONE])
        val timed = rows.events[writes.createEvent(calendar, event()).toLong()]!!
        assertEquals(0, timed[CalendarContract.Events.ALL_DAY])
        assertEquals("Europe/Berlin", timed[CalendarContract.Events.EVENT_TIMEZONE])
        assertEquals(1_000L, timed[CalendarContract.Events.DTSTART])
        assertEquals(calendar.toLong(), timed[CalendarContract.Events.CALENDAR_ID])
    }

    @Test fun anEventGoesOnlyIntoACalendarThatExists() {
        assertThrows(IllegalArgumentException::class.java) { writes.createEvent("999", event()) }
    }

    @Test fun anUpdateOfAnEventDeletedInTheCalendarAppAnswersMissingSoCoreMakesItAgain_rnBug1() {
        val calendar = writes.createCalendar(seed())
        val gone = writes.createEvent(calendar, event())
        rows.events.remove(gone.toLong())
        assertEquals(CalendarPushWrites.MISSING_EVENT, assertThrows(IllegalStateException::class.java) { writes.updateEvent(gone, null, null, event()) }.message)
        val marked = writes.createEvent(calendar, event())
        rows.deleted += marked.toLong()
        assertEquals(CalendarPushWrites.MISSING_EVENT, assertThrows(IllegalStateException::class.java) { writes.updateEvent(marked, null, null, event()) }.message)
    }

    @Test fun anUpdateWritesTheEventAndDropsItsRemindersAsExpoDoes() {
        val id = writes.createEvent(writes.createCalendar(seed()), event())
        rows.reminders[id.toLong()] = 1
        writes.updateEvent(id, null, null, event().put("title", "Changed"))
        assertEquals("Changed", rows.events[id.toLong()]!![CalendarContract.Events.TITLE])
        assertTrue(id.toLong() !in rows.reminders)
    }

    @Test fun aDeleteOfAnEventAlreadyGoneAnswersMissingSoCoreForgetsItsRow_rnBug2() {
        val id = writes.createEvent(writes.createCalendar(seed()), event())
        writes.deleteEvent(id, null, null)
        assertEquals(CalendarPushWrites.MISSING_EVENT, assertThrows(IllegalStateException::class.java) { writes.deleteEvent(id, null, null) }.message)
    }

    @Test fun anEventIdTheProviderGaveToAnEventInAnotherCalendarIsMissingAndUntouched() {
        val mindwtr = writes.createCalendar(seed())
        val users = writes.createCalendar(seed().put("name", "users-own"))
        val theirs = writes.createEvent(users, event().put("title", "Dentist"))
        assertEquals(CalendarPushWrites.MISSING_EVENT, assertThrows(IllegalStateException::class.java) { writes.updateEvent(theirs, mindwtr, null, event()) }.message)
        assertEquals(CalendarPushWrites.MISSING_EVENT, assertThrows(IllegalStateException::class.java) { writes.deleteEvent(theirs, mindwtr, null) }.message)
        assertEquals("Dentist", rows.events[theirs.toLong()]!![CalendarContract.Events.TITLE])
        writes.updateEvent(theirs, users, null, event().put("title", "Changed"))
        assertEquals("Changed", rows.events[theirs.toLong()]!![CalendarContract.Events.TITLE])
        writes.deleteEvent(theirs, null, null)
        assertTrue(theirs.toLong() !in rows.events)
    }

    @Test fun anEventWithoutTheRowsTaskMarkerIsNotMindwtrsAndIsNeverWritten() {
        val calendar = writes.createCalendar(seed())
        val marker = "Mindwtr-Task-ID: t1"
        val own = writes.createEvent(calendar, event().put("notes", "Status: Next\r\n\r\n[Mindwtr Calendar Mirror]\r\n$marker  \r\n[/Mindwtr Calendar Mirror]"))
        writes.updateEvent(own, calendar, marker, event().put("title", "Changed").put("notes", "Status: Next\n\n$marker"))
        assertEquals("Changed", rows.events[own.toLong()]!![CalendarContract.Events.TITLE])
        val theirs = writes.createEvent(calendar, event().put("title", "Dentist").put("notes", "Bring the card"))
        assertEquals(CalendarPushWrites.UNMARKED_EVENT, assertThrows(IllegalStateException::class.java) { writes.updateEvent(theirs, calendar, marker, event()) }.message)
        assertEquals(CalendarPushWrites.UNMARKED_EVENT, assertThrows(IllegalStateException::class.java) { writes.deleteEvent(theirs, calendar, marker) }.message)
        assertEquals("Dentist", rows.events[theirs.toLong()]!![CalendarContract.Events.TITLE])
        writes.deleteEvent(own, calendar, marker)
        assertTrue(own.toLong() !in rows.events)
    }

    @Test fun aCalendarDeleteRefusesACalendarWithoutMindwtrsInternalName() {
        val users = writes.createCalendar(seed().put("name", "me@example.com"))
        assertThrows(IllegalStateException::class.java) { writes.deleteCalendar(users) }
        assertTrue(users.toLong() in rows.calendars)
        rows.calendars[900L] = mapOf(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME to "Mindwtr")
        assertThrows(IllegalStateException::class.java) { writes.deleteCalendar("900") }
        assertTrue(900L in rows.calendars)
        val plain = writes.createCalendar(seed().put("name", "mindwtr"))
        writes.deleteCalendar(plain)
        assertTrue(plain.toLong() !in rows.calendars)
    }

    @Test fun aCalendarDeleteThatRemovesNoRowRefusesSoCoreKeepsTheSavedId_0c2782b76() {
        val id = writes.createCalendar(seed())
        rows.refuseCalendarDelete = true
        assertThrows(IllegalStateException::class.java) { writes.deleteCalendar(id) }
        assertTrue(id.toLong() in rows.calendars)
        rows.refuseCalendarDelete = false
        writes.deleteCalendar(id)
        assertTrue(id.toLong() !in rows.calendars)
    }
}
