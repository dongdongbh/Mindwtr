package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.ContextWrapper
import android.content.res.Resources
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetLinkSchemeTest {
  @Test
  fun anAppLinkTakesTheAppsSchemeAndEverythingElseStays() {
    assertEquals("mindwtr:///inbox", WidgetRenderer.linkInScheme("mindwtr:///inbox", "mindwtr"))
    assertEquals("mindwtr-native-dev:///inbox", WidgetRenderer.linkInScheme("mindwtr:///inbox", "mindwtr-native-dev"))
    assertEquals("mindwtr-upgradetest:///widget-list/next", WidgetRenderer.linkInScheme("mindwtr:///widget-list/next", "mindwtr-upgradetest"))
    assertEquals("mindwtr-widget://task/t1", WidgetRenderer.linkInScheme("mindwtr-widget://task/t1", "mindwtr-native-dev"))
    assertEquals("https://example.com/", WidgetRenderer.linkInScheme("https://example.com/", "mindwtr-native-dev"))
  }

  @Test
  fun rnsAppKeepsItsMindwtrLinks() {

    val context = ApplicationProvider.getApplicationContext<Context>()
    assertEquals("mindwtr:///focus", WidgetRenderer.appIntent(context, "mindwtr:///focus").dataString)
  }

  @Test
  fun anAppThatOverridesTheSchemeGetsItsOwnLinks() {

    val base = ApplicationProvider.getApplicationContext<Context>()
    @Suppress("DEPRECATION")
    val resources = object : Resources(base.assets, base.resources.displayMetrics, base.resources.configuration) {
      override fun getString(id: Int): String = if (id == R.string.mindwtr_link_scheme) "mindwtr-native-dev" else super.getString(id)
    }
    val context = object : ContextWrapper(base) {
      override fun getResources(): Resources = resources
    }
    val intent = WidgetRenderer.appIntent(context, "mindwtr:///widget-list/next")
    assertEquals("mindwtr-native-dev:///widget-list/next", intent.dataString)
    assertEquals("${base.packageName}.MainActivity", intent.component?.className)
  }
}
