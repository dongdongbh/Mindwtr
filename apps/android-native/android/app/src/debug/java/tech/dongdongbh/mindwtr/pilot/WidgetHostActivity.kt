package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.os.Bundle
import android.util.Log
import android.widget.FrameLayout


class WidgetHostActivity : Activity() {
    private lateinit var host: AppWidgetHost
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val manager = AppWidgetManager.getInstance(this)
        host = AppWidgetHost(this, HOST_ID)

        host.appWidgetIds.forEach(host::deleteAppWidgetId)
        if (intent.getBooleanExtra("release", false)) {
            finish()
            return
        }
        val provider = ComponentName(packageName, intent.getStringExtra("provider") ?: "tech.dongdongbh.mindwtr.androidwidget.TasksWidgetProvider")
        widgetId = host.allocateAppWidgetId()
        val options = Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, WIDTH_DP)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH, WIDTH_DP)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, HEIGHT_DP)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, HEIGHT_DP)
        }
        if (!manager.bindAppWidgetIdIfAllowed(widgetId, provider, options)) {
            Log.w(TAG, "Widget host bind refused provider=${provider.className}")
            finish()
            return
        }
        val view = host.createView(applicationContext, widgetId, manager.getAppWidgetInfo(widgetId))
        val density = resources.displayMetrics.density
        setContentView(FrameLayout(this).apply {
            addView(view, FrameLayout.LayoutParams((WIDTH_DP * density).toInt(), (HEIGHT_DP * density).toInt()))
        })
        Log.i(TAG, "Widget host bound id=$widgetId provider=${provider.className}")
    }

    override fun onStart() {
        super.onStart()
        host.startListening()
    }

    override fun onStop() {
        host.stopListening()
        super.onStop()
    }

    override fun onDestroy() {
        if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) host.deleteAppWidgetId(widgetId)
        super.onDestroy()
    }

    private companion object {
        const val TAG = "MindwtrNativeDev"
        const val HOST_ID = 4711
        const val WIDTH_DP = 320
        const val HEIGHT_DP = 420
    }
}
