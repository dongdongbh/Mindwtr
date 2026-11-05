package tech.dongdongbh.mindwtr.pilot.core

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

class HostCalendars(context: Context) {
    private val app = context.applicationContext

    private val asked = app.getSharedPreferences("expo.modules.permissions.asked", Context.MODE_PRIVATE)
    private val writes = CalendarPushWrites(ProviderRows(app))


    fun call(json: String, reply: (Result<Any?>) -> Unit) {
        val request = JSONObject(json)
        when (val op = request.getString("op")) {
            "getPermissions" -> reply(Result.success(JSONObject().put("status", status())))
            "requestPermissions" -> {

                asked.edit().apply { PERMISSIONS.forEach { putBoolean(it, true) } }.apply()
                CalendarPermissionPrompt.ask { reply(Result.success(JSONObject().put("status", status()))) }
            }
            "getCalendars" -> reply(runCatching { requireGranted(); calendars() })
            "getEvents" -> reply(runCatching {
                requireGranted()
                val ids = request.getJSONArray("calendarIds")
                events(List(ids.length()) { ids.getString(it) }, Instant.parse(request.getString("start")).toEpochMilli(),
                    Instant.parse(request.getString("end")).toEpochMilli())
            })
            "createCalendar" -> reply(runCatching { requireGranted(); writes.createCalendar(request.getJSONObject("details")) })
            "deleteCalendar" -> reply(runCatching { requireGranted(); writes.deleteCalendar(request.getString("calendarId")); null })
            "createEvent" -> reply(runCatching { requireGranted(); writes.createEvent(request.getString("calendarId"), request.getJSONObject("details")) })
            "updateEvent" -> reply(runCatching { requireGranted(); writes.updateEvent(request.getString("eventId"), request.optString("calendarId").ifEmpty { null }, request.optString("taskMarker").ifEmpty { null }, request.getJSONObject("details")); null })
            "deleteEvent" -> reply(runCatching { requireGranted(); writes.deleteEvent(request.getString("eventId"), request.optString("calendarId").ifEmpty { null }, request.optString("taskMarker").ifEmpty { null }); null })
            else -> reply(Result.failure(IllegalArgumentException("Unsupported calendar call $op")))
        }
    }

    private fun status(): String = status(PERMISSIONS.map { app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED },
        PERMISSIONS.map { asked.getBoolean(it, false) })

    private fun requireGranted() = check(status() == "granted") { "CALENDAR permission is required to do this operation." }


    private fun calendars(): JSONArray = JSONArray().apply {
        app.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, CALENDAR_COLUMNS, null, null, null)!!.use { cursor ->
            while (cursor.moveToNext()) {
                val access = cursor.int(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL)
                val accountType = cursor.text(CalendarContract.Calendars.ACCOUNT_TYPE)
                put(JSONObject()
                    .put("id", cursor.text(CalendarContract.Calendars._ID))
                    .put("title", cursor.text(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME) ?: JSONObject.NULL)
                    .put("name", cursor.text(CalendarContract.Calendars.NAME) ?: JSONObject.NULL)
                    .put("color", String.format("#%06X", 0xFFFFFF and cursor.int(CalendarContract.Calendars.CALENDAR_COLOR)))
                    .put("ownerAccount", cursor.text(CalendarContract.Calendars.OWNER_ACCOUNT) ?: JSONObject.NULL)
                    .put("accessLevel", ACCESS_LEVELS[access] ?: "none")
                    .put("allowsModifications", access in WRITABLE_ACCESS)
                    .put("isVisible", cursor.int(CalendarContract.Calendars.VISIBLE) != 0)
                    .put("source", JSONObject().put("name", cursor.text(CalendarContract.Calendars.ACCOUNT_NAME) ?: JSONObject.NULL)
                        .put("type", accountType ?: JSONObject.NULL).put("isLocalAccount", accountType == CalendarContract.ACCOUNT_TYPE_LOCAL)))
            }
        }
    }


    private fun events(calendarIds: List<String>, start: Long, end: Long): JSONArray = JSONArray().apply {
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, start); ContentUris.appendId(it, end) }.build()
        val chosen = if (calendarIds.isEmpty()) "" else " AND (${calendarIds.joinToString(" OR ") { "${CalendarContract.Instances.CALENDAR_ID} = ?" }})"
        val selection = "(${CalendarContract.Instances.BEGIN} >= $start AND ${CalendarContract.Instances.END} <= $end AND ${CalendarContract.Instances.VISIBLE} = 1$chosen)"
        app.contentResolver.query(uri, EVENT_COLUMNS, selection, calendarIds.toTypedArray(), "${CalendarContract.Instances.BEGIN} ASC")!!.use { cursor ->
            while (cursor.moveToNext()) {
                put(JSONObject()
                    .put("id", cursor.text(CalendarContract.Instances.EVENT_ID))
                    .put("calendarId", cursor.text(CalendarContract.Instances.CALENDAR_ID) ?: JSONObject.NULL)
                    .put("title", cursor.text(CalendarContract.Instances.TITLE) ?: JSONObject.NULL)
                    .put("notes", cursor.text(CalendarContract.Instances.DESCRIPTION) ?: JSONObject.NULL)
                    .put("startDate", cursor.text(CalendarContract.Instances.BEGIN)?.let { Instant.ofEpochMilli(it.toLong()).iso() } ?: "")
                    .put("endDate", cursor.text(CalendarContract.Instances.END)?.let { Instant.ofEpochMilli(it.toLong()).iso() } ?: "")
                    .put("allDay", cursor.int(CalendarContract.Instances.ALL_DAY) != 0)
                    .put("location", cursor.text(CalendarContract.Instances.EVENT_LOCATION) ?: JSONObject.NULL))
            }
        }
    }

    companion object {
        val PERMISSIONS = arrayOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR)


        fun status(granted: List<Boolean>, asked: List<Boolean>): String {
            val each = granted.indices.map { if (granted[it]) "granted" else if (asked[it]) "denied" else "undetermined" }
            return when {
                each.all { it == "granted" } -> "granted"
                each.all { it == "denied" } -> "denied"
                else -> "undetermined"
            }
        }
        private val CALENDAR_COLUMNS = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
            CalendarContract.Calendars.ACCOUNT_NAME, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.NAME,
            CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.Calendars.CALENDAR_COLOR, CalendarContract.Calendars.OWNER_ACCOUNT,
            CalendarContract.Calendars.VISIBLE)
        private val EVENT_COLUMNS = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE,
            CalendarContract.Instances.DESCRIPTION, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION, CalendarContract.Instances.CALENDAR_ID)
        private val ACCESS_LEVELS = mapOf(CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR to "contributor", CalendarContract.Calendars.CAL_ACCESS_EDITOR to "editor",
            CalendarContract.Calendars.CAL_ACCESS_FREEBUSY to "freebusy", CalendarContract.Calendars.CAL_ACCESS_OVERRIDE to "override",
            CalendarContract.Calendars.CAL_ACCESS_OWNER to "owner", CalendarContract.Calendars.CAL_ACCESS_READ to "read",
            CalendarContract.Calendars.CAL_ACCESS_RESPOND to "respond", CalendarContract.Calendars.CAL_ACCESS_ROOT to "root")
        private val WRITABLE_ACCESS = setOf(CalendarContract.Calendars.CAL_ACCESS_ROOT, CalendarContract.Calendars.CAL_ACCESS_OWNER,
            CalendarContract.Calendars.CAL_ACCESS_EDITOR, CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR)

        private fun Cursor.text(column: String): String? = getColumnIndex(column).takeIf { it >= 0 && !isNull(it) }?.let(::getString)
        private fun Cursor.int(column: String): Int = getColumnIndex(column).takeIf { it >= 0 && !isNull(it) }?.let(::getInt) ?: 0

        private fun Instant.iso(): String = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            .withZone(java.time.ZoneOffset.UTC).format(this)


        fun openEvent(context: Context, eventId: String): Boolean = runCatching {
            context.startActivity(Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId.toLong()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.isSuccess
    }
}

