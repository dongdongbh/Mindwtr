package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test


class DestinationMatchesTest {
    @Test fun theEditorDestinationSearchMatchesAsRnsPickerDoes() {
        assertTrue(destinationMatches("", "Kitchen renovation"))
        assertTrue(destinationMatches("  KITCHEN ", "Kitchen renovation"))
        assertTrue(destinationMatches("trip", " Plan summer trip "))
        assertFalse(destinationMatches("garden", "Kitchen renovation"))
    }
}
