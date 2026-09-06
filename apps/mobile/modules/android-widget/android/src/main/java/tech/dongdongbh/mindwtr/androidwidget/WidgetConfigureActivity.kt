package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Picks which list a Tasks widget shows (#1173): the fixed GTD lists, then
 * one project. Runs on placement (`android:configure`), from the launcher's
 * edit action (`reconfigurable`), and as a dropdown sheet when the widget's
 * own header title is tapped. OK stores the choice for this widget id and
 * redraws it; Cancel on first placement cancels the placement.
 */
class WidgetConfigureActivity : AppCompatActivity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  // Opened from the widget's header title: a top-anchored sheet, tap = pick.
  private var dropdown = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setResult(Activity.RESULT_CANCELED)
    appWidgetId = intent?.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
      ?: AppWidgetManager.INVALID_APPWIDGET_ID
    // Exported for the launcher's configure flow, so trust nothing in the
    // intent: the id must name a widget already bound to one of this app's
    // providers (the launcher binds before it starts the configure activity).
    val info = AppWidgetManager.getInstance(this)?.getAppWidgetInfo(appWidgetId)
    if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID || info?.provider?.packageName != packageName) {
      finish()
      return
    }
    dropdown = intent?.getBooleanExtra(EXTRA_DROPDOWN, false) == true
    setContentView(R.layout.mindwtr_widget_configure)
    if (dropdown) {
      window.setGravity(android.view.Gravity.TOP)
      window.attributes = window.attributes.apply { y = dp(56) }
      findViewById<View>(R.id.mindwtr_widget_configure_buttons).visibility = View.GONE
      findViewById<View>(R.id.mindwtr_widget_configure_title).visibility = View.GONE
    }
    val payload = WidgetPayloadStore.read(this)
    val palette = payload.palette?.takeUnless { payload.usesSystemColors }
    val current = WidgetListStore.read(this, appWidgetId)

    val group = findViewById<RadioGroup>(R.id.mindwtr_widget_configure_lists)
    val textColor = palette?.text ?: getColor(R.color.mindwtr_widget_text)
    val mutedColor = palette?.mutedText ?: getColor(R.color.mindwtr_widget_muted_text)
    val options = fixedOptions(payload.listTitles) + payload.projects.map { WidgetListStore.PROJECT_PREFIX + it.id to it.title }
    val identityById = payload.projects.associate { WidgetListStore.PROJECT_PREFIX + it.id to it.identityColor }
    var firstProject = true
    for ((id, title) in options) {
      if (id.startsWith(WidgetListStore.PROJECT_PREFIX) && firstProject) {
        firstProject = false
        group.addView(TextView(this).apply {
          text = payload.listTitles["projects"] ?: "Projects"
          setTextColor(mutedColor)
          textSize = 12f
          setPadding(0, dp(12), 0, dp(4))
        })
      }
      group.addView(RadioButton(this).apply {
        text = title
        tag = id
        setTextColor(textColor)
        textSize = 15f
        minHeight = dp(if (dropdown) 40 else 44)
        isChecked = id == current
        if (dropdown) setOnClickListener { save(group) }
        // The project's identity dot leads the name, as it does in the app's
        // own lists, so the dots line up in a column instead of trailing each
        // title at a different x.
        identityById[id]?.let { color ->
          val dot = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color); setSize(dp(10), dp(10)) }
          setCompoundDrawablesRelativeWithIntrinsicBounds(dot, null, null, null)
          compoundDrawablePadding = dp(10)
        }
      })
    }

    findViewById<Button>(R.id.mindwtr_widget_configure_cancel).apply {
      text = payload.quickCapture.cancel
      setOnClickListener { finish() }
    }
    findViewById<Button>(R.id.mindwtr_widget_configure_ok).apply {
      text = payload.quickCapture.save
      setOnClickListener { save(group) }
    }
    palette?.let { applyPalette(it, textColor) }
  }

  private fun fixedOptions(titles: Map<String, String>): List<Pair<String, String>> =
    listOf("focus" to "Focus", "inbox" to "Inbox", "next" to "Next Actions", "waiting" to "Waiting For", "someday" to "Someday/Maybe")
      .map { (id, fallback) -> id to (titles[id] ?: fallback) }

  private fun save(group: RadioGroup) {
    val checked = group.findViewById<RadioButton>(group.checkedRadioButtonId) ?: return
    val listId = checked.tag as? String ?: WidgetListStore.DEFAULT_LIST
    WidgetListStore.write(this, appWidgetId, listId)
    val manager = AppWidgetManager.getInstance(this)
    WidgetRenderer.render(this, manager, intArrayOf(appWidgetId), WidgetKind.TASKS)
    setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    finish()
  }

  private fun applyPalette(palette: WidgetPayload.Palette, textColor: Int) {
    (findViewById<View>(R.id.mindwtr_widget_configure_root).background?.mutate() as? GradientDrawable)?.setColor(palette.background)
    findViewById<TextView>(R.id.mindwtr_widget_configure_title).setTextColor(textColor)
    findViewById<Button>(R.id.mindwtr_widget_configure_cancel).setTextColor(palette.accent)
    findViewById<Button>(R.id.mindwtr_widget_configure_ok).apply {
      (background?.mutate() as? GradientDrawable)?.setColor(palette.accent)
      setTextColor(palette.onAccent)
    }
  }

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

  companion object {
    const val EXTRA_DROPDOWN = "tech.dongdongbh.mindwtr.androidwidget.dropdown"
  }
}
