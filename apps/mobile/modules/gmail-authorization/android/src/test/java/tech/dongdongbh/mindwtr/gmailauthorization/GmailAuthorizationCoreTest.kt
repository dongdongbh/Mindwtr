package tech.dongdongbh.mindwtr.gmailauthorization

import java.io.ByteArrayInputStream
import org.junit.Assert.*
import org.junit.Test

class GmailAuthorizationCoreTest {
  private fun expectFailure(kind: String, action: () -> Unit) {
    try { action(); fail("Expected fixed Gmail failure") }
    catch (failure: GmailFailure) { assertEquals(kind, failure.kind) }
  }
  private val identity = GmailIdentity("Designated@Example.Test", "designated@example.test",
    "3060599fb9a895dcfbbbff284ab2a08c740c5631edd78a83cc5402ebbca4b53c")

  @Test fun profileIdentityMatchesDesktopCanonicalHash() {
    assertEquals(identity.account, gmailAccount("  Designated@Example.Test  "))
    assertEquals(identity.accountId, gmailAccountId("  Designated@Example.Test  "))
    for (invalid in listOf("", "a@", "@b", "a @b", "a@b@c", "a@b\nprivate")) {
      expectFailure("OTHER") { gmailAccount(invalid) }
    }
  }

  @Test fun onlyFixedReadonlyPathsAndBoundedLabelQueriesAreAccepted() {
    for (path in listOf("profile", "labels", "labels/Label_1", "messages?labelIds=Label_1&maxResults=25",
      "messages?maxResults=1&labelIds=INBOX&pageToken=opaque%2B%2F%3D", "messages/abc123?format=full")) {
      assertEquals(path, gmailRequestPath(path))
    }
    for (path in listOf("https://evil.test/profile", "//evil.test/profile", "/profile", "profile#token",
      "messages", "messages?maxResults=25", "messages?labelIds=Label_1&maxResults=26",
      "messages?labelIds=Label_1&maxResults=0", "messages?labelIds=Label_1&maxResults=25&labelIds=OTHER",
      "messages?labelIds=Label_1&maxResults=25&q=private", "messages/abc?format=raw", "messages/abc",
      "messages/abc/attachments/private", "labels/../profile", "labels/%2e%2e", "profile?access_token=private",
      "profile\\evil", "messages?labelIds=Label_1&maxResults=25&pageToken=%0D%0A", "messages?labelIds=Label_1&maxResults=25&pageToken=${"a".repeat(4097)}")) {
      expectFailure("CONFIG") { gmailRequestPath(path) }
    }
  }

  @Test fun responseBoundDoesNotDependOnContentLengthAndChecksCancellationDuringReceipt() {
    val oversized = ByteArray(GMAIL_RESPONSE_LIMIT + 1)
    expectFailure("OTHER") { readGmailBody(ByteArrayInputStream(oversized), oversized.size.toLong()) }
    expectFailure("OTHER") { readGmailBody(ByteArrayInputStream(oversized)) }
    assertArrayEquals(byteArrayOf(1, 2), readGmailBody(ByteArrayInputStream(byteArrayOf(1, 2))))
    var reads = 0
    expectFailure("CANCELLED") {
      readGmailBody(ByteArrayInputStream(ByteArray(24_000))) {
        reads += 1
        if (reads > 1) throw GmailFailure("CANCELLED")
      }
    }
    assertEquals(2, reads)
  }

  @Test fun jsonDepthBoundIgnoresQuotedMimeData() {
    validateGmailJsonDepth("{\"data\":\"[[[[{{\\\"still quoted\\\"}}]]]]\"}")
    validateGmailJsonDepth("[".repeat(64) + "]".repeat(64))
    expectFailure("OTHER") { validateGmailJsonDepth("[".repeat(65) + "]".repeat(65)) }
    expectFailure("OTHER") { validateGmailJsonDepth("{\"data\":\"unterminated}") }
  }

  @Test fun lateConsentAndTokenCannotRestoreAccountAfterCancelDisconnectOrNewConnect() {
    for (invalidate in listOf("cancel", "disconnect", "connect")) {
      val session = GmailSession()
      session.initialize { identity }
      val old = session.snapshot()
      when (invalidate) {
        "cancel" -> session.invalidate()
        "disconnect" -> session.beginDisconnect {}
        else -> session.beginConnect {}
      }
      var persisted = false
      expectFailure("CANCELLED") { session.install(old.generation, identity, "late-token") { persisted = true } }
      expectFailure("CANCELLED") { session.acceptToken(old.generation, identity, "late-token") }
      assertFalse(persisted)
      assertNull(session.snapshot().token)
    }
  }

  @Test fun disconnectStopsFirstAndRevocationGuardSurvivesSecondDisconnectAndCancel() {
    val session = GmailSession()
    session.initialize { identity }
    val first = session.beginDisconnect { assertNull(session.snapshot().identity) }
    assertEquals(identity, first.identity)
    session.invalidate()
    session.beginDisconnect {}
    expectFailure("NETWORK") { session.beginConnect {} }
    session.finishRevocation()
    session.beginConnect {}
    assertNull(session.snapshot().identity)
  }

  @Test fun failedAccountPersistenceCannotConnectOrRetainOldAccount() {
    val session = GmailSession()
    session.initialize { identity }
    expectFailure("STORAGE") { session.beginConnect { throw GmailFailure("STORAGE") } }
    assertNull(session.snapshot().identity)
    val next = session.snapshot()
    expectFailure("STORAGE") { session.install(next.generation, identity, "new-token") { throw GmailFailure("STORAGE") } }
    assertNull(session.snapshot().identity)
    assertNull(session.snapshot().token)
  }

  @Test fun mismatchedAccountCannotAdmitCachedToken() {
    val session = GmailSession()
    session.initialize { identity }
    val other = identity.copy(account = "different@example.test", accountId = gmailAccountId("different@example.test"))
    expectFailure("CANCELLED") { session.acceptToken(session.snapshot().generation, other, "token") }
    assertNull(session.snapshot().token)
  }

  @Test fun unconnectedRequestCannotInvalidatePendingConsent() {
    val session = GmailSession()
    session.initialize { identity }
    val consent = session.beginConnect {}
    expectFailure("AUTH") { session.requestSnapshot() }
    assertEquals(consent.generation, session.snapshot().generation)
    session.install(consent.generation, identity, "selected-token") {}
    assertEquals(identity, session.requestSnapshot().identity)
  }
}
