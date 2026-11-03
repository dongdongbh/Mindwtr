package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class ListViewStateTest {
    @Test fun knownValuesAreKept() {
        assertEquals(ListViewState("completedDate", "created-desc"), ListViewState.parse("""{"groupBy":"completedDate","sortBy":"created-desc"}"""))
        assertEquals(ListViewState("tag", "completed"), ListViewState.parse("""{"groupBy":"tag","sortBy":"completed"}"""))
    }

    @Test fun anUnknownValueFallsBackAlone() {
        assertEquals(ListViewState(null, "due"), ListViewState.parse("""{"groupBy":"status","sortBy":"due"}"""))

        assertEquals(ListViewState("project", null), ListViewState.parse("""{"groupBy":"project","sortBy":"priority"}"""))
        assertEquals(ListViewState(null, null), ListViewState.parse("""{"groupBy":7,"sortBy":["due"]}"""))
    }

    @Test fun aMissingOrBrokenRecordIsCoresDefault() {
        for (raw in listOf(null, "", "{", "[]", "null")) assertEquals(raw.toString(), ListViewState(null, null), ListViewState.parse(raw))
    }
}
