package tech.dongdongbh.mindwtr.pilot

import android.os.Build
import android.view.Window
import androidx.core.view.WindowCompat
import kotlin.math.pow

/** The system bars for a theme background: their colors (null keeps the system's) and whether their icons are dark. */
data class SystemBarStyle(val statusColor: Int?, val navigationColor: Int?, val lightStatus: Boolean, val lightNavigation: Boolean)

/**
 * RN's StatusBar (apps/mobile/app/_layout.tsx) and android-system-bars.ts with its NavigationBarStyle: below Android 15 both bars
 * take the theme's background; from Android 15 the app draws behind transparent bars. The status icons follow the theme, the
 * navigation buttons the background's luminance. Android 7 draws only white navigation buttons, so a light background keeps its
 * black navigation bar there (RN colors it anyway and hides the buttons).
 */
fun systemBarStyle(bg: Int, dark: Boolean, sdk: Int): SystemBarStyle {
    val lightNavigation = luminance(bg) > 0.5
    val color = bg.takeIf { sdk < 35 }
    return SystemBarStyle(color, color.takeUnless { sdk < 26 && lightNavigation }, lightStatus = !dark, lightNavigation)
}

/** RN's relative luminance (WCAG's, with its 0.03928 cut). */
private fun luminance(argb: Int): Double {
    fun channel(shift: Int): Double {
        val value = ((argb shr shift) and 0xFF) / 255.0
        return if (value <= 0.03928) value / 12.92 else ((value + 0.055) / 1.055).pow(2.4)
    }
    return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

@Suppress("DEPRECATION")
fun Window.applySystemBars(bg: Int, dark: Boolean) {
    val style = systemBarStyle(bg, dark, Build.VERSION.SDK_INT)
    style.statusColor?.let { statusBarColor = it }
    style.navigationColor?.let { navigationBarColor = it }
    WindowCompat.getInsetsController(this, decorView).apply {
        isAppearanceLightStatusBars = style.lightStatus
        isAppearanceLightNavigationBars = style.lightNavigation
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) isNavigationBarContrastEnforced = false
}
