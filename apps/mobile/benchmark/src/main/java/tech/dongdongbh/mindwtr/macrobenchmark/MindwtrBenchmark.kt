package tech.dongdongbh.mindwtr.macrobenchmark

import android.content.pm.ApplicationInfo
import android.os.Trace
import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.BaselineProfileMode
import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.ExperimentalMetricApi
import androidx.benchmark.macro.MemoryUsageMetric
import androidx.benchmark.macro.Metric
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

// No target override: tests must never type into the normal app or change its data.
private const val TARGET = "tech.dongdongbh.mindwtr.benchmark"
private const val TIMEOUT = 15_000L

@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalMetricApi::class)
class MindwtrBenchmark {
    @get:Rule val benchmark = MacrobenchmarkRule()
    private val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val args = InstrumentationRegistry.getArguments()
    private val compilation = CompilationMode.Partial(BaselineProfileMode.Disable, warmupIterations = 3)
    private var lastGestureBounds = ""
    private val iterations: Int get() = (args.getString("iterations") ?: "10").toInt().also { require(it in 1..100) }
    private val metricMode: String get() = args.getString("metricMode") ?: "timing"

    private fun metrics(startup: Boolean = false): List<Metric> = when (metricMode) {
        "timing" -> if (startup) listOf(StartupTimingMetric()) else listOf(FrameTimingMetric())
        // AndroidX 1.4.1 drops ALL scalar results for an iteration when any
        // scalar counter is absent. ART heap samples require GC; GPU samples
        // are also intermittent. Keep memory separate and collect only RSS.
        "memory" -> listOf(MemoryUsageMetric(MemoryUsageMetric.Mode.Last,
            listOf(MemoryUsageMetric.SubMetric.RssAnon, MemoryUsageMetric.SubMetric.RssFile)))
        else -> error("metricMode must be timing or memory")
    }

