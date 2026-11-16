package tech.dongdongbh.mindwtr.pilot

import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test


class NotificationsTimeTest {
    @Test fun pickedTimeIsAsciiInArabicAndPersian() {
        val original = Locale.getDefault()
        try {
            for (tag in listOf("ar", "fa", "en-US")) {
                Locale.setDefault(Locale.forLanguageTag(tag))
                assertEquals("09:05", coreTime(9, 5))
            }
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test fun dateOnlyRowOffersOffThenChooseTimeThenCancelLikeRn() {
        Labels.load(JSONObject().put("language", "en").put("missing", JSONArray()).put("strings", JSONObject()
            .put("settings.dateOnlyReminderChooseTime", "Choose time").put("common.cancel", "Cancel")), reportLoaded = {})
        val row = JSONObject().put("type", "dateOnlyDueReminderTime").put("offLabel", "Off")
        val events = mutableListOf<String>()
        val buttons = offOrTimeButtons(row, { events += "close" }, { events += "set:$it" }, { events += "choose" })

        assertEquals(listOf("Off" to "default", "Choose time" to "default", "Cancel" to "cancel"), buttons.map { it.label to it.style })
        buttons[0].onPress()
        assertEquals(listOf("close", "set:"), events)
        events.clear(); buttons[1].onPress()
        assertEquals(listOf("close", "choose"), events)
        events.clear(); buttons[2].onPress()
        assertEquals(listOf("close"), events)
    }
}
