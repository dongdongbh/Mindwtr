package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class MarkdownAssistTest {
    @Test
    fun aTypingHelpRewriteStoresTheTextAndUndoSkipsTheRawKeystroke() {
        val stored = mutableListOf<String>()
        val draft = MarkdownDraft("- milk")
        draft.change(TextFieldValue("- milk\n", TextRange(7)), stored::add)
        draft.rewrite(TextFieldValue("- milk\n- ", TextRange(9)), stored::add)
        assertEquals(TextFieldValue("- milk\n- ", TextRange(9)), draft.field)
        assertEquals(listOf("- milk\n", "- milk\n- "), stored)
        draft.undo(stored::add)
        assertEquals("- milk", draft.field.text)
        assertFalse(draft.canUndo)
    }

    @Test
    fun aReferenceReplacesTheOpenQueryAndPutsTheCaretAfterIt() {
        val shown = MarkdownReferences("see [[pa and more", TextRange(8), 4, 8, emptyList())
        val chosen = shown.insert(MarkdownReference("task:pack", "Pack", "Task • Next", "[[task:pack|Pack]]"))
        assertEquals(TextFieldValue("see [[task:pack|Pack]] and more", TextRange(22)), chosen)
    }

    @Test
    fun aReferenceConsumesThePairedClosingBracketsAndKeepsALoneOne() {
        val token = MarkdownReference("task:pack", "Pack", "Task • Next", "[[task:pack|Pack]]")
        assertEquals(TextFieldValue("see [[task:pack|Pack]] ok", TextRange(22)),
            MarkdownReferences("see [[pa]] ok", TextRange(8), 4, 8, emptyList()).insert(token))
        assertEquals(TextFieldValue("see [[task:pack|Pack]]] ok", TextRange(22)),
            MarkdownReferences("see [[pa] ok", TextRange(8), 4, 8, emptyList()).insert(token))
    }

    @Test
    fun anEditMatchesOnlyTheSameTextAndCaret() {
        assertTrue(TextFieldValue("a[", TextRange(2)).sameEdit(TextFieldValue("a[", TextRange(2), TextRange(0, 2))))
        assertFalse(TextFieldValue("a[", TextRange(2)).sameEdit(TextFieldValue("a[", TextRange(1))))
        assertFalse(TextFieldValue("a[", TextRange(2)).sameEdit(TextFieldValue("a[x", TextRange(2))))
    }

    @Test
    fun aRewriteFinishingAfterAProjectSwitchNeverReachesTheNewProjectsNotes() {
        var notesDraft: String? = null
        val gate = AssistGate()
        val typed = TextFieldValue("- milk\n", TextRange(7))
        val stillShown = typed
        assertTrue(gate.lands(stillShown, typed))
        gate.close()
        notesDraft = "Project B notes"
        if (gate.lands(stillShown, typed)) notesDraft = "- milk\n- "
        assertEquals("Project B notes", notesDraft)
        assertFalse(AssistGate().lands(TextFieldValue("- milk\nx", TextRange(8)), typed))
    }

    @Test
    fun theSuggestionCardNeverCoversTheTypedLine() {
        assertEquals(ReferenceCard(below = true, maxHeight = 960), referenceCard(400, 450, visibleTop = 100, visibleBottom = 1500, gap = 24, wanted = 960))
        assertEquals(ReferenceCard(below = false, maxHeight = 960), referenceCard(1300, 1350, visibleTop = 100, visibleBottom = 1500, gap = 24, wanted = 960))
        assertEquals(ReferenceCard(below = true, maxHeight = 240), referenceCard(1000, 1050, visibleTop = 100, visibleBottom = 1400, gap = 24, wanted = 240))
        val tight = referenceCard(700, 750, visibleTop = 100, visibleBottom = 1100, gap = 24, wanted = 960)
        assertEquals(ReferenceCard(below = false, maxHeight = 576), tight)
        assertTrue(700 - 24 - tight.maxHeight >= 100)
        val squeezed = referenceCard(200, 250, visibleTop = 100, visibleBottom = 300, gap = 24, wanted = 960)
        assertEquals(ReferenceCard(below = false, maxHeight = 76), squeezed)
        val lowLine = referenceCard(250, 300, visibleTop = 100, visibleBottom = 900, gap = 24, wanted = 960)
        assertEquals(ReferenceCard(below = true, maxHeight = 576), lowLine)
        assertTrue(900 - lowLine.maxHeight >= 300 + 24)
    }

    @Test
    fun aScrolledFieldWidensTheTypedLineToEveryRowTheCaretCanBeOn() {
        assertEquals(300f to 350f, typedLine(300f, 350f, textHeight = 600, boxHeight = 800))
        assertEquals(500f to 800f, typedLine(1100f, 1150f, textHeight = 1400, boxHeight = 800))
        assertEquals(0f to 350f, typedLine(300f, 350f, textHeight = 1400, boxHeight = 800))
    }

    @Test
    fun theEditorPagesFollowItsTabs() {
        assertEquals(0, editorPage("task"))
        assertEquals(1, editorPage("view"))
        assertEquals("task", editorPageTab(0))
        assertEquals("view", editorPageTab(1))
    }
}
