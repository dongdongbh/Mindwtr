package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test


class SettingsDeepLinkTest {
    @Test
    fun aSettingsLinkNamesTheSubpageRnOpens() {
        assertEquals(SettingsLink("sync", false), settingsLinkOf("mindwtr:///settings?settingsScreen=sync"))
        assertEquals(SettingsLink("gtd-review", false), settingsLinkOf("mindwtr://settings?settingsScreen=gtd-review&x=1"))
        assertEquals(SettingsLink("about", false), settingsLinkOf("mindwtr:///settings?onboardingHandoff=0&settingsScreen=about"))
    }

    @Test
    fun onboardingHandoffOnTheLinkIsKeptAsRnReadsIt() {
        assertEquals(SettingsLink("data", true), settingsLinkOf("mindwtr:///settings?settingsScreen=data&onboardingHandoff=1"))
    }

    @Test
    fun timeEstimatesOpensTheGtdPageAsRnDoes() {
        assertEquals("gtd", settingsLinkOf("mindwtr:///settings?settingsScreen=gtd-time-estimates")?.screen)
    }

    @Test
    fun anUnknownOrMissingSubpageOpensSettingsItself() {
        assertNull(settingsLinkOf("mindwtr:///settings"))
        assertNull(settingsLinkOf("mindwtr:///settings?settingsScreen=main"))
        assertNull(settingsLinkOf("mindwtr:///settings?settingsScreen=nope"))
        assertNull(settingsLinkOf("mindwtr:///settings?settingsScreen="))
        assertNull(settingsLinkOf("mindwtr:///settings?onboardingHandoff=1"))
        assertNull(settingsLinkOf(null))
        assertNull(settingsLinkOf("not a uri %%"))
    }
}
