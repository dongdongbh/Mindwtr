package tech.dongdongbh.mindwtr.gmailauthorization

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.Locale

internal const val GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
internal const val GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me/"
internal const val GMAIL_RESPONSE_LIMIT = 2 * 1024 * 1024

internal class GmailFailure(val kind: String) : Exception(when (kind) {
  "AUTH" -> "Gmail authorization expired or was denied. Reconnect Gmail."
  "NETWORK" -> "Gmail could not be reached. Try again later."
  "CONFIG" -> "Gmail is unavailable or its request is not supported."
  "CANCELLED" -> "Gmail connection was cancelled."
  "STORAGE" -> "Gmail local storage is unavailable. Capture is stopped."
  else -> "Gmail returned an unsupported or oversized response."
})

internal data class GmailIdentity(val selectedName: String, val account: String, val accountId: String)
internal data class GmailSnapshot(val generation: Long, val identity: GmailIdentity?, val token: String?)

/** One monitor guards both generation admission and the durable selected-account write. */
internal class GmailSession {
  private var generation = 0L
  private var identity: GmailIdentity? = null
  private var token: String? = null
  private var loaded = false
  private var revoking = false

  @Synchronized fun initialize(read: () -> GmailIdentity?) {
    if (!loaded) { identity = read(); loaded = true }
  }
  @Synchronized fun snapshot() = GmailSnapshot(generation, identity, token)
  @Synchronized fun requestSnapshot(): GmailSnapshot {
    val current = snapshot()
    if (current.identity == null) throw GmailFailure("AUTH")
    return current
  }
  @Synchronized fun check(expected: Long): GmailSnapshot {
    if (generation != expected) throw GmailFailure("CANCELLED")
    return snapshot()
  }
  @Synchronized fun invalidate(clearIdentity: Boolean = false): GmailSnapshot {
    generation += 1
    token = null
    if (clearIdentity) identity = null
    return snapshot()
  }
  @Synchronized fun beginConnect(clear: () -> Unit): GmailSnapshot {
    if (revoking) throw GmailFailure("NETWORK")
    val next = invalidate(clearIdentity = true)
    clear()
    return next
  }
  @Synchronized fun install(expected: Long, selected: GmailIdentity, access: String, persist: () -> Unit) {
    check(expected)
    persist()
    identity = selected
    token = access
  }
  @Synchronized fun acceptToken(expected: Long, selected: GmailIdentity, access: String) {
    val current = check(expected)
    if (current.identity != selected) throw GmailFailure("CANCELLED")
    token = access
  }
  @Synchronized fun beginDisconnect(clear: () -> Unit): GmailSnapshot {
    val previous = snapshot()
    invalidate(clearIdentity = true)
    clear()
    if (previous.identity != null) revoking = true
    return previous
  }
  @Synchronized fun finishRevocation() { revoking = false }
  @Synchronized fun failAuth(expected: Long, clear: () -> Unit) {
    check(expected)
    invalidate(clearIdentity = true)
    clear()
  }
}

internal fun gmailAccount(value: String): String {
  val normalized = value.trim().lowercase(Locale.ROOT)
  if (normalized.length !in 3..320 || normalized.count { it == '@' } != 1 ||
    normalized.any { it.isWhitespace() || it.isISOControl() } ||
    normalized.startsWith('@') || normalized.endsWith('@')) throw GmailFailure("OTHER")
  return normalized
}

internal fun gmailAccountId(account: String): String = MessageDigest.getInstance("SHA-256")
  .digest(gmailAccount(account).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }

internal fun gmailRequestPath(value: String): String {
  if (value.length !in 1..8192 || value.any { it.isISOControl() || it == '\\' }) throw GmailFailure("CONFIG")
  val uri = try { URI(value) } catch (_: Exception) { throw GmailFailure("CONFIG") }
  if (uri.isAbsolute || uri.rawAuthority != null || uri.rawFragment != null || uri.rawPath.startsWith('/') ||
    uri.rawPath.contains('%')) throw GmailFailure("CONFIG")
  val path = uri.rawPath
  val parts = path.split('/')
  val id = Regex("[A-Za-z0-9_-]{1,256}")
  val allowed = path == "profile" || path == "labels" || path == "messages" ||
    (parts.size == 2 && parts[0] in setOf("labels", "messages") && id.matches(parts[1]))
  if (!allowed) throw GmailFailure("CONFIG")
  val query = mutableMapOf<String, String>()
  if (uri.rawQuery != null) {
    for (pair in uri.rawQuery.split('&')) {
      val fields = pair.split('=', limit = 2)
      if (fields.size != 2) throw GmailFailure("CONFIG")
      val name: String
      val content: String
      try {
        name = URLDecoder.decode(fields[0], "UTF-8")
        content = URLDecoder.decode(fields[1], "UTF-8")
      } catch (_: Exception) { throw GmailFailure("CONFIG") }
      if (name in query || content.isEmpty() || content.any { it.isISOControl() }) throw GmailFailure("CONFIG")
      query[name] = content
    }
  }
  when {
    path == "messages" -> {
      if (query.keys.any { it !in setOf("labelIds", "maxResults", "pageToken") } ||
        !id.matches(query["labelIds"].orEmpty()) || query["maxResults"]?.toIntOrNull() !in 1..25 ||
        query["pageToken"].orEmpty().length > 4096) throw GmailFailure("CONFIG")
    }
    parts.size == 2 && parts[0] == "messages" -> {
      if (query != mapOf("format" to "full")) throw GmailFailure("CONFIG")
    }
    query.isNotEmpty() -> throw GmailFailure("CONFIG")
  }
  return value
}

internal fun readGmailBody(input: InputStream, length: Long = -1, current: () -> Unit = {}): ByteArray {
  if (length > GMAIL_RESPONSE_LIMIT) throw GmailFailure("OTHER")
  val output = ByteArrayOutputStream()
  val buffer = ByteArray(8192)
  while (true) {
    current()
    val count = input.read(buffer, 0, minOf(buffer.size, GMAIL_RESPONSE_LIMIT + 1 - output.size()))
    if (count < 0) break
    output.write(buffer, 0, count)
    if (output.size() > GMAIL_RESPONSE_LIMIT) throw GmailFailure("OTHER")
  }
  return output.toByteArray()
}

internal fun validateGmailJsonDepth(text: String) {
  var quoted = false
  var escaped = false
  var depth = 0
  for (character in text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character == '\\') escaped = true
      else if (character == '"') quoted = false
    } else {
      when (character) {
        '"' -> quoted = true
        '{', '[' -> { depth += 1; if (depth > 64) throw GmailFailure("OTHER") }
        '}', ']' -> { depth -= 1; if (depth < 0) throw GmailFailure("OTHER") }
      }
    }
  }
  if (depth != 0 || quoted) throw GmailFailure("OTHER")
}
