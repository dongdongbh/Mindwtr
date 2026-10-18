package tech.dongdongbh.mindwtr.androidwidget

import android.app.PendingIntent
import android.annotation.TargetApi
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Parcel
import android.view.View
import android.widget.RemoteViews
import java.util.IdentityHashMap

/** Draws every widget kind from the payload in [WidgetPayloadStore]. */
object WidgetRenderer {
  data class RefreshResult(
    val legacyWidgetCount: Int = 0,
    val compactWidgetCount: Int = 0,
    val directCollectionCount: Int = 0,
    val renderedTaskCount: Int = 0,
    val eligibleTaskCount: Int = 0,
    val collectionBytes: Int = 0,
  )
  data class CollectionStats(val renderedTasks: Int, val eligibleTasks: Int, val bytes: Int)
  private data class RenderedViews(val views: RemoteViews, val collectionStats: CollectionStats?)
  data class Chrome(val title: String, val subtitle: String?, val emptyMessage: String, val isEmpty: Boolean)
  data class NavigationTarget(val requestCode: Int, val uri: String)
  data class HeaderActions(
    val openList: NavigationTarget,
    val openTargetIds: List<Int>,
    val openHome: NavigationTarget,
    val openHomeTargetIds: List<Int>,
    val openChooserRequestCode: Int?,
    val openChooserTargetId: Int?,
    val chooserContentDescription: String?,
  )
  data class TasksTheme(val headerSurface: Int, val chevron: Int)
  const val EXTRA_KIND = "tech.dongdongbh.mindwtr.androidwidget.kind"
  private const val REQUEST_CAPTURE = 4612
  private const val REQUEST_ROW = 4613
  // Every widget needs its own chooser PendingIntent (extras alone do not make
  // two of them differ), so the request code carries the widget id, offset far
  // enough that it can never land on one of the fixed codes above.
  private const val REQUEST_CHOOSER_BASE = 1 shl 20
  private const val REQUEST_NAVIGATION_BASE = 2 shl 20
  private const val REQUEST_HOME_BASE = 3 shl 20
  internal const val DIRECT_COLLECTION_BUDGET_BYTES = 256 * 1024

  fun refreshAll(context: Context): RefreshResult {
    val app = context.applicationContext
    val manager = AppWidgetManager.getInstance(app) ?: return RefreshResult()
    var directCollectionCount = 0
    var renderedTaskCount = 0
    var eligibleTaskCount = 0
    var collectionBytes = 0
    val providerCounts = refreshProviders(
      context.packageName,
      idsForProvider = { className ->
        manager.getAppWidgetIds(ComponentName(context.packageName, className))
      },
      renderProvider = { ids, kind ->
        val stats = render(app, manager, ids, kind)
        directCollectionCount += stats.size
        renderedTaskCount = maxOf(renderedTaskCount, stats.maxOfOrNull { it.renderedTasks } ?: 0)
        eligibleTaskCount = maxOf(eligibleTaskCount, stats.maxOfOrNull { it.eligibleTasks } ?: 0)
        collectionBytes = maxOf(collectionBytes, stats.maxOfOrNull { it.bytes } ?: 0)
      },
    )
    return providerCounts.copy(
      directCollectionCount = directCollectionCount,
      renderedTaskCount = renderedTaskCount,
      eligibleTaskCount = eligibleTaskCount,
      collectionBytes = collectionBytes,
    )
  }

  internal fun refreshProviders(
    applicationPackage: String,
    idsForProvider: (String) -> IntArray,
    renderProvider: (IntArray, WidgetKind) -> Unit,
  ): RefreshResult {
    var legacyWidgetCount = 0
    var compactWidgetCount = 0
    for (placed in WidgetProviderRegistry.placed(applicationPackage, idsForProvider)) {
      renderProvider(placed.ids, placed.identity.kind)
      if (placed.identity.isLegacy) legacyWidgetCount += placed.ids.size
      if (placed.identity.kind == WidgetKind.COMPACT) compactWidgetCount += placed.ids.size
    }
    return RefreshResult(legacyWidgetCount, compactWidgetCount)
  }

