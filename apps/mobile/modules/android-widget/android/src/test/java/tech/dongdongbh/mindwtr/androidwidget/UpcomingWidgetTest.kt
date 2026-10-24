package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import java.text.SimpleDateFormat
import java.util.Date
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
  }

  @Test
  fun cachedSnapshotDropsTodayInvalidAndBeyondSevenDaysWithoutMutatingSource() {
    val payload = payload(listOf(
      item("today", "2026-10-17T23:59:00Z"),
      item("tomorrow", "2026-10-18"),
      item("last", "2026-10-24T23:59:59.9Z"),
      item("outside", "2026-10-25"),
      item("invalid", "2026-02-30"),
      item("missing", null),
    ))
    val snapshot = payload.displaySnapshot(emptySet(), date("2026-10-17"), utc)
    assertEquals(listOf("tomorrow", "last"), snapshot.payload.listFor("upcoming").items.map { it.id })
    assertEquals(2, snapshot.payload.listFor("upcoming").eligibleTaskCount())
    assertEquals(6, payload.listFor("upcoming").items.size)
    assertEquals(payload.allTaskIds(), snapshot.sourceTaskIds)
    assertEquals(listOf("focus"), snapshot.payload.listFor("focus").items.map { it.id })
    val rolled = payload.displaySnapshot(emptySet(), date("2026-10-18"), utc).payload
    assertEquals(listOf("last", "outside"), rolled.listFor("upcoming").items.map { it.id })
  }

  @Test
  fun dateOnlyUsesLocalCalendarAndTimestampUsesItsInstantAcrossTimezoneAndDstChanges() {
    val payload = payload(listOf(item("day", "2026-03-08"), item("instant", "2026-03-08T00:30:00Z")))
    val now = date("2026-03-07T12:00:00Z")
    val west = TimeZone.getTimeZone("America/Los_Angeles")
    assertEquals(listOf("day", "instant"), payload.displaySnapshot(emptySet(), now, utc).payload.listFor("upcoming").items.map { it.id })
    assertEquals(listOf("day"), payload.displaySnapshot(emptySet(), now, west).payload.listFor("upcoming").items.map { it.id })
    assertEquals(emptyList<String>(), payload.displaySnapshot(emptySet(), date("2026-03-08T12:00:00Z"), west).payload.listFor("upcoming").items.map { it.id })
    val edge = payload(listOf(item("last", "2026-03-14T23:59:59-07:00"), item("outside", "2026-03-15")))
    assertEquals(listOf("last"), edge.displaySnapshot(emptySet(), now, west).payload.listFor("upcoming").items.map { it.id })
    val midnightDst = payload(listOf(item("day", "2018-11-04")))
    assertEquals(listOf("day"), midnightDst.displaySnapshot(emptySet(), date("2018-11-03T12:00:00Z"), TimeZone.getTimeZone("America/Sao_Paulo")).payload.listFor("upcoming").items.map { it.id })
  }

  @Test
  fun labelsAreAbsoluteAndReformattedInTheCurrentZone() {
    val payload = payload(listOf(item("instant", "2026-10-19T00:30:00Z")))
    val now = date("2026-10-17T12:00:00Z")
    val east = payload.displaySnapshot(emptySet(), now, utc).payload.listFor("upcoming").items.single()
    val west = payload.displaySnapshot(emptySet(), now, TimeZone.getTimeZone("America/Los_Angeles")).payload.listFor("upcoming").items.single()
    assertTrue(east.dueLabel!!.startsWith("Starts "))
    assertNotEquals(east.dueLabel, west.dueLabel)
    assertFalse(east.dueEmphasis)
    assertEquals(WidgetPayload.DueTone.NORMAL, east.dueTone)
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

  private fun date(raw: String): Date = SimpleDateFormat(
    if (raw.length == 10) "yyyy-MM-dd" else "yyyy-MM-dd'T'HH:mm:ssX", Locale.ROOT,
  ).apply { timeZone = utc }.parse(raw)!!

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
