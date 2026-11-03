package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject
import org.json.JSONArray

class UpNoteLinkTest {
    private val original = "upnote://x-callback-url/openNote?noteId=Note%2FCase%2520&new_window=true"

    @Test fun recoveryTextSurvivesActualLabelLoadAndLanguageReload() {
        val keys = listOf("common.error", "markdown.openLinkFailed", "markdown.copyLink", "markdown.copyLinkFailed")
        for (language in listOf("fr", "de")) {
            val translated = keys.associateWith { "$language:$it translated" }

            val response = JSONObject().put("language", language).put("missing", JSONArray())
                .put("strings", JSONObject(translated.filterKeys { LABEL_KEYS.contains(it) }))
            Labels.load(response, reportLoaded = {})
            for (key in keys) {

                val displayed = runCatching { t(key) }.getOrElse { key }
                assertEquals(translated.getValue(key), displayed)
            }
        }
    }

    @Test fun preservesOriginalForAcceptedHandoff() {
        val opened = mutableListOf<String>()
        val failed = mutableListOf<String>()
        assertEquals(true, attemptUpNoteLink(original, { opened.add(it) }, { failed.add(it) }))
        assertEquals(listOf(original), opened)
        assertTrue(failed.isEmpty())
    }
    @Test fun absentAppOffersExactOriginalForCopyWithoutRetrying() {
        val failed = mutableListOf<String>()
        var calls = 0
        assertEquals(false, attemptUpNoteLink(original, { calls++; throw IllegalStateException("private error") }, { failed.add(it) }))
        assertEquals(1, calls)
        assertEquals(listOf(original), failed)
    }
    @Test fun leavesOrdinaryAndBlockedSchemesToTheirExistingPolicy() {
        for (href in listOf("https://example.org", "mailto:a@example.org", "tel:123", "javascript:alert(1)", "file:///secret", "data:text/plain,x", "obsidian://vault", "upnote:opaque")) {
            assertNull(attemptUpNoteLink(href, { fail("Must not open") }, { fail("Must not offer recovery") }))
        }
    }


    @Test fun anyExternalLinkThatNothingOpensOffersItsExactTextForCopy() {
        for (href in listOf("https://example.org/a?b=1#c", "mailto:a@example.org", "obsidian://open?vault=Notes&file=A%20B", original)) {
            val failed = mutableListOf<String>()
            var calls = 0
            assertFalse(href, attemptExternalLink(href, { calls++; throw android.content.ActivityNotFoundException() }, { failed.add(it) }))
            assertEquals(href, 1, calls)
            assertEquals(href, listOf(href), failed)
            val opened = mutableListOf<String>()
            assertTrue(href, attemptExternalLink(href, { opened.add(it) }, { fail("Must not offer recovery") }))
            assertEquals(listOf(href), opened)
        }
    }


    @Test fun aFailedOpenReportsItsFailureBeforeOfferingCopy() {
        val events = mutableListOf<String>()
        val missing = android.content.ActivityNotFoundException()
        assertFalse(attemptExternalLink("https://example.org", { throw missing }, { events.add("copy $it") }) { events.add("log ${it === missing}") })
        assertEquals(listOf("log true", "copy https://example.org"), events)
    }
}
