package tech.dongdongbh.mindwtr.systembars

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

internal object ModalKeyboardInset {
  fun read(input: View): Double? {
    if (!input.isAttachedToWindow) return null

    val root = input.rootView
    val insets = ViewCompat.getRootWindowInsets(root) ?: return null
    return insets.getInsets(WindowInsetsCompat.Type.ime()).bottom.toDouble() /
      input.resources.displayMetrics.density
  }
}
