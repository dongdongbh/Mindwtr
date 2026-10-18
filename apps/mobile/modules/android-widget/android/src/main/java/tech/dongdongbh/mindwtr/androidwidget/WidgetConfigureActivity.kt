package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.text.Editable
import android.text.TextWatcher
import android.widget.EditText
import android.widget.Button
import android.widget.RadioButton
import android.content.Context
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ListView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Picks which list a Tasks widget shows (#1173): the fixed GTD lists, then
 * saved filters, contexts and tags. Runs on placement (`android:configure`), from the launcher's
 * edit action (`reconfigurable`), and as a dropdown sheet when the widget's
 * own header chevron is tapped. OK stores the choice for this widget id and
 * redraws it; Cancel on first placement cancels the placement.
 */
class WidgetConfigureActivity : AppCompatActivity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  // Opened from the widget's header chevron: a top-anchored sheet, tap = pick.
  private var dropdown = false
  private var pendingSelection = WidgetListStore.DEFAULT_LIST

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
    val palette = payload.resolvedPalette(this)
    val current = WidgetListStore.read(this, appWidgetId)
    pendingSelection = savedInstanceState?.getString("listSelection") ?: current

    val list = findViewById<ListView>(R.id.mindwtr_widget_configure_lists)
    val textColor = palette?.text ?: getColor(R.color.mindwtr_widget_text)
    val mutedColor = palette?.mutedText ?: getColor(R.color.mindwtr_widget_muted_text)
    val options = chooserGroups(payload)
    val adapter = ChooserAdapter(this, options, textColor, mutedColor, if (dropdown) 40 else 44,
      selected = { pendingSelection },
      pick = { id -> pendingSelection = id; if (dropdown) save() },
    )
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ -> adapter.pick(position) }
    findViewById<EditText>(R.id.mindwtr_widget_configure_search).apply {
      hint = payload.listTitles["search"] ?: "Search"
      setTextColor(textColor)
      setHintTextColor(mutedColor)
      visibility = if (options.sumOf { it.second.size } > 12) View.VISIBLE else View.GONE
      addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { adapter.search(s?.toString() ?: "") }
        override fun afterTextChanged(s: Editable?) {}
      })
    }

    findViewById<Button>(R.id.mindwtr_widget_configure_cancel).apply {
      text = payload.quickCapture.cancel
      setOnClickListener { finish() }
    }
    findViewById<Button>(R.id.mindwtr_widget_configure_ok).apply {
      text = payload.quickCapture.save
      setOnClickListener { save() }
    }
    palette?.let { applyPalette(it, textColor) }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    outState.putString("listSelection", pendingSelection)
    super.onSaveInstanceState(outState)
  }

  private fun save() {
    val listId = pendingSelection
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

  /** Only visible rows are inflated; filtering never discards the pending widget selection. */
  internal class ChooserAdapter(
    private val context: Context,
    private val groups: List<Pair<String?, List<Pair<String, String>>>>,
    private val textColor: Int,
    private val mutedColor: Int,
    private val rowHeight: Int,
    private val selected: () -> String,
    private val pick: (String) -> Unit,
  ) : BaseAdapter() {
    private var rows: List<Pair<String?, String>> = emptyList()
    init { search("") }

    fun search(query: String) {
      val needle = query.trim()
      rows = groups.flatMap { (label, entries) ->
        val matches = entries.filter { it.second.contains(needle, ignoreCase = true) }
        if (matches.isEmpty()) emptyList()
        else (if (label != null) listOf(null to label) else emptyList()) + matches
      }
      notifyDataSetChanged()
    }

    fun pick(position: Int) {
      rows.getOrNull(position)?.first?.let { pick(it); notifyDataSetChanged() }
    }
    override fun getCount(): Int = rows.size
    override fun getItem(position: Int): Pair<String?, String> = rows[position]
    override fun getItemId(position: Int): Long = position.toLong()
    override fun getViewTypeCount(): Int = 2
    override fun getItemViewType(position: Int): Int = if (rows[position].first == null) 0 else 1
    override fun areAllItemsEnabled(): Boolean = false
    override fun isEnabled(position: Int): Boolean = rows[position].first != null

    override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
      val (id, title) = rows[position]
      val density = context.resources.displayMetrics.density
      if (id == null) return ((convertView as? TextView)?.takeUnless { it is RadioButton } ?: TextView(context)).apply {
        text = title
        setTextColor(mutedColor)
        textSize = 12f
        setPadding(0, (12 * density).toInt(), 0, (4 * density).toInt())
      }
      return (convertView as? RadioButton ?: RadioButton(context)).apply {
        text = title
        tag = id
        setTextColor(textColor)
        textSize = 15f
        minHeight = (rowHeight * density).toInt()
        isChecked = id == selected()
        setOnClickListener { pick(position) }
      }
    }
  }

  companion object {
    const val EXTRA_DROPDOWN = "tech.dongdongbh.mindwtr.androidwidget.dropdown"

    internal fun chooserGroups(payload: WidgetPayload): List<Pair<String?, List<Pair<String, String>>>> = listOf(
      null to fixedOptions(payload.listTitles),
      (payload.listTitles["savedFilters"] ?: "Saved filters") to payload.savedFilters.map { WidgetListStore.FILTER_PREFIX + it.id to it.name },
      (payload.listTitles["contexts"] ?: "Contexts") to payload.contexts.map { it.id to it.name },
      (payload.listTitles["tags"] ?: "Tags") to payload.tags.map { it.id to it.name },
    )

    internal fun fixedOptions(titles: Map<String, String>): List<Pair<String, String>> =
      listOf("focus" to "Focus", "inbox" to "Inbox", "next" to "Next Actions", "upcoming" to "Upcoming", "waiting" to "Waiting For", "someday" to "Someday/Maybe")
        .map { (id, fallback) -> id to (titles[id] ?: fallback) }
  }
}
