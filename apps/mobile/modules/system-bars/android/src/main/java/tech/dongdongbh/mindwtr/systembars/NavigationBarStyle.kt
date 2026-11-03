package tech.dongdongbh.mindwtr.systembars

import android.graphics.Color
import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowInsetsController

internal object NavigationBarStyle {
  @Suppress("DEPRECATION")
  fun apply(window: Window, color: String, darkButtons: Boolean): String {


    if (Build.VERSION.SDK_INT < 35) {
      window.navigationBarColor = Color.parseColor(color)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val controller = window.insetsController ?: return "unavailable"
      val lightNavigation = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
      controller.setSystemBarsAppearance(if (darkButtons) lightNavigation else 0, lightNavigation)
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val decorView = window.decorView
      val currentFlags = decorView.systemUiVisibility
      decorView.systemUiVisibility = if (darkButtons) {
        currentFlags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
      } else {
        currentFlags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv()
      }
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isNavigationBarContrastEnforced = false
    }
    return if (Build.VERSION.SDK_INT >= 35) "edge-to-edge" else "legacy-color"
  }
}
