package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.security.SecureRandom
import org.json.JSONObject

data class CaptureIntentConfig(
  val enabled: Boolean,
  val token: String?,
) {
  fun toBridgeValue(): Map<String, Any?> = mapOf("enabled" to enabled, "token" to token)

  companion object {
    val DISABLED = CaptureIntentConfig(enabled = false, token = null)

    fun isValidToken(value: String?): Boolean = value?.matches(Regex("^[0-9a-f]{64}$")) == true
  }
}


object CaptureIntentConfigPolicy {
  fun setEnabled(
    current: CaptureIntentConfig,
    enabled: Boolean,
    generateToken: () -> String,
  ): CaptureIntentConfig {
    if (!enabled) return CaptureIntentConfig.DISABLED
    if (current.enabled && CaptureIntentConfig.isValidToken(current.token)) return current

    val token = generateToken()
    check(CaptureIntentConfig.isValidToken(token)) { "Capture token generator returned an invalid token" }
    return CaptureIntentConfig(enabled = true, token = token)
  }
}


internal interface CaptureIntentConfigPersistence {
  @Throws(IOException::class)
  fun read(): String?

  @Throws(IOException::class)
  fun write(raw: String)

  @Throws(IOException::class)
  fun delete()
}

private class AtomicCaptureIntentConfigPersistence(private val file: File) : CaptureIntentConfigPersistence {
  private val atomicFile = AtomicFile(file)

  override fun read(): String? = try {
    atomicFile.openRead().bufferedReader(Charsets.UTF_8).use { it.readText() }
  } catch (_: FileNotFoundException) {
    null
  } catch (error: IOException) {
    throw error
  } catch (error: Exception) {
    throw IOException("Could not read capture intent config", error)
  }

  override fun write(raw: String) {
    var stream: FileOutputStream? = null
    try {
      stream = atomicFile.startWrite()
      stream.write(raw.toByteArray(Charsets.UTF_8))


      stream.fd.sync()
      atomicFile.finishWrite(stream)
    } catch (error: Exception) {
      stream?.let { runCatching { atomicFile.failWrite(it) } }
      throw IOException("Could not update capture intent config", error)
    }
  }

  override fun delete() {
    atomicFile.delete()
    val remnants = listOf(file, File("${file.path}.bak"), File("${file.path}.new"))
    if (remnants.any(File::exists)) throw IOException("Could not disable capture intent")
  }
}

object CaptureIntentConfigStore {
  private const val FILE_NAME = "android-capture-intent.json"
  private val random = SecureRandom()

  @Synchronized
  @Throws(IOException::class)
  fun read(context: Context): CaptureIntentConfig = read(persistence(context))

  internal fun read(storage: CaptureIntentConfigPersistence): CaptureIntentConfig {
    val raw = storage.read() ?: return CaptureIntentConfig.DISABLED
    return try {
      val token = JSONObject(raw).optString("token", "")
      if (!CaptureIntentConfig.isValidToken(token)) {
        throw IOException("Capture intent config is invalid")
      }
      CaptureIntentConfig(enabled = true, token = token)
    } catch (error: IOException) {
      throw error
    } catch (error: Exception) {
      throw IOException("Could not read capture intent config", error)
    }
  }

  @Synchronized
  @Throws(IOException::class)
  fun setEnabled(context: Context, enabled: Boolean): CaptureIntentConfig =
    setEnabled(persistence(context), enabled, ::generateToken)

  internal fun setEnabled(
    storage: CaptureIntentConfigPersistence,
    enabled: Boolean,
    generateToken: () -> String,
  ): CaptureIntentConfig {
    if (!enabled) {
      storage.delete()
      if (storage.read() != null) throw IOException("Could not disable capture intent")
      return CaptureIntentConfig.DISABLED
    }

    val current = read(storage)
    val next = CaptureIntentConfigPolicy.setEnabled(current, enabled = true, generateToken = generateToken)
    if (next == current) return current

    storage.write(JSONObject().put("token", next.token).toString())
    val verified = try {
      read(storage)
    } catch (error: Exception) {
      runCatching { storage.delete() }
      throw IOException("Could not verify capture intent config", error)
    }
    if (verified != next) {
      runCatching { storage.delete() }
      throw IOException("Could not verify capture intent config")
    }
    return verified
  }

  private fun persistence(context: Context): CaptureIntentConfigPersistence =
    AtomicCaptureIntentConfigPersistence(File(context.noBackupFilesDir, FILE_NAME))

  private fun generateToken(): String {
    val bytes = ByteArray(32)
    random.nextBytes(bytes)
    val hex = "0123456789abcdef"
    return buildString(bytes.size * 2) {
      for (byte in bytes) {
        val value = byte.toInt() and 0xff
        append(hex[value ushr 4])
        append(hex[value and 0x0f])
      }
    }
  }
}
