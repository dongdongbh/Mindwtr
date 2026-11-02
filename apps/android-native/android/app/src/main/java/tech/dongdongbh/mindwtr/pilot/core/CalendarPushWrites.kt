package tech.dongdongbh.mindwtr.pilot.core

import android.provider.CalendarContract
import org.json.JSONObject
import java.util.TimeZone

/**
 * Calendar push's device writes (pass C4). Core's calendar-push-service.ts decides each one; this makes it as RN's
 * expo-calendar 15 does on Android (CalendarModule.kt saveCalendar, deleteCalendar, saveEvent, removeEvent), over [rows].
 * One change from expo: an update or a delete that finds no live event answers [MISSING_EVENT], the text core reads as a
 * missing event, so core pushes the task again or forgets its row. expo's update succeeded on a missing row, and its delete
 * failed with a text core did not read as missing. JVM-tested (CalendarPushWritesTest).
 */
internal class CalendarPushWrites(private val rows: Rows, private val zone: () -> String = { TimeZone.getDefault().id }) {
    /** The calendar provider's rows as maps of CalendarContract columns, so the rules run on the JVM. */
    interface Rows {
        fun calendarExists(id: Long): Boolean
        /** The calendar's internal NAME, or null when there is no such calendar. */
        fun calendarName(id: Long): String?
        /** Inserts a calendar as the account's sync adapter, as expo does; the new ID, or null when none was made. */
        fun insertCalendar(accountName: String, accountType: String, values: Map<String, Any>): Long?
        fun deleteCalendar(id: Long): Int
        fun insertEvent(values: Map<String, Any>): Long?
        /** Whether the event exists, is not marked deleted (expo's findEventById selection) and, when given, is in [calendarId]. */
        fun eventIsLive(id: Long, calendarId: Long?): Boolean
        fun updateEvent(id: Long, values: Map<String, Any>): Int
        fun deleteEvent(id: Long): Int
        fun deleteReminders(eventId: Long)
    }

    /** expo's createCalendarAsync: [details] is core's DeviceCalendarDetails; answers the new calendar's ID. */
    fun createCalendar(details: JSONObject): String {
        for (name in listOf("name", "title", "source", "color", "accessLevel", "ownerAccount")) {
            require(details.has(name)) { "new calendars require `$name`" }
        }
        val source = details.getJSONObject("source")
        require(source.has("name")) { "new calendars require a `source` object with a `name`" }
        val local = source.optBoolean("isLocalAccount", false)
        require(source.has("type") || local) { "new calendars require a `source` object with a `type`, or `isLocalAccount`: true" }
        val accountName = source.getString("name")
        val accountType = if (local) CalendarContract.ACCOUNT_TYPE_LOCAL else source.getString("type")
        val values = linkedMapOf<String, Any>(
            CalendarContract.Calendars.NAME to details.getString("name"),
            CalendarContract.Calendars.CALENDAR_DISPLAY_NAME to details.getString("title"),
        )
        if (details.has("isVisible")) values[CalendarContract.Calendars.VISIBLE] = if (details.getBoolean("isVisible")) 1 else 0
        if (details.has("isSynced")) values[CalendarContract.Calendars.SYNC_EVENTS] = if (details.getBoolean("isSynced")) 1 else 0
        values[CalendarContract.Calendars.ACCOUNT_NAME] = accountName
        values[CalendarContract.Calendars.ACCOUNT_TYPE] = accountType
        values[CalendarContract.Calendars.CALENDAR_COLOR] = color(details.getString("color"))
        values[CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL] = ACCESS[details.getString("accessLevel")] ?: CalendarContract.Calendars.CAL_ACCESS_NONE
        values[CalendarContract.Calendars.OWNER_ACCOUNT] = details.getString("ownerAccount")
        values[CalendarContract.Calendars.CALENDAR_TIME_ZONE] = zone()
        val id = rows.insertCalendar(accountName, accountType, values) ?: error("Calendar could not be saved")
        return id.toString()
    }

