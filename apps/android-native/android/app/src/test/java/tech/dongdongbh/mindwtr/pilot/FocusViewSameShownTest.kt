package tech.dongdongbh.mindwtr.pilot

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A Focus read with the same content as shown (a resume, a new minute, a sync that brought nothing) is not drawn again
 * (InboxViewModel.showFocus): only its revision moves. Anything the screen draws differing makes it a new view.
 */
class FocusViewSameShownTest {
    private fun row(tone: String?) = TaskRow("t", "Pay rent", "next", false, RowMeta(
        listOf(MetaPart("due", "Today", false, tone = tone)), null, null, true, RowSwipe("done", "Done", "done"), false, "Pay rent"))

    private fun view(revision: String = "r1", title: String = "Next actions", group: String = """{"id":"g","title":"Home"}""",
                     controls: String? = """{"state":{"sortBy":"default"}}""", date: String = "Tuesday", tone: String? = "soon") = FocusView(
        revision, date,
        listOf(FocusSection("next", title, 3, listOf(row(tone)), null, groups = listOf(JSONObject(group)))),
        listOf(ReviewProject("p", "Project", "active", null, null)),
        controls?.let(::JSONObject),
    )

    @Test fun anotherRevisionWithTheSameContentIsTheSame() {
        assertTrue(view().sameShown(view(revision = "r2")))
    }

    @Test fun anyDrawnDifferenceIsNew() {
        assertFalse(view().sameShown(view(title = "Next")))
        assertFalse(view().sameShown(view(group = """{"id":"g","title":"Work"}""")))
        assertFalse(view().sameShown(view(controls = """{"state":{"sortBy":"due"}}""")))
        assertFalse(view().sameShown(view(controls = null)))
        assertFalse(view().sameShown(view(date = "Wednesday")))
        // The clock moved a row's urgency tone across a threshold (the due time passed): drawn again.
        assertFalse(view().sameShown(view(revision = "r2", tone = "overdue")))
    }
}
