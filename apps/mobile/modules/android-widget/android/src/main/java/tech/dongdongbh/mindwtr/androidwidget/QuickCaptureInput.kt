package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.util.AttributeSet
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.appcompat.widget.AppCompatEditText

class QuickCaptureInput(context: Context, attrs: AttributeSet?) : AppCompatEditText(context, attrs) {
  var onSelectionChange: (() -> Unit)? = null

  override fun onSelectionChanged(start: Int, end: Int) {
    super.onSelectionChanged(start, end)
    onSelectionChange?.invoke()
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs)
    outAttrs.imeOptions = (outAttrs.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION.inv() and EditorInfo.IME_MASK_ACTION.inv()) or EditorInfo.IME_ACTION_DONE
    return connection
  }
}
