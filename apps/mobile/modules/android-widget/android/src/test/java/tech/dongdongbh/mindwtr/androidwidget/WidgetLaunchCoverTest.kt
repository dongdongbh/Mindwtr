package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.view.WindowManager
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class WidgetLaunchCoverTest {
  private fun link(path: String) = Intent(Intent.ACTION_VIEW, Uri.parse(path)).putExtra(WidgetLaunchCover.EXTRA_DESTINATION, true)

  @Test
  fun suppressesModalExitUnderTheCoverAndRestoresOnlyStillAttachedWindows() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val activity = controller.get()
    val protectedModal = Dialog(activity).apply { show() }
    val dismissedModal = Dialog(activity).apply { show() }
    shadowOf(Looper.getMainLooper()).idle()
    val original = android.R.style.Animation_Dialog
    protectedModal.window!!.setWindowAnimations(original)
    dismissedModal.window!!.setWindowAnimations(original)
    WidgetLaunchCover.receive(activity, link("mindwtr:///focus"))
    WidgetLaunchCover.suppressExitAnimation(protectedModal.window!!)
    WidgetLaunchCover.suppressExitAnimation(protectedModal.window!!)
    WidgetLaunchCover.suppressExitAnimation(dismissedModal.window!!)
    assertEquals(0, protectedModal.window!!.attributes.windowAnimations)
    assertEquals(0, dismissedModal.window!!.attributes.windowAnimations)
    dismissedModal.dismiss()
    shadowOf(Looper.getMainLooper()).idle()
    WidgetLaunchCover.complete(WidgetLaunchCover.snapshot()?.get("token") as Int)
    assertEquals(original, protectedModal.window!!.attributes.windowAnimations)
    assertEquals(0, dismissedModal.window!!.attributes.windowAnimations)
    protectedModal.dismiss()
    controller.pause().stop().destroy()
  }

  @Test
  fun resumeKeepsTheSameDeliveryAndShowsTheCoverAfterARetainedModal() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val activity = controller.get()
    val retainedModal = Dialog(activity).apply { show() }
    WidgetLaunchCover.receive(activity, link("mindwtr:///focus"))
    val cover = ShadowDialog.getLatestDialog()
    val token = WidgetLaunchCover.snapshot()?.get("token")
    assertEquals(WindowManager.LayoutParams.TYPE_APPLICATION, cover.window!!.attributes.type)
    retainedModal.dismiss()
    retainedModal.show()
    WidgetLaunchCover.resume(activity)
    assertEquals(token, WidgetLaunchCover.snapshot()?.get("token"))
    assertEquals("pending", WidgetLaunchCover.snapshot()?.get("stage"))
    assertSame(cover, ShadowDialog.getLatestDialog())
    WidgetLaunchCover.cancel(activity)
    retainedModal.dismiss()
    controller.pause().stop().destroy()
  }

  @Test
  fun onlyValidatedWidgetListsHoldTheActivity() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val activity = controller.get()
    for (path in listOf("mindwtr:///focus", "mindwtr:///inbox", "mindwtr:///waiting", "mindwtr:///someday", "mindwtr:///widget-list/context%3AWork%2FHome")) {
      WidgetLaunchCover.receive(activity, link(path))
      assertEquals("pending", WidgetLaunchCover.snapshot()?.get("stage"))
    }
    assertEquals("/widget-list/context:Work/Home", WidgetLaunchCover.snapshot()?.get("path"))
    for (path in listOf("other:///focus", "mindwtr://host/focus", "mindwtr:///focus?taskId=private", "mindwtr:///focus#fragment", "mindwtr://open?task=private", "mindwtr:///capture-quick", "mindwtr:///widget-list/", "mindwtr:///widget-list/next/extra")) {
      WidgetLaunchCover.receive(activity, link(path))
      assertNotEquals(path, "pending", WidgetLaunchCover.snapshot()?.get("stage"))
    }
    WidgetLaunchCover.receive(activity, Intent(Intent.ACTION_VIEW, Uri.parse("mindwtr:///focus")))
    assertNotEquals("pending", WidgetLaunchCover.snapshot()?.get("stage"))
    controller.pause().stop().destroy()
  }

  @Test
  fun onlyTheNewestDeliveryCanAcknowledgeAndSameRouteGetsANewToken() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val activity = controller.get()
    WidgetLaunchCover.receive(activity, link("mindwtr:///focus"))
    val first = WidgetLaunchCover.snapshot()?.get("token") as Int
    WidgetLaunchCover.receive(activity, link("mindwtr:///focus"))
    val second = WidgetLaunchCover.snapshot()?.get("token") as Int
    assertNotEquals(first, second)
    assertFalse(WidgetLaunchCover.complete(first))
    assertEquals("pending", WidgetLaunchCover.snapshot()?.get("stage"))
    assertTrue(WidgetLaunchCover.complete(second))
    assertEquals("acknowledged", WidgetLaunchCover.snapshot()?.get("stage"))
    assertFalse(WidgetLaunchCover.complete(second))
    controller.pause().stop().destroy()
  }

  @Test
  fun routingFailureAndOrdinaryResumeCannotLeaveTheCoverHeld() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    val activity = controller.get()
    WidgetLaunchCover.receive(activity, link("mindwtr:///inbox"))
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
    assertEquals("fallback", WidgetLaunchCover.snapshot()?.get("stage"))
    WidgetLaunchCover.receive(activity, link("mindwtr:///inbox"))
    WidgetLaunchCover.cancel(activity)
    assertEquals("cancelled", WidgetLaunchCover.snapshot()?.get("stage"))
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(5))
    assertEquals("cancelled", WidgetLaunchCover.snapshot()?.get("stage"))
    WidgetLaunchCover.receive(activity, link("mindwtr:///inbox"))
    WidgetLaunchCover.receive(activity, Intent(Intent.ACTION_MAIN))
    assertEquals("cancelled", WidgetLaunchCover.snapshot()?.get("stage"))
    controller.pause().stop().destroy()
  }
}