    /**
     * expo's deleteCalendarAsync: no row deleted is a refusal (core then lists the calendars to see whether it is gone). Only
     * a calendar whose internal name is still RN's "mindwtr" or a marked "mindwtr:<marker>" is deleted: core checked the name
     * in its list, and the provider can hand a deleted calendar's _id to the user's next calendar.
     */
    fun deleteCalendar(calendarId: String) {
        val id = calendarId.toLong()
        val name = rows.calendarName(id)
        check(name == null || name == MANAGED_NAME || name.startsWith("$MANAGED_NAME:")) { "Calendar with id $calendarId is not a Mindwtr calendar" }
        check(rows.deleteCalendar(id) > 0) { "Calendar with id $calendarId could not be deleted" }
    }

    /** expo's createEventAsync; answers the new event's ID. */
    fun createEvent(calendarId: String, details: JSONObject): String {
        val calendar = calendarId.toLong()
        require(rows.calendarExists(calendar)) { "Couldn't find calendar with given id: $calendarId" }
        val values = eventValues(details).apply { put(CalendarContract.Events.CALENDAR_ID, calendar) }
        return (rows.insertEvent(values) ?: error("Event could not be saved")).toString()
    }

    /**
     * expo's updateEventAsync, which also drops the event's reminders; an event that is gone is [MISSING_EVENT]. So is one in
     * another calendar than [calendarId] (the row's): the provider hands a deleted event's _id to the next event, which can be
     * the user's own, and it is never written.
     */
    fun updateEvent(eventId: String, calendarId: String?, details: JSONObject) {
        val id = eventId.toLong()
        val values = eventValues(details)
        check(rows.eventIsLive(id, calendarId?.toLong()) && rows.updateEvent(id, values) > 0) { MISSING_EVENT }
        rows.deleteReminders(id)
    }

    /** expo's deleteEventAsync; an event that is already gone, or one in another calendar than [calendarId], is [MISSING_EVENT]. */
    fun deleteEvent(eventId: String, calendarId: String?) {
        val id = eventId.toLong()
        // A row only marked deleted (its sync adapter has not removed it yet) is gone already: deleting it again counts a row.
        check(rows.eventIsLive(id, calendarId?.toLong()) && rows.deleteEvent(id) > 0) { MISSING_EVENT }
    }

    /** The event columns RN writes: no alarms and no recurrence rule; `url` has no Android column, as in expo. */
    private fun eventValues(details: JSONObject): LinkedHashMap<String, Any> = linkedMapOf(
        CalendarContract.Events.DTSTART to details.getLong("startMs"),
        CalendarContract.Events.DTEND to details.getLong("endMs"),
        CalendarContract.Events.TITLE to details.getString("title"),
        CalendarContract.Events.DESCRIPTION to details.optString("notes", ""),
        CalendarContract.Events.EVENT_LOCATION to details.optString("location", ""),
        CalendarContract.Events.ALL_DAY to if (details.getBoolean("allDay")) 1 else 0,
        // expo's putEventTimeZone: the given zone (UTC for an all-day event), else the phone's.
        CalendarContract.Events.EVENT_TIMEZONE to details.optString("timeZone").ifEmpty { zone() },
        CalendarContract.Events.EVENT_END_TIMEZONE to details.optString("endTimeZone").ifEmpty { zone() },
    )

    companion object {
        const val MISSING_EVENT = "Calendar event not found"
        /** core's MANAGED_CALENDAR_NAME (calendar-push-service.ts). */
        private const val MANAGED_NAME = "mindwtr"

        /** expo's calAccessConstantMatchingString. */
        private val ACCESS = mapOf(
            "contributor" to CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR, "editor" to CalendarContract.Calendars.CAL_ACCESS_EDITOR,
            "freebusy" to CalendarContract.Calendars.CAL_ACCESS_FREEBUSY, "override" to CalendarContract.Calendars.CAL_ACCESS_OVERRIDE,
            "owner" to CalendarContract.Calendars.CAL_ACCESS_OWNER, "read" to CalendarContract.Calendars.CAL_ACCESS_READ,
            "respond" to CalendarContract.Calendars.CAL_ACCESS_RESPOND, "root" to CalendarContract.Calendars.CAL_ACCESS_ROOT,
        )

        /** RN's processColor of core's `#RRGGBB`: opaque ARGB. */
        fun color(hex: String): Int {
            require(Regex("^#[0-9A-Fa-f]{6}$").matches(hex)) { "Calendar color must be #RRGGBB" }
            return (0xFF000000L or hex.substring(1).toLong(16)).toInt()
        }
    }
}
