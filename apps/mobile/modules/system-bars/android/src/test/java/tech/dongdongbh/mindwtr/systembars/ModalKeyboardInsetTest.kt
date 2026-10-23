package tech.dongdongbh.mindwtr.systembars

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.graphics.Insets
import android.os.Looper
import android.view.View
import android.view.WindowInsets
import android.widget.EditText
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30, 35], qualifiers = "xxxhdpi")
class ModalKeyboardInsetTest {
  // Inject the platform inset at the dialog root: Robolectric does not run an IME.
  private class InsetsRoot(context: Context, var insets: WindowInsets?) : View(context) {
    override fun getRootWindowInsets(): WindowInsets? = insets
  }

  @Test
  fun measuresOwningModalRootAndConvertsPixelsToReactNativeUnits() {
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val density = activity.resources.displayMetrics.density
    val root = InsetsRoot(activity, WindowInsets.Builder()
      .setInsets(WindowInsets.Type.ime(), Insets.of(0, 0, 0, (283 * density).toInt()))
      .setVisible(WindowInsets.Type.ime(), true)
      .build())
    val input = object : EditText(activity) {
      override fun getRootView(): View = root
    }
    val dialog = Dialog(activity)
    dialog.setContentView(input)
    dialog.show()
    shadowOf(Looper.getMainLooper()).idle()
    assertTrue(input.isAttachedToWindow)
    assertEquals(283.0, ModalKeyboardInset.read(input)!!, 0.01)
    root.insets = WindowInsets.Builder()
      .setInsets(WindowInsets.Type.ime(), Insets.NONE)
      .setVisible(WindowInsets.Type.ime(), false)
      .build()
    assertEquals(0.0, ModalKeyboardInset.read(input)!!, 0.01)
    root.insets = null
    assertNull(ModalKeyboardInset.read(input))
    dialog.dismiss()
    shadowOf(Looper.getMainLooper()).idle()
    assertNull(ModalKeyboardInset.read(input))
  }
}
