package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test


class SystemBarsTest {
    private val light = 0xFFF6F7FB.toInt()
    private val dark = 0xFF151718.toInt()

    @Test fun belowAndroid15TheBarsTakeTheThemeBackground() {
        assertEquals(SystemBarStyle(statusColor = light, navigationColor = light, lightStatus = true, lightNavigation = true), systemBarStyle(light, dark = false, sdk = 34))
        assertEquals(SystemBarStyle(statusColor = dark, navigationColor = dark, lightStatus = false, lightNavigation = false), systemBarStyle(dark, dark = true, sdk = 24))
    }

    @Test fun android15DrawsBehindTransparentBars() {
        val style = systemBarStyle(light, dark = false, sdk = 35)
        assertNull(style.statusColor)
        assertNull(style.navigationColor)
    }

    @Test fun navigationButtonsFollowTheBackgroundsLuminance() {
        assertTrue(systemBarStyle(0xFFFFFFFF.toInt(), dark = true, sdk = 30).lightNavigation)
        assertFalse(systemBarStyle(0xFF000000.toInt(), dark = false, sdk = 30).lightNavigation)
    }

    @Test fun android7KeepsItsBlackNavigationBarUnderALightBackground() {

        assertNull(systemBarStyle(light, dark = false, sdk = 25).navigationColor)
        assertEquals(dark, systemBarStyle(dark, dark = true, sdk = 25).navigationColor)
        assertEquals(light, systemBarStyle(light, dark = false, sdk = 26).navigationColor)
    }
}
