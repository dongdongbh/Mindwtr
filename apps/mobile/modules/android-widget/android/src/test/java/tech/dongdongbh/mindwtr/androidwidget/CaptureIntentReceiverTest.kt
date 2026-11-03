package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CaptureIntentReceiverTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val queue = File(context.filesDir, PendingCaptureWriter.DIRECTORY)

  @After
  fun clean() {
    CaptureIntentReceiver.queuedHook = null
    CaptureIntentConfigStore.setEnabled(context, false)
    queue.deleteRecursively()
  }

  private fun send(text: String, token: String) {
    context.sendBroadcast(Intent(CaptureIntentProcessor.ACTION)
      .putExtra(CaptureIntentProcessor.EXTRA_TEXT, text)
      .putExtra(CaptureIntentProcessor.EXTRA_TOKEN, token))
    shadowOf(Looper.getMainLooper()).idle()
  }

  @Test
  fun aQueuedCaptureRunsTheHostsHookWithItsFileOnDiskAndARefusedOneDoesNot() {
    val token = CaptureIntentConfigStore.setEnabled(context, true).token!!
    context.registerReceiver(CaptureIntentReceiver(), IntentFilter(CaptureIntentProcessor.ACTION), Context.RECEIVER_NOT_EXPORTED)
    val seen = Collections.synchronizedList(mutableListOf<Int>())
    val ran = CountDownLatch(1)

    CaptureIntentReceiver.queuedHook = { seen += queue.listFiles { file -> file.name.endsWith(".json") }!!.size; ran.countDown() }

    send("Buy milk", token)
    assertTrue(ran.await(5, TimeUnit.SECONDS))
    assertEquals(listOf(1), seen.toList())

    send("Buy bread", "cd".repeat(32))
    Thread.sleep(500)
    assertEquals("a refused capture queues nothing and runs no hook", listOf(1), seen.toList())
  }
}
