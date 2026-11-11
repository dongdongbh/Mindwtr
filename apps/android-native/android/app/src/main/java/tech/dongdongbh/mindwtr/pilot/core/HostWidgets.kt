package tech.dongdongbh.mindwtr.pilot.core

import android.content.Context
import android.content.res.Configuration
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import tech.dongdongbh.mindwtr.androidwidget.CheckoffStore
import tech.dongdongbh.mindwtr.androidwidget.WidgetListStore
import tech.dongdongbh.mindwtr.androidwidget.WidgetPayloadStore
import tech.dongdongbh.mindwtr.androidwidget.WidgetRenderer
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit


class HostWidgets(private val app: Context, val appState: () -> String) {
    private val worker = Executors.newSingleThreadExecutor { task -> Thread(task, "mindwtr-widgets") }

    @Volatile private var stale = false


    fun inputs(): String {
        val night = app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        return JSONObject()
            .put("systemColorScheme", if (night) "dark" else "light")
            .put("systemLocale", Locale.getDefault().toLanguageTag())
            .put("listSelections", JSONArray(WidgetListStore.selections(app)))
            .put("stale", stale)

            .apply { debugProperty("widget_language").takeIf { it.isNotEmpty() }?.let { put("language", it) } }
            .toString()
    }


    fun publish(payload: String) {
        worker.execute {
            runCatching {
                check(WidgetPayloadStore.write(app, payload)) { "payload not stored" }
                val drawn = WidgetRenderer.refreshAll(app)
                Log.i(CoreHost.TAG, "Native Android widgets refreshed bytes=${payload.length} legacy=${drawn.legacyWidgetCount} " +
                    "compact=${drawn.compactWidgetCount} rendered=${drawn.renderedTaskCount} hiddenCheckoffs=${CheckoffStore.consumeHiddenCount(app)} " +
                    "serializedCheckoffs=${CheckoffStore.consumeSerializedCount(app)}")
                CheckoffStore.consumeHeldCount(app).takeIf { it > 0 }?.let {
                    Log.i(CoreHost.TAG, "Native Android widget check-offs held until the last Undo count=$it releaseCheck=v1.3.9/widget-checkoff-batch")
                }
            }.onSuccess { stale = false }.onFailure {
                stale = true
                Log.w(CoreHost.TAG, "Native Android widget refresh failed", it)
            }
        }
    }


    fun settle() {
        runCatching { worker.submit {}.get(SETTLE_SECONDS, TimeUnit.SECONDS) }
            .onFailure { Log.w(CoreHost.TAG, "Native Android widget refresh still running after ${SETTLE_SECONDS}s", it) }
    }

    private companion object {
        const val SETTLE_SECONDS = 30L
    }
}
