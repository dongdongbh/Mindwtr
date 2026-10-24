package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class WidgetNavigationTest {
  @Test
  fun tasksTitleAndBlankSpaceOpenTheListWhileChevronOpensChooser() {
    val payload = payloadWithLists()

    val actions = WidgetRenderer.tasksHeaderActions(payload, "inbox", appWidgetId = 42)

    assertEquals("mindwtr:///inbox", actions.openList.uri)
    assertEquals(
      listOf(R.id.mindwtr_widget_title_target),
      actions.openTargetIds,
    )
    assertEquals("mindwtr:///inbox", actions.openHome.uri)
    assertEquals(
      listOf(R.id.mindwtr_widget_root, R.id.mindwtr_widget_empty, R.id.mindwtr_widget_spacer),
      actions.openHomeTargetIds,
    )
    assertNotEquals(actions.openList.requestCode, actions.openHome.requestCode)
    assertEquals(R.id.mindwtr_widget_chooser, actions.openChooserTargetId)
    assertNotEquals(actions.openList.requestCode, actions.openChooserRequestCode)
    assertNotEquals(actions.openHome.requestCode, actions.openChooserRequestCode)
    assertEquals("Change: Inbox", actions.chooserContentDescription)
  }

  @Test
  fun navigationPendingIntentIdentityIsUniquePerWidgetAndList() {
    val payload = payloadWithLists()

    val firstInbox = WidgetRenderer.tasksHeaderActions(payload, "inbox", appWidgetId = 42).openList
    val secondInbox = WidgetRenderer.tasksHeaderActions(payload, "inbox", appWidgetId = 43).openList
    val firstWaiting = WidgetRenderer.tasksHeaderActions(payload, "waiting", appWidgetId = 42).openList

    assertNotEquals(firstInbox.requestCode, secondInbox.requestCode)
    assertNotEquals(firstInbox.uri, firstWaiting.uri)
  }

  @Test
  fun blankSpaceFollowsEachTasksSelectionWhileCompactKeepsItsHomeRoute() {
    val payload = payloadWithLists()
    val focus = WidgetRenderer.tasksHeaderActions(payload, "focus", appWidgetId = 42)
    val inbox = WidgetRenderer.tasksHeaderActions(payload, "inbox", appWidgetId = 42)
    val saved = WidgetRenderer.tasksHeaderActions(payload, "filter:abc", appWidgetId = 42)
    val otherWidget = WidgetRenderer.tasksHeaderActions(payload, "inbox", appWidgetId = 43)
    val compact = WidgetRenderer.compactHeaderActions(payload, appWidgetId = 42)

    listOf(focus, inbox, saved, otherWidget).forEach { actions ->
      assertEquals(actions.openList.uri, actions.openHome.uri)
      assertNotEquals(actions.openList.requestCode, actions.openHome.requestCode)
    }
    assertEquals("mindwtr:///inbox", inbox.openList.uri)
    assertEquals("mindwtr:///widget-list/filter%3Aabc", saved.openList.uri)
    assertEquals(focus.openHome.requestCode, inbox.openHome.requestCode)
    assertEquals(inbox.openHome.requestCode, saved.openHome.requestCode)
    assertNotEquals(inbox.openHome.requestCode, otherWidget.openHome.requestCode)
    assertEquals("mindwtr:///focus", compact.openHome.uri)
    assertEquals(listOf(R.id.mindwtr_widget_title_target), compact.openTargetIds)

    val unsafePayload = payloadWithLists(rootFocusUri = "mindwtr://evil.example/focus")
    assertEquals("mindwtr:///inbox", WidgetRenderer.tasksHeaderActions(unsafePayload, "inbox", 42).openHome.uri)
  }

  @Test
  fun legacyListsUseOnlyTheSettledFixedAndSavedFilterRoutes() {
    val payload = payloadWithLists()

    assertEquals("mindwtr:///focus", payload.openUriFor("focus"))
    assertEquals("mindwtr:///inbox", payload.openUriFor("inbox"))
    assertEquals("mindwtr:///widget-list/next", payload.openUriFor("next"))
    assertEquals("mindwtr:///waiting", payload.openUriFor("waiting"))
    assertEquals("mindwtr:///someday", payload.openUriFor("someday"))
    assertEquals("mindwtr:///widget-list/filter%3Aabc", payload.openUriFor("filter:abc"))
    assertEquals("mindwtr:///focus", payload.openUriFor("filter:"))
    assertEquals("mindwtr:///focus", payload.openUriFor("filter:${"x".repeat(1_025)}"))
    assertEquals("mindwtr:///focus", payload.openUriFor("filter:bad\u0000id"))
    assertEquals("mindwtr:///focus", payload.openUriFor("project:untrusted"))

    val unsafeFallback = payloadWithLists(rootFocusUri = "mindwtr://evil.example/focus")
    assertEquals("mindwtr:///focus", unsafeFallback.openUriFor("focus"))
    assertEquals("mindwtr:///focus", unsafeFallback.openUriFor("project:untrusted"))
  }

  @Test
  fun optionalPayloadRouteCannotReplaceASettledFixedDestination() {
    val payload = payloadWithLists(inboxUri = "mindwtr:///widget-list/inbox")

    assertEquals("mindwtr:///inbox", payload.openUriFor("inbox"))
  }

  @Test
  fun partialCompactChromeSwitchesItsLinkWithTheDisplayedFallbackList() {
    val payload = payloadWithLists(
      focusItems = listOf("focus-task"),
      nextItems = listOf("next-task"),
      focusUri = "mindwtr:///focus",
      nextUri = "mindwtr:///widget-list/next",
    )

    val before = WidgetRenderer.compactHeaderActions(payload, appWidgetId = 71).openList
    val after = WidgetRenderer.compactHeaderActions(
      payload.displaySnapshot(setOf("focus-task")).payload,
      appWidgetId = 71,
    ).openList

    assertEquals("mindwtr:///focus", before.uri)
    assertEquals("mindwtr:///widget-list/next", after.uri)
    assertEquals(before.requestCode, after.requestCode)
  }

  private fun payloadWithLists(
    focusItems: List<String> = emptyList(),
    nextItems: List<String> = emptyList(),
    focusUri: String? = null,
    nextUri: String? = null,
    inboxUri: String? = null,
    rootFocusUri: String = "mindwtr:///focus",
  ): WidgetPayload {
    fun list(title: String, ids: List<String>, openUri: String?): JSONObject = JSONObject()
      .put("title", title)
      .put("items", JSONArray().apply {
        ids.forEach { id -> put(JSONObject().put("id", id).put("title", id)) }
      })
      .apply { if (openUri != null) put("openUri", openUri) }
    val lists = JSONObject()
      .put("focus", list("Focus", focusItems, focusUri))
      .put("inbox", list("Inbox", emptyList(), inboxUri))
      .put("next", list("Next Actions", nextItems, nextUri))
      .put("waiting", list("Waiting For", emptyList(), null))
      .put("someday", list("Someday/Maybe", emptyList(), null))
    return WidgetPayload.parse(JSONObject()
      .put("focusUri", rootFocusUri)
      .put("lists", lists)
      .put("listTitles", JSONObject()
        .put("focus", "Focus")
        .put("inbox", "Inbox")
        .put("next", "Next Actions")
        .put("waiting", "Waiting For")
        .put("someday", "Someday/Maybe"))
      .toString())!!
  }
}
