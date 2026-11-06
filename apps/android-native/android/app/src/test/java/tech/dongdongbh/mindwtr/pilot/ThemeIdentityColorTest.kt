package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class ThemeIdentityColorTest {
    private fun reply(mode: String, preset: String) = ThemeChoice.Reply(mode, preset, false, null, emptyMap(), emptyMap(), emptyMap())

    @Test fun einkDrawsEveryProjectAndAreaColorBlackAsRnDoes_c30388ad2() {
        val eink = mindwtrTheme(reply("eink", "eink"), systemDark = false)
        assertEquals(Color.Black, eink.identityColorOrNull("#3B82F6"))
        assertEquals(Color.Black, eink.identityColorOrNull("#EF4444"))
        assertNull(eink.identityColorOrNull(null))
    }

    @Test fun otherThemesKeepTheStoredColor() {
        for (theme in listOf(mindwtrTheme(reply("light", "default"), false), mindwtrTheme(reply("dark", "default"), true), mindwtrTheme(null, false))) {
            assertEquals(Color(0xFF3B82F6), theme.identityColorOrNull("#3B82F6"))
            assertNull(theme.identityColorOrNull("not a color"))
        }
    }

    @Test fun einkDrawsTheFocusStarAndTheSwipeTraysFocusAndDeleteBlackAsRnDoes() {
        val eink = mindwtrTheme(reply("eink", "eink"), systemDark = false)
        assertEquals(Color.Black, eink.star)
        assertEquals(Color.Black, trayButtonColor(eink, "focus"))
        assertEquals(Color.Black, trayButtonColor(eink, "delete"))
        assertEquals(eink.status("done").text, trayButtonColor(eink, "done"))
    }

    @Test fun otherThemesKeepRnsAmberStarAndRedDelete() {
        val light = mindwtrTheme(reply("light", "default"), false)
        assertEquals(Color(0xFFF59E0B), light.star)
        assertEquals(Color(0xFFF59E0B), trayButtonColor(light, "focus"))
        assertEquals(Color(0xFFEF4444), trayButtonColor(light, "delete"))
    }
}
