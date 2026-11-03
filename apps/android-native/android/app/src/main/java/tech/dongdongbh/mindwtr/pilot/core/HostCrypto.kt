package tech.dongdongbh.mindwtr.pilot.core

import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.json.JSONObject
import java.util.Arrays
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec


object HostCrypto {

    private const val TAG_BYTES = 16


    class AuthFailure : Exception("wrong passphrase or corrupted data")


    fun argon2id(pass: ByteArray, salt: ByteArray, mKib: Int, t: Int, p: Int, dkLen: Int): ByteArray {

        require(p in 1..0xffffff && t >= 1 && mKib >= 8 * p && dkLen >= 4 && salt.size >= 8) { "invalid Argon2id parameters" }
        val parameters = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withSalt(salt)
            .withMemoryAsKB(mKib)
            .withIterations(t)
            .withParallelism(p)
            .build()
        val out = ByteArray(dkLen)
        Argon2BytesGenerator().apply { init(parameters) }.generateBytes(pass, out)
        return out
    }


    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray =
        gcm(Cipher.ENCRYPT_MODE, key, nonce, aad).doFinal(plaintext)


    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ctAndTag: ByteArray, aad: ByteArray): ByteArray {
        if (ctAndTag.size < TAG_BYTES) throw AuthFailure()
        val cipher = gcm(Cipher.DECRYPT_MODE, key, nonce, aad)
        return try {
            cipher.doFinal(ctAndTag)
        } catch (_: AEADBadTagException) {
            throw AuthFailure()
        }
    }

    private fun gcm(mode: Int, key: ByteArray, nonce: ByteArray, aad: ByteArray): Cipher {

        require(key.size == 32) { "AES-256-GCM needs a 32-byte key" }
        require(nonce.size == 12) { "AES-GCM needs a 12-byte nonce" }
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonce))
            updateAAD(aad)
        }
    }


    fun argon2Params(request: JSONObject): IntArray = intArrayOf(
        exact(request, "m", 1), exact(request, "t", 1), exact(request, "p", 1, 0xffffff), exact(request, "dkLen", 4),
    )

    private fun exact(request: JSONObject, name: String, min: Long, max: Long = Int.MAX_VALUE.toLong()): Int {
        val value = request.opt(name)
        require(value is Number) { "invalid Argon2id parameters" }
        val number = value.toDouble()
        require(number.isFinite() && number == Math.floor(number) && number >= min && number <= max) { "invalid Argon2id parameters" }
        return number.toInt()
    }


    fun <T> answer(closed: () -> Boolean, compute: () -> ByteArray, encode: (ByteArray) -> T): T? {
        if (closed()) return null
        val out = compute()
        try {
            return if (closed()) null else encode(out)
        } finally {
            wipe(out)
        }
    }


    fun wipe(vararg bytes: ByteArray?) = bytes.forEach { if (it != null) Arrays.fill(it, 0) }
}
