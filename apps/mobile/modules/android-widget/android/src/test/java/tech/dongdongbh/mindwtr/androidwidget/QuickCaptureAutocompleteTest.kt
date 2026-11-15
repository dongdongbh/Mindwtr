package tech.dongdongbh.mindwtr.androidwidget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QuickCaptureAutocompleteTest {
  @Test fun replacesTheWholeTokenWhenTheCaretIsInItsMiddle() {
    val text = "Call @persn before lunch"
    val token = QuickCaptureAutocomplete.tokenAt(text, 9)!!
    assertEquals("per", token.query)
    assertEquals("Call @person/Todd before lunch" to "Call @person/Todd ".length,
      QuickCaptureAutocomplete.replace(text, token, QuickCaptureAutocomplete.Choice("@person/Todd", "@person/Todd")))
  }

  @Test fun quotedNamesCanBeEditedInTheMiddleAndKeepSurroundingText() {
    val text = "Read +\"週末 planning\" tonight"
    val token = QuickCaptureAutocomplete.tokenAt(text, 11)!!
    assertEquals('+', token.prefix)
    assertEquals("週末 p", token.query)
    val result = QuickCaptureAutocomplete.replace(text, token,
      QuickCaptureAutocomplete.Choice("週末 plan", "+\"週末 plan\"", "project-a"))
    assertEquals("Read tonight", result.first)
    assertEquals("Read ".length, result.second)
  }

  @Test fun doesNotTreatEmailOrEscapedMarkersAsTokens() {
    assertNull(QuickCaptureAutocomplete.tokenAt("mail@example.com", 8))
    assertNull(QuickCaptureAutocomplete.tokenAt("Use \\@home", 10))
    assertNull(QuickCaptureAutocomplete.tokenAt("Plain title", 5))
    assertNull(QuickCaptureAutocomplete.tokenAt("@home ", 6))
  }

  @Test fun ranksExistingNamesAndAcceptsEmptyPrefixQuery() {
    val choices = listOf("#coffee", "#office", "#off").map { QuickCaptureAutocomplete.Choice(it, it) }
    val token = QuickCaptureAutocomplete.tokenAt("#off", 4)!!
    assertEquals(listOf("#off", "#office", "#coffee"), QuickCaptureAutocomplete.matches(token, choices).map { it.label })
    assertEquals(choices, QuickCaptureAutocomplete.matches(QuickCaptureAutocomplete.tokenAt("#", 1)!!, choices))
  }
}