  /**
   * Modern widgets receive rows and chrome together without a service-backed
   * adapter. Only pre-31 hosts need the legacy collection invalidation path.
   */
  internal fun refreshTaskCollections(
    applicationPackage: String,
    sdkInt: Int,
    idsForProvider: (String) -> IntArray,
    invalidateRows: (IntArray) -> Unit,
    partiallyUpdateChrome: (Int, WidgetKind) -> Unit,
  ): Int {
    var widgetCount = 0
    for (placed in WidgetProviderRegistry.placed(applicationPackage, idsForProvider)) {
      if (!placed.identity.kind.hasTaskList) continue
      if (!usesDirectCollections(sdkInt)) invalidateRows(placed.ids)
      placed.ids.forEach { id -> partiallyUpdateChrome(id, placed.identity.kind) }
      widgetCount += placed.ids.size
    }
    return widgetCount
  }

  /**
   * Keeps the row PendingIntent template intact. On API 31+ the partial update
   * carries direct rows: Android 16 can convert legacy notify calls into full
   * asynchronous updates, so using that API here is not a row-only operation.
   */
  fun refreshTaskCollections(context: Context): Int {
    val manager = AppWidgetManager.getInstance(context.applicationContext) ?: return 0
    val rawPayload = WidgetPayloadStore.read(context)
    CheckoffStore.prune(context, rawPayload.allTaskIds())
    val hiddenTaskIds = CheckoffStore.committed(context)
    if (hiddenTaskIds.isEmpty()) return 0
    val payload = rawPayload.displaySnapshot(hiddenTaskIds).payload
    return refreshTaskCollections(
      context.packageName,
      sdkInt = Build.VERSION.SDK_INT,
      idsForProvider = { className ->
        manager.getAppWidgetIds(ComponentName(context.packageName, className))
      },
      invalidateRows = { ids -> manager.notifyAppWidgetViewDataChanged(ids, R.id.mindwtr_widget_list) },
      partiallyUpdateChrome = { id, kind ->
        val views = buildChromeViews(context, id, kind, payload)
        if (usesDirectCollections(Build.VERSION.SDK_INT)) bindDirectCollection(context, views, id, kind, payload)
        manager.partiallyUpdateAppWidget(id, views)
      },
    )
  }

  fun render(context: Context, manager: AppWidgetManager, ids: IntArray, kind: WidgetKind): List<CollectionStats> {
    // Commit check-offs whose undo window elapsed while nothing else ran.
    if (kind.hasTaskList) CheckoffStore.sweep(context)
    val rawPayload = WidgetPayloadStore.read(context)
    // Prune against the unfiltered source, then hide only committed ids in the
    // local presentation. The queue and app-published snapshot stay intact.
    if (kind.hasTaskList) CheckoffStore.prune(context, rawPayload.allTaskIds())
    val payload = if (kind.hasTaskList) {
      rawPayload.displaySnapshot(CheckoffStore.committed(context)).payload
    } else {
      rawPayload
    }
    val stats = ArrayList<CollectionStats>()
    for (id in ids) {
      val rendered = buildViews(context, id, kind, payload)
      manager.updateAppWidget(id, rendered.views)
      rendered.collectionStats?.let { stats.add(it) }
    }
    if (kind.hasTaskList && !usesDirectCollections(Build.VERSION.SDK_INT)) {
      manager.notifyAppWidgetViewDataChanged(ids, R.id.mindwtr_widget_list)
    }
    return stats
  }

  private fun buildChromeViews(
    context: Context,
    appWidgetId: Int,
    kind: WidgetKind,
    payload: WidgetPayload,
  ): RemoteViews = RemoteViews(context.packageName, kind.layoutRes).apply {
    when (kind) {
      WidgetKind.TASKS -> bindTasksChrome(context, this, appWidgetId, payload)
      WidgetKind.COMPACT -> bindCompactChrome(context, this, appWidgetId, payload)
      WidgetKind.QUICK_CAPTURE -> Unit
    }
  }

