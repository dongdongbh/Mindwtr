package tech.dongdongbh.mindwtr.pilot.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.text.Normalizer
import java.util.Base64


class HostCryptoTest {

    private val fixtures = File("../../../../packages/core/src/__fixtures__/sync-crypto")
    private val primitives by lazy { JSONObject(File(fixtures, "primitive-vectors.json").readText()) }
    private val containers by lazy { JSONArray(File(fixtures, "vectors.json").readText()) }

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun b64(text: String): ByteArray = Base64.getDecoder().decode(text)
    private fun JSONArray.objects() = List(length()) { getJSONObject(it) }

    @Test fun argon2idMatchesCoreAndOpenSsl() {
        val cases = primitives.getJSONArray("argon2id").objects()
        assertEquals(8, cases.size)
        for (case in cases) {
            val key = HostCrypto.argon2id(hex(case.getString("passHex")), hex(case.getString("saltHex")), case.getInt("mKib"), case.getInt("t"),
                case.getInt("p"), case.getInt("dkLen"))
            assertArrayEquals(case.getString("passphrase"), hex(case.getString("keyHex")), key)
        }
    }

    @Test fun aesGcmSealsAndOpensAsCoreAndOpenSsl() {
        for (case in primitives.getJSONArray("aesGcm").objects()) {
            val key = hex(case.getString("keyHex"))
            val nonce = hex(case.getString("nonceHex"))
            val aad = hex(case.getString("aadHex"))
            val plaintext = hex(case.getString("plaintextHex"))
            val sealed = hex(case.getString("sealedHex"))
            assertArrayEquals(sealed, HostCrypto.aesGcmSeal(key, nonce, plaintext, aad))
            assertArrayEquals(plaintext, HostCrypto.aesGcmOpen(key, nonce, sealed, aad))
        }
    }

    @Test fun aChangedByteTagOrAadIsAnAuthFailure() {
        val case = primitives.getJSONArray("aesGcm").getJSONObject(5)
        val key = hex(case.getString("keyHex"))
        val nonce = hex(case.getString("nonceHex"))
        val aad = hex(case.getString("aadHex"))
        val sealed = hex(case.getString("sealedHex"))
        for (at in listOf(0, sealed.size / 2, sealed.size - 1)) {
            val changed = sealed.copyOf().also { it[at] = (it[at].toInt() xor 1).toByte() }
            assertThrows(HostCrypto.AuthFailure::class.java) { HostCrypto.aesGcmOpen(key, nonce, changed, aad) }
        }
        val otherAad = aad.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        assertThrows(HostCrypto.AuthFailure::class.java) { HostCrypto.aesGcmOpen(key, nonce, sealed, otherAad) }
        val otherKey = key.copyOf().also { it[31] = (it[31].toInt() xor 1).toByte() }
        assertThrows(HostCrypto.AuthFailure::class.java) { HostCrypto.aesGcmOpen(otherKey, nonce, sealed, aad) }

        assertThrows(HostCrypto.AuthFailure::class.java) { HostCrypto.aesGcmOpen(key, nonce, ByteArray(15), aad) }
        assertThrows(HostCrypto.AuthFailure::class.java) { HostCrypto.aesGcmOpen(key, nonce, ByteArray(0), aad) }
    }

    @Test fun everyMwenc1ContainerIsReproducedAndOpened() {
        val cases = containers.objects()
        assertEquals(5, cases.size)
        for (case in cases) {
            val encrypted = b64(case.getString("encryptedB64"))
            val header = encrypted.copyOfRange(0, 54)
            val aad = header + "mindwtr-sync:2\u0000document\u0000data.json".toByteArray(Charsets.UTF_8)
            val params = case.getJSONObject("params")

            val pass = Normalizer.normalize(case.getString("passphrase"), Normalizer.Form.NFC).toByteArray(Charsets.UTF_8)
            val key = HostCrypto.argon2id(pass, b64(case.getString("saltB64")), params.getInt("mKib"), params.getInt("t"), params.getInt("p"), 32)
            val plaintext = b64(case.getString("plaintextB64"))
            val body = HostCrypto.aesGcmSeal(key, header.copyOfRange(34, 46), plaintext, aad)
            assertArrayEquals(case.getString("name"), encrypted.copyOfRange(54, encrypted.size), body)
            assertArrayEquals(case.getString("name"), plaintext, HostCrypto.aesGcmOpen(key, header.copyOfRange(34, 46), body, aad))
        }
    }

