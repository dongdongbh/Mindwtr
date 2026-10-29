package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test

/** RN's long-press Move up / Move down on the Projects list (#1263, 2678f9a44): offered only where core's planProjectMove moves. */
class ProjectMovesTest {
    private fun row(id: String, starred: Boolean = false) = ProjectRow(id, id, "active", "Active", starred, false, 0, null, false, "1")

    @Test fun movesStayInsideTheAreaAndNeverPassAStar() {
        val group = listOf(row("star", starred = true), row("a"), row("b"), row("c"))
        assertEquals(false to false, projectMoves(group, 0))
        assertEquals(false to true, projectMoves(group, 1))
        assertEquals(true to true, projectMoves(group, 2))
        assertEquals(true to false, projectMoves(group, 3))
        assertEquals(false to false, projectMoves(listOf(row("only")), 0))
    }
}
