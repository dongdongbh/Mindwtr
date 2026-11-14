package tech.dongdongbh.mindwtr.pilot.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.URI
import java.net.URLDecoder
import java.util.Base64


class DropboxAuthorizationTest {
    private val encode: (ByteArray) -> String = { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }

    private fun query(url: String) = URI(url).rawQuery.split('&').associate {
        it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }

    @Test fun theChallengeIsTheRfc7636S256OfTheVerifier() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", DropboxAuthorization.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", encode))
    }

    @Test fun theAuthorizeUrlAsksForRnsScopesOfflineAccessAndAPkceCodeOnTheRedirect() {
        val url = DropboxAuthorization.authorizeUrl("appkey1", "mindwtr://redirect", "challenge-1", "state-1")
        assertTrue(url.startsWith("https://www.dropbox.com/oauth2/authorize?"))
        assertEquals(mapOf("response_type" to "code", "client_id" to "appkey1", "redirect_uri" to "mindwtr://redirect",
            "scope" to "files.content.read files.content.write files.metadata.read", "code_challenge_method" to "S256",
            "code_challenge" to "challenge-1", "state" to "state-1", "token_access_type" to "offline"), query(url))
        assertFalse(url.contains('+'))
    }

    @Test fun aDebugOriginReroutesEveryDropboxHostAndNothingElse() {
        val origin = "http://127.0.0.1:18790"
        assertTrue(DropboxAuthorization.authorizeUrl("k", "mindwtr-native-dev://redirect", "c", "s", origin).startsWith("$origin/oauth2/authorize?"))
        assertEquals("$origin/oauth2/token", DropboxAuthorization.route("https://api.dropboxapi.com/oauth2/token", origin))
        assertEquals("$origin/2/files/upload", DropboxAuthorization.route("https://content.dropboxapi.com/2/files/upload", origin))
        assertEquals("https://example.com/dav", DropboxAuthorization.route("https://example.com/dav", origin))
        assertEquals("https://api.dropboxapi.com.evil.test/x", DropboxAuthorization.route("https://api.dropboxapi.com.evil.test/x", origin))
        assertEquals("https://api.dropboxapi.com/oauth2/token", DropboxAuthorization.route("https://api.dropboxapi.com/oauth2/token", ""))
    }

    @Test fun theRedirectAnswersItsCodeOnlyForTheSameStateAndRoute() {
        val redirect = "mindwtr://redirect"
        assertEquals("abc DEF", DropboxAuthorization.redirectCode("$redirect?code=abc%20DEF&state=s1", redirect, "s1"))
        assertEquals("c", DropboxAuthorization.redirectCode("$redirect/?state=s1&code=c#frag", redirect, "s1"))
        for (url in listOf("$redirect?code=c&state=other", "$redirect?code=c", "$redirect?state=s1", "$redirect?error=access_denied&state=s1",
            "$redirect?code=c&state=s1&error=x", "mindwtr://capture?code=c&state=s1", "mindwtr://redirectx?code=c&state=s1")) {
            assertThrows(url, IOException::class.java) { DropboxAuthorization.redirectCode(url, redirect, "s1") }
        }
        assertTrue(DropboxAuthorization.isRedirect("$redirect?x=1", redirect))
        assertFalse(DropboxAuthorization.isRedirect("mindwtr-native-dev://redirect?code=c", redirect))
    }

    @Test fun aReplayedOlderRedirectNeverAnswersTheNewSignIn() {
        val redirect = "mindwtr://redirect"
        assertTrue(DropboxAuthorization.answers("$redirect?error=access_denied&state=s1", redirect, "s1"))
        assertFalse(DropboxAuthorization.answers("$redirect?code=old&state=s0", redirect, "s1"))
        assertFalse(DropboxAuthorization.answers("$redirect?code=old", redirect, "s1"))
        assertFalse(DropboxAuthorization.answers("mindwtr://capture?state=s1", redirect, "s1"))
    }

    @Test fun aMalformedEscapeIsNotAnsweredAndNeverThrows() {
        val redirect = "mindwtr://redirect"
        for (url in listOf("$redirect?state=%zz", "$redirect?code=c&state=s1%", "$redirect?%zz=1&state=s1")) {
            assertFalse(url, DropboxAuthorization.answers(url, redirect, "s1"))
            assertThrows(url, IOException::class.java) { DropboxAuthorization.redirectCode(url, redirect, "s1") }
        }
        val signIn = DropboxSignIn("k", redirect)
        val replies = mutableListOf<Result<Any?>>()
        signIn.start("r1", "v".repeat(43), "s1") { replies += it }
        assertFalse(signIn.redirected("$redirect?state=%zz"))
        assertTrue(replies.isEmpty())
        assertTrue(signIn.redirected("$redirect?code=c1&state=s1"))
        assertEquals(1, replies.size)
    }

    private fun signIn(): Pair<DropboxSignIn, MutableList<Result<Any?>>> = DropboxSignIn("appkey1", "mindwtr://redirect") to mutableListOf()

    @Test fun theMatchingRedirectAnswersTheGrantOnce() {
        val (signIn, replies) = signIn()
        signIn.start("r1", "v".repeat(43), "s1") { replies += it }
        assertTrue(signIn.redirected("mindwtr://redirect?code=c1&state=s1"))
        assertFalse(signIn.redirected("mindwtr://redirect?code=c1&state=s1"))
        val grant = replies.single().getOrThrow() as org.json.JSONObject
        assertEquals(listOf("r1", "appkey1", "mindwtr://redirect", "c1", "v".repeat(43)),
            listOf("requestId", "clientId", "redirectUri", "code", "codeVerifier").map(grant::getString))
    }

    @Test fun returningWithoutARedirectCancelsOnlyAfterTheAppLeft() {
        val (signIn, replies) = signIn()
        signIn.start("r1", "v".repeat(43), "s1") { replies += it }
        signIn.resumed()
        assertTrue(replies.isEmpty())
        signIn.left()
        signIn.resumed()
        assertTrue(replies.single().isFailure)
        assertFalse(signIn.redirected("mindwtr://redirect?code=c1&state=s1"))
    }

    @Test fun aNewConnectCancelsTheOldOneAndAFailedOpenEndsOnlyItsOwn() {
        val (signIn, replies) = signIn()
        val first = signIn.start("r1", "v".repeat(43), "s1") { replies += it }
        signIn.start("r2", "w".repeat(43), "s2") { replies += it }
        assertTrue(replies.single().isFailure)
        signIn.finish(first, Result.failure(IOException("no browser")))
        assertEquals(1, replies.size)
        assertTrue(signIn.redirected("mindwtr://redirect?code=c2&state=s2"))
        assertEquals("r2", (replies.last().getOrThrow() as org.json.JSONObject).getString("requestId"))
    }

    @Test fun anErrorRedirectAnswersAFailure() {
        val (signIn, replies) = signIn()
        signIn.start("r1", "v".repeat(43), "s1") { replies += it }
        assertTrue(signIn.redirected("mindwtr://redirect?error=access_denied&state=s1"))
        assertTrue(replies.single().isFailure)
    }
}
