package tech.dongdongbh.mindwtr.pilot

import java.util.Locale
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
}
