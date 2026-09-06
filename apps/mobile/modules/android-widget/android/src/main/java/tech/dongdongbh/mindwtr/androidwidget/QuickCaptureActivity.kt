package tech.dongdongbh.mindwtr.androidwidget

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import java.io.IOException

/**
 * Floating quick-capture dialog (#1169). Runs in its own task, never brings
 * the main app forward, and only appends to the pending-captures queue.
 * Drawn in the app's palette from the stored widget payload, so a theme
 * change in the app shows on the next open.
 */
class QuickCaptureActivity : AppCompatActivity() {
  private lateinit var input: EditText
  private lateinit var save: Button
  private lateinit var labels: WidgetPayload.QuickCaptureLabels

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.mindwtr_quick_capture)
    val payload = WidgetPayloadStore.read(this)
    labels = payload.quickCapture

    val title = findViewById<TextView>(R.id.mindwtr_quick_capture_title)
    title.text = labels.title
    input = findViewById(R.id.mindwtr_quick_capture_input)
    input.hint = labels.placeholder
    val cancel = findViewById<Button>(R.id.mindwtr_quick_capture_cancel).apply {
      text = labels.cancel
      setOnClickListener { finish() }
    }
    save = findViewById<Button>(R.id.mindwtr_quick_capture_save).apply {
      text = labels.save
      setOnClickListener { save() }
    }
    input.doAfterTextChanged { text ->
      val enabled = !text.isNullOrBlank()
      save.isEnabled = enabled
      save.alpha = if (enabled) 1f else 0.5f
    }
    save.isEnabled = false
    save.alpha = 0.5f
    input.setOnEditorActionListener { _, actionId, event ->
      val enterPressed = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
      if (actionId == EditorInfo.IME_ACTION_DONE || enterPressed) {
        save()
        true
      } else {
        false
      }
    }
    payload.palette?.takeUnless { payload.usesSystemColors }?.let { applyPalette(it, title, cancel) }
    input.requestFocus()
  }

  private fun applyPalette(palette: WidgetPayload.Palette, title: TextView, cancel: Button) {
    tint(findViewById(R.id.mindwtr_quick_capture_root), palette.background)
    title.setTextColor(palette.text)
    input.setTextColor(palette.text)
    input.setHintTextColor(palette.mutedText)
    tint(input, palette.card)
    cancel.setTextColor(palette.accent)
    tint(save, palette.accent)
    save.setTextColor(palette.onAccent)
  }

  private fun tint(view: View, color: Int) {
    (view.background?.mutate() as? GradientDrawable)?.setColor(color)
  }

  private fun save() {
    val title = input.text?.toString().orEmpty()
    val written = try {
      PendingCaptureWriter.write(filesDir, title)
    } catch (error: IOException) {
      Log.w(TAG, "quick capture write failed: ${error.message}")
      Toast.makeText(this, error.message ?: "Could not save", Toast.LENGTH_SHORT).show()
      return
    }
    if (written == null) {
      // Empty title: keep the dialog open so the user can type.
      input.requestFocus()
      return
    }
    Log.i(TAG, "quick capture queued ${written.name}")
    Toast.makeText(this, labels.added, Toast.LENGTH_SHORT).show()
    WidgetPayloadStore.incrementInboxCount(this)
    WidgetRenderer.refreshAll(this)
    finish()
  }

  companion object {
    private const val TAG = "Mindwtr"
  }
}
