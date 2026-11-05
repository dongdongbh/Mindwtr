package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test


class AttachmentLogTest {
    @Test fun aLaunchFailureLogsNoPartOfTheLinkOrTheExceptionText() {
        val link = "missing-app://alice:secret@example.test/document?token=secret"

        val failure = android.content.ActivityNotFoundException("No Activity found to handle Intent { act=android.intent.action.VIEW dat=$link }")
        val line = attachmentLaunchLog("link", link, failure)
        for (secret in listOf("alice", "secret", "example.test", "token", "document")) assertFalse(line, line.contains(secret))
        assertEquals("Attachment link not opened uri=missing-app:external error=ActivityNotFoundException", line)
    }

    @Test fun aManagedFileIsNamedByItsSchemePlaceAndExtension() {
        assertEquals("file:managed.pdf", attachmentUriForLog("file:///data/user/0/x/files/attachments/abc.pdf"))
        assertEquals("content:external", attachmentUriForLog("content://com.android.providers.downloads.documents/document/42"))
        assertEquals("https:external", attachmentUriForLog("https://u:p@example.com/a?b=c"))
        assertEquals("none", attachmentUriForLog(null))
    }

    @Test fun aFailureCodeIsCoresCodeOrNothing() {
        assertEquals("STALE_REVISION", attachmentCodeForLog("STALE_REVISION: Task changed"))
        assertEquals("other", attachmentCodeForLog("could not open https://alice:secret@example.test/a"))
        assertEquals("other", attachmentCodeForLog(null))
    }

    @Test fun aFailureLogsItsClassAndCoresCodeNeverItsText() {
        val failure = IllegalStateException("SAVE_FAILED: could not read content://alice:secret@provider.test/document?token=secret")
        val line = failureForLog(failure)
        assertEquals("error=IllegalStateException code=SAVE_FAILED", line)
        val plain = failureForLog(java.io.IOException("Network request failed: https://alice:secret@dav.test/data.json"))
        for (secret in listOf("alice", "secret", "dav.test", "https", "token")) assertFalse(plain, plain.contains(secret))
    }
}
