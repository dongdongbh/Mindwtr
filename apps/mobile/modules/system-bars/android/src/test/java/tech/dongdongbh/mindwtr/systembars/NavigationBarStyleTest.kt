package tech.dongdongbh.mindwtr.systembars

import android.app.Activity
import android.graphics.Color
import android.view.View
import android.view.WindowInsetsController
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Suppress("DEPRECATION")
class NavigationBarStyleTest {
  @Test
  @Config(sdk = [28])
  fun legacyColorAndIconsPreserveUnrelatedFlags() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val window = activity.window
    window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
    assertEquals("legacy-color", NavigationBarStyle.apply(window, "#F6F7FB", true))
    assertEquals(Color.parseColor("#F6F7FB"), window.navigationBarColor)
    assertEquals(View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR,
      window.decorView.systemUiVisibility)
    NavigationBarStyle.apply(window, "#151718", false)
    assertEquals(View.SYSTEM_UI_FLAG_LAYOUT_STABLE, window.decorView.systemUiVisibility)
  }

  @Test
  @Config(sdk = [30, 35])
  fun modernIconsPreserveStatusBarAppearance() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val window = activity.window
    val controller = window.insetsController!!
    val status = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
    val navigation = WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
    controller.setSystemBarsAppearance(status, status)
    NavigationBarStyle.apply(window, "#F6F7FB", true)


    assertEquals(status or navigation, controller.systemBarsAppearance and (status or navigation))
    assertFalse(window.isNavigationBarContrastEnforced)
    NavigationBarStyle.apply(window, "#151718", false)
    assertEquals(status, controller.systemBarsAppearance and (status or navigation))
  }

  @Test
  @Config(sdk = [35])
  fun edgeToEdgeDoesNotWriteLegacyColor() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val window = activity.window
    val originalColor = window.navigationBarColor
    assertEquals("edge-to-edge", NavigationBarStyle.apply(window, "#123456", false))
    assertEquals(originalColor, window.navigationBarColor)
  }
}
