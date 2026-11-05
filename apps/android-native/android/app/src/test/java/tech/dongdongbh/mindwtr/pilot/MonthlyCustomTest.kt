package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class MonthlyCustomTest {
    private val en = mapOf(
        "recurrence.onDayOfMonth" to "Day {day}", "recurrence.lastDay" to "Last day", "recurrence.onNthWeekday" to "The {ordinal} {weekday}",
        "recurrence.weekdayMonFri" to "Weekday (Mon–Fri)", "recurrence.ordinal.first" to "First", "recurrence.ordinal.second" to "Second",
        "recurrence.ordinal.third" to "Third", "recurrence.ordinal.fourth" to "Fourth", "recurrence.ordinal.last" to "Last",
    )
    private val t = { key: String -> en.getValue(key) }
    private fun plain(value: Any?): Any? = when (value) {
        is JSONObject -> value.keys().asSequence().toSortedSet().associateWith { plain(value.get(it)) }
        is JSONArray -> List(value.length()) { plain(value.get(it)) }
        else -> value
    }
    private fun assertSame(expected: String, actual: JSONObject) = assertEquals(plain(JSONObject(expected)), plain(actual))
    private val core = JSONObject("""{"interval":1,"mode":"nth","ordinal":"2","weekday":"TU","monthDays":[9]}""")

    @Test fun saveSendsCoresStateWithTheIntervalAsTyped() {
        val open = MonthlyCustom.of(core)
        assertSame("""{"kind":"monthlyCustom","custom":{"interval":1,"mode":"nth","ordinal":"2","weekday":"TU","monthDays":[9]},"intervalText":"1"}""",
            open.edit())
        val lastWeekday = open.copy(ordinal = "-1", weekday = "WEEKDAY", intervalText = "")
        assertSame("""{"kind":"monthlyCustom","custom":{"interval":1,"mode":"nth","ordinal":"-1","weekday":"WEEKDAY","monthDays":[9]},"intervalText":""}""",
            lastWeekday.edit())
    }

    @Test fun theOpenDialogSurvivesRotationAsText() {
        val changed = MonthlyCustom.of(core).copy(mode = "date", monthDays = listOf(-1, 3), intervalText = "12")
        assertEquals(changed, MonthlyCustom.restore(changed.save()))
    }

    @Test fun aDayTapAddsInOrderRemovesAndNeverEmptiesTheList() {
        val one = MonthlyCustom.of(core)
        assertEquals(listOf(3, 9), one.toggleDay(3).monthDays)
        assertEquals(listOf(9, -1), one.toggleDay(-1).monthDays)
        assertEquals(listOf(3, 9, -1), one.toggleDay(-1).toggleDay(3).monthDays)
        assertEquals(listOf(9), one.toggleDay(3).toggleDay(3).monthDays)
        assertEquals(listOf(9), one.toggleDay(9).monthDays)
    }

    @Test fun theModeChipsReadAsRnsDo() {
        val days = { list: List<Int> -> MonthlyCustom.of(core).copy(monthDays = list).monthDaysLabel(t) }
        assertEquals("Day 15", days(listOf(15)))
        assertEquals("Day 1, 15 + Last day", days(listOf(-1, 1, 15)))
        assertEquals("Last day", days(listOf(-1)))
        val nth = { ordinal: String, weekday: String -> MonthlyCustom.of(core).copy(ordinal = ordinal, weekday = weekday).nthLabel(t) { "Tuesday" } }
        assertEquals("The Second Tuesday", nth("2", "TU"))
        assertEquals("The Last Weekday (Mon–Fri)", nth("-1", "WEEKDAY"))
        assertEquals(listOf("First", "Second", "Third", "Fourth", "Last"), MONTHLY_ORDINALS.map { ordinalLabel(it, t) })
    }
}
