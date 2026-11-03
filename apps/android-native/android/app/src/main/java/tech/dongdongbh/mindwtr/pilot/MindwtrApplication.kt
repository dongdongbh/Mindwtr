package tech.dongdongbh.mindwtr.pilot

import android.app.Application
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
    }

    private companion object {
        const val DURABLE_WAIT_SECONDS = 10L
    }
}
