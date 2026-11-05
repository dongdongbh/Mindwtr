package tech.dongdongbh.mindwtr.androidwidget

import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity


class TaskPeekActivity : AppCompatActivity() {
  private var taskId: String = ""

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    taskId = intent?.getStringExtra(EXTRA_TASK_ID)?.trim().orEmpty()
    val payload = WidgetPayloadStore.read(this)
    val item = payload.itemFor(taskId)
    if (item == null) {

      finish()
      return
    }
    setContentView(R.layout.mindwtr_task_peek)
    val palette = payload.resolvedPalette(this)
    val mutedColor = palette?.mutedText ?: getColor(R.color.mindwtr_widget_muted_text)
    val textColor = palette?.text ?: getColor(R.color.mindwtr_widget_text)

    findViewById<TextView>(R.id.mindwtr_task_peek_title).apply {
      text = item.title
      setTextColor(textColor)
    }
    findViewById<TextView>(R.id.mindwtr_task_peek_context).apply {
      isVisible(item.contextLabel != null)
      text = item.contextLabel
      setTextColor(mutedColor)
      item.identityColor?.let { setCompoundDrawablesRelativeWithIntrinsicBounds(dot(it), null, null, null) }
    }
    findViewById<TextView>(R.id.mindwtr_task_peek_description).apply {
      isVisible(item.description != null)
      text = item.description
      setTextColor(textColor)
    }

    val chips = findViewById<LinearLayout>(R.id.mindwtr_task_peek_chips)
    for (token in item.contexts + item.tags) chips.addView(chip(token, mutedColor, palette?.card))
    findViewById<View>(R.id.mindwtr_task_peek_chip_row).isVisible(chips.childCount > 0)

    val meta = findViewById<LinearLayout>(R.id.mindwtr_task_peek_meta)
    addMetaLine(meta, payload.taskPeek.start, item.startLabel, mutedColor)
    addMetaLine(meta, payload.taskPeek.due, item.dueLabel, mutedColor)
    addMetaLine(meta, payload.taskPeek.priority, item.priorityLabel, mutedColor)
    meta.isVisible(meta.childCount > 0)

    findViewById<Button>(R.id.mindwtr_task_peek_open).apply {
      text = payload.taskPeek.open
      palette?.let { setTextColor(it.accent) }
      setOnClickListener {
        startActivity(WidgetRenderer.appIntent(this@TaskPeekActivity, item.openUri ?: payload.focusUri))
        finish()
      }
    }
    findViewById<Button>(R.id.mindwtr_task_peek_complete).apply {
      text = payload.taskPeek.complete
      palette?.let {
        (background?.mutate() as? GradientDrawable)?.setColor(it.accent)
        setTextColor(it.onAccent)
      }
      setOnClickListener { complete() }
    }
    palette?.let {
      (findViewById<View>(R.id.mindwtr_task_peek_root).background?.mutate() as? GradientDrawable)?.setColor(it.background)
    }
  }


  private fun complete() {
    when (CheckoffStore.tapAction(this, taskId)) {
      CheckoffStore.TapAction.TOGGLE_PENDING -> {
        CheckoffStore.toggle(this, taskId)
        WidgetRenderer.refreshAll(this)
      }
      CheckoffStore.TapAction.RECONCILE -> CheckoffStore.reconcileFromInteraction(this)
      CheckoffStore.TapAction.NO_OP -> Unit
    }
    finish()
  }

  private fun addMetaLine(parent: LinearLayout, label: String, value: String?, color: Int) {
    if (value.isNullOrEmpty()) return
    parent.addView(TextView(this).apply {
      text = "$label: $value"
      textSize = 13f
      setTextColor(color)
      setPadding(0, dp(2), 0, dp(2))
    })
  }

  private fun chip(label: String, textColor: Int, fill: Int?): TextView = TextView(this).apply {
    text = label
    textSize = 12f
    setTextColor(textColor)
    setBackgroundResource(R.drawable.mindwtr_dialog_field)
    fill?.let { (background?.mutate() as? GradientDrawable)?.setColor(it) }
    setPadding(dp(10), dp(4), dp(10), dp(4))
    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      .apply { marginEnd = dp(6) }
  }

  private fun dot(color: Int): GradientDrawable = GradientDrawable().apply {
    shape = GradientDrawable.OVAL
    setColor(color)
    setSize(dp(8), dp(8))
  }

  private fun View.isVisible(visible: Boolean) {
    visibility = if (visible) View.VISIBLE else View.GONE
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  companion object {
    const val EXTRA_TASK_ID = "tech.dongdongbh.mindwtr.androidwidget.taskId"
  }
}
