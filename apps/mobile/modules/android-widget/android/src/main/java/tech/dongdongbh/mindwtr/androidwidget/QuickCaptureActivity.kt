package tech.dongdongbh.mindwtr.androidwidget

import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.IOException

/**
 * Floating quick-capture dialog (#1169). Runs in its own task, never brings
 * the main app forward, and only appends to the pending-captures queue.
 */
class QuickCaptureActivity : AppCompatActivity() {
  private lateinit var input: EditText
  private lateinit var labels: WidgetPayload.QuickCaptureLabels

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.mindwtr_quick_capture)
    labels = WidgetPayloadStore.read(this).quickCapture

    findViewById<TextView>(R.id.mindwtr_quick_capture_title).text = labels.title
    input = findViewById(R.id.mindwtr_quick_capture_input)
    input.hint = labels.placeholder
    findViewById<Button>(R.id.mindwtr_quick_capture_cancel).apply {
      text = labels.cancel
      setOnClickListener { finish() }
    }
    findViewById<Button>(R.id.mindwtr_quick_capture_save).apply {
      text = labels.save
      setOnClickListener { save() }
    }
    input.setOnEditorActionListener { _, actionId, event ->
      val enterPressed = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
      if (actionId == EditorInfo.IME_ACTION_DONE || enterPressed) {
        save()
        true
      } else {
        false
      }
    }
    input.requestFocus()
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
