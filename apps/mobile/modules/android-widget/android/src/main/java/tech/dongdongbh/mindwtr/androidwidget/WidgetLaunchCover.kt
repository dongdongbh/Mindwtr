package tech.dongdongbh.mindwtr.androidwidget

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.view.Window
import android.widget.FrameLayout

/** Keeps the retained RN screen and its separate Modal window behind the widget's destination handoff. */
object WidgetLaunchCover {
  const val EXTRA_DESTINATION = "tech.dongdongbh.mindwtr.widget.DESTINATION"
  private const val RECOVERY_MS = 5_000L
  private val handler = Handler(Looper.getMainLooper())
  private var sequence = 0
  private var owner: Activity? = null
  private var cover: Dialog? = null
  private var recovery: Runnable? = null
  private val modalAnimations = mutableMapOf<Window, Int>()
  @Volatile private var state: Map<String, Any>? = null

  internal fun destination(activity: Activity, intent: Intent?): String? {
    if (intent?.action != Intent.ACTION_VIEW || !intent.getBooleanExtra(EXTRA_DESTINATION, false)) return null
    val uri = intent.data ?: return null
    if (uri.scheme != activity.getString(R.string.mindwtr_link_scheme) || !uri.encodedAuthority.isNullOrEmpty()
      || uri.query != null || uri.fragment != null) return null
    val segments = uri.pathSegments
    return when {
      segments.size == 1 && segments[0] in setOf("focus", "inbox", "waiting", "someday") -> "/${segments[0]}"
      segments.size == 2 && segments[0] == "widget-list" && segments[1].isNotBlank() -> "/widget-list/${segments[1]}"
      else -> null
    }
  }

  /** Called before ReactActivity forwards the new intent to Linking. A non-widget intent cancels a held handoff. */
  fun receive(activity: Activity, intent: Intent?) {
    finish("cancelled")
    val path = destination(activity, intent) ?: return
    sequence += 1
    owner = activity
    state = mapOf("token" to sequence, "path" to path, "url" to intent!!.dataString!!, "stage" to "pending")
    try {
      val dark = activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES
      val background = if (dark) Color.rgb(18, 18, 18) else Color.WHITE
      cover = Dialog(activity).apply {
        requestWindowFeature(Window.FEATURE_NO_TITLE)
        setContentView(FrameLayout(activity).apply { setBackgroundColor(background) })
        setCancelable(true)
        setOnCancelListener { finish("cancelled") }
        window?.apply {
          setBackgroundDrawable(ColorDrawable(background))
          setWindowAnimations(0)
          // RN Modal is another application window. Insert our application dialog after it, rather than a base-window subwindow.
          setType(WindowManager.LayoutParams.TYPE_APPLICATION)
          addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
          clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        }
        show()
        window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      }
      val token = sequence
      recovery = Runnable { if (state?.get("token") == token) finish("fallback") }.also {
        handler.postDelayed(it, RECOVERY_MS)
      }
    } catch (_: RuntimeException) {
      finish("fallback")
    }
  }

  fun snapshot(): Map<String, Any>? = state

  /** A clean RN Modal must disappear under the cover, rather than keep sliding after destination acknowledgement. */
  fun suppressExitAnimation(window: Window) {
    if (state?.get("stage") != "pending") return
    modalAnimations.putIfAbsent(window, window.attributes.windowAnimations)
    window.setWindowAnimations(0)
  }

  /** ReactActivity's host resume may re-show a retained RN Modal after onNewIntent. Our cover must be last. */
  fun resume(activity: Activity) {
    if (owner !== activity || state?.get("stage") != "pending") return
    try {
      cover?.apply {
        dismiss()
        show()
        window?.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
      }
    } catch (_: RuntimeException) {
      finish("fallback")
    }
  }

  fun complete(token: Int): Boolean {
    if (state?.get("token") != token || state?.get("stage") != "pending") return false
    finish("acknowledged")
    return true
  }

  /** Leaving or destroying this Activity must never leave a cover on an ordinary later resume. */
  fun cancel(activity: Activity) {
    if (owner === activity) finish("cancelled")
  }

  private fun finish(stage: String) {
    recovery?.let(handler::removeCallbacks)
    recovery = null
    if (state?.get("stage") == "pending") state = state?.plus("stage" to stage)
    modalAnimations.forEach { (window, animations) ->
      if (window.decorView.isAttachedToWindow) runCatching { window.setWindowAnimations(animations) }
    }
    modalAnimations.clear()
    cover?.setOnCancelListener(null)
    runCatching { cover?.dismiss() }
    cover = null
    owner = null
  }
}
