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
      "sections": [{"title": "Next", "items": []}],
      "emptyMessage": "All clear",
      "focusUri": "mindwtr:///focus",
      "themeMode": "dark",
      "palette": {"background": "#111827", "text": "#F9FAFB", "mutedText": "#CBD5E1", "accent": "#2563EB", "onAccent": "#FFFFFF"},
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
    assertNull("a non-app openUri must never reach a PendingIntent", payload.items[1].openUri)
    assertEquals(0xFF111827.toInt(), payload.palette!!.background)
    assertEquals(0xFF2563EB.toInt(), payload.palette!!.accent)
    assertFalse(payload.usesSystemColors)
    assertEquals("Add task to inbox...", payload.quickCapture.placeholder)
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
