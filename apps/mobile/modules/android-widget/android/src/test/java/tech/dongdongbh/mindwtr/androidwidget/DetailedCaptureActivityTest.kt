package tech.dongdongbh.mindwtr.androidwidget

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DetailedCaptureActivityTest {
  @Test
  fun opensTheDetailedCaptureLinkOfTheAppsSchemeOnMainActivity() {
    val activity = Robolectric.buildActivity(DetailedCaptureActivity::class.java).create().get()

    val started = shadowOf(activity).nextStartedActivity
    // The module's default scheme is RN's; an app that links on another scheme overrides mindwtr_link_scheme.
    assertEquals("mindwtr:///capture-quick?mode=text&entry=details", started.dataString)
    assertEquals("${activity.packageName}.MainActivity", started.component?.className)
  }
}
