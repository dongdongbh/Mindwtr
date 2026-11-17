package tech.dongdongbh.mindwtr.pilot

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test


class WindowLoadTest {
    private fun page(rows: Int, revision: String = "r1", bulk: JSONObject? = null) =
        MenuPage("inbox", JSONObject().put("revision", revision).put("total", 120), JSONObject(),
            List(rows) { MenuItem(JSONObject().put("type", "heading").put("id", "h$it"), null) }, emptyMap(), bulk)

    @Test fun aLoadInFlightIsNotStartedTwice() {
        val load = WindowLoad<MenuPage>()
        val shown = page(50)
        assertTrue(load.begin(shown))
        assertFalse(load.begin(shown))
        load.end(shown)
        assertTrue(load.begin(shown))
    }

    @Test fun aRefreshThatLandsDuringTheLoadWins() {
        val load = WindowLoad<MenuPage>()
        val shown = page(50)
        load.begin(shown)
        val refreshed = page(50, revision = "r2")
        assertFalse(load.lands(shown, refreshed, moved = true))
    }

    @Test fun aLoadCountsOnlyForThePageItGrewFrom() {
        val load = WindowLoad<MenuPage>()
        val shown = page(50)
        assertFalse(load.loading(shown))
        load.begin(shown)
        assertTrue(load.loading(shown))
        assertFalse(load.loading(page(50)))
        load.end(shown)
        assertFalse(load.loading(shown))
    }

    @Test fun aPageReplacedDuringTheLoadWins() {
        val load = WindowLoad<MenuPage>()
        val shown = page(50, bulk = JSONObject().put("selectedIds", JSONArray()))
        load.begin(shown)
        val selected = shown.withBulk(JSONObject().put("selectedIds", JSONArray().put("t1")))
        assertFalse(load.lands(shown, selected, moved = true))
    }

    @Test fun aNewerPageCanLoadWhileAnOlderLoadIsInFlight() {
        val load = WindowLoad<MenuPage>()
        val old = page(50)
        val newer = page(50, revision = "r2")
        load.begin(old)
        assertTrue(load.begin(newer))
        load.end(old)
        assertFalse(load.begin(newer))
    }

    @Test fun anEmptyWindowDoesNotLandSoTheListCannotLoopOnIt() {
        val load = WindowLoad<MenuPage>()
        val shown = page(50)
        load.begin(shown)
        assertFalse(load.lands(shown, shown, moved = false))
        assertTrue(load.lands(shown, shown, moved = true))
    }

    @Test fun theNextWindowKeepsTheSelection() {
        val bulk = JSONObject().put("selectAll", JSONObject().put("except", JSONArray().put("t3")))
        val shown = page(50, bulk = bulk)
        val grown = shown.appended(List(50) { MenuItem(JSONObject().put("type", "heading").put("id", "n$it"), null) })
        assertSame(bulk, grown.bulk)
        assertTrue(grown.items.size == 100)
    }
}