internal fun <C : AutoCloseable> C?.liveDescription(first: C.() -> Boolean, description: C.() -> String?): String? =
    (this ?: throw IllegalStateException(CalendarPushWrites.EVENT_READ_FAILED)).use { if (it.first()) it.description() ?: "" else null }

private class ProviderRows(context: Context) : CalendarPushWrites.Rows {
    private val resolver = context.contentResolver

    override fun calendarExists(id: Long): Boolean = resolver.query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI, id),
        arrayOf(CalendarContract.Calendars._ID), null, null, null)?.use { it.count > 0 } ?: false

    override fun calendarName(id: Long): String? = resolver.query(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI, id),
        arrayOf(CalendarContract.Calendars.NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else null }

    override fun insertCalendar(accountName: String, accountType: String, values: Map<String, Any>): Long? {
        val uri = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, accountName)
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, accountType).build()
        return resolver.insert(uri, values.toContentValues())?.lastPathSegment?.toLongOrNull()
    }

    override fun deleteCalendar(id: Long): Int = resolver.delete(ContentUris.withAppendedId(CalendarContract.Calendars.CONTENT_URI, id), null, null)

    override fun insertEvent(values: Map<String, Any>): Long? =
        resolver.insert(CalendarContract.Events.CONTENT_URI, values.toContentValues())?.lastPathSegment?.toLongOrNull()

    override fun liveEventDescription(id: Long, calendarId: Long?): String? = resolver.query(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id),
        arrayOf(CalendarContract.Events.DESCRIPTION),
        "(${CalendarContract.Events.DELETED} != 1)" + (calendarId?.let { " AND ${CalendarContract.Events.CALENDAR_ID} = $it" } ?: ""),
        null, null).liveDescription(Cursor::moveToFirst) { getString(0) }

    override fun updateEvent(id: Long, values: Map<String, Any>): Int =
        resolver.update(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), values.toContentValues(), null, null)

    override fun deleteEvent(id: Long): Int = resolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, id), null, null)

    override fun deleteReminders(eventId: Long) {
        resolver.delete(CalendarContract.Reminders.CONTENT_URI, "${CalendarContract.Reminders.EVENT_ID} = ?", arrayOf(eventId.toString()))
    }

    private fun Map<String, Any>.toContentValues() = ContentValues().also { out ->
        forEach { (column, value) ->
            when (value) {
                is String -> out.put(column, value)
                is Int -> out.put(column, value)
                is Long -> out.put(column, value)
                else -> error("Unsupported calendar column $column")
            }
        }
    }
}

object CalendarPermissionPrompt {
    private val main = Handler(Looper.getMainLooper())

    var launcher: ((Array<String>) -> Unit)? = null
    private val waiting = ArrayList<() -> Unit>()

    fun ask(done: () -> Unit) = main.post {
        val launch = launcher ?: return@post done()
        waiting.add(done)
        if (waiting.size == 1) runCatching { launch(HostCalendars.PERMISSIONS) }.onFailure { answered() }
    }


    fun answered() {
        val done = waiting.toList()
        waiting.clear()
        done.forEach { runCatching { it() } }
    }
}
