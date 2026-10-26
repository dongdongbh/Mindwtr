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
import android.widget.Spinner
import android.widget.ArrayAdapter
import android.widget.AdapterView
import androidx.appcompat.app.AppCompatActivity

/**
 * Picks which list a Tasks widget shows (#1173): the fixed GTD lists, then
 * saved filters, contexts and tags, and its background (Default, or transparent with light or dark text).
 * A Compact widget gets the background row only. Runs on placement (`android:configure`),
 * from the launcher's edit action (`reconfigurable`), and, for Tasks, as a list-only
 * dropdown sheet when the widget's own header chevron is tapped. OK stores the choice
 * for this widget id and redraws it; Cancel on first placement cancels the placement.
 */
class WidgetConfigureActivity : AppCompatActivity() {
  private var appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID
  // Opened from the widget's header chevron: a top-anchored sheet, tap = pick.
  private var dropdown = false
  private var pendingSelection = WidgetListStore.DEFAULT_LIST
  private var groupingOptions = WidgetListStore.GROUPINGS
  private var kind = WidgetKind.TASKS
  private var pendingBackground = WidgetBackground.DEFAULT

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
    kind = kindFor(packageName, info.provider.className)
    if (kind == WidgetKind.QUICK_CAPTURE) {
      finish()
      return
    }
    dropdown = kind == WidgetKind.TASKS && intent?.getBooleanExtra(EXTRA_DROPDOWN, false) == true
    setContentView(R.layout.mindwtr_widget_configure)
    if (kind == WidgetKind.COMPACT) {
      findViewById<View>(R.id.mindwtr_widget_configure_lists).visibility = View.GONE
    }
    if (dropdown) {
      window.setGravity(android.view.Gravity.TOP)
      window.attributes = window.attributes.apply { y = dp(56) }
      findViewById<View>(R.id.mindwtr_widget_configure_buttons).visibility = View.GONE
      findViewById<View>(R.id.mindwtr_widget_configure_title).visibility = View.GONE
      findViewById<View>(R.id.mindwtr_widget_configure_background_row).visibility = View.GONE
    }
    val payload = WidgetPayloadStore.read(this)
    groupingOptions = WidgetListStore.GROUPINGS.filter { it != "priority" || payload.prioritiesEnabled }
    val palette = payload.resolvedPalette(this)
    val current = WidgetListStore.read(this, appWidgetId)
    pendingSelection = savedInstanceState?.getString("listSelection") ?: current
    pendingBackground = savedInstanceState?.getString("background")?.let { name -> WidgetBackground.entries.firstOrNull { it.name == name } }
      ?: WidgetListStore.background(this, appWidgetId)

