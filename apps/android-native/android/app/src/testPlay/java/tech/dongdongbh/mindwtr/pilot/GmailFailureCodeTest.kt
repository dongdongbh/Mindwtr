package tech.dongdongbh.mindwtr.pilot

import org.json.JSONException
import tech.dongdongbh.mindwtr.gmailauthorization.GmailFailure
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeoutException


class GmailFailureCodeTest {
    @Test fun eachFailureLeavesAsItsFixedCode() {
        for (kind in listOf("AUTH", "NETWORK", "CONFIG", "CANCELLED", "STORAGE", "OTHER")) {
            assertEquals("E_GMAIL_$kind", gmailFailureCode(GmailFailure(kind)))
            assertEquals("E_GMAIL_$kind", gmailFailureCode(ExecutionException(GmailFailure(kind))))
        }
        assertEquals("E_GMAIL_NETWORK", gmailFailureCode(IOException("connect to gmail.googleapis.com failed")))
        assertEquals("E_GMAIL_NETWORK", gmailFailureCode(SocketTimeoutException("timeout")))
        assertEquals("E_GMAIL_NETWORK", gmailFailureCode(ExecutionException(TimeoutException())))
    }

    @Test fun aFailureCarryingMailTextLeavesAsOtherWithNoText() {
        assertEquals("E_GMAIL_OTHER", gmailFailureCode(JSONException("Unterminated string at 40 [character 41 line 1]: \"Subject: payslip")))
        assertEquals("E_GMAIL_OTHER", gmailFailureCode(IllegalStateException("token ya29.secret")))
        assertEquals("E_GMAIL_OTHER", gmailFailureCode(OutOfMemoryError()))
    }
}
