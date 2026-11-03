package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.BadPaddingException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec


internal class SecretStore(context: Context) {
    companion object {
        private const val SERVICE = "key_v1"
        private const val CIPHER = "AES/GCM/NoPadding"
        private const val ALIAS = "$CIPHER:$SERVICE:keystoreUnauthenticated"
        private const val LEGACY_ALIAS = "$CIPHER:$SERVICE"
        private val KEY = Regex("^[\\w.-]+$")


        fun requireKey(key: String) = require(KEY.matches(key)) { "Invalid secret key" }
    }

    private val prefs = context.getSharedPreferences("SecureStore", Context.MODE_PRIVATE)
    private val keyStore: KeyStore by lazy { KeyStore.getInstance("AndroidKeyStore").apply { load(null) } }

    fun get(key: String): String? {
        val stored = prefs.getString(entry(key), null) ?: prefs.getString(key, null) ?: return null
        val item = JSONObject(stored)
        check(item.optString("scheme") == "aes") { "Secret $key has an unsupported scheme" }
        check(!item.optBoolean("requireAuthentication")) { "Secret $key needs a device authentication this app does not ask for" }
        val alias = if (item.optBoolean("usesKeystoreSuffix")) ALIAS else LEGACY_ALIAS
        if (!keyStore.containsAlias(alias)) {
            delete(key)
            return null
        }
        val tagBits = item.getInt("tlen")
        check(tagBits >= 96) { "Secret $key has a short authentication tag" }
        val cipher = Cipher.getInstance(CIPHER)
        cipher.init(Cipher.DECRYPT_MODE, (keyStore.getEntry(alias, null) as KeyStore.SecretKeyEntry).secretKey,
            GCMParameterSpec(tagBits, Base64.decode(item.getString("iv"), Base64.DEFAULT)))
        return try {
            String(cipher.doFinal(Base64.decode(item.getString("ct"), Base64.DEFAULT)), Charsets.UTF_8)
        } catch (_: BadPaddingException) {

            delete(key)
            null
        }
    }

    fun set(key: String, value: String) {
        val secretKey = if (keyStore.containsAlias(ALIAS)) (keyStore.getEntry(ALIAS, null) as KeyStore.SecretKeyEntry).secretKey else createKey()
        val cipher = Cipher.getInstance(CIPHER).apply { init(Cipher.ENCRYPT_MODE, secretKey) }
        val spec = cipher.parameters.getParameterSpec(GCMParameterSpec::class.java)
        val item = JSONObject()
            .put("ct", Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
            .put("iv", Base64.encodeToString(spec.iv, Base64.NO_WRAP))
            .put("tlen", spec.tLen)
            .put("scheme", "aes")
            .put("usesKeystoreSuffix", true)
            .put("keystoreAlias", SERVICE)
            .put("requireAuthentication", false)
        check(prefs.edit().putString(entry(key), item.toString()).remove(key).commit()) { "Could not save the secret $key" }
    }

    fun delete(key: String) {
        check(prefs.edit().remove(entry(key)).remove(key).commit()) { "Could not delete the secret $key" }
    }

    private fun entry(key: String) = "$SERVICE-$key"

    private fun createKey(): SecretKey = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
        init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        generateKey()
    }
}
