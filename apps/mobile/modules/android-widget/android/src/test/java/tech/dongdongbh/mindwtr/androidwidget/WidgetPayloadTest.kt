package tech.dongdongbh.mindwtr.androidwidget

import org.json.JSONArray
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
      "dateLabel": "Saturday, Sep 6",
      "subtitle": "Inbox: 3 · +2 More",
      "inboxLabel": "Inbox",
      "inboxCount": 3,
      "items": [
        {"id": "a", "title": "Call the bank", "statusLabel": "Next", "dueLabel": "Today", "dueEmphasis": true, "openUri": "mindwtr://open?task=a", "description": "Ask about the fee", "contexts": ["@calls", "  "], "tags": ["#money"], "startLabel": "Today 09:00", "priorityLabel": "High"},
        {"id": "b", "title": "Write report", "statusLabel": "Next", "dueLabel": null, "dueEmphasis": false, "openUri": "https://evil.example"},
        {"id": "c", "title": "   ", "statusLabel": "Next", "dueLabel": null, "dueEmphasis": false}
      ],
      "sections": [
        {"key": "focus", "title": "Today's Focus", "detail": "Sat Sep 6", "items": [{"id": "a", "title": "Call the bank", "dueLabel": "Today", "dueEmphasis": true, "dueTone": "today", "openUri": "mindwtr://open?task=a", "priorityColor": "#dc2626", "contextLabel": "Finance", "identityColor": "#8b5cf6"}]},
        {"key": "next", "title": "Next actions", "items": []},
        {"key": "upcoming", "title": "Upcoming", "items": [{"id": "b", "title": "Write report", "dueLabel": null, "dueEmphasis": false, "openUri": "mindwtr://open?task=b", "priorityColor": null, "contextLabel": null}]}
      ],
      "lists": {
        "focus": {"title": "Focus", "dateLabel": "Saturday, Sep 6", "sections": [{"key": "focus", "title": "Today's Focus", "items": [{"id": "a", "title": "Call the bank"}]}], "items": [{"id": "a", "title": "Call the bank"}]},
        "waiting": {"title": "Waiting For", "items": [{"id": "w", "title": "Reply from Sam"}]},
        "filter:f1": {"title": "Errands", "items": [{"id": "e", "title": "Post the parcel"}]}
      },
      "listTitles": {"focus": "Focus", "inbox": "Inbox", "next": "Next Actions", "waiting": "Waiting For", "someday": "Someday/Maybe", "savedFilters": "Saved filters"},
      "savedFilters": [{"id": "f1", "name": "Errands"}, {"id": "", "name": "Nameless"}],
      "emptyMessage": "All clear",
      "focusUri": "mindwtr:///focus",
      "themeMode": "dark",
      "palette": {"background": "#111827", "card": "#1F2937", "text": "#F9FAFB", "mutedText": "#CBD5E1", "accent": "#2563EB", "onAccent": "#FFFFFF", "border": "#374151", "warning": "#F59E0B", "headerWash": "#2563EB2E"},
      "taskPeek": {"complete": "Complete", "open": "Open", "start": "Start", "due": "Due date", "priority": "Priority"},
      "quickCapture": {"title": "Quick capture", "placeholder": "Add task to inbox...", "save": "Save", "cancel": "Cancel", "added": "Task added to Mindwtr."}
    }
  """.trimIndent()

  @Test
  fun quickCaptureDescriptionUsesThePublishedTranslation() {
    val payload = WidgetPayload.parse("""{"quickCapture":{"descriptionPlaceholder":"Beschreibung"}}""")!!
    assertEquals("Beschreibung", payload.quickCapture.descriptionPlaceholder)
  }

  @Test
  fun parsesItemsLabelsAndPalette() {
    val payload = WidgetPayload.parse(sample)

    assertNotNull(payload)
    payload!!
    assertEquals("Today's Focus", payload.headerTitle)
    assertEquals("Inbox: 3 · +2 More", payload.subtitle)
    assertEquals("Inbox: 3 · +2 More", WidgetRenderer.taskSubtitle(payload, isFocus = true))
    assertNull(WidgetRenderer.taskSubtitle(payload, isFocus = false))
    assertEquals(2, payload.items.size)
    assertEquals("Call the bank", payload.items[0].title)
    assertEquals("a", payload.items[0].id)
    assertEquals("Today", payload.items[0].dueLabel)
    assertTrue(payload.items[0].dueEmphasis)
    assertNull(payload.items[1].dueLabel)
    assertEquals("mindwtr://open?task=a", payload.items[0].openUri)
    assertNull(payload.items[0].priorityColor)
    assertEquals(2, payload.sections.size)
    assertEquals("Today's Focus", payload.sections[0].title)
    assertEquals(0xFFDC2626.toInt(), payload.sections[0].items[0].priorityColor)
    assertEquals("Finance", payload.sections[0].items[0].contextLabel)
    assertEquals("Sat Sep 6", payload.sections[0].detail)
    assertEquals(0xFF8B5CF6.toInt(), payload.sections[0].items[0].identityColor)
    assertEquals(WidgetPayload.DueTone.TODAY, payload.sections[0].items[0].dueTone)
    assertEquals(WidgetPayload.DueTone.NORMAL, payload.sections[1].items[0].dueTone)
    assertEquals("Saturday, Sep 6", payload.dateLabel)
    assertEquals(0xFF374151.toInt(), payload.palette!!.border)
    assertEquals(0xFFF59E0B.toInt(), payload.palette!!.warning)
    assertNull(payload.sections[1].items[0].contextLabel)
    val rows = TasksWidgetFactory.buildRows(WidgetPayload.ListPayload("", null, payload.sections, payload.items))
    assertEquals(4, rows.size)
    assertTrue(rows[0] is TasksWidgetFactory.Row.Header && rows[1] is TasksWidgetFactory.Row.Task)
    assertEquals("Sat Sep 6", (rows[0] as TasksWidgetFactory.Row.Header).detail)
    assertTrue(rows[2] is TasksWidgetFactory.Row.Header && rows[3] is TasksWidgetFactory.Row.Task)
    assertNull("a non-app openUri must never reach a PendingIntent", payload.items[1].openUri)
    assertEquals(0xFF111827.toInt(), payload.palette!!.background)
    assertEquals(0xFF2563EB.toInt(), payload.palette!!.accent)
    assertEquals(0xFF1F2937.toInt(), payload.palette!!.card)
    assertFalse(payload.usesSystemColors)
    assertEquals(WidgetPayload.EMPTY.quickCapture.placeholder, payload.quickCapture.placeholder)
    assertEquals("Description (optional)", payload.quickCapture.descriptionPlaceholder)
  }

  @Test
  fun compactRowsKeepSectionOrderWithoutHeadingsOrDuplicatingTheFlatItems() {
    val payload = WidgetPayload.parse(sample)!!
    val list = WidgetPayload.ListPayload("Focus", null, payload.sections, payload.items)
    val rows = TasksWidgetFactory.buildRows(list, compact = true)
    assertEquals(listOf("a", "b"), rows.map { (it as TasksWidgetFactory.Row.Task).item.id })
    assertEquals(4, TasksWidgetFactory.buildRows(list).size)
    assertEquals(2, TasksWidgetFactory.buildRows(list.copy(sections = emptyList()), compact = true).size)
    assertTrue(TasksWidgetFactory.buildRows(list.copy(sections = emptyList(), items = emptyList()), compact = true).isEmpty())
  }

  @Test
  fun committedRowsAreHiddenEverywhereWithoutChangingTheSourceSnapshot() {
    val payload = WidgetPayload.parse(sample)!!

    val display = payload.displaySnapshot(setOf("a"))

    assertEquals(setOf("a", "b", "w", "e"), display.sourceTaskIds)
    assertEquals(listOf("b"), display.payload.items.map { it.id })
    assertEquals(listOf("Upcoming"), display.payload.sections.map { it.title })
    assertEquals(listOf("b"), display.payload.sections.single().items.map { it.id })
    assertTrue(display.payload.listFor("focus").items.isEmpty())
    assertTrue(display.payload.listFor("focus").sections.isEmpty())
    assertEquals(listOf("w"), display.payload.listFor("waiting").items.map { it.id })
  }

  @Test
  fun undoWindowRowsStayVisibleUntilTheyJoinTheCommittedSet() {
    val payload = WidgetPayload.parse(sample)!!

    val duringUndo = payload.displaySnapshot(emptySet()).payload
    val afterCommit = payload.displaySnapshot(setOf("a")).payload

    assertEquals(listOf("a", "b"), duringUndo.items.map { it.id })
    assertEquals(listOf("b"), afterCommit.items.map { it.id })
  }

  @Test
  fun compactFallsBackToTranslatedNextActionsWhenFocusIsEmpty() {
    val payload = payloadWithLists(
      focus = listPayload("Focus"),
      next = listPayload("Prochaines actions", items = items("next-1")),
    )

    assertEquals(WidgetPayload.NEXT_LIST_ID, payload.compactListId())
    assertEquals("Prochaines actions", WidgetRenderer.compactHeaderTitle(payload))
    assertEquals(
      listOf("next-1"),
      TasksWidgetFactory.buildRows(payload.listFor(payload.compactListId()), compact = true)
        .map { (it as TasksWidgetFactory.Row.Task).item.id },
    )
  }

  @Test
  fun hidingAllTodayRowsSwitchesCompactRowsAndHeaderToNextActions() {
    val payload = payloadWithLists(
      focus = listPayload("Focus", sections = sections("Today", "today-1")),
      next = listPayload("Next Actions", items = items("next-1", "next-2")),
    )

    val visible = payload.displaySnapshot(setOf("today-1")).payload
    val chrome = WidgetRenderer.compactChrome(visible)

    assertEquals("Next Actions", chrome.title)
    assertFalse(chrome.isEmpty)
    assertEquals(
      listOf("next-1", "next-2"),
      TasksWidgetFactory.buildRows(visible.listFor(visible.compactListId()), compact = true)
        .map { (it as TasksWidgetFactory.Row.Task).item.id },
    )
  }

  @Test
  fun hidingEveryAvailableRowShowsTheCoherentEmptyState() {
    val payload = payloadWithLists(
      focus = listPayload("Focus", items = items("focus-1")),
      next = listPayload("Next Actions", items = items("next-1")),
    )

    val visible = payload.displaySnapshot(setOf("focus-1", "next-1")).payload
    val chrome = WidgetRenderer.compactChrome(visible)

    assertEquals("Today's Focus", chrome.title)
    assertTrue(chrome.isEmpty)
    assertTrue(TasksWidgetFactory.buildRows(visible.listFor(visible.compactListId()), compact = true).isEmpty())
  }

  @Test
  fun hiddenChooserRowsUpdateTheDisplayedCountAndEmptyState() {
    val payload = WidgetPayload.parse(sample)!!

    val chrome = WidgetRenderer.tasksChrome(payload.displaySnapshot(setOf("w")).payload, "waiting")

    assertEquals("Waiting For · 0", chrome.title)
    assertTrue(chrome.isEmpty)
    assertNull(chrome.subtitle)
  }

  @Test
  fun compactKeepsFocusWhenItsFlatRowsArePopulated() {
    val payload = payloadWithLists(
      focus = listPayload("Focus", items = items("focus-1")),
      next = listPayload("Next Actions", items = items("next-1")),
    )

    assertEquals(WidgetListStore.DEFAULT_LIST, payload.compactListId())
    assertEquals("Today's Focus", WidgetRenderer.compactHeaderTitle(payload))
  }

  @Test
  fun compactKeepsFocusWhenTodayOnlyHasSectionRows() {
    val payload = payloadWithLists(
      focus = listPayload("Focus", sections = sections("Today", "today-1")),
      next = listPayload("Next Actions", items = items("next-1")),
    )

    assertEquals(WidgetListStore.DEFAULT_LIST, payload.compactListId())
    assertEquals(
      listOf("today-1"),
      TasksWidgetFactory.buildRows(payload.listFor(payload.compactListId()), compact = true)
        .map { (it as TasksWidgetFactory.Row.Task).item.id },
    )
  }

  @Test
  fun compactPreservesLegacyEmptyFocusWhenNextIsMissingOrEmpty() {
    val missingNext = payloadWithLists(focus = listPayload("Focus"))
    val emptyNext = payloadWithLists(
      focus = listPayload("Focus"),
      next = listPayload("Next Actions"),
    )

    assertEquals(WidgetListStore.DEFAULT_LIST, missingNext.compactListId())
    assertEquals(WidgetListStore.DEFAULT_LIST, emptyNext.compactListId())
    assertEquals("Today's Focus", WidgetRenderer.compactHeaderTitle(missingNext))
    assertEquals("Today's Focus", WidgetRenderer.compactHeaderTitle(emptyNext))
  }

  @Test
  fun compactFlattensNextSectionsInOrderWithoutChangingTasksFocusRows() {
    val payload = payloadWithLists(
      focus = listPayload("Focus"),
      next = listPayload(
        "Next Actions",
        items = items("flat-copy"),
        sections = JSONArray()
          .put(section("First", "next-1", "next-2"))
          .put(section("Second", "next-3")),
      ),
    )

    val compactRows = TasksWidgetFactory.buildRows(payload.listFor(payload.compactListId()), compact = true)
    val tasksFocusRows = TasksWidgetFactory.buildRows(payload.listFor(WidgetListStore.DEFAULT_LIST))

    assertEquals(
      listOf("next-1", "next-2", "next-3"),
      compactRows.map { (it as TasksWidgetFactory.Row.Task).item.id },
    )
    assertTrue("Tasks widgets must keep the empty Focus list", tasksFocusRows.isEmpty())
  }

  @Test
  fun flatItemsBackTheRowsWhenAPayloadCarriesNoSections() {
    val payload = WidgetPayload.parse(JSONObject(sample).apply { remove("sections"); remove("lists") }.toString())!!

    val rows = TasksWidgetFactory.buildRows(payload.listFor("focus"))

    assertEquals(2, rows.size)
    assertTrue(rows.all { it is TasksWidgetFactory.Row.Task })
  }

  @Test
  fun parserKeepsTwoHundredRowsAndTheEligibleTotal() {
    val many = JSONArray().apply {
      repeat(240) { index -> put(JSONObject().put("id", "task-$index").put("title", "Task $index")) }
    }
    val payload = WidgetPayload.parse(JSONObject()
      .put("viewAllLabel", "View all {{count}} tasks")
      .put("lists", JSONObject().put("next", listPayload("Next", items = many).put("totalCount", 240)))
      .toString())!!

    val list = payload.listFor("next")
    assertEquals(200, list.items.size)
    assertEquals(240, list.eligibleTaskCount())
    assertEquals("View all 240 tasks", payload.formatViewAllLabel(list.eligibleTaskCount()))
  }

  @Test
  fun sectionCapIsSharedAndNeverLeavesAnOrphanHeader() {
    val first = Array(150) { "first-$it" }
    val second = Array(100) { "second-$it" }
    val list = WidgetPayload.parse(JSONObject()
      .put("lists", JSONObject().put("focus", listPayload(
        "Focus",
        sections = JSONArray().put(section("First", *first)).put(section("Second", *second)),
      ).put("totalCount", 250)))
      .toString())!!.listFor("focus")

    assertEquals(listOf(150, 50), list.sections.map { it.items.size })
    val limited = TasksWidgetFactory.takeTaskRows(TasksWidgetFactory.buildBaseRows(list), 151)
    assertEquals(151, limited.count { it is TasksWidgetFactory.Row.Task })
    assertTrue(limited.last() is TasksWidgetFactory.Row.Task)
    assertEquals(2, limited.count { it is TasksWidgetFactory.Row.Header })
  }

  @Test
  fun committedRowsDecrementProvidedTotalsOncePerListAndLegacyUsesActualRows() {
    val root = JSONObject(sample)
    val focus = root.getJSONObject("lists").getJSONObject("focus")
    focus.put("totalCount", 1)
    val payload = WidgetPayload.parse(root.toString())!!

    val visible = payload.displaySnapshot(setOf("a")).payload.listFor("focus")
    assertEquals(0, visible.eligibleTaskCount())
    assertTrue(visible.sections.isEmpty())
    assertTrue(visible.items.isEmpty())

    val legacy = WidgetPayload.parse(sample)!!.displaySnapshot(setOf("a")).payload.listFor("waiting")
    assertEquals(1, legacy.eligibleTaskCount())
  }

  @Test
  fun listsResolveToTheSelectionOrFallBackToFocus() {
    val payload = WidgetPayload.parse(sample)!!

    assertEquals(setOf("focus", "waiting", "filter:f1"), payload.lists.keys)
    assertEquals("Reply from Sam", payload.listFor("waiting").items[0].title)
    // An unpublished project cannot borrow Focus rows under another title.
    assertEquals("Focus", payload.listFor("project:gone").title)
    assertEquals("Saved filters", payload.listTitles["savedFilters"])
    assertEquals(2, TasksWidgetFactory.buildRows(payload.listFor("focus")).size)
  }

  @Test
  fun listOpenUrisAcceptOnlyHostlessMindwtrRoutes() {
    val root = JSONObject(sample)
    root.put("lists", JSONObject()
      .put("focus", listPayload("Focus", openUri = "mindwtr:///focus"))
      .put("inbox", listPayload("Inbox", openUri = "https://example.com/inbox"))
      .put("waiting", listPayload("Waiting", openUri = "mindwtr://evil.example/waiting"))
      .put("someday", listPayload("Someday", openUri = "mindwtr:opaque"))
      .put("next", listPayload("Next", openUri = "mindwtr:///%ZZ"))
      .put("filter:abc", listPayload("Filter", openUri = "mindwtr:///settings"))
      .put("filter:good", listPayload("Good filter", openUri = "mindwtr:///widget-list/filter%3Agood")))

    val payload = WidgetPayload.parse(root.toString())!!

    assertEquals("mindwtr:///focus", payload.lists.getValue("focus").openUri)
    assertNull(payload.lists.getValue("inbox").openUri)
    assertNull(payload.lists.getValue("waiting").openUri)
    assertNull(payload.lists.getValue("someday").openUri)
    assertNull(payload.lists.getValue("next").openUri)
    assertNull(payload.lists.getValue("filter:abc").openUri)
    assertEquals("mindwtr:///widget-list/filter%3Agood", payload.lists.getValue("filter:good").openUri)

    root.getJSONObject("lists").put("inbox", listPayload("Inbox", openUri = "mindwtr:///widget-list/inbox"))
    assertNull(WidgetPayload.parse(root.toString())!!.lists.getValue("inbox").openUri)
  }

  @Test
  fun aListPickedButNotPublishedYetKeepsItsOwnNameAndStaysEmpty() {
    val payload = WidgetPayload.parse(sample)!!

    // The chooser can name every list; the app builds the rows on its next
    // publish. Until then the widget must not show the Focus rows under the
    // picked list's title.
    val pending = payload.listFor("inbox")
    assertEquals("Inbox", pending.title)
    assertTrue(pending.items.isEmpty())
    assertTrue(pending.sections.isEmpty())
    assertEquals("Inbox", payload.titleFor("inbox"))
    assertNull(payload.titleFor("project:gone"))
  }

  @Test
  fun savedFiltersAreOfferedAsListsAndFallBackToFocusWhenGone() {
    val payload = WidgetPayload.parse(sample)!!

    assertEquals(listOf("f1"), payload.savedFilters.map { it.id })
    assertEquals("Errands", payload.titleFor("filter:f1"))
    assertEquals("Post the parcel", payload.listFor("filter:f1").items[0].title)
    // A filter the user deleted is in neither the lists nor the options.
    assertNull(payload.titleFor("filter:gone"))
    assertEquals("Focus", payload.listFor("filter:gone").title)
  }

  @Test
  fun theTaskSheetFindsItsRowAnywhereInThePayloadAndReadsItsDetails() {
    val payload = WidgetPayload.parse(sample)!!

    val item = payload.itemFor("a")!!
    assertEquals("Ask about the fee", item.description)
    assertEquals(listOf("@calls"), item.contexts)
    assertEquals(listOf("#money"), item.tags)
    assertEquals("Today 09:00", item.startLabel)
    assertEquals("High", item.priorityLabel)
    assertEquals("Complete", payload.taskPeek.complete)
    // Rows that live only inside a named list are reachable too.
    assertEquals("Reply from Sam", payload.itemFor("w")?.title)
    assertNull(payload.itemFor("nope"))
    assertNull(payload.itemFor(""))
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
    assertEquals("Inbox: 0", payload.subtitle)
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
    assertEquals(0x802563EB.toInt(), WidgetPayload.parseHexColor("#2563EB80"))
    assertNull(WidgetPayload.parseHexColor("blue"))
    assertNull(WidgetPayload.parseHexColor(null))
  }

  @Test
  fun incrementInboxCountKeepsTheRestOfThePayload() {
    val bumped = JSONObject(WidgetPayloadStore.incrementInboxCount(sample)!!)

    assertEquals(4, bumped.getInt("inboxCount"))
    assertEquals(2 + 1, bumped.getJSONArray("items").length())
    assertEquals("Inbox: 4 · +2 More", bumped.getString("subtitle"))
    assertEquals("Inbox: 4 · +2 More", WidgetPayload.parse(bumped.toString())!!.subtitle)
    assertNull(WidgetPayloadStore.incrementInboxCount("nope"))
  }

  @Test
  fun incrementInboxCountAddsALegacySubtitleWithoutInventingHiddenRows() {
    val legacy = JSONObject(sample).apply { remove("subtitle") }.toString()
    val bumped = JSONObject(WidgetPayloadStore.incrementInboxCount(legacy)!!)

    assertEquals(4, bumped.getInt("inboxCount"))
    assertEquals("Inbox: 4", bumped.getString("subtitle"))
    assertEquals("Inbox: 4", WidgetPayload.parse(bumped.toString())!!.subtitle)
  }

  private fun payloadWithLists(focus: JSONObject, next: JSONObject? = null): WidgetPayload {
    val lists = JSONObject().put(WidgetListStore.DEFAULT_LIST, focus)
    if (next != null) lists.put(WidgetPayload.NEXT_LIST_ID, next)
    val root = JSONObject(sample)
      .put("items", JSONArray())
      .put("sections", JSONArray())
      .put("lists", lists)
    return WidgetPayload.parse(root.toString())!!
  }

  private fun listPayload(
    title: String,
    items: JSONArray = JSONArray(),
    sections: JSONArray = JSONArray(),
    openUri: String? = null,
  ): JSONObject = JSONObject()
    .put("title", title)
    .put("items", items)
    .put("sections", sections)
    .apply { if (openUri != null) put("openUri", openUri) }

  private fun items(vararg ids: String): JSONArray = JSONArray().apply {
    ids.forEach { put(JSONObject().put("id", it).put("title", it)) }
  }

  private fun sections(title: String, vararg ids: String): JSONArray = JSONArray().put(section(title, *ids))

  private fun section(title: String, vararg ids: String): JSONObject = JSONObject()
    .put("title", title)
    .put("items", items(*ids))
}
