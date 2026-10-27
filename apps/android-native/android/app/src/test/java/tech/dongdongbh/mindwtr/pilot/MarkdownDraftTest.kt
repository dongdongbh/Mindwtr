package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The expanded editor's undo stack, as RN's use-task-description-editor keeps it. */
class MarkdownDraftTest {
    @Test
    fun undoRestoresEachTextChangeWithItsSelectionAndStoresIt() {
        val stored = mutableListOf<String>()
        val draft = MarkdownDraft("pack")
        assertFalse(draft.canUndo)
        // A cursor move alone records nothing.
        draft.change(TextFieldValue("pack", TextRange(0)), stored::add)
        assertFalse(draft.canUndo)
        draft.change(TextFieldValue("pack the", TextRange(8)), stored::add)
        draft.change(TextFieldValue("**pack the**", TextRange(2, 10)), stored::add)
        assertEquals(listOf("pack the", "**pack the**"), stored)
        draft.undo(stored::add)
        assertEquals(TextFieldValue("pack the", TextRange(8)), draft.field)
        assertTrue(draft.canUndo)
        draft.undo(stored::add)
        assertEquals(TextFieldValue("pack", TextRange(0)), draft.field)
        assertFalse(draft.canUndo)
        assertEquals("pack", stored.last())
    }

    @Test
    fun keepsTheLastHundredChanges() {
        val draft = MarkdownDraft("")
        repeat(150) { draft.change(TextFieldValue("x".repeat(it + 1)), {}) }
        repeat(100) { draft.undo {} }
        assertEquals("x".repeat(50), draft.field.text)
        assertFalse(draft.canUndo)
    }

    @Test
    fun aStoredValueReadAgainKeepsTheCursorInsideTheText() {
        val draft = MarkdownDraft("pack the boxes")
        draft.change(TextFieldValue("pack the boxes", TextRange(9, 14)), {})
        draft.sync("pack")
        assertEquals(TextFieldValue("pack", TextRange(4)), draft.field)
    }
}
