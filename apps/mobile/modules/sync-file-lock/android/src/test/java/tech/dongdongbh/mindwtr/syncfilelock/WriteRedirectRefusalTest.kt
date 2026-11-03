package tech.dongdongbh.mindwtr.syncfilelock

import java.net.ServerSocket
import java.util.Collections
import kotlin.concurrent.thread
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WriteRedirectRefusalTest {


  private val server = ServerSocket(0)
  private val seen: MutableList<String> = Collections.synchronizedList(mutableListOf())
  private val base = "http://127.0.0.1:${server.localPort}"
  private val guarded = OkHttpClient.Builder().addNetworkInterceptor(WriteRedirectRefusal).build()

  init {
    thread(isDaemon = true) {
      while (!server.isClosed) {
        val socket = runCatching { server.accept() }.getOrNull() ?: break
        socket.use {
          val input = it.getInputStream().bufferedReader(Charsets.ISO_8859_1)
          val requestLine = input.readLine() ?: return@use
          var contentLength = 0
          while (true) {
            val header = input.readLine() ?: break
            if (header.isEmpty()) break
            if (header.startsWith("Content-Length:", ignoreCase = true)) {
              contentLength = header.substringAfter(':').trim().toInt()
            }
          }
          repeat(contentLength) { input.read() }
          val (method, path) = requestLine.split(' ')
          seen.add("$method $path")
          val reply = if (method == "GET" && path == "/dav/data.json") {
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
          } else {
            "HTTP/1.1 301 Moved Permanently\r\nLocation: /dav/data.json\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
          }
          it.getOutputStream().apply { write(reply.toByteArray(Charsets.ISO_8859_1)); flush() }
        }
      }
    }
  }

  @After
  fun closeServer() {
    server.close()
  }

  private fun put(client: OkHttpClient) = client.newCall(
    Request.Builder()
      .url("$base/dav/data.json")
      .put("{\"tasks\":[]}".toRequestBody("application/json".toMediaType()))
      .build(),
  ).execute().use { it.code to it.header("Location") }

  @Test
  fun unguardedClientTurnsARedirectedPutIntoAGetThatLooksLikeSuccess() {
    assertEquals(200 to null, put(OkHttpClient()))
    assertEquals(listOf("PUT /dav/data.json", "GET /dav/data.json"), seen.toList())
  }

  @Test
  fun guardHandsARedirectedWriteBackUnfollowed() {
    assertEquals(301 to null, put(guarded))
    assertEquals(listOf("PUT /dav/data.json"), seen.toList())
  }

  @Test
  fun guardLeavesReadsOnTheDefaultRedirectPolicy() {
    val code = guarded.newCall(Request.Builder().url("$base/dav/old").build()).execute().use { it.code }
    assertEquals(200, code)
    assertEquals(listOf("GET /dav/old", "GET /dav/data.json"), seen.toList())
  }
}
