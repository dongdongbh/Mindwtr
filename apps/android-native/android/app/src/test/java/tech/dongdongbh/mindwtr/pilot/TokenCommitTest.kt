package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class TokenCommitTest {
    private fun shown(text: String, draftValue: String) = EditorSuggestions(text, draftValue, emptyList(), emptyList())

    @Test fun leavingTheFieldShowsCoresTokenList() {
        assertEquals("@home, @work", committedTokens("home work", shown("home work", "@home, @work")))

        assertNull(committedTokens("@home", shown("@home", "@home")))
        assertNull(committedTokens("home work", shown("home", "@home")))
        assertNull(committedTokens("home", null))
    }
}
