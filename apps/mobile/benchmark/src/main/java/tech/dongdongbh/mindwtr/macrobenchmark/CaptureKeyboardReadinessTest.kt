package tech.dongdongbh.mindwtr.macrobenchmark

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.pm.ApplicationInfo
import android.graphics.Rect
import android.os.SystemClock
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

// Correctness gate, deliberately separate from timing measurements. No settings,
// permissions, input method, task data, or compilation state are changed.
@RunWith(AndroidJUnit4::class)
class CaptureKeyboardReadinessTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation = instrumentation.uiAutomation
    private val device = UiDevice.getInstance(instrumentation)
    private val args = InstrumentationRegistry.getArguments()
    private val target = "tech.dongdongbh.mindwtr.benchmark"
    private val timeout = 5_000L

    private fun find(selector: BySelector) = device.wait(Until.findObject(selector.pkg(target)), 15_000L)
        ?: error("Expected benchmark UI element: $selector")

    private fun keyboardVisible(): Boolean = automation.windows.any { window ->
        val bounds = Rect()
        window.getBoundsInScreen(bounds)
        window.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD &&
            !bounds.isEmpty && Rect.intersects(bounds, Rect(0, 0, device.displayWidth, device.displayHeight))
    }

    private fun waitForKeyboard(visible: Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeout
        do {
            if (keyboardVisible() == visible) return true
            SystemClock.sleep(50)
        } while (SystemClock.uptimeMillis() < deadline)
        return false
    }

    private fun verifyTarget(): String {
        require(args.getString("syntheticDataConfirmed") == "true")
        require(!args.getString("datasetId").isNullOrBlank())
        val expected = args.getString("expectedApkSha256") ?: error("expectedApkSha256 is required")
        require(expected.matches(Regex("[a-f0-9]{64}")))
        val app = instrumentation.context.packageManager.getApplicationInfo(target, 0)
        assertFalse("Target must be a release APK", app.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        require(app.splitSourceDirs.isNullOrEmpty()) { "Use the single locally built benchmark APK" }
        val digest = MessageDigest.getInstance("SHA-256")
        File(app.sourceDir).inputStream().use { input ->
            val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        assertEquals("Installed APK differs from the requested experiment", expected, actual)
        return actual
    }

    @Test fun coldAndWarmCapture() {
        val apkHash = verifyTarget()
        val iterations = (args.getString("iterations") ?: "10").toInt().also { require(it in 1..50) }
        val output = File(args.getString("additionalTestOutputDir") ?: error("Output directory is required"))
        require(output.canonicalPath.startsWith("/storage/emulated/0/Android/media/tech.dongdongbh.mindwtr.macrobenchmark/") ||
            output.canonicalPath.startsWith("/sdcard/Android/media/tech.dongdongbh.mindwtr.macrobenchmark/"))
        check(output.isDirectory || output.mkdirs()) { "Cannot create readiness output directory" }
        val originalFlags = automation.serviceInfo.flags
        val samples = JSONArray()
        val report = JSONObject().put("apkHash", apkHash).put("dataset", args.getString("datasetId"))
            .put("requestedColdLaunches", iterations).put("samples", samples).put("status", "running")
        var phase = "setup"
        try {
            automation.serviceInfo = automation.serviceInfo.apply {
                flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            }
            repeat(iterations) { iteration ->
                phase = "cold-launch-$iteration"
                device.executeShellCommand("am force-stop $target")
                device.executeShellCommand("am start -W -n $target/.MainActivity")
                find(By.desc("Inbox")).click()
                assertTrue("Startup notice obstructs capture", device.wait(Until.gone(By.text("Notifications disabled").pkg(target)), 15_000L))
                val inbox = find(By.descStartsWith("Process Inbox (")).contentDescription
                for (kind in listOf("cold", "warm")) {
                    phase = "$kind-$iteration"
                    // Negative control on every cycle: the predicate must not
                    // confuse the nav bar or a stale hidden IME with a keyboard.
                    assertTrue("Keyboard must be absent before capture", waitForKeyboard(false))
                    find(By.desc("Add Task")).click()
                    find(By.desc("Task title").focused(true))
                    assertTrue("Focused title has no visible keyboard: $phase", waitForKeyboard(true))
                    assertEquals("Another app interrupted keyboard readiness", target, device.currentPackageName)
                    samples.put(JSONObject().put("iteration", iteration).put("kind", kind).put("keyboardVisible", true))
                    find(By.res("quick-capture-close").desc("Close")).click()
                    assertTrue("Capture did not close", device.wait(Until.gone(By.desc("Task title").pkg(target)), 15_000L))
                    assertEquals("Cancelling changed the Inbox", inbox, find(By.descStartsWith("Process Inbox (")).contentDescription)
                }
            }
            report.put("status", "passed")
        } catch (failure: Throwable) {
            report.put("status", "failed").put("phase", phase)
            // Never capture another foreground app's contents after interference.
            if (device.currentPackageName == target) {
                device.takeScreenshot(File(output, "failure.png"))
                device.dumpWindowHierarchy(File(output, "failure.xml"))
            }
            throw failure
        } finally {
            try {
                File(output, "keyboard-readiness.json").writeText(report.toString(2))
            } finally {
                automation.serviceInfo = automation.serviceInfo.apply { flags = originalFlags }
            }
        }
    }
}
