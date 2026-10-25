package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * RN's readDoneListViewState and readArchivedListViewState (57271148e): a stored Done or Archive view value this build does not
 * know (an older or newer app wrote it, or it is broken) falls back to core's default instead of failing the whole view, which
 * core's reader refuses for any unknown groupBy or sortBy.
 */
class ListViewStateTest {
    @Test fun knownValuesAreKept() {
        assertEquals(ListViewState("completedDate", "created-desc"), ListViewState.parse("""{"groupBy":"completedDate","sortBy":"created-desc"}"""))
        assertEquals(ListViewState("tag", "completed"), ListViewState.parse("""{"groupBy":"tag","sortBy":"completed"}"""))
    }

    @Test fun anUnknownValueFallsBackAlone() {
        assertEquals(ListViewState(null, "due"), ListViewState.parse("""{"groupBy":"status","sortBy":"due"}"""))
        // Priority sorts the other lists but not Done or Archive (core's DONE_TASK_LIST_SORT_OPTIONS).
        assertEquals(ListViewState("project", null), ListViewState.parse("""{"groupBy":"project","sortBy":"priority"}"""))
        assertEquals(ListViewState(null, null), ListViewState.parse("""{"groupBy":7,"sortBy":["due"]}"""))
    }

    @Test fun aMissingOrBrokenRecordIsCoresDefault() {
        for (raw in listOf(null, "", "{", "[]", "null")) assertEquals(raw.toString(), ListViewState(null, null), ListViewState.parse(raw))
    }
}