  private fun buildViews(context: Context, appWidgetId: Int, kind: WidgetKind, payload: WidgetPayload): RenderedViews {
    val views = RemoteViews(context.packageName, kind.layoutRes)
    val palette = payload.resolvedPalette(context)
    val captureIntent = Intent(context, QuickCaptureActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    views.setOnClickPendingIntent(
      R.id.mindwtr_widget_capture,
      PendingIntent.getActivity(context, REQUEST_CAPTURE, captureIntent, immutableFlags()),
    )

    val collectionStats = when (kind) {
      WidgetKind.TASKS -> bindTasks(context, views, appWidgetId, payload, palette)
      WidgetKind.COMPACT -> bindCompact(context, views, appWidgetId, payload, palette)
      WidgetKind.QUICK_CAPTURE -> {
        views.setTextViewText(R.id.mindwtr_widget_title, payload.quickCapture.title)
        palette?.let {
          views.setInt(R.id.mindwtr_widget_capture_background, "setColorFilter", it.accent)
          views.setTextColor(R.id.mindwtr_widget_capture_label, it.onAccent)
          views.setTextColor(R.id.mindwtr_widget_title, it.text)
        }
        null
      }
    }
    return RenderedViews(views, collectionStats)
  }

  private fun bindCompact(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    payload: WidgetPayload,
    palette: WidgetPayload.Palette?,
  ): CollectionStats? {
    // The simple style prefers Focus, then automatically shows Next Actions
    // when Focus has no rows. It stays chooser-free like v1.2.8.
    bindCompactChrome(context, views, appWidgetId, payload)
    views.setTextViewText(R.id.mindwtr_widget_capture_label, payload.quickCapture.title)
    val stats = bindCollection(context, views, appWidgetId, WidgetKind.COMPACT, payload)
    palette?.let {
      views.setInt(R.id.mindwtr_widget_surface, "setColorFilter", it.background)
      views.setTextColor(R.id.mindwtr_widget_title, it.text)
      views.setTextColor(R.id.mindwtr_widget_subtitle, it.mutedText)
      views.setTextColor(R.id.mindwtr_widget_empty, it.mutedText)
      views.setInt(R.id.mindwtr_widget_capture_background, "setColorFilter", it.accent)
      views.setTextColor(R.id.mindwtr_widget_capture_label, it.onAccent)
    }
    return stats
  }

  private fun bindTasks(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    payload: WidgetPayload,
    palette: WidgetPayload.Palette?,
  ): CollectionStats? {
    // Header: Focus shows the date plus the Inbox chip; any other list shows its
    // full title with a small count, so the header never reads as two lists. A
    // list picked in the chooser that the app has not published yet has no rows
    // to count, so it shows its bare title until the next publish.
    val listId = payload.resolvedListId(WidgetListStore.read(context, appWidgetId))
    bindTasksChrome(context, views, appWidgetId, payload, listId)

    val stats = bindCollection(context, views, appWidgetId, WidgetKind.TASKS, payload)
    // Match the body surface; the divider and capture plus carry the accent.
    palette?.let {
      val theme = tasksTheme(it)
      views.setInt(R.id.mindwtr_widget_surface, "setColorFilter", it.background)
      views.setInt(R.id.mindwtr_widget_band, "setColorFilter", theme.headerSurface)
      views.setInt(R.id.mindwtr_widget_chooser_icon, "setColorFilter", theme.chevron)
      views.setTextColor(R.id.mindwtr_widget_title, it.text)
      views.setTextColor(R.id.mindwtr_widget_subtitle, it.mutedText)
      views.setTextColor(R.id.mindwtr_widget_capture, it.accent)
      views.setInt(R.id.mindwtr_widget_header_divider, "setBackgroundColor", it.border)
      views.setTextColor(R.id.mindwtr_widget_empty, it.mutedText)
    }
    return stats
  }

  internal fun usesDirectCollections(sdkInt: Int): Boolean = sdkInt >= 31

  @TargetApi(31)
  private fun bindDirectCollection(context: Context, views: RemoteViews, appWidgetId: Int, kind: WidgetKind, payload: WidgetPayload): CollectionStats {
    val factory = TasksWidgetFactory(context, kind, appWidgetId, payload)
    val result = buildDirectCollection(factory)
    views.setRemoteAdapter(R.id.mindwtr_widget_list, result.first)
    return result.second
  }

  @TargetApi(31)
  internal fun buildDirectCollection(
    factory: TasksWidgetFactory,
    budgetBytes: Int = DIRECT_COLLECTION_BUDGET_BYTES,
  ): Pair<RemoteViews.RemoteCollectionItems, CollectionStats> {
    data class Candidate(
      val collection: RemoteViews.RemoteCollectionItems,
      val bytes: Int,
      val taskCount: Int,
    )

    val prepared = IdentityHashMap<TasksWidgetFactory.Row, RemoteViews>()
    factory.baseRows().forEach { row -> prepared[row] = factory.viewForRow(row) }
    factory.rowsForTaskLimit(0).filterIsInstance<TasksWidgetFactory.Row.Footer>().firstOrNull()?.let { footer ->
      prepared[footer] = factory.viewForRow(footer)
    }
    val cache = HashMap<Int, Candidate>()
    fun candidate(taskLimit: Int): Candidate = cache.getOrPut(taskLimit) {
      val rows = factory.rowsForTaskLimit(taskLimit)
      val builder = RemoteViews.RemoteCollectionItems.Builder()
        .setViewTypeCount(factory.getViewTypeCount())
        .setHasStableIds(factory.hasStableIds())
      rows.forEachIndexed { index, row ->
        val rowViews = prepared[row] ?: factory.viewForRow(row).also { prepared[row] = it }
        builder.addItem(index.toLong(), rowViews)
      }
      val collection = builder.build()
      Candidate(collection, parcelSize(collection), rows.count { it is TasksWidgetFactory.Row.Task })
    }

    val published = factory.publishedTaskCount()
    val full = candidate(published)
    val selected = if (full.bytes <= budgetBytes || published == 0) {
      full
    } else {
      val first = candidate(1)
      if (first.bytes > budgetBytes) {
        candidate(0)
      } else {
        var low = 1
        var high = published - 1
        var best = first
        while (low <= high) {
          val middle = low + (high - low) / 2
          val measured = candidate(middle)
          if (measured.bytes <= budgetBytes) {
            best = measured
            low = middle + 1
          } else {
            high = middle - 1
          }
        }
        best
      }
    }
    return selected.collection to CollectionStats(
      renderedTasks = selected.taskCount,
      eligibleTasks = factory.eligibleTaskCount(),
      bytes = selected.bytes,
    )
  }

  @TargetApi(31)
  private fun parcelSize(collection: RemoteViews.RemoteCollectionItems): Int {
    val parcel = Parcel.obtain()
    return try {
      collection.writeToParcel(parcel, 0)
      parcel.dataSize()
    } finally {
      parcel.recycle()
    }
  }

  private fun bindCollection(context: Context, views: RemoteViews, appWidgetId: Int, kind: WidgetKind, payload: WidgetPayload): CollectionStats? {
    val stats = if (usesDirectCollections(Build.VERSION.SDK_INT)) {
      bindDirectCollection(context, views, appWidgetId, kind, payload)
    } else {
      val adapterIntent = Intent(context, TasksWidgetService::class.java).apply {
        putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        putExtra(EXTRA_KIND, kind.name)
        data = Uri.parse(toUri(Intent.URI_INTENT_SCHEME))
      }
      views.setRemoteAdapter(R.id.mindwtr_widget_list, adapterIntent)
      null
    }
    views.setEmptyView(R.id.mindwtr_widget_list, R.id.mindwtr_widget_empty)
    // Collection rows deliver clicks through a fill-in intent, which the
    // platform can only merge into a mutable template. The template fixes the
    // component (the invisible WidgetTapActivity) and leaves the data unset,
    // so a row's fill-in can add exactly one thing: the task's open link or its
    // check-off URI, both validated before anything acts on them.
    val rowTemplate = Intent(context, WidgetTapActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val mutable = PendingIntent.FLAG_UPDATE_CURRENT or
      (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
    views.setPendingIntentTemplate(
      R.id.mindwtr_widget_list,
      PendingIntent.getActivity(context, REQUEST_ROW, rowTemplate, mutable),
    )
    return stats
  }

  /** Focus alone owns the curated hidden-row count; chooser lists keep their existing count title. */
  internal fun taskSubtitle(payload: WidgetPayload, isFocus: Boolean): String? =
    payload.subtitle.takeIf { isFocus }

  /** Next Actions carries its translated payload title; normal Focus keeps the compact header. */
  internal fun compactHeaderTitle(payload: WidgetPayload): String {
    val listId = payload.compactListId()
    return if (listId == WidgetListStore.DEFAULT_LIST) payload.headerTitle else payload.listFor(listId).title
  }

  internal fun tasksChrome(payload: WidgetPayload, listId: String): Chrome {
    val resolvedListId = payload.resolvedListId(listId)
    val list = payload.listFor(resolvedListId)
    val isFocus = resolvedListId == WidgetListStore.DEFAULT_LIST
    val counted = payload.lists[resolvedListId] != null
    val rowCount = if (list.sections.isEmpty()) list.items.size else list.sections.sumOf { it.items.size }
    return Chrome(
      title = when {
        isFocus -> list.dateLabel?.ifEmpty { null } ?: list.title
        counted -> "${list.title} · ${list.eligibleTaskCount()}"
        else -> list.title
      },
      subtitle = taskSubtitle(payload, isFocus),
      emptyMessage = payload.emptyMessage,
      isEmpty = rowCount == 0,
    )
  }

  internal fun compactChrome(payload: WidgetPayload): Chrome {
    val list = payload.listFor(payload.compactListId())
    val rowCount = if (list.sections.isEmpty()) list.items.size else list.sections.sumOf { it.items.size }
    return Chrome(
      title = compactHeaderTitle(payload),
      subtitle = payload.subtitle,
      emptyMessage = payload.emptyMessage,
      isEmpty = rowCount == 0,
    )
  }

  internal fun tasksHeaderActions(payload: WidgetPayload, listId: String, appWidgetId: Int): HeaderActions {
    val resolvedListId = payload.resolvedListId(listId)
    val list = payload.listFor(resolvedListId)
    return HeaderActions(
      openList = navigationTarget(appWidgetId, payload.openUriFor(resolvedListId)),
      openTargetIds = listOf(R.id.mindwtr_widget_title_target),
      openHome = homeTarget(appWidgetId, payload),
      openHomeTargetIds = listOf(R.id.mindwtr_widget_root, R.id.mindwtr_widget_empty, R.id.mindwtr_widget_spacer),
      openChooserRequestCode = REQUEST_CHOOSER_BASE + appWidgetId,
      openChooserTargetId = R.id.mindwtr_widget_chooser,
      chooserContentDescription = "${payload.chooseListLabel}: ${list.title}",
    )
  }

  internal fun compactHeaderActions(payload: WidgetPayload, appWidgetId: Int): HeaderActions {
    val listId = payload.compactListId()
    return HeaderActions(
      openList = navigationTarget(appWidgetId, payload.openUriFor(listId)),
      openTargetIds = listOf(R.id.mindwtr_widget_title_target),
      openHome = homeTarget(appWidgetId, payload),
      openHomeTargetIds = listOf(R.id.mindwtr_widget_root, R.id.mindwtr_widget_empty, R.id.mindwtr_widget_spacer),
      openChooserRequestCode = null,
      openChooserTargetId = null,
      chooserContentDescription = null,
    )
  }

  internal fun tasksTheme(palette: WidgetPayload.Palette): TasksTheme =
    TasksTheme(headerSurface = palette.background, chevron = palette.mutedText)

  private fun navigationTarget(appWidgetId: Int, uri: String): NavigationTarget =
    NavigationTarget(REQUEST_NAVIGATION_BASE + appWidgetId, uri)

  private fun homeTarget(appWidgetId: Int, payload: WidgetPayload): NavigationTarget =
    NavigationTarget(
      REQUEST_HOME_BASE + appWidgetId,
      payload.focusUri.takeIf { it == WidgetPayload.DEFAULT_FOCUS_URI } ?: WidgetPayload.DEFAULT_FOCUS_URI,
    )

  private fun bindTasksChrome(
    context: Context,
    views: RemoteViews,
    appWidgetId: Int,
    payload: WidgetPayload,
    listId: String = WidgetListStore.read(context, appWidgetId),
  ) {
    applyTasksChrome(views, tasksChrome(payload, listId))
    val actions = tasksHeaderActions(payload, listId, appWidgetId)
    bindHeaderNavigation(context, views, actions)
    val chooser = Intent(context, WidgetConfigureActivity::class.java)
      .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
      .putExtra(WidgetConfigureActivity.EXTRA_DROPDOWN, true)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    views.setOnClickPendingIntent(
      actions.openChooserTargetId!!,
      PendingIntent.getActivity(context, actions.openChooserRequestCode!!, chooser, immutableFlags()),
    )
    views.setContentDescription(actions.openChooserTargetId, actions.chooserContentDescription)
  }

  private fun bindCompactChrome(context: Context, views: RemoteViews, appWidgetId: Int, payload: WidgetPayload) {
    applyCompactChrome(views, compactChrome(payload))
    bindHeaderNavigation(context, views, compactHeaderActions(payload, appWidgetId))
  }

  private fun bindHeaderNavigation(context: Context, views: RemoteViews, actions: HeaderActions) {
    bindNavigationTarget(context, views, actions.openHome, actions.openHomeTargetIds)
    bindNavigationTarget(context, views, actions.openList, actions.openTargetIds)
  }

  private fun bindNavigationTarget(context: Context, views: RemoteViews, target: NavigationTarget, targetIds: List<Int>) {
    val pendingIntent = PendingIntent.getActivity(
      context,
      target.requestCode,
      appIntent(context, target.uri),
      immutableFlags(),
    )
    targetIds.forEach { targetId -> views.setOnClickPendingIntent(targetId, pendingIntent) }
  }

  private fun applyTasksChrome(views: RemoteViews, chrome: Chrome) {
    views.setTextViewText(R.id.mindwtr_widget_title, chrome.title)
    views.setTextViewText(R.id.mindwtr_widget_subtitle, chrome.subtitle.orEmpty())
    views.setViewVisibility(R.id.mindwtr_widget_subtitle, if (chrome.subtitle != null) View.VISIBLE else View.GONE)
    views.setTextViewText(R.id.mindwtr_widget_empty, chrome.emptyMessage)
    views.setViewVisibility(R.id.mindwtr_widget_empty, if (chrome.isEmpty) View.VISIBLE else View.GONE)
  }

  private fun applyCompactChrome(views: RemoteViews, chrome: Chrome) {
    views.setTextViewText(R.id.mindwtr_widget_title, chrome.title)
    views.setTextViewText(R.id.mindwtr_widget_subtitle, chrome.subtitle.orEmpty())
    views.setTextViewText(R.id.mindwtr_widget_empty, chrome.emptyMessage)
    views.setViewVisibility(R.id.mindwtr_widget_empty, if (chrome.isEmpty) View.VISIBLE else View.GONE)
  }

  private fun immutableFlags(): Int = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

  /**
   * Explicit VIEW intent to the app's MainActivity, same shape as the tile and notification. A `mindwtr:` link (the payload's,
   * a shortcut's) takes the app's link scheme, mindwtr_link_scheme: RN's `mindwtr`, so RN opens the link as it is; an app that
   * links on another scheme (the native development builds) overrides the resource.
   */
  fun appIntent(context: Context, uri: String?): Intent =
    Intent(Intent.ACTION_VIEW).apply {
      if (uri != null) data = Uri.parse(linkInScheme(uri, context.getString(R.string.mindwtr_link_scheme)))
      setClassName(context.packageName, "${context.packageName}.MainActivity")
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }

  /** [uri] with [scheme] in place of `mindwtr`, when it is a `mindwtr:` link; any other URI as it is. */
  fun linkInScheme(uri: String, scheme: String): String =
    if (uri.startsWith("mindwtr:")) scheme + uri.substring("mindwtr".length) else uri
}
