package tech.dongdongbh.mindwtr.androidwidget

import android.content.Context
import android.os.FileObserver
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config


@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CaptureSyncHeadlessServiceTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val started = java.util.Collections.synchronizedList(mutableListOf<Context>())

  @Before
  fun clean() {
    File(context.filesDir, PendingCaptureWriter.DIRECTORY).deleteRecursively()
  }

  @After
  fun uninstall() = CaptureSyncHeadlessService.install(context, null)


  private fun offMain(block: () -> Unit) {
    var failure: Throwable? = null
    thread { try { block() } catch (error: Throwable) { failure = error } }.join()
    failure?.let { throw it }
  }

  @Test
  fun selectingAListUsesTheRefreshHookWithoutStartingCaptureSync() {
    val refreshed = mutableListOf<Context>()
    CaptureSyncHeadlessService.install(context, queued = { started += it }, widgetRefresh = { refreshed += it })
    offMain { CaptureSyncHeadlessService.startWidgetRefresh(context) }
    assertEquals(emptyList<Context>(), started)
    assertEquals(listOf(context.applicationContext), refreshed)
    offMain { CaptureSyncHeadlessService.start(context) }
    assertEquals(listOf(context.applicationContext), started)
  }

  @Test
  fun theDialogsStartReachesTheAppsHookOffTheMainThreadWithTheApplicationContext() {
    CaptureSyncHeadlessService.start(context)
    assertEquals("no hook yet: nothing starts, nothing throws", 0, started.size)
    val ran = CountDownLatch(1)
    var hookThread: Thread? = null
    CaptureSyncHeadlessService.install(context) { started += it; hookThread = Thread.currentThread(); ran.countDown() }

    CaptureSyncHeadlessService.start(context)
    assertTrue(ran.await(5, TimeUnit.SECONDS))
    assertSame(context.applicationContext, started.single())
    assertNotSame(Looper.getMainLooper().thread, hookThread)
  }

  @Test
  fun offTheMainThreadStartReturnsOnlyOnceTheHookStoredTheJob() {
    var stored = false
    CaptureSyncHeadlessService.install(context) { Thread.sleep(200); stored = true }
    var storedAtReturn = false
    offMain { CaptureSyncHeadlessService.start(context); storedAtReturn = stored }
    assertTrue("the watcher's wake waits for WorkManager's durable enqueue", storedAtReturn)

    CaptureSyncHeadlessService.install(context) { throw TimeoutException() }
    offMain { CaptureSyncHeadlessService.start(context) }
  }

  @Test
  fun anItemRnsWriterPublishesInTheQueueStartsTheHook() {
    val queue = File(context.filesDir, PendingCaptureWriter.DIRECTORY)
    CaptureSyncHeadlessService.install(context) { started += it }
    assertTrue("the watched queue folder exists", queue.isDirectory)

    offMain { CaptureSyncHeadlessService.queueEvent(context, FileObserver.MOVED_TO, "a.json") }
    assertEquals(1, started.size)
    offMain {
      CaptureSyncHeadlessService.queueEvent(context, FileObserver.CREATE, "b.tmp")
      CaptureSyncHeadlessService.queueEvent(context, FileObserver.MOVED_TO, "b.tmp")
      CaptureSyncHeadlessService.queueEvent(context, FileObserver.DELETE, "a.json")
    }
    assertEquals("a half-written file or the drain's delete starts nothing", 1, started.size)
    CaptureSyncHeadlessService.install(context, null)
    offMain { CaptureSyncHeadlessService.queueEvent(context, FileObserver.MOVED_TO, "c.json") }
    assertEquals("no hook: nothing starts", 1, started.size)
  }

  @Test
  fun theCaptureIntentReceiversQueuedCaptureWaitsForTheStoredJobBeforeTheBroadcastFinishes() {
    var stored = false
    CaptureSyncHeadlessService.install(context) { Thread.sleep(200); stored = true }
    val hook = CaptureIntentReceiver.queuedHook ?: error("no receiver hook")
    var storedAtReturn = false

    offMain { hook(context); storedAtReturn = stored }
    assertTrue(storedAtReturn)
    CaptureSyncHeadlessService.install(context, null)
    assertEquals(null, CaptureIntentReceiver.queuedHook)
  }
}
