package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** RN's commitContextDraft and commitTagDraft (Done or leaving the field): the field shows core's tidy token list. */
class TokenCommitTest {
    private fun shown(text: String, draftValue: String) = EditorSuggestions(text, draftValue, emptyList(), emptyList())

    @Test fun leavingTheFieldShowsCoresTokenList() {
        assertEquals("@home, @work", committedTokens("home work", shown("home work", "@home, @work")))
        // Already tidy, or core's answer is for older text (it arrives later): the text stays as typed.
        assertNull(committedTokens("@home", shown("@home", "@home")))
        assertNull(committedTokens("home work", shown("home", "@home")))
        assertNull(committedTokens("home", null))
    }
}