    @Before fun verifyTarget() {
        require(args.getString("syntheticDataConfirmed") == "true") { "Confirm the synthetic fixture and disabled sync first" }
        require(!args.getString("datasetId").isNullOrBlank()) { "datasetId is required" }
        val app = InstrumentationRegistry.getInstrumentation().context.packageManager.getApplicationInfo(TARGET, 0)
        assertFalse("Target must be a release APK", app.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
    }

    private fun find(selector: BySelector): UiObject2 = device.wait(Until.findObject(selector.pkg(TARGET)), TIMEOUT)
        ?: error("Expected benchmark UI element was not found: $selector")
    private fun tap(label: String) { find(By.desc(label)).click() }
    private inline fun stage(name: String, block: () -> Unit) {
        // Runner-process sections identify automation phases in Perfetto. They
        // include UiAutomator waits; do not report them as app input latency.
        Trace.beginSection("benchmark.capture.$name")
        try { block() } finally { Trace.endSection() }
    }
    private fun selectSort(label: String) {
        if (!device.hasObject(By.desc("Sort: $label").pkg(TARGET))) {
            find(By.descStartsWith("Sort:")).click()
            tap(label)
        }
        find(By.desc("Sort: $label"))
    }
    private fun scroll(down: Boolean) {
        // React Native may replace an accessibility node after a scroll. Never
        // keep UiObject2 references across gestures; derive bounds afresh.
        val bounds = find(By.scrollable(true)).visibleBounds
        lastGestureBounds = bounds.toString()
        assertTrue("Expected a visible list, got $bounds", bounds.height() > device.displayHeight / 4 && bounds.width() > device.displayWidth / 2)
        val top = bounds.top + bounds.height() / 5
        val bottom = bounds.bottom - bounds.height() / 5
        assertTrue("Gesture injection failed for $bounds", device.swipe(bounds.centerX(), if (down) bottom else top, bounds.centerX(), if (down) top else bottom, 30))
    }
    private fun ready() {
        find(By.desc("Inbox"))
        assertFalse("Stale APK: main-page help must be absent", device.hasObject(By.desc("Help: Focus").pkg(TARGET)))
    }
    private fun inboxCount(): Int {
        val description = find(By.descStartsWith("Process Inbox (")).contentDescription
        val match = Regex("""^Process Inbox \((\d+)\)$""").matchEntire(description)
        return match?.groupValues?.get(1)?.toIntOrNull()
            ?: error("Malformed Inbox count accessibility description: '$description'")
    }
    private fun settleStartupNotice() {
        assertTrue("Startup notification notice obstructs interaction", device.wait(Until.gone(By.text("Notifications disabled").pkg(TARGET)), TIMEOUT))
    }

    @Test fun coldStartup() = benchmark.measureRepeated(
        packageName = TARGET, metrics = metrics(startup = true), iterations = iterations,
        startupMode = StartupMode.COLD, compilationMode = compilation,
        setupBlock = { pressHome() },
    ) { startActivityAndWait(); ready() }

    @Test fun inboxScroll() = benchmark.measureRepeated(
        packageName = TARGET, metrics = metrics(), iterations = iterations,
        compilationMode = compilation,
        setupBlock = {
            startActivityAndWait(); ready(); tap("Inbox")
            settleStartupNotice()
            selectSort("Default")
            // Captures can fill the entire first screen in Newest order.
            // Normalize ordering before asserting a fixture row is visible.
            find(By.descStartsWith("Synthetic task "))
            // Warm-ups and previous iterations must not leave us at the end.
            var remaining = 40
            while (!device.hasObject(By.descStartsWith("Synthetic task 0.").pkg(TARGET)) && remaining-- > 0) {
                scroll(false)
                device.waitForIdle()
            }
            find(By.descStartsWith("Synthetic task 0."))
        },
    ) {
        val before = device.findObjects(By.descStartsWith("Synthetic task ").pkg(TARGET)).map { it.contentDescription }
        repeat(5) { scroll(true) }
        device.waitForIdle()
        find(By.descStartsWith("Synthetic task "))
        val after = device.findObjects(By.descStartsWith("Synthetic task ").pkg(TARGET)).map { it.contentDescription }
        if (before == after || after.isEmpty()) {
            val output = File(args.getString("additionalTestOutputDir")!!)
            device.takeScreenshot(File(output, "scroll-failure.png"))
            device.dumpWindowHierarchy(File(output, "scroll-failure.xml"))
        }
        assertTrue("Scroll must change visible rows: bounds=$lastGestureBounds before=$before after=$after", after.isNotEmpty() && before != after)
    }

    @Test fun settingsNavigation() = benchmark.measureRepeated(
        packageName = TARGET, metrics = metrics(), iterations = iterations,
        compilationMode = compilation,
        setupBlock = { startActivityAndWait(); ready(); tap("Menu"); settleStartupNotice() },
    ) {
        find(By.text("Settings")).click()
        find(By.text("General"))
        device.pressBack()
        find(By.desc("Inbox"))
    }

    // Non-mutating capture baseline: identical data across A/A and A/B runs.
    // Exercise the normal autofocus/keyboard path, then use the header close
    // control (not the full-screen backdrop, which also has a Close label).
    @Test fun captureOpenClose() = benchmark.measureRepeated(
        packageName = TARGET, metrics = metrics(), iterations = iterations,
        compilationMode = compilation,
        setupBlock = { startActivityAndWait(); ready(); tap("Inbox"); settleStartupNotice(); selectSort("Newest") },
    ) {
        val inboxBefore = find(By.descStartsWith("Process Inbox (")).contentDescription
        stage("open") {
            tap("Add Task")
            find(By.desc("Task title").focused(true))
            device.waitForIdle()
        }
        stage("close") {
            find(By.res("quick-capture-close").desc("Close")).click()
            assertTrue("Capture must close", device.wait(Until.gone(By.desc("Task title").pkg(TARGET)), TIMEOUT))
            find(By.desc("Add Task"))
            device.waitForIdle()
        }
        assertTrue("Opening and cancelling must not change the Inbox count",
            inboxBefore == find(By.descStartsWith("Process Inbox (")).contentDescription)
    }

    // Run last or alone: successful captures intentionally remain in this
    // synthetic-only app. A fresh fixture is required for comparable reruns.
    @Test fun captureSave() = benchmark.measureRepeated(
        packageName = TARGET, metrics = metrics(), iterations = iterations,
        compilationMode = compilation,
        setupBlock = { startActivityAndWait(); ready(); tap("Inbox"); settleStartupNotice(); selectSort("Newest") },
    ) {
        val title = "Benchmark capture ${System.nanoTime()}"
        val inboxBefore = inboxCount()
        stage("open") { tap("Add Task"); find(By.desc("Task title")) }
        stage("enterTitle") { find(By.desc("Task title")).text = title }
        stage("save") {
            tap("Save")
            assertTrue("Capture must close after save",
                device.wait(Until.gone(By.desc("Task title").pkg(TARGET)), TIMEOUT))
            val expectedInboxCount = inboxBefore + 1
            assertTrue("Inbox count must advance exactly once from $inboxBefore to $expectedInboxCount",
                device.wait(Until.hasObject(By.desc("Process Inbox ($expectedInboxCount)").pkg(TARGET)), TIMEOUT))
            device.waitForIdle()
            val inboxAfter = inboxCount()
            assertTrue("Inbox count changed by more or less than one: before=$inboxBefore after=$inboxAfter",
                inboxAfter == expectedInboxCount)
            find(By.descStartsWith(title))
            device.waitForIdle()
            val titleRows = device.findObjects(By.descStartsWith(title).pkg(TARGET))
            assertTrue("Expected exactly one saved task row for '$title', found ${titleRows.size}", titleRows.size == 1)
        }
    }
}
