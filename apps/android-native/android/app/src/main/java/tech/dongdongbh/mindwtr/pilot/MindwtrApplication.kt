package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import java.util.concurrent.TimeUnit
import tech.dongdongbh.mindwtr.androidwidget.CaptureSyncHeadlessService


class MindwtrApplication : Application() {
    override fun onCreate() {
        super.onCreate()

        CaptureSyncHeadlessService.install(this,
            queued = { context -> CoreWork.enqueue(context, CoreJob.INGEST).result.get(DURABLE_WAIT_SECONDS, TimeUnit.SECONDS) },
            widgetRefresh = { context -> CoreWork.enqueue(context, CoreJob.WIDGET_REFRESH).result.get(DURABLE_WAIT_SECONDS, TimeUnit.SECONDS) })

        runCatching { CoreWork.cancelRnSync(this) }


        Thread({ PersistentCapture.restoreAtProcessStart(this) }, "mindwtr-capture-repin").start()
        if (BuildConfig.BUILD_TYPE.startsWith("benchmark")) registerBenchmarkMemoryProbe()
    }

    private fun registerBenchmarkMemoryProbe() {
        val probe = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                Thread(ProcessCoreHost::benchmarkMemoryProbe, "mindwtr-memory-probe").start()
            }
        }
        ContextCompat.registerReceiver(this, probe, IntentFilter(BENCHMARK_MEMORY_PROBE), ContextCompat.RECEIVER_EXPORTED)
    }

    private companion object {
        const val DURABLE_WAIT_SECONDS = 10L
        const val BENCHMARK_MEMORY_PROBE = "tech.dongdongbh.mindwtr.BENCHMARK_MEMORY_PROBE"
    }
}
