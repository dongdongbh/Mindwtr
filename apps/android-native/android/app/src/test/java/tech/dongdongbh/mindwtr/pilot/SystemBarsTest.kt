package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RN's android-system-bars.ts and its StatusBar (513ac068a, 52e4f2461): below Android 15 both bars take the theme's background,
 * the status icons follow the theme, and the navigation buttons follow the background's luminance; from Android 15 the app draws
 * behind transparent bars.
 */
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
        // Android 7 cannot draw dark navigation buttons, so a light bar would hide its white ones (RN colors it anyway).
        assertNull(systemBarStyle(light, dark = false, sdk = 25).navigationColor)
        assertEquals(dark, systemBarStyle(dark, dark = true, sdk = 25).navigationColor)
        assertEquals(light, systemBarStyle(light, dark = false, sdk = 26).navigationColor)
    }
}
