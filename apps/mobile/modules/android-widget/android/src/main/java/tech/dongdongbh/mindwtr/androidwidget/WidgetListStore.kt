package tech.dongdongbh.mindwtr.androidwidget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import java.net.URLDecoder

/**
 * A Tasks or Compact widget's background. Transparent drops the panel and picks
 * the text colors itself, light or dark, so the rows stay readable on the
 * wallpaper whatever the app theme is.
 */
enum class WidgetBackground(internal val stored: String?) {
  DEFAULT(null), LIGHT_TEXT("light"), DARK_TEXT("dark");

  val isTransparent: Boolean get() = this != DEFAULT

  /** The theme palette whose text this background uses; null draws as the app theme does. */
  val textPalette: WidgetPayload.Palette? get() = when (this) {
    DEFAULT -> null
    LIGHT_TEXT -> WidgetPayload.DARK_THEME_PALETTE
    DARK_TEXT -> WidgetPayload.LIGHT_THEME_PALETTE
  }
}

/**
 * Which list each placed Tasks widget shows (#1173): SharedPreferences `mindwtr_widget_lists`, key = widget id.
 * Also each Tasks or Compact widget's background choice, in `mindwtr_widget_backgrounds`; both stay on the device.
 */
object WidgetListStore {
  const val PREFS_NAME = "mindwtr_widget_lists"
  const val BACKGROUNDS_PREFS_NAME = "mindwtr_widget_backgrounds"
  const val DEFAULT_LIST = "focus"
  /** Kept for installed widgets that still carry a project selection. */
  const val PROJECT_PREFIX = "project:"
  const val CONTEXT_PREFIX = "context:"
  const val TAG_PREFIX = "tag:"
  fun isTokenList(id: String): Boolean = id.startsWith(CONTEXT_PREFIX) || id.startsWith(TAG_PREFIX)
  const val FILTER_PREFIX = "filter:"
  private const val GROUP_PREFIX = "group:"
  val GROUPINGS = listOf("none", "context", "project", "priority")

  fun grouping(listId: String): Pair<String, String>? {
    if (!listId.startsWith(GROUP_PREFIX)) return null
    val parts = listId.split(":", limit = 3)
    if (parts.size != 3 || parts[1] !in GROUPINGS) return null
    val base = try { URLDecoder.decode(parts[2].replace("+", "%2B"), Charsets.UTF_8.name()) }
      catch (_: IllegalArgumentException) { return null }
    if (base == DEFAULT_LIST || base.startsWith(GROUP_PREFIX)) return null
    return parts[1] to base
  }

  fun baseListId(listId: String): String = grouping(listId)?.second ?: listId

  fun withGrouping(listId: String, grouping: String?): String {
    val base = baseListId(listId)
    return if (base == DEFAULT_LIST || grouping !in GROUPINGS) base else "$GROUP_PREFIX$grouping:${Uri.encode(base)}"
  }

  // Core's SIMPLE_ / HIERARCHICAL_TASK_TOKEN_RE: quick-add reads these unaided as typed (`@Todd`, `@person/todd`).
  private val PLAIN_CAPTURE_TOKEN = Regex("[\\p{L}\\p{N}_-]+(?:/[\\p{L}\\p{N}_-]+)*")

  // Any other name goes in quick-add's quoted form (`@"Two words"`) when that reads back exactly: no quote
  // or backslash, single inner spaces only (the parse collapses spacing), and no space before a marker or
  // slash (`#"x @y"` loses `@y` to the context parse; `/link:` is read before any token).
  private fun quotable(value: String): Boolean =
    value.isNotEmpty() && !value.first().isWhitespace() && !value.last().isWhitespace() &&
      value.none { it in "\"\\\u201C\u201D\u201E" || (it.isWhitespace() && it != ' ') } &&
      value.zipWithNext().none { (a, b) -> a == ' ' && (b == ' ' || b in "@#+!%/") }

  /** Capture text for a widget showing one context or tag (#1418), e.g. `@Todd `, `@"Two words" `; empty otherwise. */
  fun captureText(listId: String): String {
    val baseListId = baseListId(listId)
    val token = when {
      baseListId.startsWith(CONTEXT_PREFIX) -> baseListId.removePrefix(CONTEXT_PREFIX).takeIf { it.startsWith("@") }
      baseListId.startsWith(TAG_PREFIX) -> baseListId.removePrefix(TAG_PREFIX).takeIf { it.startsWith("#") }
      else -> null
    } ?: return ""
    val value = token.substring(1)
    return when {
      PLAIN_CAPTURE_TOKEN.matches(value) -> "$token "
      quotable(value) -> "${token[0]}\"$value\" "
      else -> ""
    }
  }

  fun read(context: Context, appWidgetId: Int): String {
    val stored = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getString(appWidgetId.toString(), null)
    return stored ?: DEFAULT_LIST
  }

  fun write(context: Context, appWidgetId: Int, listId: String) {
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putString(appWidgetId.toString(), listId).commit()
  }

  /** Default until the widget's settings pick another. The first release stored Transparent as `true`: that reads as light text. */
  fun background(context: Context, appWidgetId: Int): WidgetBackground =
    when (val stored = context.getSharedPreferences(BACKGROUNDS_PREFS_NAME, Context.MODE_PRIVATE).all[appWidgetId.toString()]) {
      true -> WidgetBackground.LIGHT_TEXT
      else -> WidgetBackground.entries.firstOrNull { it.stored != null && it.stored == stored } ?: WidgetBackground.DEFAULT
    }

  fun writeBackground(context: Context, appWidgetId: Int, background: WidgetBackground) {
    val editor = context.getSharedPreferences(BACKGROUNDS_PREFS_NAME, Context.MODE_PRIVATE).edit()
    background.stored?.let { editor.putString(appWidgetId.toString(), it) } ?: editor.remove(appWidgetId.toString())
    editor.commit()
  }

  fun remove(context: Context, appWidgetIds: IntArray) {
    for (name in listOf(PREFS_NAME, BACKGROUNDS_PREFS_NAME)) {
      val editor = context.getSharedPreferences(name, Context.MODE_PRIVATE).edit()
      for (id in appWidgetIds) editor.remove(id.toString())
      editor.apply()
    }
  }

  /** Distinct list ids bound to the Tasks widgets currently placed. */
  fun selections(context: Context): List<String> {
    val manager = AppWidgetManager.getInstance(context) ?: return emptyList()
    return selectionsForProviders(
      context.packageName,
      idsForProvider = { className ->
        manager.getAppWidgetIds(ComponentName(context.packageName, className))
      },
      readSelection = { appWidgetId -> read(context, appWidgetId) },
    )
  }

  internal fun selectionsForProviders(
    applicationPackage: String,
    idsForProvider: (String) -> IntArray,
    readSelection: (Int) -> String,
  ): List<String> = WidgetProviderRegistry
    .placed(applicationPackage, idsForProvider)
    .filter { it.identity.kind == WidgetKind.TASKS }
    .flatMap { it.ids.asIterable() }
    .map(readSelection)
    .distinct()
}