    @Test fun sha256MatchesCore() {
        val files = HostFiles(File("build/tmp/host-crypto-files"), File("build/tmp/host-crypto-cache"), syncDirectory = {})
        for (case in primitives.getJSONArray("sha256").objects()) {
            assertEquals(case.getString("digestHex"), files.call("""{"op":"sha256"}""", hex(case.getString("inputHex"))).value)
        }
    }

    @Test fun parametersArgon2ForbidsAreRefusedAsCoreRefusesThem() {
        val salt = ByteArray(16)

        for ((m, t, p, dkLen) in listOf(listOf(15, 1, 2, 32), listOf(64, 0, 1, 32), listOf(64, 1, 0, 32), listOf(64, 1, 1, 3))) {
            assertThrows(IllegalArgumentException::class.java) { HostCrypto.argon2id(ByteArray(1), salt, m, t, p, dkLen) }
        }
        assertThrows(IllegalArgumentException::class.java) { HostCrypto.argon2id(ByteArray(1), ByteArray(7), 64, 1, 1, 32) }
    }

    @Test fun argon2ParametersAreExactIntegersOrRefused() {
        val params = { json: String -> HostCrypto.argon2Params(JSONObject(json)) }
        assertArrayEquals(intArrayOf(19456, 2, 1, 32), params("""{"m":19456,"t":2,"p":1,"dkLen":32}"""))

        assertArrayEquals(intArrayOf(64, 1, 1, 32), params("""{"m":64.0,"t":1,"p":1,"dkLen":32}"""))
        for (bad in listOf("""{"m":64.9,"t":1,"p":1,"dkLen":32}""", """{"m":64,"t":1.9,"p":1,"dkLen":32}""",
            """{"m":64,"t":1,"p":1.9,"dkLen":32}""", """{"m":64,"t":1,"p":1,"dkLen":32.9}""",
            """{"m":4294967360,"t":1,"p":1,"dkLen":32}""", """{"m":64,"t":4294967297,"p":1,"dkLen":32}""",
            """{"m":"64","t":1,"p":1,"dkLen":32}""", """{"m":64,"t":1,"p":1}""", """{"m":-64,"t":1,"p":1,"dkLen":32}""",
            """{"m":64,"t":1,"p":16777216,"dkLen":32}""")) {
            assertThrows(bad, IllegalArgumentException::class.java) { params(bad) }
        }
    }

    @Test fun aResultTheStoppedHostWillNeverReadIsDroppedAndEveryResultIsWiped() {
        var computed: ByteArray? = null
        val compute = { byteArrayOf(1, 2, 3).also { computed = it } }
        val encode = { bytes: ByteArray -> bytes.joinToString(",") }
        assertEquals("1,2,3", HostCrypto.answer({ false }, compute, encode))
        assertArrayEquals(byteArrayOf(0, 0, 0), computed)

        var closed = false
        assertEquals(null, HostCrypto.answer({ closed }, { compute().also { closed = true } }, encode))
        assertArrayEquals(byteArrayOf(0, 0, 0), computed)

        computed = null
        assertEquals(null, HostCrypto.answer({ true }, compute, encode))
        assertEquals(null, computed)
    }

    @Test fun aKeyOrNonceOfAnotherSizeIsRefused() {
        assertThrows(IllegalArgumentException::class.java) { HostCrypto.aesGcmSeal(ByteArray(16), ByteArray(12), ByteArray(1), ByteArray(0)) }
        assertThrows(IllegalArgumentException::class.java) { HostCrypto.aesGcmSeal(ByteArray(32), ByteArray(16), ByteArray(1), ByteArray(0)) }
    }
}
