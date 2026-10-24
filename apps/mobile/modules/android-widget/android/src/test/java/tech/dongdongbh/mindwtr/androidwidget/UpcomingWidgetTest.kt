package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UpcomingWidgetTest {
  private lateinit var context: Context
  private val utc = TimeZone.getTimeZone("UTC")

  @Before
  fun setUp() {
    context = ApplicationProvider.getApplicationContext()
    context.getSharedPreferences(WidgetListStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    context.getSharedPreferences(CheckoffStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
    context.getSharedPreferences(WidgetPayloadStore.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
  }

  @Test
  fun switchingCachedListsAfterMidnightKeepsThePublishedGenerationUntilTheAppPublishesAgain() {
    val start = item("starts-today", "2000-10-25")
    val cached = JSONObject().put("lists", JSONObject()
      .put("focus", JSONObject().put("title", "Focus").put("dateLabel", "Oct 24").put("items", JSONArray()))
      .put("upcoming", JSONObject().put("title", "Upcoming").put("items", JSONArray().put(start)).put("totalCount", 1)))
      .toString()
    assertTrue(WidgetPayloadStore.write(context, cached))

    fun selectedRows(listId: String): List<String> {
      WidgetListStore.write(context, 9, listId)
      val factory = TasksWidgetFactory(context, WidgetKind.TASKS, 9)
      factory.onCreate()
      return factory.baseRows().filterIsInstance<TasksWidgetFactory.Row.Task>().map { it.item.id }
    }
    assertEquals(listOf("starts-today"), selectedRows("upcoming"))
    assertEquals(emptyList<String>(), selectedRows("focus"))
    assertEquals("Oct 24", WidgetRenderer.tasksChrome(WidgetPayloadStore.read(context).displaySnapshot(emptySet()).payload, "focus").title)
    assertEquals(listOf("starts-today"), selectedRows("upcoming"))
    assertEquals(cached, WidgetPayloadStore.readRaw(context))

    val fresh = JSONObject(cached).apply {
      getJSONObject("lists").getJSONObject("focus").put("dateLabel", "Oct 25").put("items", JSONArray().put(start))
      getJSONObject("lists").getJSONObject("upcoming").put("items", JSONArray()).put("totalCount", 0)
    }.toString()
    assertTrue(WidgetPayloadStore.write(context, fresh))
    assertEquals(listOf("starts-today"), selectedRows("focus"))
    assertEquals("Oct 25", WidgetRenderer.tasksChrome(WidgetPayloadStore.read(context).displaySnapshot(emptySet()).payload, "focus").title)
    assertEquals(emptyList<String>(), selectedRows("upcoming"))
    assertEquals(fresh, WidgetPayloadStore.readRaw(context))
  }

  @Test
  fun cachedDatesAndMissingMetadataNeverReclassifyPublishedRowsButCommittedCheckoffsStillHide() {
    val payload = payload(listOf(
      item("past", "2000-10-17"),
      item("future", "2100-10-25"),
      item("invalid", "2026-02-30"),
      item("missing", null),
    ))
    val snapshot = payload.displaySnapshot(setOf("past"))
    assertEquals(listOf("future", "invalid", "missing"), snapshot.payload.listFor("upcoming").items.map { it.id })
    assertEquals(3, snapshot.payload.listFor("upcoming").eligibleTaskCount())
    assertEquals(listOf("stale", "stale"), snapshot.payload.listFor("upcoming").items.drop(1).map { it.dueLabel })
    assertEquals(4, payload.listFor("upcoming").items.size)
    assertEquals(payload.allTaskIds(), snapshot.sourceTaskIds)
    assertEquals(listOf("focus"), snapshot.payload.listFor("focus").items.map { it.id })
  }

  @Test
  fun labelsAreAbsoluteAndReformattedInTheCurrentZone() {
    for (listId in listOf("upcoming", "group:project:upcoming")) {
      val published = payload(listOf(item("instant", "2026-10-19T00:30:00Z")))
      val list = published.listFor("upcoming")
      val payload = published.copy(lists = mapOf(listId to list.copy(
        sections = listOf(WidgetPayload.Section("Project", "1", list.items, "project:p1")),
      )))
      val eastList = payload.displaySnapshot(emptySet(), timeZone = utc).payload.listFor(listId)
      val east = eastList.items.single()
      val west = payload.displaySnapshot(emptySet(), timeZone = TimeZone.getTimeZone("America/Los_Angeles")).payload.listFor(listId).items.single()
      assertTrue(east.dueLabel!!.startsWith("Starts "))
      assertNotEquals(east.dueLabel, west.dueLabel)
      assertFalse(east.dueEmphasis)
      assertEquals(WidgetPayload.DueTone.NORMAL, east.dueTone)
      assertEquals(east.dueLabel, eastList.sections.single().items.single().dueLabel)
    }
  }

  @Test
  fun dateOnlyLabelsKeepTheirCalendarDayAcrossZonesAndAMidnightDstTransition() {
    val payload = payload(listOf(item("day", "2018-11-04")))
    val expected = payload.displaySnapshot(emptySet(), timeZone = utc).payload.listFor("upcoming").items.single().dueLabel
    for (zone in listOf("America/Los_Angeles", "America/Sao_Paulo")) {
      val item = payload.displaySnapshot(emptySet(), timeZone = TimeZone.getTimeZone(zone)).payload.listFor("upcoming").items.single()
      assertEquals(expected, item.dueLabel)
    }
  }

  @Test
  fun upcomingSelectionAndEmptyPayloadKeepTheirTitleAndDestination() {
    val payload = payload(emptyList())
    assertEquals("upcoming", payload.resolvedListId("upcoming"))
    assertEquals("mindwtr:///widget-list/upcoming", payload.openUriFor("upcoming"))
    assertTrue(payload.listFor("upcoming").items.isEmpty())
    assertEquals("Upcoming", WidgetPayload.EMPTY.listFor("upcoming").title)
    assertTrue(WidgetPayload.EMPTY.listFor("upcoming").items.isEmpty())
    assertTrue(WidgetConfigureActivity.fixedOptions(mapOf("upcoming" to "Bald" )).contains("upcoming" to "Bald"))
    assertEquals("focus", WidgetListStore.read(context, 8))
  }

  @Test
  fun upcomingRowUsesTheSameCompletionControlAndQuickActionsAsOtherTasks() {
    val tomorrow = java.util.Calendar.getInstance().apply { add(java.util.Calendar.DAY_OF_MONTH, 1) }
    val raw = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(tomorrow.time)
    val payload = payload(listOf(item("task / +", raw)))
    WidgetListStore.write(context, 9, "upcoming")
    val factory = TasksWidgetFactory(context, WidgetKind.TASKS, 9, payload)
    val views = factory.getViewAt(0)
    // Collection children carry their row intent on the root, consumed by the launcher template.
    RemoteViews::class.java.getDeclaredMethod("addFlags", Int::class.javaPrimitiveType)
      .apply { isAccessible = true }.invoke(views, 2)
    val row = views.apply(context, null)
    assertEquals(View.VISIBLE, row.findViewById<View>(R.id.mindwtr_widget_item_ring_target).visibility)
    assertEquals("task / +", row.findViewById<TextView>(R.id.mindwtr_widget_item_title).text.toString())
    val fillInId = context.resources.getIdentifier("fillInIntent", "id", "android")
    val response = row.getTag(fillInId)
    val intent = response.javaClass.getDeclaredField("mFillIntent")
      .apply { isAccessible = true }.get(response) as Intent
    assertEquals(WidgetTapActivity.peekUri("task / +"), intent.dataString)
    assertTrue(row.findViewById<View>(R.id.mindwtr_widget_item_ring_target).hasOnClickListeners())
    CheckoffStore.toggle(context, "task / +")
    val pendingRow = factory.getViewAt(0).apply(context, null)
    assertTrue(pendingRow.findViewById<TextView>(R.id.mindwtr_widget_item_title).text is android.text.Spanned)
  }

  private fun item(id: String, upcomingDate: String?): JSONObject = JSONObject()
    .put("id", id).put("title", id)
    .put("openUri", "mindwtr://open?task=${java.net.URLEncoder.encode(id, Charsets.UTF_8.name()).replace("+", "%20")}")
    .put("upcomingDate", upcomingDate).put("upcomingLabel", "Starts")
    .put("dueLabel", "stale").put("dueEmphasis", true).put("dueTone", "overdue")

  private fun payload(items: List<JSONObject>): WidgetPayload = WidgetPayload.parse(JSONObject()
    .put("lists", JSONObject()
      .put("focus", JSONObject().put("title", "Focus").put("items", JSONArray().put(item("focus", null))))
      .put("upcoming", JSONObject().put("title", "Upcoming").put("items", JSONArray(items)).put("totalCount", items.size)))
    .toString())!!
}
