package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetPayloadTest {
  private val sample = """
    {
      "headerTitle": "Today's Focus",
      "subtitle": "Inbox: 3 · +2 More",
      "inboxLabel": "Inbox",
      "inboxCount": 3,
      "items": [
        {"id": "a", "title": "Call the bank", "statusLabel": "Next", "dueLabel": "Today", "dueEmphasis": true, "openUri": "mindwtr://open?task=a"},
        {"id": "b", "title": "Write report", "statusLabel": "Next", "dueLabel": null, "dueEmphasis": false, "openUri": "https://evil.example"},
        {"id": "c", "title": "   ", "statusLabel": "Next", "dueLabel": null, "dueEmphasis": false}
      ],
      "sections": [
        {"key": "focus", "title": "Today's Focus", "items": [{"id": "a", "title": "Call the bank", "dueLabel": "Today", "dueEmphasis": true, "openUri": "mindwtr://open?task=a", "priorityColor": "#dc2626", "contextLabel": "Finance"}]},
        {"key": "next", "title": "Next actions", "items": []},
        {"key": "upcoming", "title": "Upcoming", "items": [{"id": "b", "title": "Write report", "dueLabel": null, "dueEmphasis": false, "openUri": "mindwtr://open?task=b", "priorityColor": null, "contextLabel": null}]}
      ],
      "emptyMessage": "All clear",
      "focusUri": "mindwtr:///focus",
      "themeMode": "dark",
      "palette": {"background": "#111827", "card": "#1F2937", "text": "#F9FAFB", "mutedText": "#CBD5E1", "accent": "#2563EB", "onAccent": "#FFFFFF"},
      "quickCapture": {"title": "Quick capture", "placeholder": "Add task to inbox...", "save": "Save", "cancel": "Cancel", "added": "Task added to Mindwtr."}
    }
  """.trimIndent()

  @Test
  fun parsesItemsLabelsAndPalette() {
    val payload = WidgetPayload.parse(sample)

    assertNotNull(payload)
    payload!!
    assertEquals("Today's Focus", payload.headerTitle)
    assertEquals("Inbox: 3", payload.subtitle)
    assertEquals(2, payload.items.size)
    assertEquals("Call the bank", payload.items[0].title)
    assertEquals("Today", payload.items[0].dueLabel)
    assertTrue(payload.items[0].dueEmphasis)
    assertNull(payload.items[1].dueLabel)
    assertEquals("mindwtr://open?task=a", payload.items[0].openUri)
    assertNull(payload.items[0].priorityColor)
    assertEquals(2, payload.sections.size)
    assertEquals("Today's Focus", payload.sections[0].title)
    assertEquals(0xFFDC2626.toInt(), payload.sections[0].items[0].priorityColor)
    assertEquals("Finance", payload.sections[0].items[0].contextLabel)
    assertNull(payload.sections[1].items[0].contextLabel)
    val rows = TasksWidgetFactory.buildRows(payload)
    assertEquals(4, rows.size)
    assertTrue(rows[0] is TasksWidgetFactory.Row.Header && rows[1] is TasksWidgetFactory.Row.Task)
    assertTrue(rows[2] is TasksWidgetFactory.Row.Header && rows[3] is TasksWidgetFactory.Row.Task)
    assertNull("a non-app openUri must never reach a PendingIntent", payload.items[1].openUri)
    assertEquals(0xFF111827.toInt(), payload.palette!!.background)
    assertEquals(0xFF2563EB.toInt(), payload.palette!!.accent)
    assertEquals(0xFF1F2937.toInt(), payload.palette!!.card)
    assertFalse(payload.usesSystemColors)
    assertEquals("Add task to inbox...", payload.quickCapture.placeholder)
  }

  @Test
  fun flatItemsBackTheRowsWhenAPayloadCarriesNoSections() {
    val payload = WidgetPayload.parse(JSONObject(sample).apply { remove("sections") }.toString())!!

    val rows = TasksWidgetFactory.buildRows(payload)

    assertEquals(2, rows.size)
    assertTrue(rows.all { it is TasksWidgetFactory.Row.Task })
  }

  @Test
  fun systemThemeLeavesColorsToTheLauncherResources() {
    val payload = WidgetPayload.parse(JSONObject(sample).put("themeMode", "system").toString())

    assertTrue(payload!!.usesSystemColors)
  }

  @Test
  fun fallsBackToDefaultsForMissingFieldsAndRejectsForeignFocusUris() {
    val payload = WidgetPayload.parse("""{"focusUri": "https://example.com", "inboxCount": -4}""")

    assertNotNull(payload)
    assertEquals(WidgetPayload.DEFAULT_FOCUS_URI, payload!!.focusUri)
    assertEquals(0, payload.inboxCount)
    assertEquals(WidgetPayload.EMPTY.quickCapture, payload.quickCapture)
    assertNull(payload.palette)
    assertTrue(payload.items.isEmpty())
  }

  @Test
  fun rejectsMalformedJson() {
    assertNull(WidgetPayload.parse("not json"))
  }

  @Test
  fun parsesHexColorsWithAndWithoutAlpha() {
    assertEquals(0xFF2563EB.toInt(), WidgetPayload.parseHexColor("#2563EB"))
    assertEquals(0x802563EB.toInt(), WidgetPayload.parseHexColor("#802563EB"))
    assertNull(WidgetPayload.parseHexColor("blue"))
    assertNull(WidgetPayload.parseHexColor(null))
  }

  @Test
  fun incrementInboxCountKeepsTheRestOfThePayload() {
    val bumped = JSONObject(WidgetPayloadStore.incrementInboxCount(sample)!!)

    assertEquals(4, bumped.getInt("inboxCount"))
    assertEquals(2 + 1, bumped.getJSONArray("items").length())
    assertEquals("Inbox: 4", WidgetPayload.parse(bumped.toString())!!.subtitle)
    assertNull(WidgetPayloadStore.incrementInboxCount("nope"))
  }
}
