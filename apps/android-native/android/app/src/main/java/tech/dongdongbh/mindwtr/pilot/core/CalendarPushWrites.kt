package tech.dongdongbh.mindwtr.pilot.core

import android.provider.CalendarContract
import org.json.JSONObject
import java.util.TimeZone

internal class CalendarPushWrites(private val rows: Rows, private val zone: () -> String = { TimeZone.getDefault().id }) {
    interface Rows {
        fun calendarExists(id: Long): Boolean
        fun calendarName(id: Long): String?
        fun insertCalendar(accountName: String, accountType: String, values: Map<String, Any>): Long?
        fun deleteCalendar(id: Long): Int
        fun insertEvent(values: Map<String, Any>): Long?
        fun liveEventDescription(id: Long, calendarId: Long?): String?
        fun updateEvent(id: Long, values: Map<String, Any>): Int
        fun deleteEvent(id: Long): Int
        fun deleteReminders(eventId: Long)
    }

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

    fun deleteCalendar(calendarId: String) {
        val id = calendarId.toLong()
        val name = rows.calendarName(id)
        check(name == MANAGED_NAME || name?.startsWith("$MANAGED_NAME:") == true) { "Calendar with id $calendarId is not a Mindwtr calendar" }
        check(rows.deleteCalendar(id) > 0) { "Calendar with id $calendarId could not be deleted" }
    }

    fun createEvent(calendarId: String, details: JSONObject): String {
        val calendar = calendarId.toLong()
        require(rows.calendarExists(calendar)) { "Couldn't find calendar with given id: $calendarId" }
        val values = eventValues(details).apply { put(CalendarContract.Events.CALENDAR_ID, calendar) }
        return (rows.insertEvent(values) ?: error("Event could not be saved")).toString()
    }

    fun updateEvent(eventId: String, calendarId: String?, taskMarker: String?, details: JSONObject) {
        val id = eventId.toLong()
        requireOwnEvent(id, calendarId, taskMarker)
        check(rows.updateEvent(id, eventValues(details)) > 0) { MISSING_EVENT }
        rows.deleteReminders(id)
    }

    fun deleteEvent(eventId: String, calendarId: String?, taskMarker: String?) {
        val id = eventId.toLong()
        requireOwnEvent(id, calendarId, taskMarker)
        check(rows.deleteEvent(id) > 0) { MISSING_EVENT }
    }

    private fun requireOwnEvent(id: Long, calendarId: String?, taskMarker: String?) {
        val notes = rows.liveEventDescription(id, calendarId?.toLong()) ?: throw IllegalStateException(MISSING_EVENT)
        check(taskMarker == null || notes.lines().any { it.trimEnd() == taskMarker }) { UNMARKED_EVENT }
    }

    private fun eventValues(details: JSONObject): LinkedHashMap<String, Any> = linkedMapOf(
        CalendarContract.Events.DTSTART to details.getLong("startMs"),
        CalendarContract.Events.DTEND to details.getLong("endMs"),
        CalendarContract.Events.TITLE to details.getString("title"),
        CalendarContract.Events.DESCRIPTION to details.optString("notes", ""),
        CalendarContract.Events.EVENT_LOCATION to details.optString("location", ""),
        CalendarContract.Events.ALL_DAY to if (details.getBoolean("allDay")) 1 else 0,
        CalendarContract.Events.EVENT_TIMEZONE to details.optString("timeZone").ifEmpty { zone() },
        CalendarContract.Events.EVENT_END_TIMEZONE to details.optString("endTimeZone").ifEmpty { zone() },
    )

    companion object {
        const val MISSING_EVENT = "Calendar event not found"
        const val UNMARKED_EVENT = "Calendar event not found: not made by Mindwtr"
        private const val MANAGED_NAME = "mindwtr"

        private val ACCESS = mapOf(
            "contributor" to CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR, "editor" to CalendarContract.Calendars.CAL_ACCESS_EDITOR,
            "freebusy" to CalendarContract.Calendars.CAL_ACCESS_FREEBUSY, "override" to CalendarContract.Calendars.CAL_ACCESS_OVERRIDE,
            "owner" to CalendarContract.Calendars.CAL_ACCESS_OWNER, "read" to CalendarContract.Calendars.CAL_ACCESS_READ,
            "respond" to CalendarContract.Calendars.CAL_ACCESS_RESPOND, "root" to CalendarContract.Calendars.CAL_ACCESS_ROOT,
        )

        fun color(hex: String): Int {
            require(Regex("^#[0-9A-Fa-f]{6}$").matches(hex)) { "Calendar color must be #RRGGBB" }
            return (0xFF000000L or hex.substring(1).toLong(16)).toInt()
        }
    }
}