    val list = findViewById<ListView>(R.id.mindwtr_widget_configure_lists)
    val textColor = palette?.text ?: getColor(R.color.mindwtr_widget_text)
    val mutedColor = palette?.mutedText ?: getColor(R.color.mindwtr_widget_muted_text)
    val options = chooserGroups(payload)
    val adapter = ChooserAdapter(this, options, textColor, mutedColor, if (dropdown) 40 else 44,
      selected = { WidgetListStore.baseListId(pendingSelection) },
      pick = { id ->
        pendingSelection = WidgetListStore.withGrouping(id, WidgetListStore.grouping(pendingSelection)?.first)
        updateGroupingVisibility()
        if (dropdown) save()
      },
    )
    list.adapter = adapter
    list.setOnItemClickListener { _, _, position, _ -> adapter.pick(position) }
    findViewById<TextView>(R.id.mindwtr_widget_configure_grouping_label).apply {
      text = payload.listTitles["groupBy"] ?: "Group by"
      setTextColor(textColor)
    }
    findViewById<Spinner>(R.id.mindwtr_widget_configure_grouping).apply {
      val labels = listOf("groupDefault" to "Default", "groupNone" to "None", "groupContext" to "Context", "groupProject" to "Project") +
        if (payload.prioritiesEnabled) listOf("groupPriority" to "Priority") else emptyList()
      this.adapter = spinnerAdapter(labels.map { (key, fallback) -> payload.listTitles[key] ?: fallback }, textColor, palette)
      setSelection((groupingOptions.indexOf(WidgetListStore.grouping(pendingSelection)?.first) + 1).coerceAtLeast(0))
      onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
          val currentPosition = (groupingOptions.indexOf(WidgetListStore.grouping(pendingSelection)?.first) + 1).coerceAtLeast(0)
          if (position != currentPosition) pendingSelection = WidgetListStore.withGrouping(pendingSelection, groupingOptions.getOrNull(position - 1))
        }
        override fun onNothingSelected(parent: AdapterView<*>?) {}
      }
    }
    updateGroupingVisibility()
    findViewById<TextView>(R.id.mindwtr_widget_configure_background_label).apply {
      text = payload.listTitles["background"] ?: "Background"
      setTextColor(textColor)
    }
    findViewById<Spinner>(R.id.mindwtr_widget_configure_background).apply {
      // Spinner positions follow WidgetBackground's order.
      this.adapter = spinnerAdapter(listOf(payload.listTitles["groupDefault"] ?: "Default",
        payload.listTitles["backgroundLightText"] ?: "Transparent, light text",
        payload.listTitles["backgroundDarkText"] ?: "Transparent, dark text"), textColor, palette)
      setSelection(pendingBackground.ordinal)
      onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
        override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) { pendingBackground = WidgetBackground.entries[position] }
        override fun onNothingSelected(parent: AdapterView<*>?) {}
      }
    }
    findViewById<EditText>(R.id.mindwtr_widget_configure_search).apply {
      hint = payload.listTitles["search"] ?: "Search"
      setTextColor(textColor)
      setHintTextColor(mutedColor)
      visibility = if (kind == WidgetKind.TASKS && options.sumOf { it.second.size } > 12) View.VISIBLE else View.GONE
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
    outState.putString("background", pendingBackground.name)
    super.onSaveInstanceState(outState)
  }

  private fun save() {
    if (kind == WidgetKind.TASKS) WidgetListStore.write(this, appWidgetId, pendingSelection)
    WidgetListStore.writeBackground(this, appWidgetId, pendingBackground)
    val manager = AppWidgetManager.getInstance(this)
    WidgetRenderer.render(this, manager, intArrayOf(appWidgetId), kind)
    CaptureSyncHeadlessService.startWidgetRefresh(this)
    setResult(Activity.RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId))
    finish()
  }

  private fun updateGroupingVisibility() {
    val focus = WidgetListStore.baseListId(pendingSelection) == WidgetListStore.DEFAULT_LIST
    findViewById<View>(R.id.mindwtr_widget_configure_grouping_row).visibility =
      if (dropdown || focus || kind != WidgetKind.TASKS) View.GONE else View.VISIBLE
    findViewById<Spinner>(R.id.mindwtr_widget_configure_grouping).setSelection(
      (groupingOptions.indexOf(WidgetListStore.grouping(pendingSelection)?.first) + 1).coerceAtLeast(0),
    )
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

  private fun spinnerAdapter(labels: List<String>, textColor: Int, palette: WidgetPayload.Palette?) =
    object : ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, labels) {
      override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = super.getView(position, convertView, parent).apply {
        (this as TextView).setTextColor(textColor)
        palette?.let { setBackgroundColor(it.background) }
      }
      override fun getDropDownView(position: Int, convertView: View?, parent: ViewGroup): View = getView(position, convertView, parent)
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

    /** Tasks for the current and legacy Tasks providers (and any unknown class); Compact and Quick capture by their class. */
    internal fun kindFor(applicationPackage: String, providerClassName: String): WidgetKind =
      WidgetProviderRegistry.identities(applicationPackage).firstOrNull { it.className == providerClassName }?.kind ?: WidgetKind.TASKS

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
