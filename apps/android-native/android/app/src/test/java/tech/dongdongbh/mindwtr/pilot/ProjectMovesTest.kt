package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** RN's long-press Move up / Move down (#1263): the Projects list offers exactly core's moves (planProjectMove's rule), as sent. */
class ProjectMovesTest {
    @Test fun theListTakesCoreMovesPerProject() {
        val json = JSONObject("""{"version":1,"active":[],"deferred":[],"archived":[],
            "moves":{"s1":{"up":false,"down":true},"s2":{"up":true,"down":false},"a":{"up":false,"down":false}}}""")
        val view = ProjectsView.parse(json)
        assertEquals(mapOf("s1" to (false to true), "s2" to (true to false), "a" to (false to false)), view.moves)
        // A reply without moves (an older bundle) offers none.
        assertEquals(emptyMap<String, Pair<Boolean, Boolean>>(), ProjectsView.parse(JSONObject("""{"version":1,"active":[],"deferred":[],"archived":[]}""")).moves)
    }
}
