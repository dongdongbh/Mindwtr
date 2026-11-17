package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Test


class PairedCloserTest {
    private class Field(text: String) {
        val draft = MarkdownDraft(text)
        private val closer = PairedCloser()

        fun type(typed: TextFieldValue, coreRewrite: TextFieldValue? = null) {
            val before = draft.field
            draft.change(typed) {}
            closer.changed(before, typed)?.let { return draft.rewrite(it) {} }
            coreRewrite?.let { draft.rewrite(it) {}; closer.inserted(it, typed) }
        }
    }

    private fun value(text: String, caret: Int) = TextFieldValue(text, TextRange(caret))

    private fun backspaceTwiceAfterAutoPair(open: String, close: String) {
        val field = Field("x")
        field.type(value("x$open", 2), coreRewrite = value("x$open$close", 2))
        assertEquals(value("x$open$close", 2), field.draft.field)
        field.type(value("x$close", 1))
        assertEquals(value("x$open", 2), field.draft.field)
        field.type(value("x", 1))
        assertEquals(value("x", 1), field.draft.field)
    }

    @Test
    fun backspaceAfterAnAutoPairedBracketRemovesTheCloserThenTheOpener() = backspaceTwiceAfterAutoPair("[", "]")

    @Test
    fun backspaceAfterAnAutoPairedParenthesisRemovesTheCloserThenTheOpener() = backspaceTwiceAfterAutoPair("(", ")")

    @Test
    fun backspaceAfterAnAutoPairedBacktickRemovesTheCloserThenTheOpener() = backspaceTwiceAfterAutoPair("`", "`")

    @Test
    fun theKeyboardReplayingTheDeletedTextKeepsTheOpener() {
        val field = Field("x")
        field.type(value("x[", 2), coreRewrite = value("x[]", 2))
        field.type(value("x]", 1))
        field.type(value("x]", 1))
        assertEquals(value("x[", 2), field.draft.field)
        field.type(value("x", 1))
        assertEquals(value("x", 1), field.draft.field)
        field.type(value("x]", 1))
        assertEquals(value("x]", 1), field.draft.field)
    }

    @Test
    fun aCharacterTypedInsideThePairEndsTheRule() {
        val field = Field("x")
        field.type(value("x[", 2), coreRewrite = value("x[]", 2))
        field.type(value("x[a]", 3))
        field.type(value("x[]", 2))
        assertEquals(value("x[]", 2), field.draft.field)
        field.type(value("x]", 1))
        assertEquals(value("x]", 1), field.draft.field)
    }

    @Test
    fun aCaretMoveEndsTheRule() {
        val field = Field("x")
        field.type(value("x[", 2), coreRewrite = value("x[]", 2))
        field.type(value("x[]", 1))
        field.type(value("x[]", 2))
        field.type(value("x]", 1))
        assertEquals(value("x]", 1), field.draft.field)
    }

    @Test
    fun aRewriteThatAddsMoreThanOneCharacterIsNotAPair() {
        val field = Field("- a")
        field.type(value("- a\n", 4), coreRewrite = value("- a\n- ", 6))
        field.type(value("- a\n-", 5))
        assertEquals(value("- a\n-", 5), field.draft.field)
    }

    @Test
    fun undoAfterTheCloserBackspaceRestoresThePair() {
        val field = Field("x")
        field.type(value("x[", 2), coreRewrite = value("x[]", 2))
        field.type(value("x]", 1))
        field.draft.undo {}
        assertEquals(value("x[]", 2), field.draft.field)
    }
}
