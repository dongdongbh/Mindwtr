package tech.dongdongbh.mindwtr.pilot

import android.app.Application
import java.util.concurrent.TimeUnit
import tech.dongdongbh.mindwtr.androidwidget.CaptureSyncHeadlessService

/**
 * Cancels RN's background sync worker, and sets, before any component of this process runs, the hook through which RN's widget module (the quick capture dialog, the
 * capture intent receiver, a widget check-off queued by RN's CheckoffStore) has the pending-captures queue stored now: CoreWork's
 * ingest job, where RN started its headless task.
 */
class MindwtrApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // The wake returns once WorkManager stored the job: a process started only for a capture may end soon after.
        CaptureSyncHeadlessService.install(this,
            queued = { context -> CoreWork.enqueue(context, CoreJob.INGEST).result.get(DURABLE_WAIT_SECONDS, TimeUnit.SECONDS) },
            widgetRefresh = { context -> CoreWork.enqueue(context, CoreJob.WIDGET_REFRESH).result.get(DURABLE_WAIT_SECONDS, TimeUnit.SECONDS) })
        // RN's background sync worker goes on the first start after the upgrade (a no-op later): the native job replaces it.
        runCatching { CoreWork.cancelRnSync(this) }
        // RN's NotificationOpenIntentsPackage: any process start (a receiver, a widget, the app) posts the persistent capture
        // notification again from RN's own mirror of it, off the main thread (#819); a failure reaches the next boot's log.
        Thread({ PersistentCapture.restoreAtProcessStart(this) }, "mindwtr-capture-repin").start()
    }

    private companion object {
        const val DURABLE_WAIT_SECONDS = 10L
    }
}
