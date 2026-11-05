package tech.dongdongbh.mindwtr.pilot

import android.os.Build
import android.view.Window
import androidx.core.view.WindowCompat
import kotlin.math.pow


data class SystemBarStyle(val statusColor: Int?, val navigationColor: Int?, val lightStatus: Boolean, val lightNavigation: Boolean)


fun systemBarStyle(bg: Int, dark: Boolean, sdk: Int): SystemBarStyle {
    val lightNavigation = luminance(bg) > 0.5
    val color = bg.takeIf { sdk < 35 }
    return SystemBarStyle(color, color.takeUnless { sdk < 26 && lightNavigation }, lightStatus = !dark, lightNavigation)
}


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
