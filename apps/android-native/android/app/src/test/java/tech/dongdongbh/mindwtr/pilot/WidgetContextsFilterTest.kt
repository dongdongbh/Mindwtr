package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test


class WidgetContextsFilterTest {
    @Test fun aSavedContextsFilterLinkOpensContexts() = assertEquals("desk", widgetContextsFilterId(JSONObject().put("contextsFilterId", "desk")))

    @Test fun otherWidgetListsStayLists() {
        assertNull(widgetContextsFilterId(JSONObject().put("contextsFilterId", JSONObject.NULL)))
        assertNull(widgetContextsFilterId(JSONObject().put("contextsFilterId", "")))
        assertNull(widgetContextsFilterId(JSONObject().put("found", true)))
    }

    @Test fun aSortUnderASavedFilterIsATemporaryOverride() =
        assertEquals("title", contextsSortOverride(JSONObject().put("savedFilterId", "desk"), "title"))

    @Test fun aSortWithoutASavedFilterWritesTheGlobalSort() {
        assertNull(contextsSortOverride(JSONObject().put("savedFilterId", JSONObject.NULL), "title"))
        assertNull(contextsSortOverride(JSONObject(), "title"))
        assertNull(contextsSortOverride(null, "title"))
    }

    private val overridden = JSONObject().put("savedFilterId", "desk").put("sortOverride", "title").put("tokens", JSONArray().put("@desk"))
        .put("preservedCriteria", JSONObject()).put("searchQuery", "kept")

    @Test fun aSavedContextsFilterDropsTheTemporarySort() {
        val saved = contextsAfterSave(overridden, "new")
        assertEquals("new", saved.getString("savedFilterId"))
        assertFalse(saved.has("sortOverride"))
        assertFalse(saved.has("preservedCriteria"))
        assertEquals(0, saved.getJSONArray("tokens").length())
    }

    @Test fun leavingTheStackedContextsScreenClearsItsSavedFilterAndSort() {
        assertTrue(leavesSavedContexts(MenuScreen.Contexts, null, overridden))
        val cleared = contextsWithSavedFilter(overridden, null)
        assertTrue(cleared.isNull("savedFilterId"))
        assertFalse(cleared.has("sortOverride"))
        assertEquals(0, cleared.getJSONObject("filters").length())
    }

    @Test fun aQuickAccessTabOrAPlainContextsScreenKeepsItsState() {
        assertFalse(leavesSavedContexts(null, null, overridden))
        assertFalse(leavesSavedContexts(MenuScreen.Contexts, MenuScreen.Contexts, overridden))
        assertFalse(leavesSavedContexts(MenuScreen.Contexts, null, JSONObject().put("savedFilterId", JSONObject.NULL)))
        assertFalse(leavesSavedContexts(MenuScreen.Waiting, null, overridden))
    }
}
