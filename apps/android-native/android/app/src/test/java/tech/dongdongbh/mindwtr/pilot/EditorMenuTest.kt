package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tech.dongdongbh.mindwtr.pilot.EditorMenuAction.*

/** RN's TaskEditHeader menu: its rows, order and conditions (task-edit-modal.tsx props, TaskEditHeader.tsx). */
class EditorMenuTest {
    @Test fun aPlainTaskShowsRnsRowsInRnsOrder() {
        assertEquals(listOf(CopyLink, CopyId, Share, Duplicate, Promote, Cancel, Delete),
            editorMenuActions(readOnly = false, reference = false, hasProject = false, canSkip = false, canCancel = true))
    }

    @Test fun eachConditionalRowShowsOnlyWhenRnsConditionHolds() {
        assertEquals(listOf(CopyLink, CopyId, Share, Duplicate, Promote, ConvertToAction, ConvertToSection, Skip, Cancel, Delete),
            editorMenuActions(readOnly = false, reference = true, hasProject = true, canSkip = true, canCancel = true))
        assertEquals(listOf(CopyLink, CopyId, Share, Duplicate, Promote, Delete),
            editorMenuActions(readOnly = false, reference = false, hasProject = false, canSkip = false, canCancel = false))
    }

    @Test fun aReadOnlyTaskOffersOnlyTheCopyRows() {
        assertEquals(listOf(CopyLink, CopyId), editorMenuActions(readOnly = true, reference = true, hasProject = true, canSkip = true, canCancel = true))
    }

    @Test fun onlyCancelAndDeleteAreDangerRows() {
        assertTrue(EditorMenuAction.entries.filter { it.danger } == listOf(Cancel, Delete))
    }
}
